import { pool } from "@/lib/db";
import { getDrop } from "@/lib/drops";
import { ApiError, json, route } from "@/lib/http";
import { snapshot } from "@/lib/counters";

export const dynamic = "force-dynamic";

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const d = await getDrop(pool(), id);
  if (!d) throw new ApiError(404, "NOT_FOUND");
  return json({
    id: d.id, name: d.name, mode: d.mode, status: d.status, inventory: d.inventory,
    opensAt: d.opensAt, closesAt: d.closesAt, commit: d.commit,
    entrantCount: snapshot(d.id).entries ?? 0,
  });
});
