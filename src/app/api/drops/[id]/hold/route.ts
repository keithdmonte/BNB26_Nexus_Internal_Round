import { holdSeats, parseSeatNos } from "@/lib/checkout";
import { pool } from "@/lib/db";
import { getDrop } from "@/lib/drops";
import { ApiError, clientIp, json, requireWriteHeaders, route, shedIfBusy } from "@/lib/http";
import { requestHash } from "@/lib/idempotency";
import { enforce } from "@/lib/ratelimit";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

// Body: { seatNos: number[] } (1-6 seats). Holds them for the hold TTL; a new hold replaces the old one.
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const key = requireWriteHeaders(req);
  const s = await requireSession(req);
  const drop = await getDrop(pool(), id);
  if (!drop) throw new ApiError(404, "NOT_FOUND");
  if (drop.config.rateLimit !== false) enforce(drop.id, s.userId, clientIp(req), "write");
  shedIfBusy();
  const body = await req.text();
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new ApiError(400, "BAD_JSON"); }
  const seatNos = parseSeatNos(parsed, drop.inventory);
  const out = await holdSeats(drop, s.userId, seatNos, key, requestHash("POST", `/drops/${id}/hold`, body));
  return json(out.body, out.status, out.replayed ? { "Idempotent-Replayed": "true" } : {});
});
