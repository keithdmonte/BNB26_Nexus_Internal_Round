import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@/lib/db";
import { getDrop } from "@/lib/drops";
import { enter } from "@/lib/lottery";
import { confirmPhone, normalizePhone, startPhoneVerification } from "@/lib/phone";
import { resetBuckets } from "@/lib/ratelimit";
import { migrate } from "../scripts/migrate";
import { makeDrop, makeUsers, resetDb } from "./helpers";

beforeAll(async () => {
  process.env.DEV_LOGIN = "true"; // dev SMS: code is returned instead of sent
  await migrate(process.env.DATABASE_URL!, () => {});
});
beforeEach(async () => {
  await resetDb();
  resetBuckets();
});
afterAll(() => pool().end());

const ip = "10.0.0.1";
const meta = { ip, deviceFp: null };

async function verify(userId: string, phone: string) {
  const { devCode } = await startPhoneVerification(userId, phone, ip);
  return confirmPhone(userId, devCode!);
}

async function phoneDrop() {
  const id = await makeDrop("lottery", 10);
  await pool().query(`UPDATE drops SET config = config || '{"requirePhone": true}' WHERE id = $1`, [id]);
  return (await getDrop(pool(), id, true))!;
}

describe("phone verification", () => {
  it("normalizes to E.164 and rejects junk", () => {
    expect(normalizePhone("+1 (415) 555-0123")).toBe("+14155550123");
    expect(() => normalizePhone("4155550123")).toThrow();
    expect(() => normalizePhone("+0123456789")).toThrow();
  });

  it("verifies with the right code and locks the number", async () => {
    const [u] = await makeUsers(1);
    expect(await verify(u, "+14155550123")).toEqual({ phone: "+14155550123" });
    const { rows } = await pool().query("SELECT phone, phone_verified_at FROM users WHERE id = $1", [u]);
    expect(rows[0].phone).toBe("+14155550123");
    expect(rows[0].phone_verified_at).not.toBeNull();
    await expect(startPhoneVerification(u, "+14155550999", ip)).rejects.toMatchObject({ code: "PHONE_ALREADY_VERIFIED" });
  });

  it("one account per number", async () => {
    const [a, b] = await makeUsers(2);
    await verify(a, "+14155550123");
    await expect(startPhoneVerification(b, "+14155550123", ip)).rejects.toMatchObject({ code: "PHONE_IN_USE" });
  });

  it("two accounts racing for one number: only one wins", async () => {
    const [a, b] = await makeUsers(2);
    const ca = (await startPhoneVerification(a, "+14155550123", ip)).devCode!;
    const cb = (await startPhoneVerification(b, "+14155550123", ip)).devCode!;
    const res = await Promise.allSettled([confirmPhone(a, ca), confirmPhone(b, cb)]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(res.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "PHONE_IN_USE" } });
  });

  it("wrong codes burn attempts; after 5 the code is dead even if correct", async () => {
    const [u] = await makeUsers(1);
    const { devCode } = await startPhoneVerification(u, "+14155550123", ip);
    const wrong = devCode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await expect(confirmPhone(u, wrong)).rejects.toMatchObject({ code: "CODE_WRONG" });
    await expect(confirmPhone(u, devCode!)).rejects.toMatchObject({ code: "CODE_EXPIRED" });
  });

  it("parallel guesses cannot exceed the attempt cap", async () => {
    const [u] = await makeUsers(1);
    const { devCode } = await startPhoneVerification(u, "+14155550123", ip);
    const guesses = Array.from({ length: 50 }, (_, i) => String(i).padStart(6, "0")).filter((g) => g !== devCode);
    await Promise.allSettled(guesses.map((g) => confirmPhone(u, g)));
    const { rows } = await pool().query("SELECT attempts FROM phone_otps WHERE user_id = $1", [u]);
    expect(rows[0].attempts).toBe(5);
  });

  it("expired code is rejected", async () => {
    const [u] = await makeUsers(1);
    const { devCode } = await startPhoneVerification(u, "+14155550123", ip);
    await pool().query("UPDATE phone_otps SET expires_at = now() - interval '1 second' WHERE user_id = $1", [u]);
    await expect(confirmPhone(u, devCode!)).rejects.toMatchObject({ code: "CODE_EXPIRED" });
  });

  it("rate-limits code sends per user", async () => {
    const [u] = await makeUsers(1);
    for (let i = 0; i < 3; i++) await startPhoneVerification(u, "+14155550123", ip);
    await expect(startPhoneVerification(u, "+14155550123", ip)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("entry with requirePhone", () => {
  it("rejects unverified accounts, accepts verified ones", async () => {
    const d = await phoneDrop();
    const [a, b] = await makeUsers(2);
    await verify(a, "+14155550123");
    expect((await enter(d, a, meta, randomUUID())).status).toBe(201);
    await expect(enter(d, b, meta, randomUUID())).rejects.toMatchObject({ code: "PHONE_REQUIRED" });
  });

  it("verified account retrying still gets one entry", async () => {
    const d = await phoneDrop();
    const [u] = await makeUsers(1);
    await verify(u, "+14155550123");
    const res = await Promise.all(Array.from({ length: 20 }, () => enter(d, u, meta, randomUUID())));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
  });

  it("drops without requirePhone are unaffected", async () => {
    const d = (await getDrop(pool(), await makeDrop("lottery", 10), true))!;
    const [u] = await makeUsers(1);
    expect((await enter(d, u, meta, randomUUID())).status).toBe(201);
  });
});
