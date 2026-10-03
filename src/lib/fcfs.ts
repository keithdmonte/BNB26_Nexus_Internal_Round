import { pool } from "@/lib/db";
import type { Drop } from "@/lib/drops";
import { ApiError } from "@/lib/http";
import { idempotent, type Outcome } from "@/lib/idempotency";
import { inc } from "@/lib/counters";

const g = globalThis as unknown as { __soldOut?: Set<string> };
const soldOut = (g.__soldOut ??= new Set());

function assertOpen(drop: Drop) {
  if (drop.mode === "lottery") throw new ApiError(409, "WRONG_MODE", "this drop uses the lottery");
  const now = Date.now();
  if (drop.status === "scheduled" || now < drop.opensAt.getTime()) throw new ApiError(409, "WINDOW_NOT_OPEN");
  if (drop.status !== "open" || now >= drop.closesAt.getTime()) throw new ApiError(409, "WINDOW_CLOSED");
}

/**
 * Naive-but-correct first-come-first-served: the fastest request wins, inventory is still exact.
 * One transaction: idempotency key + FOR UPDATE SKIP LOCKED seat claim + allocation insert.
 */
export async function purchase(drop: Drop, userId: string, key: string, reqHash: string) {
  assertOpen(drop);
  if (soldOut.has(drop.id)) {
    inc(drop.id, "sold_out");
    throw new ApiError(410, "SOLD_OUT");
  }
  const out = await idempotent(userId, key, reqHash, async (c): Promise<Outcome> => {
    const existing = await c.query(
      `SELECT a.id, s.seat_no FROM allocations a JOIN seats s ON s.id = a.seat_id
       WHERE a.drop_id = $1 AND a.user_id = $2 AND a.status IN ('offered','confirmed')`,
      [drop.id, userId],
    );
    if (existing.rows[0]) {
      inc(drop.id, "duplicate_absorbed");
      return { status: 200, body: { allocation: allocationBody(existing.rows[0]), alreadyPurchased: true } };
    }
    // Retry the claim a few times: SKIP LOCKED can come up empty while other transactions hold
    // the last free seats and later roll back.
    for (let i = 0; i < 4; i++) {
      const seat = await c.query(
        `UPDATE seats SET held = true
         WHERE id = (SELECT id FROM seats WHERE drop_id = $1 AND NOT held ORDER BY seat_no
                     FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING id, seat_no`,
        [drop.id],
      );
      if (seat.rows[0]) {
        const { rows } = await c.query(
          `INSERT INTO allocations (drop_id, seat_id, user_id, status, confirmed_at, request_id)
           VALUES ($1, $2, $3, 'confirmed', now(), $4) RETURNING id`,
          [drop.id, seat.rows[0].id, userId, key],
        );
        inc(drop.id, "purchase_ok");
        return { status: 201, body: { allocation: allocationBody({ id: rows[0].id, seat_no: seat.rows[0].seat_no }) } };
      }
      const free = await c.query("SELECT 1 FROM seats WHERE drop_id = $1 AND NOT held LIMIT 1", [drop.id]);
      if (!free.rows[0]) break;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
    }
    soldOut.add(drop.id);
    inc(drop.id, "sold_out");
    throw new ApiError(410, "SOLD_OUT");
  });
  return out;
}

/**
 * DELIBERATELY BROKEN. Check-then-act with no lock and no constraints, writing to allocations_unsafe.
 * Exists only so the integrity checker can be shown catching a real oversell. The short sleep stands in
 * for real-world work between the check and the write (payment call, etc.) and widens the race window.
 */
export async function purchaseUnsafe(drop: Drop, userId: string, key: string) {
  assertOpen(drop);
  const p = pool();
  const sold = await p.query("SELECT count(*)::int n FROM allocations_unsafe WHERE drop_id = $1", [drop.id]);
  if (sold.rows[0].n >= drop.inventory) {
    inc(drop.id, "sold_out");
    throw new ApiError(410, "SOLD_OUT");
  }
  const mine = await p.query("SELECT 1 FROM allocations_unsafe WHERE drop_id = $1 AND user_id = $2", [drop.id, userId]);
  if (mine.rows[0]) return { status: 200, body: { alreadyPurchased: true }, replayed: false };
  await new Promise((r) => setTimeout(r, Math.random() * 10));
  const seatNo = sold.rows[0].n + 1;
  const seat = await p.query("SELECT id FROM seats WHERE drop_id = $1 AND seat_no = $2", [drop.id, Math.min(seatNo, drop.inventory)]);
  const { rows } = await p.query(
    `INSERT INTO allocations_unsafe (drop_id, seat_id, user_id, status, confirmed_at, request_id)
     VALUES ($1, $2, $3, 'confirmed', now(), $4) RETURNING id`,
    [drop.id, seat.rows[0].id, userId, key],
  );
  inc(drop.id, "purchase_ok");
  return { status: 201, body: { allocation: { id: rows[0].id, seatNo, status: "confirmed" } }, replayed: false };
}

function allocationBody(r: { id: string; seat_no: number }) {
  return { id: r.id, seatNo: r.seat_no, status: "confirmed" };
}

export function clearSoldOut(dropId: string) {
  soldOut.delete(dropId);
}
