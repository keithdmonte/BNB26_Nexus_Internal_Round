import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@/lib/db";
import { getDrop } from "@/lib/drops";
import { purchase, purchaseUnsafe } from "@/lib/fcfs";
import { checkIntegrity } from "@/lib/integrity";
import { migrate } from "../scripts/migrate";
import { makeDrop, makeUsers, resetDb } from "./helpers";

beforeAll(async () => {
  await migrate(process.env.DATABASE_URL!, () => {});
});
beforeEach(resetDb);
afterAll(() => pool().end());

const settle = (ps: Promise<unknown>[]) => Promise.allSettled(ps);

describe("fcfs (safe)", () => {
  it("2,000 users racing for 500 seats: exactly 500 sold, no duplicates", async () => {
    const d = (await getDrop(pool(), await makeDrop("fcfs", 500), true))!;
    const users = await makeUsers(2000);
    const res = await settle(users.map((u) => purchase(d, u, randomUUID(), "h")));
    const ok = res.filter((r) => r.status === "fulfilled").length;
    const rejected = res.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.code);
    expect(ok).toBe(500);
    expect(new Set(rejected)).toEqual(new Set(["SOLD_OUT"]));
    const i = await checkIntegrity(pool(), d.id);
    expect(i).toMatchObject({ activeAllocations: 500, oversell: 0, duplicateUsers: 0, doubleBookedSeats: 0, ok: true });
  });

  it("one user flooding 200 parallel requests with different keys gets exactly one seat", async () => {
    const d = (await getDrop(pool(), await makeDrop("fcfs", 50), true))!;
    const [u] = await makeUsers(1);
    const res = await settle(Array.from({ length: 200 }, () => purchase(d, u, randomUUID(), "h")));
    const bodies = res.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ status: number }>).value.status);
    expect(bodies.filter((s) => s === 201)).toHaveLength(1);
    expect(bodies.filter((s) => s === 200)).toHaveLength(199);
    expect((await checkIntegrity(pool(), d.id)).activeAllocations).toBe(1);
  });

  it("same idempotency key 50x in parallel: one execution, the rest replay the same body", async () => {
    const d = (await getDrop(pool(), await makeDrop("fcfs", 5), true))!;
    const [u] = await makeUsers(1);
    const key = randomUUID();
    const res = await Promise.all(Array.from({ length: 50 }, () => purchase(d, u, key, "h")));
    expect(res.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(res.map((r) => JSON.stringify(r.body))).size).toBe(1);
  });

  it("same key with a different body is rejected", async () => {
    const d = (await getDrop(pool(), await makeDrop("fcfs", 5), true))!;
    const [u] = await makeUsers(1);
    const key = randomUUID();
    await purchase(d, u, key, "h1");
    await expect(purchase(d, u, key, "h2")).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_MISMATCH" });
  });
});

describe("fcfs_unsafe (deliberately broken)", () => {
  it("oversells under concurrency and the integrity checker reports it", async () => {
    const d = (await getDrop(pool(), await makeDrop("fcfs_unsafe", 50), true))!;
    const users = await makeUsers(1000);
    await settle(users.map((u) => purchaseUnsafe(d, u, randomUUID())));
    const i = await checkIntegrity(pool(), d.id);
    expect(i.oversell).toBeGreaterThan(0);
    expect(i.ok).toBe(false);
  });
});
