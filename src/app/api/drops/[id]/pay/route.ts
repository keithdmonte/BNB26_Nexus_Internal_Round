import { payOrder } from "@/lib/checkout";
import { pool } from "@/lib/db";
import { getDrop } from "@/lib/drops";
import { ApiError, clientIp, json, requireWriteHeaders, route, shedIfBusy } from "@/lib/http";
import { requestHash } from "@/lib/idempotency";
import { enforce } from "@/lib/ratelimit";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

// Body: { orderId }. Mock gateway: no card data is accepted or stored; it always approves.
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const key = requireWriteHeaders(req);
  const s = await requireSession(req);
  const drop = await getDrop(pool(), id);
  if (!drop) throw new ApiError(404, "NOT_FOUND");
  if (drop.config.rateLimit !== false) enforce(drop.id, s.userId, clientIp(req), "write");
  shedIfBusy();
  const body = await req.text();
  let orderId: unknown;
  try { orderId = JSON.parse(body)?.orderId; } catch { throw new ApiError(400, "BAD_JSON"); }
  if (typeof orderId !== "string") throw new ApiError(400, "BAD_ORDER");
  const out = await payOrder(drop, s.userId, orderId, key, requestHash("POST", `/drops/${id}/pay`, body));
  return json(out.body, out.status, out.replayed ? { "Idempotent-Replayed": "true" } : {});
});
