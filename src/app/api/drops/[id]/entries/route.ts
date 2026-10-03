import { pool } from "@/lib/db";
import { getDrop } from "@/lib/drops";
import { ApiError, clientIp, json, requireWriteHeaders, route, shedIfBusy } from "@/lib/http";
import { enter } from "@/lib/lottery";
import { enforce } from "@/lib/ratelimit";
import { requireSession } from "@/lib/session";
import { inc } from "@/lib/counters";

export const dynamic = "force-dynamic";

export const POST = route<{ params: Promise<{ id: string }> }>(
  async (req, { params }) => {
    const { id } = await params;
    const key = requireWriteHeaders(req);
    const s = await requireSession(req);
    const drop = await getDrop(pool(), id);
    if (!drop) throw new ApiError(404, "NOT_FOUND");
    inc(drop.id, "req_entry");
    const ip = clientIp(req);
    if (drop.config.rateLimit !== false) enforce(drop.id, s.userId, ip, "write");
    shedIfBusy();
    const fp = req.headers.get("x-device-fp")?.slice(0, 128) ?? null;
    const out = await enter(drop, s.userId, { ip, deviceFp: fp }, key);
    return json(out.body, out.status, out.replayed ? { "Idempotent-Replayed": "true" } : {});
  },
);
