import { tx } from "@/lib/db";
import { createDrop, type DropMode } from "@/lib/drops";
import { ApiError, json, requireAdmin, route } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  requireAdmin(req);
  const b = (await req.json().catch(() => ({}))) as {
    name?: string; mode?: DropMode; inventory?: number; opensInS?: number; windowS?: number; config?: Record<string, unknown>;
  };
  if (!b.mode || !["lottery", "fcfs", "fcfs_unsafe"].includes(b.mode)) throw new ApiError(400, "VALIDATION", "mode");
  const inventory = Number(b.inventory ?? 500);
  const opensAt = new Date(Date.now() + 1000 * Number(b.opensInS ?? 30));
  const closesAt = new Date(opensAt.getTime() + 1000 * Number(b.windowS ?? 120));
  const id = await tx((c) => createDrop(c, { name: b.name ?? `Drop ${b.mode}`, mode: b.mode!, inventory, opensAt, closesAt, config: b.config }));
  return json({ id, opensAt, closesAt }, 201);
});
