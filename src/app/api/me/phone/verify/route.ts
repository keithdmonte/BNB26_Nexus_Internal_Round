import { json, requireXrw, route } from "@/lib/http";
import { confirmPhone } from "@/lib/phone";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

// Step 2: confirm the code. Body { code: "123456" }. Locks the number to this account.
export const POST = route(async (req) => {
  requireXrw(req);
  const s = await requireSession(req);
  const { code } = (await req.json().catch(() => ({}))) as { code?: unknown };
  const { phone } = await confirmPhone(s.userId, code);
  return json({ phone: maskPhone(phone), phoneVerified: true });
});

function maskPhone(p: string) {
  return p.slice(0, 3) + "•".repeat(Math.max(0, p.length - 5)) + p.slice(-2);
}
