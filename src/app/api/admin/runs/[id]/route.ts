import { pool } from "@/lib/db";
import { ApiError, json, requireAdmin, route } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  await requireAdmin(req);
  const { id } = await params;
  const { rows } = await pool().query("SELECT * FROM sim_runs WHERE id = $1", [id]);
  if (!rows[0]) throw new ApiError(404, "NOT_FOUND");
  return json({ run: rows[0] });
});
