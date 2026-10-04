import type pg from "pg";
import { pool, tx } from "@/lib/db";
import { invalidateDrop, type DropConfig } from "@/lib/drops";

// Post-draw queue for seat-select drops. The draw fixes the order (draw_ranks); this module only
// decides how fast that order is admitted. serving_rank = how many ranks are in (rank < serving_rank).
//
// Demo pacing: the queue drains linearly so the LAST human in it is admitted within queue_target_s
// (random 20-32s), with ticks randomly skipped so the "people ahead" count drops in uneven steps.
// Bots admitted ahead of humans buy seats, so the map a human reaches is already partly sold.
// Normal pacing: a batch of queueBatch ranks every queueStepS seconds.

export const TURN_TTL_S = 600; // how long an admitted user may take to hold seats
export const HOLD_TTL_S = 300; // how long held seats wait for payment
const DEMO_HARD_CAP_S = 34; // everyone is admitted by then, whatever the pacing says
const BOT_SHARE = 0.5; // demo: bots ahead of the last human buy up to this share of inventory

export function turnTtlS(cfg: DropConfig & { turnTtlS?: number }) {
  return cfg.turnTtlS ?? TURN_TTL_S;
}
export function holdTtlS(cfg: DropConfig & { holdTtlS?: number }) {
  return cfg.holdTtlS ?? HOLD_TTL_S;
}

/** Called inside the draw transaction once ranks are written. Moves the drop to 'claim'. */
export async function startQueue(c: pg.PoolClient, dropId: string, cfg: DropConfig) {
  let paceRank: number | null = null;
  let targetS: number | null = null;
  if (cfg.demo) {
    const { rows } = await c.query(
      `SELECT max(r.rank) AS last_human, count(*)::int AS total FROM draw_ranks r
       JOIN entries e ON e.id = r.entry_id JOIN users u ON u.id = e.user_id
       WHERE r.drop_id = $1 AND NOT u.is_sim`,
      [dropId],
    );
    const { rows: tot } = await c.query("SELECT count(*)::int n FROM draw_ranks WHERE drop_id = $1", [dropId]);
    paceRank = rows[0].last_human == null ? tot[0].n : Number(rows[0].last_human) + 1;
    targetS = 20 + Math.random() * 12;
  }
  await c.query(
    `UPDATE drops SET status = 'claim', serving_rank = 0, queue_started_at = now(), queue_target_s = $2, queue_pace_rank = $3
     WHERE id = $1`,
    [dropId, targetS, paceRank],
  );
}

/** Where serving_rank should be now. Monotonic is enforced by the caller. */
function targetServing(d: { elapsed_s: number; queue_target_s: number | null; queue_pace_rank: number | null; total: number; config: DropConfig & { queueBatch?: number; queueStepS?: number } }) {
  if (d.config.demo && d.queue_target_s && d.queue_pace_rank != null) {
    if (d.elapsed_s >= Math.min(d.queue_target_s, DEMO_HARD_CAP_S)) return d.total;
    return Math.floor((d.queue_pace_rank * d.elapsed_s) / d.queue_target_s);
  }
  const batch = d.config.queueBatch ?? 50;
  const step = d.config.queueStepS ?? 10;
  return Math.min(d.total, (Math.floor(d.elapsed_s / step) + 1) * batch);
}

/** Admitted users per second right now, for the ETA shown to people still waiting. */
export function queueRate(d: { queue_target_s: number | null; queue_pace_rank: number | null; config: DropConfig & { queueBatch?: number; queueStepS?: number } }) {
  if (d.config.demo && d.queue_target_s && d.queue_pace_rank != null) return d.queue_pace_rank / d.queue_target_s;
  return (d.config.queueBatch ?? 50) / (d.config.queueStepS ?? 10);
}

/** Demo only: bots just admitted buy single seats, biased towards the front. */
async function botsBuy(c: pg.PoolClient, dropId: string, from: number, to: number, paceRank: number, inventory: number) {
  const { rows: sold } = await c.query(
    "SELECT count(*)::int n FROM allocations WHERE drop_id = $1 AND order_id IS NULL AND status = 'confirmed'",
    [dropId],
  );
  const quota = Math.floor(BOT_SHARE * inventory * Math.min(1, to / Math.max(1, paceRank))) - sold[0].n;
  if (quota <= 0) return;
  const { rows: bots } = await c.query(
    `SELECT e.id AS entry_id, e.user_id, r.rank FROM draw_ranks r
     JOIN entries e ON e.id = r.entry_id JOIN users u ON u.id = e.user_id
     WHERE r.drop_id = $1 AND r.rank >= $2 AND r.rank < $3 AND u.is_sim ORDER BY r.rank LIMIT $4`,
    [dropId, from, to, quota],
  );
  if (!bots.length) return;
  const { rows: seats } = await c.query(
    `UPDATE seats SET held = true WHERE id IN (
       SELECT id FROM seats WHERE drop_id = $1 AND NOT held
       ORDER BY random() * (seat_no + $3) LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING id`,
    [dropId, bots.length, Math.ceil(inventory * 0.25)],
  );
  const n = seats.length;
  if (!n) return;
  await c.query(
    `INSERT INTO allocations (drop_id, seat_id, user_id, entry_id, rank, status, confirmed_at)
     SELECT $1, x.seat_id, x.user_id, x.entry_id, x.rank, 'confirmed', now()
     FROM unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::int[]) AS x(seat_id, user_id, entry_id, rank)`,
    [dropId, seats.map((s) => s.id), bots.slice(0, n).map((b) => b.user_id), bots.slice(0, n).map((b) => b.entry_id), bots.slice(0, n).map((b) => b.rank)],
  );
}

/** Seats whose hold ran out go back on the map. */
export async function expireHolds(c: pg.PoolClient | pg.Pool, dropId: string) {
  await c.query(
    `WITH o AS (UPDATE orders SET status = 'expired' WHERE drop_id = $1 AND status = 'held' AND expires_at <= now() RETURNING id),
          a AS (UPDATE allocations SET status = 'expired' WHERE order_id IN (SELECT id FROM o) AND status = 'offered' RETURNING seat_id)
     UPDATE seats SET held = false WHERE id IN (SELECT seat_id FROM a)`,
    [dropId],
  );
}

/** One scheduler step for a drop in 'claim'. Idempotent; advisory-locked like every other step. */
export async function advanceQueue(dropId: string) {
  const changed = await tx(async (c) => {
    const l = await c.query("SELECT pg_try_advisory_xact_lock(hashtext('drop:' || $1)) AS ok", [dropId]);
    if (!l.rows[0].ok) return false;
    const { rows } = await c.query(
      `SELECT status, inventory, config, serving_rank, queue_target_s, queue_pace_rank,
              extract(epoch FROM now() - queue_started_at)::float AS elapsed_s,
              (SELECT count(*)::int FROM draw_ranks WHERE drop_id = d.id) AS total
       FROM drops d WHERE id = $1 FOR UPDATE`,
      [dropId],
    );
    const d = rows[0];
    if (!d || d.status !== "claim") return false;
    await expireHolds(c, dropId);

    // Random skipped ticks make the countdown move in uneven jumps instead of a smooth slide.
    const target = Math.min(d.total, targetServing(d));
    const skip = d.config.demo && target < d.total && Math.random() < 0.4;
    if (target > d.serving_rank && !skip) {
      await c.query("UPDATE draw_ranks SET admitted_at = now() WHERE drop_id = $1 AND rank >= $2 AND rank < $3", [dropId, d.serving_rank, target]);
      if (d.config.demo) await botsBuy(c, dropId, d.serving_rank, target, d.queue_pace_rank ?? d.total, d.inventory);
      await c.query("UPDATE drops SET serving_rank = $2 WHERE id = $1", [dropId, target]);
    }

    // Done once nothing more can sell: sold out with no open holds, or everyone admitted and every turn and hold has lapsed.
    const { rows: s } = await c.query(
      `SELECT (SELECT count(*)::int FROM seats WHERE drop_id = $1 AND NOT held) AS free,
              (SELECT count(*)::int FROM orders WHERE drop_id = $1 AND status = 'held') AS holds,
              (SELECT max(admitted_at) FROM draw_ranks WHERE drop_id = $1) AS last_admit`,
      [dropId],
    );
    const allIn = Math.max(target, d.serving_rank) >= d.total;
    const turnsOver = s[0].last_admit && Date.now() - new Date(s[0].last_admit).getTime() > turnTtlS(d.config) * 1000;
    if (s[0].holds === 0 && (s[0].free === 0 || (allIn && (turnsOver || d.total === 0)))) {
      await c.query("UPDATE drops SET status = 'done' WHERE id = $1", [dropId]);
      return true;
    }
    return false;
  });
  if (changed) invalidateDrop(dropId);
}

/** Demo only: while the window is open, bot entrants trickle in so the entrant count climbs live. */
export async function fillBots(dropId: string) {
  const { rows } = await pool().query(
    `SELECT config, extract(epoch FROM now() - opens_at)::float AS elapsed_s, extract(epoch FROM closes_at - opens_at)::float AS window_s,
            (SELECT count(*)::int FROM entries e JOIN users u ON u.id = e.user_id WHERE e.drop_id = d.id AND u.is_sim) AS have
     FROM drops d WHERE id = $1 AND status = 'open'`,
    [dropId],
  );
  const d = rows[0];
  const bots = Number(d?.config?.bots ?? 0);
  if (!d || !d.config.demo || !bots) return;
  // All bots are in by 70% of the window (instant-queue drops have long windows: ramp over the first minute).
  const rampS = d.config.instantQueue ? 60 : d.window_s * 0.7;
  const want = Math.min(bots, Math.ceil((bots * d.elapsed_s) / Math.max(1, rampS)));
  if (want <= d.have) return;
  await pool().query(
    `WITH nu AS (
       INSERT INTO users (email, verified_at, is_sim, created_at)
       SELECT 'bot-' || $4 || '-' || g || '@bots.fairdrop.local', now(), true, now() - interval '30 days'
       FROM generate_series($2::int + 1, $3::int) g
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id)
     INSERT INTO entries (drop_id, user_id, public_id, challenge_ok)
     SELECT $1, nu.id, encode(hmac(convert_to(nu.id::text, 'UTF8'), d.public_salt, 'sha256'), 'hex'), true
     FROM nu, drops d WHERE d.id = $1
     ON CONFLICT DO NOTHING`,
    [dropId, d.have, want, dropId.slice(0, 8)],
  );
  if (d.config.instantQueue && saleStartsInS(d.config) > 0) {
    // Pre-sale: bots take the next first-come-first-served numbers, so a human joining later is behind them.
    await tx(async (c) => {
      const { rows: need } = await c.query(
        `SELECT e.id FROM entries e JOIN users u ON u.id = e.user_id
         WHERE e.drop_id = $1 AND u.is_sim AND e.queue_pos IS NULL ORDER BY e.created_at, e.id`,
        [dropId],
      );
      if (!need.length) return;
      const { rows: s } = await c.query("UPDATE drops SET queue_seq = queue_seq + $2 WHERE id = $1 RETURNING queue_seq", [dropId, need.length]);
      const first = s[0].queue_seq - need.length + 1;
      await c.query(
        "UPDATE entries e SET queue_pos = $2 + x.n - 1 FROM unnest($1::uuid[]) WITH ORDINALITY AS x(id, n) WHERE e.id = x.id",
        [need.map((r) => r.id), first],
      );
    });
  }
}

// ---------- instant demo queue (config.instantQueue) ----------
// Each entrant gets a random queue number at entry and is admitted queueWaitS seconds later.
// The "people ahead" count falls in uneven, per-entry deterministic steps, so every poll agrees.

export const INSTANT_WAIT_S = 10;

/** Seconds until the sale starts (0 once it has). Before that the queue is open but nobody is admitted. */
export function saleStartsInS(cfg: DropConfig, now = Date.now()) {
  return cfg.saleOpensAt ? Math.max(0, (new Date(cfg.saleOpensAt).getTime() - now) / 1000) : 0;
}

/**
 * Queue number plus seconds until admission (the pre-sale wait, if any, then the queue countdown).
 * Before the sale numbers are first-come-first-served from the drop's counter (locks the drop row, so
 * call inside the transaction that inserts the entry); once the sale is live a joiner gets a random number.
 */
export async function instantQueueSlot(c: pg.ClientBase, dropId: string, cfg: DropConfig) {
  const waitS = saleStartsInS(cfg) + (cfg.queueWaitS ?? INSTANT_WAIT_S);
  if (saleStartsInS(cfg) > 0) {
    const { rows } = await c.query("UPDATE drops SET queue_seq = queue_seq + 1 WHERE id = $1 RETURNING queue_seq", [dropId]);
    return { pos: rows[0].queue_seq as number, waitS };
  }
  return { pos: 120 + Math.floor(Math.random() * 480), waitS };
}

function stepWeight(seed: string, i: number) {
  let h = 2166136261;
  for (const ch of `${seed}:${i}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return 0.2 + ((h >>> 0) % 1000) / 600; // 0.2 .. ~1.87
}

/** People still ahead of this entry right now. Reaches 0 exactly at admitAt. */
export function instantAhead(entryId: string, pos: number, admitAt: Date, waitS: number, now = Date.now()) {
  const left = admitAt.getTime() - now;
  if (left <= 0) return 0;
  const steps = Math.max(1, Math.round(waitS * 2)); // one step per 0.5s
  const done = Math.max(0, Math.min(steps, Math.floor(((waitS * 1000 - left) / 1000) * 2)));
  let total = 0, cum = 0;
  for (let i = 0; i < steps; i++) {
    const w = stepWeight(entryId, i);
    total += w;
    if (i < done) cum += w;
  }
  return pos <= 1 ? 0 : Math.max(1, Math.round((pos - 1) * (1 - cum / total)));
}

/** Demo: while an instant-queue drop is open, bots keep buying so the map is never empty: 30% at open, up to 60% by close. */
export async function instantBotSales(dropId: string) {
  const { rows } = await pool().query(
    `SELECT inventory, extract(epoch FROM now() - opens_at)::float AS elapsed_s, extract(epoch FROM closes_at - opens_at)::float AS window_s,
            (SELECT count(*)::int FROM allocations WHERE drop_id = d.id AND order_id IS NULL AND status = 'confirmed') AS sold
     FROM drops d WHERE id = $1 AND status = 'open'`,
    [dropId],
  );
  const d = rows[0];
  if (!d) return;
  // Nothing sells before the sale starts.
  const cfg = (await pool().query("SELECT config FROM drops WHERE id = $1", [dropId])).rows[0].config as DropConfig;
  if (saleStartsInS(cfg) > 0) return;
  const frac = 0.3 + 0.3 * Math.min(1, d.elapsed_s / Math.max(1, d.window_s));
  // Small batches so the map visibly fills while someone is looking at it.
  const n = Math.min(Math.floor(frac * d.inventory) - d.sold, 3);
  if (n <= 0) return;
  await tx(async (c) => {
    const { rows: seats } = await c.query(
      `UPDATE seats SET held = true WHERE id IN (
         SELECT id FROM seats WHERE drop_id = $1 AND NOT held
         ORDER BY random() * (seat_no + $3) LIMIT $2 FOR UPDATE SKIP LOCKED)
       RETURNING id`,
      [dropId, n, Math.ceil(d.inventory * 0.25)],
    );
    if (!seats.length) return;
    await c.query(
      `WITH u AS (
         INSERT INTO users (email, verified_at, is_sim, created_at)
         SELECT 'bot-' || $3 || '-s' || gen_random_uuid() || '@bots.fairdrop.local', now(), true, now() - interval '30 days'
         FROM unnest($2::uuid[]) RETURNING id),
       pairs AS (SELECT u.id AS user_id, s.seat_id FROM
         (SELECT id, row_number() OVER () n FROM u) u JOIN
         (SELECT seat_id, row_number() OVER () n FROM unnest($2::uuid[]) seat_id) s USING (n))
       INSERT INTO allocations (drop_id, seat_id, user_id, status, confirmed_at)
       SELECT $1, seat_id, user_id, 'confirmed', now() FROM pairs`,
      [dropId, seats.map((s) => s.id), dropId.slice(0, 8)],
    );
  });
}
