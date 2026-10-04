import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@/lib/db";
import { getDrop } from "@/lib/drops";
import { audit, draw, enter, freeze } from "@/lib/lottery";
import { computeSeed } from "@/lib/draw-core";
import { roundAt, roundTime, setBeaconFetcher, verifyBeacon, type Beacon } from "@/lib/beacon";
import { verifyAudit, type AuditJson } from "@/lib/verify-core";
import { migrate } from "../scripts/migrate";
import { makeDrop, makeUsers, resetDb } from "./helpers";

// A real drand quicknet round, recorded from https://api.drand.sh (public, signed by the League of Entropy).
const ROUND: Beacon = {
  round: 32761748,
  randomness: "84654b1bafd4b870f8fe9b519368da2fb63ca93b7c2c6a81b12fb84d7e2165ea",
  signature: "a4986f64bf60f046864f1dbe084bb0ae234a1852b6bab650c350c0fbc9a11511eb369d8c78c75eb32f7cf51d3a2ea3f0",
};
const flipLastHex = (h: string) => h.slice(0, -1) + (h.endsWith("0") ? "1" : "0");

beforeAll(async () => {
  await migrate(process.env.DATABASE_URL!, () => {});
});
beforeEach(async () => {
  await resetDb();
  process.env.BEACON = "drand";
});
afterEach(() => {
  process.env.BEACON = "off";
  setBeaconFetcher(null);
});
afterAll(() => pool().end());

async function frozenDrop(inventory: number, n: number) {
  const id = await makeDrop("lottery", inventory);
  const d = (await getDrop(pool(), id, true))!;
  for (const u of await makeUsers(n)) await enter(d, u, { ip: "10.0.0.1", deviceFp: null }, randomUUID());
  await pool().query("UPDATE drops SET status = 'closed' WHERE id = $1", [id]);
  await freeze(id);
  return id;
}

describe("drand beacon verification", () => {
  it("accepts a genuine quicknet round", () => {
    expect(verifyBeacon(ROUND)).toEqual({ ok: true });
  });
  it("rejects tampered randomness and tampered signatures", () => {
    expect(verifyBeacon({ ...ROUND, randomness: flipLastHex(ROUND.randomness) }).ok).toBe(false);
    expect(verifyBeacon({ ...ROUND, signature: flipLastHex(ROUND.signature) }).ok).toBe(false);
    expect(verifyBeacon({ ...ROUND, round: ROUND.round + 1 }).ok).toBe(false);
  });
  it("round numbering matches the quicknet schedule", () => {
    expect(roundAt(roundTime(ROUND.round))).toBe(ROUND.round);
    expect(roundTime(ROUND.round + 1) - roundTime(ROUND.round)).toBe(3000);
  });
  it("seed is a deterministic function of (secret, entries hash, beacon): fixed test vector", () => {
    expect(computeSeed("11".repeat(32), "ab".repeat(32), ROUND.randomness)).toBe(
      "cdf0e558e0572ff7cc10d067dcdbfd4c19c8514469ae80c7bd8771a4b39c63a3",
    );
  });
});

describe("draw with drand", () => {
  it("freeze commits to a future round; draw waits until it is published", async () => {
    const id = await frozenDrop(3, 10);
    const { rows } = await pool().query("SELECT beacon_round, beacon_status, frozen_at FROM drops WHERE id = $1", [id]);
    expect(rows[0].beacon_status).toBe("pending");
    expect(roundTime(Number(rows[0].beacon_round))).toBeGreaterThan(new Date(rows[0].frozen_at).getTime());
    const fetcher = vi.fn(async () => ROUND);
    setBeaconFetcher(fetcher);
    expect(await draw(id)).toBe(false); // round is in the future: no fetch, no draw
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the verified round in the seed, and the audit verifies independently", async () => {
    const id = await frozenDrop(5, 40);
    await pool().query("UPDATE drops SET beacon_round = $2 WHERE id = $1", [id, ROUND.round]);
    setBeaconFetcher(async () => ROUND);
    expect(await draw(id)).toBe(true);
    const a = (await audit(id)) as unknown as AuditJson;
    expect(a.beacon).toMatchObject({ source: "drand-quicknet", status: "drand", round: ROUND.round, value: ROUND.randomness });
    expect(a.seed).toBe(computeSeed(a.secret!, a.entriesHash!, ROUND.randomness));
    const { checks, notice } = await verifyAudit(a, async () => ROUND);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(notice).toBeNull();
  });

  it("crash mid-draw then re-run fetches the same round and produces the identical result", async () => {
    const id = await frozenDrop(5, 60);
    await pool().query("UPDATE drops SET beacon_round = $2 WHERE id = $1", [id, ROUND.round]);
    setBeaconFetcher(async () => ROUND);
    await expect(draw(id, { crashAfterRanks: true })).rejects.toThrow(/injected/);
    await draw(id);
    const a = (await audit(id)) as unknown as AuditJson;
    const { checks } = await verifyAudit(a, async () => ROUND);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("refuses a beacon that fails verification (waits, then falls back; never uses it)", async () => {
    const id = await frozenDrop(3, 10);
    await pool().query("UPDATE drops SET beacon_round = $2 WHERE id = $1", [id, ROUND.round]);
    setBeaconFetcher(async () => ({ ...ROUND, randomness: flipLastHex(ROUND.randomness) }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await draw(id, { beaconTimeoutMs: 60_000 })).toBe(false);
    await pool().query("UPDATE drops SET beacon_first_try_at = now() - interval '2 minutes' WHERE id = $1", [id]);
    expect(await draw(id, { beaconTimeoutMs: 60_000 })).toBe(true);
    const { rows } = await pool().query("SELECT beacon_status, beacon_value FROM drops WHERE id = $1", [id]);
    expect(rows[0]).toEqual({ beacon_status: "fallback", beacon_value: "" });
    warn.mockRestore();
  });

  it("fallback: drand unreachable -> waits within the window, then records 'fallback' explicitly", async () => {
    const id = await frozenDrop(3, 10);
    await pool().query("UPDATE drops SET beacon_round = $2 WHERE id = $1", [id, ROUND.round]);
    setBeaconFetcher(async () => {
      throw new Error("network down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await draw(id, { beaconTimeoutMs: 60_000 })).toBe(false);
    let { rows } = await pool().query("SELECT status, beacon_first_try_at FROM drops WHERE id = $1", [id]);
    expect(rows[0].status).toBe("frozen");
    expect(rows[0].beacon_first_try_at).not.toBeNull();
    await pool().query("UPDATE drops SET beacon_first_try_at = now() - interval '2 minutes' WHERE id = $1", [id]);
    expect(await draw(id, { beaconTimeoutMs: 60_000 })).toBe(true);
    ({ rows } = await pool().query("SELECT status, beacon_status, beacon_value FROM drops WHERE id = $1", [id]));
    expect(rows[0]).toEqual({ status: "drawn", beacon_status: "fallback", beacon_value: "" });
    const a = (await audit(id)) as unknown as AuditJson;
    expect(a.beacon).toMatchObject({ source: "none", status: "fallback" });
    const { checks, notice } = await verifyAudit(a, async () => ROUND);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(notice).toMatch(/^beacon: none \(fallback\)/);
    warn.mockRestore();
  });
});

describe("verify script logic catches tampering", () => {
  it("fails when the published beacon value is altered", async () => {
    const id = await frozenDrop(5, 40);
    await pool().query("UPDATE drops SET beacon_round = $2 WHERE id = $1", [id, ROUND.round]);
    setBeaconFetcher(async () => ROUND);
    await draw(id);
    const a = (await audit(id)) as unknown as AuditJson;
    const tampered = { ...a, beacon: { ...a.beacon!, value: flipLastHex(a.beacon!.value) } };
    const { checks } = await verifyAudit(tampered, async () => ROUND);
    const failed = checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toContain("drand beacon signature valid (BLS, quicknet key)");
    expect(failed).toContain("drand round matches independent fetch");
    expect(failed).toContain("seed = SHA256(secret || entriesHash || beacon)");
  });

  it("fails when the server claims a drand round that drand itself disagrees with", async () => {
    const id = await frozenDrop(5, 40);
    await pool().query("UPDATE drops SET beacon_round = $2 WHERE id = $1", [id, ROUND.round]);
    setBeaconFetcher(async () => ROUND);
    await draw(id);
    const a = (await audit(id)) as unknown as AuditJson;
    const { checks } = await verifyAudit(a, async () => ({ ...ROUND, randomness: "00".repeat(32) }));
    expect(checks.find((c) => c.name === "drand round matches independent fetch")!.ok).toBe(false);
  });
});
