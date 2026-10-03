import { pool } from "@/lib/db";
import { createDrop, type DropMode } from "@/lib/drops";

export async function resetDb() {
  await pool().query(
    `TRUNCATE sim_labels, sim_runs, metric_snapshots, events, idempotency_keys,
              allocations_unsafe, allocations, draw_ranks, entries, seats, drops, users CASCADE`,
  );
}

export async function makeUsers(n: number): Promise<string[]> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO users (email, verified_at, is_sim)
     SELECT 't' || g || '-' || gen_random_uuid() || '@test', now(), true FROM generate_series(1, $1) g
     RETURNING id`,
    [n],
  );
  return rows.map((r) => r.id);
}

export async function makeDrop(mode: DropMode, inventory: number, status = "open"): Promise<string> {
  const c = await pool().connect();
  try {
    const id = await createDrop(c, {
      name: `test ${mode}`,
      mode,
      inventory,
      opensAt: new Date(Date.now() - 1000),
      closesAt: new Date(Date.now() + 60_000),
    });
    await c.query("UPDATE drops SET status = $2 WHERE id = $1", [id, status]);
    return id;
  } finally {
    c.release();
  }
}

export async function seatIds(dropId: string): Promise<string[]> {
  const { rows } = await pool().query<{ id: string }>(
    "SELECT id FROM seats WHERE drop_id = $1 ORDER BY seat_no",
    [dropId],
  );
  return rows.map((r) => r.id);
}

export function insertEntry(dropId: string, userId: string) {
  return pool().query(
    `INSERT INTO entries (drop_id, user_id, public_id)
     VALUES ($1, $2::uuid, encode(hmac($2::uuid::text, 'salt', 'sha256'), 'hex'))
     ON CONFLICT (drop_id, user_id) DO NOTHING`,
    [dropId, userId],
  );
}
