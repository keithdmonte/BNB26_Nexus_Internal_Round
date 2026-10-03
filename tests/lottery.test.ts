import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@/lib/db";
import { getDrop } from "@/lib/drops";
import { audit, draw, enter, freeze } from "@/lib/lottery";
import { checkIntegrity } from "@/lib/integrity";
import { computeSeed, entriesHash, rankEntries, commitOf } from "@/lib/draw-core";
import { tick } from "@/lib/scheduler";
import { migrate } from "../scripts/migrate";
import { makeDrop, makeUsers, resetDb } from "./helpers";

beforeAll(async () => {
  await migrate(process.env.DATABASE_URL!, () => {});
});
beforeEach(resetDb);
afterAll(() => pool().end());

const meta = { ip: "10.0.0.1", deviceFp: null };
const fresh = async (id: string) => (await getDrop(pool(), id, true))!;
const setStatus = (id: string, s: string) => pool().query("UPDATE drops SET status = $2 WHERE id = $1", [id, s]);

async function filledDrop(inventory: number, n: number) {
  const id = await makeDrop("lottery", inventory);
  const d = await fresh(id);
  const users = await makeUsers(n);
  await Promise.all(users.map((u) => enter(d, u, meta, randomUUID())));
  return { id, users };
}

describe("entry", () => {
  it("one entry per account across 100 parallel requests with different keys", async () => {
    const d = await fresh(await makeDrop("lottery", 10));
    const [u] = await makeUsers(1);
    const res = await Promise.all(Array.from({ length: 100 }, () => enter(d, u, meta, randomUUID())));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => "alreadyEntered" in r.body)).toHaveLength(99);
  });

  it("same key replays", async () => {
    const d = await fresh(await makeDrop("lottery", 10));
    const [u] = await makeUsers(1);
    const k = randomUUID();
    const a = await enter(d, u, meta, k);
    const b = await enter(d, u, meta, k);
    expect(b.replayed).toBe(true);
    expect(JSON.stringify(b.body)).toBe(JSON.stringify(a.body));
  });

  it("rejects entries before open and after close", async () => {
    const id = await makeDrop("lottery", 10, "scheduled");
    const [u] = await makeUsers(1);
    await expect(enter(await fresh(id), u, meta, randomUUID())).rejects.toMatchObject({ code: "WINDOW_NOT_OPEN" });
    await setStatus(id, "closed");
    await expect(enter(await fresh(id), u, meta, randomUUID())).rejects.toMatchObject({ code: "WINDOW_CLOSED" });
  });

  it("stale cache says open but DB says closed: trigger rejects with WINDOW_CLOSED", async () => {
    const id = await makeDrop("lottery", 10);
    const d = await fresh(id);
    await setStatus(id, "closed");
    const [u] = await makeUsers(1);
    await expect(enter(d, u, meta, randomUUID())).rejects.toMatchObject({ code: "WINDOW_CLOSED" });
  });
});

describe("draw", () => {
  it("draws exactly inventory winners, verifiable from the audit alone", async () => {
    const { id } = await filledDrop(50, 400);
    await setStatus(id, "closed");
    expect(await freeze(id)).toBe(true);
    expect(await draw(id)).toBe(true);
    const a = (await audit(id)) as Record<string, any>;
    expect(a.winners).toHaveLength(50);
    expect(commitOf(a.secret)).toBe(a.commit);
    expect(entriesHash(a.eligiblePublicIds)).toBe(a.entriesHash);
    const seed = computeSeed(a.secret, a.entriesHash);
    expect(seed).toBe(a.seed);
    const expected = rankEntries(seed, a.eligiblePublicIds).slice(0, 50).map((r) => r.publicId);
    expect(a.winners.map((w: { publicId: string }) => w.publicId)).toEqual(expected);
    expect((await checkIntegrity(pool(), id)).ok).toBe(true);
  });

  it("draw is a no-op the second time", async () => {
    const { id } = await filledDrop(5, 20);
    await setStatus(id, "closed");
    await freeze(id);
    await draw(id);
    expect(await draw(id)).toBe(false);
    expect((await checkIntegrity(pool(), id)).activeAllocations).toBe(5);
  });

  it("crash mid-draw rolls back; re-run gives the same result as an uninterrupted draw", async () => {
    const { id } = await filledDrop(20, 200);
    await setStatus(id, "closed");
    await freeze(id);
    await expect(draw(id, { crashAfterRanks: true })).rejects.toThrow(/injected/);
    const { rows } = await pool().query("SELECT status, (SELECT count(*)::int FROM draw_ranks WHERE drop_id = $1) n FROM drops WHERE id = $1", [id]);
    expect(rows[0]).toEqual({ status: "frozen", n: 0 });
    await draw(id);
    const a = (await audit(id)) as Record<string, any>;
    const expected = rankEntries(computeSeed(a.secret, a.entriesHash), a.eligiblePublicIds).slice(0, 20).map((r) => r.publicId);
    expect(a.winners.map((w: { publicId: string }) => w.publicId)).toEqual(expected);
  });

  it("fewer entrants than seats: everyone wins, no oversell", async () => {
    const { id } = await filledDrop(50, 10);
    await setStatus(id, "closed");
    await freeze(id);
    await draw(id);
    const i = await checkIntegrity(pool(), id);
    expect(i).toMatchObject({ activeAllocations: 10, heldSeats: 10, ok: true });
  });

  it("scheduler drives open -> closed -> frozen -> drawn", async () => {
    const id = await makeDrop("lottery", 3, "scheduled");
    await pool().query("UPDATE drops SET opens_at = now() - interval '2s', closes_at = now() - interval '1s' WHERE id = $1", [id]);
    for (let i = 0; i < 4; i++) await tick();
    expect((await fresh(id)).status).toBe("drawn");
  });

  it("arrival order does not matter: early and late halves win at similar rates", async () => {
    const id = await makeDrop("lottery", 300);
    const d = await fresh(id);
    const users = await makeUsers(2000);
    for (const u of users) await enter(d, u, meta, randomUUID()); // sequential: users[0] is earliest
    await setStatus(id, "closed");
    await freeze(id);
    await draw(id);
    const { rows } = await pool().query("SELECT user_id FROM allocations WHERE drop_id = $1", [id]);
    const early = new Set(users.slice(0, 1000));
    const earlyWins = rows.filter((r) => early.has(r.user_id)).length;
    // Binomial(300, 0.5): mean 150, sd ~8.7. 5 sd bound keeps the test non-flaky.
    expect(Math.abs(earlyWins - 150)).toBeLessThan(45);
  });
});
