import { pool } from "@/lib/db";
import { json, requireAdmin, route } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  requireAdmin(req);
  const { rows } = await pool().query(
    `SELECT id, scenario, seed, started_at, ended_at, report FROM sim_runs WHERE report IS NOT NULL ORDER BY started_at DESC LIMIT 50`,
  );
  return json({ runs: rows });
});
