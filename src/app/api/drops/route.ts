import { pool } from "@/lib/db";
import { cached } from "@/lib/cache";
import { json, route } from "@/lib/http";

export const dynamic = "force-dynamic";

// Drops a participant can see: anything not created by the simulator.
export const GET = route(async () => {
  const rows = await cached("drops:list", 250, async () => (await pool().query(
    `SELECT d.id, d.name, d.mode, d.status, d.inventory, d.opens_at, d.closes_at,
            (SELECT count(*)::int FROM entries e WHERE e.drop_id = d.id) AS entries,
            (SELECT count(*)::int FROM allocations a WHERE a.drop_id = d.id AND a.status = 'confirmed') AS sold
     FROM drops d WHERE d.created_at > now() - interval '3 hours' AND NOT (d.config ? 'hidden') AND NOT EXISTS (SELECT 1 FROM sim_runs r WHERE r.drop_id = d.id)
     ORDER BY d.created_at DESC LIMIT 24`,
  )).rows);
  return json({ drops: rows });
});
