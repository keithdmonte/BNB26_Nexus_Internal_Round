import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { cached, clearCache } from "@/lib/cache";
import { seedDemo, DEMO_EVENTS } from "@/lib/demo";
import { tick } from "@/lib/scheduler";
import { migrate } from "../scripts/migrate";
import { makeDrop, resetDb } from "./helpers";

beforeAll(async () => {
  await migrate(process.env.DATABASE_URL!, () => {});
});
beforeEach(async () => {
  await resetDb();
  clearCache();
});
afterAll(() => pool().end());

describe("scheduler", () => {
  it("skips a lottery drop with no draw secret (warns once) and keeps driving other drops", async () => {
    const broken = await makeDrop("lottery", 3, "frozen");
    await pool().query("UPDATE drops SET secret_enc = NULL WHERE id = $1", [broken]);
    const ok = await makeDrop("lottery", 3, "scheduled");
    await pool().query("UPDATE drops SET opens_at = now() - interval '2s', closes_at = now() - interval '1s' WHERE id = $1", [ok]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 5; i++) await tick();
    const { rows } = await pool().query("SELECT id, status FROM drops WHERE id = ANY($1)", [[broken, ok]]);
    const st = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(st[broken]).toBe("frozen");
    expect(st[ok]).toBe("drawn");
    expect(warn.mock.calls.filter((c) => String(c[0]).includes(broken))).toHaveLength(1);
    expect(err).not.toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });
});

describe("cached()", () => {
  it("collapses concurrent calls into one query and expires after the TTL", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return calls;
    };
    const vals = await Promise.all(Array.from({ length: 50 }, () => cached("k", 100, fn)));
    expect(calls).toBe(1);
    expect(new Set(vals)).toEqual(new Set([1]));
    expect(await cached("k", 100, fn)).toBe(1);
    await new Promise((r) => setTimeout(r, 120));
    expect(await cached("k", 100, fn)).toBe(2);
  });

  it("does not cache failures", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return "ok";
    };
    await expect(cached("e", 1000, fn)).rejects.toThrow("boom");
    expect(await cached("e", 1000, fn)).toBe("ok");
  });
});

describe("seedDemo()", () => {
  it("creates the demo events spaced relative to now and hides older non-sim drops", async () => {
    const old = await makeDrop("lottery", 1, "drawn");
    const c = await pool().connect();
    try {
      const before = Date.now();
      const out = await seedDemo(c, { firstOpenInS: 30, gapS: 60, windowS: 300, hideOld: true });
      expect(out.hidden).toBe(1);
      expect(out.created).toHaveLength(DEMO_EVENTS.length);
      out.created.forEach((e, i) => {
        const offset = (e.opensAt.getTime() - before) / 1000;
        const want = 30 + DEMO_EVENTS[i].openInS + i * 60;
        expect(offset).toBeGreaterThanOrEqual(want - 1);
        expect(offset).toBeLessThanOrEqual(want + 1);
        expect((e.closesAt.getTime() - e.opensAt.getTime()) / 1000).toBe(300);
      });
      const { rows } = await c.query("SELECT config ? 'hidden' AS hidden FROM drops WHERE id = $1", [old]);
      expect(rows[0].hidden).toBe(true);
      const secrets = await c.query("SELECT count(*)::int n FROM drops WHERE id = ANY($1) AND secret_enc IS NOT NULL AND commit IS NOT NULL", [out.created.map((e) => e.id)]);
      expect(secrets.rows[0].n).toBe(DEMO_EVENTS.length);
    } finally {
      c.release();
    }
  });
});

describe("arrivalDeciles()", () => {
  it("buckets humans by arrival into 10 equal groups with P(win) each", async () => {
    const { arrivalDeciles } = await import("@/lib/report");
    const arrivals = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`u${i}`, i * 10]));
    const winners = new Set(Array.from({ length: 10 }, (_, i) => `u${i}`)); // the 10 earliest win (FCFS-like)
    const d = arrivalDeciles(arrivals, winners);
    expect(d).toHaveLength(10);
    expect(d.map((x) => x.n)).toEqual(Array(10).fill(10));
    expect(d[0].pWin).toBe(1);
    expect(d.slice(1).every((x) => x.pWin === 0)).toBe(true);
    expect(d[0].fromMs).toBe(0);
    expect(d[9].toMs).toBe(990);
  });
});
