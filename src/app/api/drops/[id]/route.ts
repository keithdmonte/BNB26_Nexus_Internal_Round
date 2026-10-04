import { cached } from "@/lib/cache";
import { pool } from "@/lib/db";
import { getDrop } from "@/lib/drops";
import { ApiError, json, route } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const d = await getDrop(pool(), id);
  if (!d) throw new ApiError(404, "NOT_FOUND");
  const entrantCount = await cached(`entries:${d.id}`, 250, async () =>
    (await pool().query("SELECT count(*)::int n FROM entries WHERE drop_id = $1", [d.id])).rows[0].n as number);
  return json({
    id: d.id, name: d.name, mode: d.mode, status: d.status, inventory: d.inventory,
    opensAt: d.opensAt, closesAt: d.closesAt, commit: d.commit, seatSelect: !!d.config.seatSelect, instantQueue: !!d.config.instantQueue, saleOpensAt: d.config.saleOpensAt ?? null,
    entrantCount,
  });
});
