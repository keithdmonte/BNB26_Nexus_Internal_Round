import { pool } from "@/lib/db";
import { ApiError, json, requireSim, route } from "@/lib/http";
import { fairnessReport } from "@/lib/report";

export const dynamic = "force-dynamic";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  requireSim(req);
  const { id } = await params;
  const { client } = (await req.json()) as { client: Record<string, unknown> };
  const server = await fairnessReport(id);
  if (!server) throw new ApiError(404, "NOT_FOUND");
  const report = { ...server, client };
  await pool().query("UPDATE sim_runs SET report = $2, ended_at = now() WHERE id = $1", [id, report]);
  return json({ report });
});
