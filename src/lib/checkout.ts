import { randomBytes } from "node:crypto";
import type pg from "pg";
import { pool } from "@/lib/db";
import type { Drop } from "@/lib/drops";
import { ApiError } from "@/lib/http";
import { idempotent, type Outcome } from "@/lib/idempotency";
import { holdTtlS, INSTANT_WAIT_S, instantAhead, queueRate, turnTtlS } from "@/lib/queue";
import { MAX_SEATS_PER_ORDER } from "@/lib/venue";
import { inc } from "@/lib/counters";

// Seat selection and mock checkout for seat-select drops (status 'claim').
// Hold: all-or-nothing row-locked claim of up to 6 seats, only during the user's turn.
// Pay: mock gateway, flips the held order and its allocations to paid/confirmed.

function assertClaim(drop: Drop) {
  if (!drop.config.seatSelect) throw new ApiError(409, "WRONG_MODE", "this drop has no seat selection");
  if (drop.status === "done") throw new ApiError(410, "SOLD_OUT");
  // Instant-queue drops sell while open (each entrant has their own admission time); others after the draw.
  if (drop.status !== (drop.config.instantQueue ? "open" : "claim")) throw new ApiError(409, "QUEUE_NOT_OPEN");
}

export async function orderBody(c: pg.ClientBase | pg.Pool, orderId: string) {
  const { rows } = await c.query(
    `SELECT o.id, o.status, o.total, o.expires_at, o.paid_at, o.payment_ref,
            json_agg(json_build_object('seatNo', s.seat_no, 'section', s.section, 'row', s.row_label, 'label', s.seat_label, 'price', s.price)
                     ORDER BY s.seat_no) AS seats
     FROM orders o JOIN allocations a ON a.order_id = o.id JOIN seats s ON s.id = a.seat_id
     WHERE o.id = $1 GROUP BY o.id`,
    [orderId],
  );
  const o = rows[0];
  return o
    ? { id: o.id, status: o.status, total: o.total, expiresAt: o.expires_at, paidAt: o.paid_at, paymentRef: o.payment_ref, seats: o.seats }
    : null;
}

export function parseSeatNos(raw: unknown, inventory: number): number[] {
  const list = (raw as { seatNos?: unknown })?.seatNos;
  if (!Array.isArray(list) || list.length === 0) throw new ApiError(400, "NO_SEATS", "pick at least one seat");
  if (list.length > MAX_SEATS_PER_ORDER) throw new ApiError(400, "TOO_MANY_SEATS", `max ${MAX_SEATS_PER_ORDER} tickets per order`);
  const nos = [...new Set(list)];
  if (nos.length !== list.length || !nos.every((n) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= inventory)) {
    throw new ApiError(400, "BAD_SEATS");
  }
  return (nos as number[]).sort((a, b) => a - b);
}

/** Holds seats for the caller. A second hold during the turn replaces the first ("change seats"). */
export async function holdSeats(drop: Drop, userId: string, seatNos: number[], key: string, reqHash: string) {
  assertClaim(drop);
  return idempotent(userId, key, reqHash, async (c): Promise<Outcome> => {
    // Locking the caller's rank row serialises their own concurrent holds.
    const { rows: me } = drop.config.instantQueue
      ? await c.query(
          `SELECT queue_pos - 1 AS rank, CASE WHEN queue_admit_at <= now() THEN queue_admit_at END AS admitted_at, id AS entry_id
           FROM entries WHERE drop_id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`,
          [drop.id, userId],
        )
      : await c.query(
          `SELECT r.rank, r.admitted_at, e.id AS entry_id FROM draw_ranks r JOIN entries e ON e.id = r.entry_id
           WHERE r.drop_id = $1 AND e.user_id = $2 FOR UPDATE OF r`,
          [drop.id, userId],
        );
    if (!me[0]) throw new ApiError(403, "NOT_IN_QUEUE");
    if (!me[0].admitted_at) throw new ApiError(409, "NOT_YOUR_TURN", "wait for your turn in the queue");
    const { rows: live } = await c.query(
      "SELECT id, status FROM orders WHERE drop_id = $1 AND user_id = $2 AND status IN ('held','paid') FOR UPDATE",
      [drop.id, userId],
    );
    if (live[0]?.status === "paid") throw new ApiError(409, "ALREADY_PURCHASED");
    const turnOver = Date.now() - new Date(me[0].admitted_at).getTime() > turnTtlS(drop.config) * 1000;
    if (turnOver && !live[0]) throw new ApiError(409, "TURN_EXPIRED", "your turn has ended");
    if (live[0]) {
      // Release the previous pick in the same transaction: if the new claim fails, the old hold survives.
      await c.query(
        `WITH a AS (UPDATE allocations SET status = 'released' WHERE order_id = $1 AND status = 'offered' RETURNING seat_id)
         UPDATE seats SET held = false WHERE id IN (SELECT seat_id FROM a)`,
        [live[0].id],
      );
      await c.query("UPDATE orders SET status = 'expired' WHERE id = $1", [live[0].id]);
    }
    // Row locks + the NOT held recheck make this all-or-nothing under concurrency: a seat another
    // transaction just took is simply not returned, and we roll back.
    const { rows: got } = await c.query(
      "UPDATE seats SET held = true WHERE drop_id = $1 AND seat_no = ANY($2::int[]) AND NOT held RETURNING id, seat_no, price",
      [drop.id, seatNos],
    );
    if (got.length !== seatNos.length) {
      inc(drop.id, "hold_conflict");
      const taken = seatNos.filter((n) => !got.some((g) => g.seat_no === n));
      throw new ApiError(409, "SEATS_TAKEN", `seat${taken.length > 1 ? "s" : ""} just taken: ${taken.join(", ")}`);
    }
    const total = got.reduce((t, s) => t + (s.price ?? 0), 0);
    const { rows: o } = await c.query(
      `INSERT INTO orders (drop_id, user_id, seat_count, total, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5)) RETURNING id, expires_at`,
      [drop.id, userId, got.length, total, holdTtlS(drop.config)],
    );
    await c.query(
      `INSERT INTO allocations (drop_id, seat_id, user_id, entry_id, rank, status, expires_at, request_id, order_id)
       SELECT $1, s, $2, $3, $4, 'offered', $5, $6, $7 FROM unnest($8::uuid[]) s`,
      [drop.id, userId, me[0].entry_id, me[0].rank, o[0].expires_at, key, o[0].id, got.map((g) => g.id)],
    );
    inc(drop.id, "hold_ok");
    return { status: 201, body: { order: await orderBody(c, o[0].id) } };
  });
}

/** Mock payment. Card details are never sent or stored; the "gateway" always approves. */
export async function payOrder(drop: Drop, userId: string, orderId: string, key: string, reqHash: string) {
  assertClaim(drop);
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new ApiError(400, "BAD_ORDER");
  return idempotent(userId, key, reqHash, async (c): Promise<Outcome> => {
    const { rows } = await c.query(
      "SELECT id, status, expires_at <= now() AS lapsed FROM orders WHERE id = $1 AND drop_id = $2 AND user_id = $3 FOR UPDATE",
      [orderId, drop.id, userId],
    );
    const o = rows[0];
    if (!o) throw new ApiError(404, "NOT_FOUND");
    if (o.status === "paid") return { status: 200, body: { order: await orderBody(c, o.id), alreadyPaid: true } };
    if (o.status !== "held" || o.lapsed) throw new ApiError(410, "HOLD_EXPIRED", "your seat hold expired, pick again");
    const ref = `MOCK-${randomBytes(4).toString("hex").toUpperCase()}`;
    await c.query("UPDATE orders SET status = 'paid', paid_at = now(), payment_ref = $2 WHERE id = $1", [o.id, ref]);
    await c.query("UPDATE allocations SET status = 'confirmed', confirmed_at = now() WHERE order_id = $1 AND status = 'offered'", [o.id]);
    inc(drop.id, "purchase_ok");
    return { status: 201, body: { order: await orderBody(c, o.id) } };
  });
}

/** Static layout (cache it) and the live taken-mask, one char per seat_no: 0 free, 1 taken. */
export async function seatLayout(dropId: string) {
  const { rows } = await pool().query(
    "SELECT seat_no, section, row_label, seat_label, price, x, y FROM seats WHERE drop_id = $1 ORDER BY seat_no",
    [dropId],
  );
  return rows.map((r) => [r.seat_no, r.section, r.row_label, r.seat_label, r.price, r.x, r.y]);
}

export async function takenMask(dropId: string): Promise<string> {
  const { rows } = await pool().query("SELECT string_agg(CASE WHEN held THEN '1' ELSE '0' END, '' ORDER BY seat_no) AS m FROM seats WHERE drop_id = $1", [dropId]);
  return rows[0].m ?? "";
}

/** Post-draw state of one user in a seat-select drop. */
export async function seatState(drop: Drop, userId: string, entry: { status: string; rank: number | null } | undefined) {
  const p = pool();
  const [{ rows: q }, { rows: me }, { rows: ord }] = await Promise.all([
    p.query(
      `SELECT serving_rank, queue_target_s, queue_pace_rank, config, eligible_count,
              extract(epoch FROM now() - queue_started_at)::float AS elapsed_s,
              (SELECT count(*)::int FROM seats WHERE drop_id = d.id AND NOT held) AS free
       FROM drops d WHERE id = $1`,
      [drop.id],
    ),
    p.query(
      `SELECT r.admitted_at FROM draw_ranks r JOIN entries e ON e.id = r.entry_id WHERE r.drop_id = $1 AND e.user_id = $2`,
      [drop.id, userId],
    ),
    p.query("SELECT id FROM orders WHERE drop_id = $1 AND user_id = $2 AND status IN ('held','paid') ORDER BY created_at DESC LIMIT 1", [drop.id, userId]),
  ]);
  const d = q[0];
  const order = ord[0] ? await orderBody(p, ord[0].id) : null;
  const queue = { servingRank: d.serving_rank as number, total: d.eligible_count as number, freeSeats: d.free as number };
  if (order?.status === "paid") return { state: "confirmed", order, queue };
  if (!entry) return { state: "missed", queue };
  if (entry.status !== "active" || entry.rank == null) return { state: "lost", queue };
  const rank: number = entry.rank;
  if (order) return { state: "checkout", order, queue };
  const admittedAt = me[0]?.admitted_at as Date | null;
  if (!admittedAt) {
    const ahead = Math.max(0, rank - d.serving_rank);
    let etaS = ahead / Math.max(0.001, queueRate(d));
    if (d.config.demo && d.queue_target_s) etaS = Math.min(etaS, Math.max(0, Math.min(d.queue_target_s, 34) - d.elapsed_s));
    return { state: "waiting", position: rank + 1, ahead, etaS: Math.ceil(etaS), queue };
  }
  if (drop.status === "done" || d.free === 0) return { state: "sold_out", queue };
  const turnEndsAt = new Date(admittedAt.getTime() + turnTtlS(d.config) * 1000);
  if (turnEndsAt.getTime() < Date.now()) return { state: "turn_expired", queue };
  return { state: "your_turn", position: rank + 1, turnEndsAt, queue };
}

/** State of one entrant in an instant-queue drop: own random number, own countdown, then seats. */
export async function instantState(
  drop: Drop,
  userId: string,
  entry: { id: string; status: string; queue_pos: number; queue_admit_at: Date },
) {
  const p = pool();
  const [{ rows: f }, { rows: ord }] = await Promise.all([
    p.query("SELECT count(*)::int AS free FROM seats WHERE drop_id = $1 AND NOT held", [drop.id]),
    p.query("SELECT id FROM orders WHERE drop_id = $1 AND user_id = $2 AND status IN ('held','paid') ORDER BY created_at DESC LIMIT 1", [drop.id, userId]),
  ]);
  const order = ord[0] ? await orderBody(p, ord[0].id) : null;
  const queue = { servingRank: 0, total: 0, freeSeats: f[0].free as number }; // no shared queue to count
  if (order?.status === "paid") return { state: "confirmed", order, queue };
  if (entry.status !== "active") return { state: "lost", queue };
  if (order) return { state: "checkout", order, queue };
  const admitAt = new Date(entry.queue_admit_at);
  const now = Date.now();
  if (admitAt.getTime() > now) {
    const ahead = instantAhead(entry.id, entry.queue_pos, admitAt, drop.config.queueWaitS ?? INSTANT_WAIT_S, now);
    return { state: "waiting", position: entry.queue_pos, ahead, etaS: Math.ceil((admitAt.getTime() - now) / 1000), saleOpensAt: drop.config.saleOpensAt ?? null, queue };
  }
  if (drop.status === "done" || f[0].free === 0) return { state: "sold_out", queue };
  const turnEndsAt = new Date(admitAt.getTime() + turnTtlS(drop.config) * 1000);
  if (turnEndsAt.getTime() < now) return { state: "turn_expired", queue };
  return { state: "your_turn", position: entry.queue_pos, turnEndsAt, queue };
}
