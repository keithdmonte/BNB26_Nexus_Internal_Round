import { createHash } from "node:crypto";
import { pool } from "@/lib/db";
import { getDrop } from "@/lib/drops";
import { ApiError, clientIp, route } from "@/lib/http";
import { myState } from "@/lib/lottery";
import { enforce } from "@/lib/ratelimit";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const s = await requireSession(req, { verified: false });
  const drop = await getDrop(pool(), id);
  if (!drop) throw new ApiError(404, "NOT_FOUND");
  if (drop.config.rateLimit !== false) enforce(drop.id, s.userId, clientIp(req), "read");
  const state = await myState(drop, s.userId);
  const body = JSON.stringify(state);
  const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return new Response(JSON.stringify({ ...state, serverTime: new Date().toISOString() }), {
    headers: { "Content-Type": "application/json", ETag: etag, "Cache-Control": "no-store" },
  });
});
