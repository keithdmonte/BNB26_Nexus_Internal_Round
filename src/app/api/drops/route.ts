import { pool } from "@/lib/db";
import { json, route } from "@/lib/http";

export const dynamic = "force-dynamic";

// Drops a participant can see: anything not created by the simulator.
export const GET = route(async () => {
  const { rows } = await pool().query(
    `SELECT d.id, d.name, d.mode, d.status, d.inventory, d.opens_at, d.closes_at
     FROM drops d WHERE NOT EXISTS (SELECT 1 FROM sim_runs r WHERE r.drop_id = d.id)
     ORDER BY d.created_at DESC LIMIT 10`,
  );
  return json({ drops: rows });
});
