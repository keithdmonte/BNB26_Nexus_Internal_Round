import { ApiError } from "@/lib/http";

// SMS delivery and line-type lookup. Uses Twilio when TWILIO_* is set; otherwise, with DEV_LOGIN=true,
// the code is logged and returned to the caller so the demo works without a provider.

function twilio() {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
  return sid && token && from ? { sid, from, auth: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") } : null;
}

export const devSms = () => !twilio() && process.env.DEV_LOGIN === "true";

/** Returns the code when running in dev mode (no provider), otherwise null after sending. */
export async function sendCode(phone: string, code: string): Promise<string | null> {
  const t = twilio();
  if (!t) {
    if (!devSms()) throw new ApiError(503, "SMS_UNAVAILABLE", "SMS provider not configured");
    console.log(`[sms:dev] ${phone} code ${code}`);
    return code;
  }
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.sid}/Messages.json`, {
    method: "POST",
    headers: { authorization: t.auth, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: phone, From: t.from, Body: `Your Fair Drop code is ${code}. It expires in 10 minutes.` }),
  });
  if (!r.ok) throw new ApiError(502, "SMS_FAILED", "could not send code, try again");
  return null;
}

const VIRTUAL = new Set(["nonFixedVoip", "voip", "tollFree", "personal", "pager", "sharedCost", "uan", "voicemail"]);

/**
 * Rejects virtual (VoIP) numbers, which cost almost nothing in bulk. Needs Twilio Lookup; enabled with
 * PHONE_BLOCK_VIRTUAL=true. Fails open on lookup errors so a provider outage does not block real users.
 */
export async function assertRealLine(phone: string) {
  const t = twilio();
  if (!t || process.env.PHONE_BLOCK_VIRTUAL !== "true") return;
  try {
    const r = await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phone)}?Fields=line_type_intelligence`, {
      headers: { authorization: t.auth },
    });
    if (!r.ok) return;
    const j = (await r.json()) as { valid?: boolean; line_type_intelligence?: { type?: string } };
    if (j.valid === false) throw new ApiError(400, "PHONE_INVALID", "not a valid phone number");
    if (VIRTUAL.has(j.line_type_intelligence?.type ?? "")) throw new ApiError(400, "PHONE_VIRTUAL", "use a mobile number, not a virtual one");
  } catch (e) {
    if (e instanceof ApiError) throw e;
  }
}
