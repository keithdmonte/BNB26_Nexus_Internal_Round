import { pool } from "@/lib/db";
import { cached } from "@/lib/cache";
import { json, route } from "@/lib/http";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

// Drops a participant can see: anything not created by the simulator.
export const GET = route(async (req) => {
  const rows = await cached("drops:list", 250, async () => (await pool().query(
    `SELECT d.id, d.name, d.mode, d.status, d.inventory, d.opens_at, d.closes_at, d.config->>'saleOpensAt' AS sale_opens_at,
            (SELECT count(*)::int FROM entries e WHERE e.drop_id = d.id) AS entries,
            (SELECT count(*)::int FROM allocations a WHERE a.drop_id = d.id AND a.status = 'confirmed') AS sold
     FROM drops d WHERE d.created_at > now() - interval '24 hours' AND NOT (d.config ? 'hidden') AND NOT EXISTS (SELECT 1 FROM sim_runs r WHERE r.drop_id = d.id)
     ORDER BY d.created_at DESC LIMIT 24`,
  )).rows);
  // Signed-in viewers also get their own place per event, so leaving an event never hides it.
  const s = await getSession(req);
  let mine: Record<string, { queuePos: number | null; booked: boolean }> = {};
  if (s && rows.length) {
    const { rows: m } = await pool().query(
      `SELECT e.drop_id, e.queue_pos,
              EXISTS (SELECT 1 FROM orders o WHERE o.drop_id = e.drop_id AND o.user_id = e.user_id AND o.status = 'paid') AS booked
       FROM entries e WHERE e.user_id = $1 AND e.drop_id = ANY($2::uuid[])`,
      [s.userId, rows.map((r: { id: string }) => r.id)],
    );
    mine = Object.fromEntries(m.map((r) => [r.drop_id, { queuePos: r.queue_pos, booked: r.booked }]));
  }
  return json({ drops: rows.map((r: { id: string }) => ({ ...r, mine: mine[r.id] ?? null })) });
});
