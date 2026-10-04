import { pool } from "@/lib/db";
import { ApiError, clientIp, inetOrNull, json, route } from "@/lib/http";
import { getSession, issueSession, sessionCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

// DEMO ONLY: stand-in for email OTP (undecided, OPEN_QUESTIONS Q5). Enabled only with DEV_LOGIN=true.
// Creates a new account for an unused email. An existing email can only be "signed into" again by the
// session that already owns it, so this endpoint cannot be used to take over someone else's account.
export const POST = route(async (req) => {
  if (process.env.DEV_LOGIN !== "true") throw new ApiError(404, "NOT_FOUND");
  const { email } = (await req.json().catch(() => ({}))) as { email?: string };
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email) || email.length > 200) throw new ApiError(400, "VALIDATION", "valid email required");
  const fp = req.headers.get("x-device-fp")?.slice(0, 128) ?? null;
  const ins = await pool().query(
    `INSERT INTO users (email, verified_at, signup_ip, device_fp) VALUES (lower($1), now(), $2, $3)
     ON CONFLICT (email) DO NOTHING RETURNING id, email`,
    [email, inetOrNull(clientIp(req)), fp],
  );
  let user = ins.rows[0];
  if (!user) {
    const existing = (await pool().query("SELECT id, email FROM users WHERE email = lower($1)", [email])).rows[0];
    const s = await getSession(req);
    if (!s || s.userId !== existing.id) throw new ApiError(409, "EMAIL_TAKEN", "that email already has an account (demo login cannot sign into it)");
    user = existing;
  }
  const token = await issueSession(user.id, true);
  return json({ user: { id: user.id, email: user.email, verified: true }, demoOnly: true }, 200, { "Set-Cookie": sessionCookie(token) });
});
