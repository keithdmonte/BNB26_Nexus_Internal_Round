import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { pool, tx } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { take } from "@/lib/ratelimit";
import { assertRealLine, sendCode } from "@/lib/sms";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;

// Sends cost money and invite SMS-pumping fraud, so they are limited per user, per number and per IP.
const SEND_LIMITS = {
  user: { rate: 1 / 60, burst: 3 },
  phone: { rate: 1 / 60, burst: 3 },
  ip: { rate: 10 / 3600, burst: 10 },
} as const;

/** E.164 only: "+" then 8-15 digits. Spaces, dashes, dots and parentheses are stripped. */
export function normalizePhone(raw: unknown): string {
  const p = typeof raw === "string" ? raw.replace(/[\s\-().]/g, "") : "";
  if (!/^\+[1-9]\d{7,14}$/.test(p)) throw new ApiError(400, "PHONE_INVALID", "use international format, e.g. +14155550123");
  return p;
}

function hashCode(userId: string, phone: string, code: string): string {
  const k = process.env.SESSION_SECRET;
  if (!k) throw new Error("SESSION_SECRET missing");
  return createHmac("sha256", k).update(`${userId}|${phone}|${code}`).digest("hex");
}

function limit(key: string, l: { rate: number; burst: number }) {
  const wait = take(key, l.rate, l.burst);
  if (wait > 0) throw new ApiError(429, "RATE_LIMITED", "too many codes requested, wait and retry", wait);
}

/** Sends a 6-digit code. Returns the code only in dev mode (no SMS provider configured). */
export async function startPhoneVerification(userId: string, rawPhone: unknown, ip: string): Promise<{ devCode: string | null }> {
  const phone = normalizePhone(rawPhone);
  const { rows } = await pool().query(
    `SELECT (SELECT phone_verified_at FROM users WHERE id = $1) AS mine,
            EXISTS (SELECT 1 FROM users WHERE phone = $2 AND id <> $1) AS taken`,
    [userId, phone],
  );
  if (rows[0].mine) throw new ApiError(409, "PHONE_ALREADY_VERIFIED", "this account already has a verified number");
  if (rows[0].taken) throw new ApiError(409, "PHONE_IN_USE", "this number is linked to another account");
  limit(`sms:user:${userId}`, SEND_LIMITS.user);
  limit(`sms:phone:${phone}`, SEND_LIMITS.phone);
  limit(`sms:ip:${ip}`, SEND_LIMITS.ip);
  await assertRealLine(phone);

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await pool().query(
    `INSERT INTO phone_otps (user_id, phone, code_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))
     ON CONFLICT (user_id) DO UPDATE SET phone = EXCLUDED.phone, code_hash = EXCLUDED.code_hash, attempts = 0,
       expires_at = EXCLUDED.expires_at, created_at = now()`,
    [userId, phone, hashCode(userId, phone, code), CODE_TTL_MS / 1000],
  );
  return { devCode: await sendCode(phone, code) };
}

/** Checks the code and locks the number to the account. The users_phone unique index settles races. */
export async function confirmPhone(userId: string, rawCode: unknown): Promise<{ phone: string }> {
  const code = typeof rawCode === "string" ? rawCode.trim() : "";
  if (!/^\d{6}$/.test(code)) throw new ApiError(400, "CODE_INVALID", "enter the 6-digit code");
  return tx(async (c) => {
    // Counting the attempt before comparing means parallel guesses cannot exceed MAX_ATTEMPTS.
    const { rows } = await c.query(
      `UPDATE phone_otps SET attempts = attempts + 1
       WHERE user_id = $1 AND attempts < $2 AND expires_at > now() RETURNING phone, code_hash`,
      [userId, MAX_ATTEMPTS],
    );
    if (!rows[0]) throw new ApiError(410, "CODE_EXPIRED", "code expired or too many attempts, request a new one");
    const want = Buffer.from(rows[0].code_hash, "hex");
    const got = Buffer.from(hashCode(userId, rows[0].phone, code), "hex");
    if (!timingSafeEqual(want, got)) {
      // Commit the attempt counter, then report the wrong code.
      return { wrong: true as const };
    }
    try {
      const u = await c.query(
        "UPDATE users SET phone = $2, phone_verified_at = now() WHERE id = $1 AND phone_verified_at IS NULL RETURNING id",
        [userId, rows[0].phone],
      );
      if (!u.rows[0]) throw new ApiError(409, "PHONE_ALREADY_VERIFIED", "this account already has a verified number");
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ApiError(409, "PHONE_IN_USE", "this number is linked to another account");
      throw e;
    }
    await c.query("DELETE FROM phone_otps WHERE user_id = $1", [userId]);
    return { phone: rows[0].phone as string };
  }).then((r) => {
    if ("wrong" in r) throw new ApiError(400, "CODE_WRONG", "wrong code");
    return r;
  });
}
