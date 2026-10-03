import { pool } from "@/lib/db";
import { ApiError, clientIp, json, route } from "@/lib/http";
import { issueSession, sessionCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

// Stand-in for email OTP (undecided, OPEN_QUESTIONS Q5). Enabled only with DEV_LOGIN=true.
export const POST = route(async (req) => {
  if (process.env.DEV_LOGIN !== "true") throw new ApiError(404, "NOT_FOUND");
  const { email } = (await req.json().catch(() => ({}))) as { email?: string };
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email) || email.length > 200) throw new ApiError(400, "VALIDATION", "valid email required");
  const fp = req.headers.get("x-device-fp")?.slice(0, 128) ?? null;
  const { rows } = await pool().query(
    `INSERT INTO users (email, verified_at, signup_ip, device_fp) VALUES (lower($1), now(), $2, $3)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id, email`,
    [email, clientIp(req), fp],
  );
  const token = await issueSession(rows[0].id, true);
  return json({ user: { id: rows[0].id, email: rows[0].email, verified: true } }, 200, { "Set-Cookie": sessionCookie(token) });
});
