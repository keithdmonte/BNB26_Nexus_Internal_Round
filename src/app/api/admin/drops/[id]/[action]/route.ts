import { pool } from "@/lib/db";
import { invalidateDrop } from "@/lib/drops";
import { ApiError, json, requireAdmin, route } from "@/lib/http";
import { checkIntegrity } from "@/lib/integrity";
import { tick } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

// Demo controls. open/close move the window edge to now; the scheduler performs the transition.
export const POST = route<{ params: Promise<{ id: string; action: string }> }>(async (req, { params }) => {
  requireAdmin(req);
  const { id, action } = await params;
  if (action === "open") {
    await pool().query("UPDATE drops SET opens_at = least(opens_at, now()) WHERE id = $1 AND status = 'scheduled'", [id]);
  } else if (action === "close") {
    await pool().query("UPDATE drops SET closes_at = greatest(opens_at + interval '1 ms', least(closes_at, now())) WHERE id = $1 AND status = 'open'", [id]);
  } else if (action !== "tick") {
    throw new ApiError(404, "NOT_FOUND");
  }
  invalidateDrop(id);
  await tick();
  return json({ ok: true });
});

export const GET = route<{ params: Promise<{ id: string; action: string }> }>(async (req, { params }) => {
  requireAdmin(req);
  const { id, action } = await params;
  if (action !== "integrity") throw new ApiError(404, "NOT_FOUND");
  return json(await checkIntegrity(pool(), id));
});
