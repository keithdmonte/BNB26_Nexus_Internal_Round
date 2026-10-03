import { pool } from "@/lib/db";
import { getDrop } from "@/lib/drops";
import { purchase, purchaseUnsafe } from "@/lib/fcfs";
import { ApiError, clientIp, json, requireWriteHeaders, route, shedIfBusy } from "@/lib/http";
import { requestHash } from "@/lib/idempotency";
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
    inc(drop.id, "req_purchase");
    if (drop.config.rateLimit !== false) enforce(drop.id, s.userId, clientIp(req), "write");
    shedIfBusy();
    const body = await req.text();
    const out =
      drop.mode === "fcfs_unsafe"
        ? await purchaseUnsafe(drop, s.userId, key)
        : await purchase(drop, s.userId, key, requestHash("POST", `/drops/${id}/purchase`, body));
    return json(out.body, out.status, out.replayed ? { "Idempotent-Replayed": "true" } : {});
  },
);
