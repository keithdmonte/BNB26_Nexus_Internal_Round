import { clientIp, json, requireXrw, route } from "@/lib/http";
import { startPhoneVerification } from "@/lib/phone";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

// Step 1: send a code. Body { phone: "+14155550123" }. `devCode` is present only without an SMS provider.
export const POST = route(async (req) => {
  requireXrw(req);
  const s = await requireSession(req);
  const { phone } = (await req.json().catch(() => ({}))) as { phone?: unknown };
  const { devCode } = await startPhoneVerification(s.userId, phone, clientIp(req));
  return json({ sent: true, ...(devCode ? { devCode } : {}) }, 202);
});
