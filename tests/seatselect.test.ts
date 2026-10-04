import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@/lib/db";
import { createDrop, getDrop, type DropConfig } from "@/lib/drops";
import { draw, enter, freeze, myState } from "@/lib/lottery";
import { advanceQueue, expireHolds } from "@/lib/queue";
import { holdSeats, parseSeatNos, payOrder } from "@/lib/checkout";
import { checkIntegrity } from "@/lib/integrity";
import { migrate } from "../scripts/migrate";
import { makeUsers, resetDb } from "./helpers";

beforeAll(async () => {
  await migrate(process.env.DATABASE_URL!, () => {});
});
beforeEach(resetDb);
afterAll(() => pool().end());

const meta = { ip: "10.0.0.1", deviceFp: null };
const fresh = async (id: string) => (await getDrop(pool(), id, true))!;
const h = (s: string) => s; // request hash stand-in: one per logical request

async function humans(n: number) {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO users (email, verified_at) SELECT 'h' || g || '-' || gen_random_uuid() || '@test', now() FROM generate_series(1, $1) g RETURNING id`,
    [n],
  );
  return rows.map((r) => r.id);
}

/** A seat-select drop that has been entered, frozen and drawn: status 'claim'. */
async function drawnDrop(opts: { inventory: number; humans: number; bots?: number; config?: DropConfig }) {
  const c = await pool().connect();
  let id: string;
  try {
    id = await createDrop(c, {
      name: "Test Night | Test Hall | Comedy",
      mode: "lottery",
      inventory: opts.inventory,
      opensAt: new Date(Date.now() - 1000),
      closesAt: new Date(Date.now() + 60_000),
      config: { seatSelect: true, rateLimit: false, ...opts.config },
    });
    await c.query("UPDATE drops SET status = 'open' WHERE id = $1", [id]);
  } finally {
    c.release();
  }
  const d = await fresh(id);
  const hs = await humans(opts.humans);
  const bs = await makeUsers(opts.bots ?? 0);
  await Promise.all([...hs, ...bs].map((u) => enter(d, u, meta, randomUUID())));
  await pool().query("UPDATE drops SET status = 'closed' WHERE id = $1", [id]);
  expect(await freeze(id)).toBe(true);
  expect(await draw(id)).toBe(true);
  return { id, humans: hs, bots: bs };
}

const admitAll = (id: string) =>
  pool().query("UPDATE draw_ranks SET admitted_at = now() WHERE drop_id = $1", [id]).then(() =>
    pool().query("UPDATE drops SET serving_rank = (SELECT count(*) FROM draw_ranks WHERE drop_id = $1) WHERE id = $1", [id]));

const hold = async (id: string, u: string, seats: number[]) => holdSeats(await fresh(id), u, seats, randomUUID(), h(`hold:${seats}`));

describe("seat-select draw", () => {
  it("draw fixes queue order only: no seats allocated, drop moves to claim", async () => {
    const { id } = await drawnDrop({ inventory: 20, humans: 30 });
    const d = await fresh(id);
    expect(d.status).toBe("claim");
    const { rows } = await pool().query("SELECT count(*)::int n FROM allocations WHERE drop_id = $1", [id]);
    expect(rows[0].n).toBe(0);
    const { rows: s } = await pool().query("SELECT count(*)::int n, count(price)::int priced FROM seats WHERE drop_id = $1", [id]);
    expect(s[0]).toEqual({ n: 20, priced: 20 });
  });

  it("users wait with a position until admitted", async () => {
    const { id, humans: hs } = await drawnDrop({ inventory: 20, humans: 5 });
    const st = await Promise.all(hs.map(async (u) => myState(await fresh(id), u)));
    expect(st.every((s) => s.state === "waiting")).toBe(true);
    expect(st.map((s) => (s as { position: number }).position).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("demo pacing", () => {
  it("admits the last human by the target time, with bots buying at most half the seats", async () => {
    const { id, humans: hs } = await drawnDrop({ inventory: 100, humans: 3, bots: 200, config: { demo: true } });
    const { rows } = await pool().query("SELECT queue_target_s, queue_pace_rank FROM drops WHERE id = $1", [id]);
    expect(rows[0].queue_target_s).toBeGreaterThanOrEqual(20);
    expect(rows[0].queue_target_s).toBeLessThanOrEqual(32);
    let last = 0;
    // Walk the clock forward in 2s steps; serving_rank must never go backwards.
    for (let t = 0; t <= 40; t += 2) {
      await pool().query("UPDATE drops SET queue_started_at = now() - make_interval(secs => $2) WHERE id = $1", [id, t]);
      await advanceQueue(id);
      const { rows: r } = await pool().query("SELECT serving_rank FROM drops WHERE id = $1", [id]);
      expect(r[0].serving_rank).toBeGreaterThanOrEqual(last);
      last = r[0].serving_rank;
    }
    const st = await Promise.all(hs.map(async (u) => myState(await fresh(id), u)));
    expect(st.every((s) => s.state === "your_turn")).toBe(true);
    const { rows: sold } = await pool().query("SELECT count(*)::int n FROM allocations WHERE drop_id = $1 AND status = 'confirmed'", [id]);
    expect(sold[0].n).toBeGreaterThan(0);
    expect(sold[0].n).toBeLessThanOrEqual(50);
    expect((await checkIntegrity(pool(), id)).ok).toBe(true);
  });

  it("hard cap: everyone is in by 34s even if the target is longer", async () => {
    const { id } = await drawnDrop({ inventory: 10, humans: 2, bots: 50, config: { demo: true } });
    await pool().query("UPDATE drops SET queue_target_s = 300, queue_started_at = now() - interval '35 seconds' WHERE id = $1", [id]);
    await advanceQueue(id);
    const { rows } = await pool().query("SELECT serving_rank, (SELECT count(*)::int FROM draw_ranks WHERE drop_id = $1) total FROM drops WHERE id = $1", [id]);
    expect(rows[0].serving_rank).toBe(rows[0].total);
  });
});

describe("hold and pay", () => {
  it("rejects a hold before your turn", async () => {
    const { id, humans: [u] } = await drawnDrop({ inventory: 10, humans: 3 });
    await expect(hold(id, u, [1])).rejects.toMatchObject({ code: "NOT_YOUR_TURN" });
  });

  it("caps an order at 6 seats", () => {
    expect(parseSeatNos({ seatNos: [1, 2, 3, 4, 5, 6] }, 50)).toHaveLength(6);
    expect(() => parseSeatNos({ seatNos: [1, 2, 3, 4, 5, 6, 7] }, 50)).toThrow(/max 6/);
    expect(() => parseSeatNos({ seatNos: [1, 1] }, 50)).toThrow();
    expect(() => parseSeatNos({ seatNos: [51] }, 50)).toThrow();
  });

  it("20 users racing for the same seats: exactly one gets them, no double booking", async () => {
    const { id, humans: hs } = await drawnDrop({ inventory: 10, humans: 20 });
    await admitAll(id);
    const res = await Promise.allSettled(hs.map((u) => hold(id, u, [3, 4])));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(res.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === "SEATS_TAKEN")).toBe(true);
    expect((await checkIntegrity(pool(), id)).ok).toBe(true);
  });

  it("hold then pay confirms all seats; pay is idempotent", async () => {
    const { id, humans: [u] } = await drawnDrop({ inventory: 10, humans: 1 });
    await admitAll(id);
    const held = await hold(id, u, [1, 2, 3]);
    const order = held.body.order as { id: string; total: number; seats: unknown[] };
    expect(order.seats).toHaveLength(3);
    expect((await myState(await fresh(id), u)).state).toBe("checkout");
    const key = randomUUID();
    const a = await payOrder(await fresh(id), u, order.id, key, h("pay"));
    const b = await payOrder(await fresh(id), u, order.id, key, h("pay"));
    expect(a.status).toBe(201);
    expect(b.replayed).toBe(true);
    const st = await myState(await fresh(id), u);
    expect(st.state).toBe("confirmed");
    const integ = await checkIntegrity(pool(), id);
    expect(integ).toMatchObject({ ok: true, activeAllocations: 3, heldSeats: 3, duplicateUsers: 0 });
    await expect(hold(id, u, [5])).rejects.toMatchObject({ code: "ALREADY_PURCHASED" });
  });

  it("a second hold replaces the first", async () => {
    const { id, humans: [u] } = await drawnDrop({ inventory: 10, humans: 1 });
    await admitAll(id);
    await hold(id, u, [1, 2]);
    await hold(id, u, [7]);
    const { rows } = await pool().query("SELECT seat_no FROM seats WHERE drop_id = $1 AND held ORDER BY seat_no", [id]);
    expect(rows.map((r) => r.seat_no)).toEqual([7]);
    expect((await checkIntegrity(pool(), id)).ok).toBe(true);
  });

  it("an expired hold frees its seats and cannot be paid", async () => {
    const { id, humans: [u, v] } = await drawnDrop({ inventory: 10, humans: 2 });
    await admitAll(id);
    const held = await hold(id, u, [1, 2]);
    await pool().query("UPDATE orders SET expires_at = now() - interval '1 second' WHERE drop_id = $1", [id]);
    await expect(payOrder(await fresh(id), u, (held.body.order as { id: string }).id, randomUUID(), h("pay"))).rejects.toMatchObject({ code: "HOLD_EXPIRED" });
    await expireHolds(pool(), id);
    await hold(id, v, [1, 2]);
    expect((await checkIntegrity(pool(), id)).ok).toBe(true);
  });

  it("a turn that has ended cannot start a hold", async () => {
    const { id, humans: [u] } = await drawnDrop({ inventory: 10, humans: 1 });
    await pool().query("UPDATE draw_ranks SET admitted_at = now() - interval '1 hour' WHERE drop_id = $1", [id]);
    await expect(hold(id, u, [1])).rejects.toMatchObject({ code: "TURN_EXPIRED" });
    expect((await myState(await fresh(id), u)).state).toBe("turn_expired");
  });
});

describe("instant demo queue", () => {
  async function openInstantDrop(inventory: number) {
    const c = await pool().connect();
    try {
      const id = await createDrop(c, {
        name: "Instant Night | Test Hall | Comedy",
        mode: "lottery",
        inventory,
        opensAt: new Date(Date.now() - 1000),
        closesAt: new Date(Date.now() + 3_600_000),
        config: { seatSelect: true, instantQueue: true, queueWaitS: 10, rateLimit: false },
      });
      await c.query("UPDATE drops SET status = 'open' WHERE id = $1", [id]);
      return id;
    } finally {
      c.release();
    }
  }

  it("entry gets a random queue number at once and waits about 10s", async () => {
    const id = await openInstantDrop(20);
    const [u] = await humans(1);
    await enter(await fresh(id), u, meta, randomUUID());
    const st = (await myState(await fresh(id), u)) as { state: string; position: number; ahead: number; etaS: number };
    expect(st.state).toBe("waiting");
    expect(st.position).toBeGreaterThanOrEqual(120);
    expect(st.position).toBeLessThan(600);
    expect(st.ahead).toBeGreaterThan(0);
    expect(st.etaS).toBeGreaterThan(8);
    expect(st.etaS).toBeLessThanOrEqual(10);
  });

  it("people-ahead count only goes down and reaches 0 at admission", async () => {
    const { instantAhead } = await import("@/lib/queue");
    const admit = new Date(Date.now() + 10_000);
    let last = Infinity;
    for (let t = 0; t <= 10_000; t += 250) {
      const a = instantAhead("e1", 400, admit, 10, admit.getTime() - 10_000 + t);
      expect(a).toBeLessThanOrEqual(last);
      last = a;
    }
    expect(last).toBe(0);
  });

  it("no hold before admission; after it, hold and pay work while the drop is open", async () => {
    const id = await openInstantDrop(20);
    const [u] = await humans(1);
    await enter(await fresh(id), u, meta, randomUUID());
    await expect(hold(id, u, [1])).rejects.toMatchObject({ code: "NOT_YOUR_TURN" });
    await pool().query("UPDATE entries SET queue_admit_at = now() - interval '1 second' WHERE drop_id = $1", [id]);
    expect((await myState(await fresh(id), u)).state).toBe("your_turn");
    const held = await hold(id, u, [1, 2]);
    await payOrder(await fresh(id), u, (held.body.order as { id: string }).id, randomUUID(), h("pay"));
    expect((await myState(await fresh(id), u)).state).toBe("confirmed");
    expect((await checkIntegrity(pool(), id)).ok).toBe(true);
  });

  it("bot sales fill part of the map without breaking integrity", async () => {
    const { instantBotSales } = await import("@/lib/queue");
    const id = await openInstantDrop(50);
    for (let i = 0; i < 10; i++) await instantBotSales(id);
    const { rows } = await pool().query("SELECT count(*)::int n FROM seats WHERE drop_id = $1 AND held", [id]);
    expect(rows[0].n).toBeGreaterThan(0);
    expect(rows[0].n).toBeLessThanOrEqual(30);
    expect((await checkIntegrity(pool(), id)).ok).toBe(true);
  });
});

describe("instant queue backfill", () => {
  it("an entry without a queue number gets one on its next status read", async () => {
    const c = await pool().connect();
    let id: string;
    try {
      id = await createDrop(c, {
        name: "Late Night | Hall | Comedy", mode: "lottery", inventory: 10,
        opensAt: new Date(Date.now() - 1000), closesAt: new Date(Date.now() + 3_600_000),
        config: { seatSelect: true, instantQueue: true, rateLimit: false },
      });
      await c.query("UPDATE drops SET status = 'open' WHERE id = $1", [id]);
    } finally {
      c.release();
    }
    const [u] = await humans(1);
    await enter(await fresh(id), u, meta, randomUUID());
    await pool().query("UPDATE entries SET queue_pos = NULL, queue_admit_at = NULL WHERE drop_id = $1", [id]);
    const st = (await myState(await fresh(id), u)) as { state: string; position: number };
    expect(st.state).toBe("waiting");
    expect(st.position).toBeGreaterThan(0);
  });
});

describe("pre-sale queue", () => {
  it("joining before the sale gives a number at once, holds it until the sale, and sells nothing early", async () => {
    const { instantBotSales } = await import("@/lib/queue");
    const saleOpensAt = new Date(Date.now() + 300_000).toISOString();
    const c = await pool().connect();
    let id: string;
    try {
      id = await createDrop(c, {
        name: "Pre Sale | Hall | Music", mode: "lottery", inventory: 30,
        opensAt: new Date(Date.now() - 1000), closesAt: new Date(Date.now() + 3_600_000),
        config: { seatSelect: true, instantQueue: true, queueWaitS: 10, saleOpensAt, rateLimit: false },
      });
      await c.query("UPDATE drops SET status = 'open' WHERE id = $1", [id]);
    } finally {
      c.release();
    }
    const [u] = await humans(1);
    await enter(await fresh(id), u, meta, randomUUID());
    const st = (await myState(await fresh(id), u)) as unknown as { state: string; position: number; ahead: number; etaS: number; saleOpensAt: string };
    expect(st.state).toBe("waiting");
    expect(st.ahead).toBe(st.position - 1); // nobody moves before the sale
    expect(st.etaS).toBeGreaterThanOrEqual(305);
    expect(st.saleOpensAt).toBe(saleOpensAt);
    await expect(hold(id, u, [1])).rejects.toMatchObject({ code: "NOT_YOUR_TURN" });
    for (let i = 0; i < 5; i++) await instantBotSales(id);
    const { rows } = await pool().query("SELECT count(*)::int n FROM seats WHERE drop_id = $1 AND held", [id]);
    expect(rows[0].n).toBe(0);
  });
});

describe("pre-sale queue numbers are first-come-first-served", () => {
  it("joiners get 1, 2, 3... in join order, and 20 concurrent joins get 20 distinct numbers", async () => {
    const c = await pool().connect();
    let id: string;
    try {
      id = await createDrop(c, {
        name: "FCFS Pre Sale | Hall | Music", mode: "lottery", inventory: 30,
        opensAt: new Date(Date.now() - 1000), closesAt: new Date(Date.now() + 3_600_000),
        config: { seatSelect: true, instantQueue: true, saleOpensAt: new Date(Date.now() + 600_000).toISOString(), rateLimit: false },
      });
      await c.query("UPDATE drops SET status = 'open' WHERE id = $1", [id]);
    } finally {
      c.release();
    }
    const [a, b] = await humans(2);
    await enter(await fresh(id), a, meta, randomUUID());
    await enter(await fresh(id), b, meta, randomUUID());
    expect(((await myState(await fresh(id), a)) as unknown as { position: number }).position).toBe(1);
    expect(((await myState(await fresh(id), b)) as unknown as { position: number }).position).toBe(2);
    const many = await humans(20);
    const d = await fresh(id);
    await Promise.all(many.map((u) => enter(d, u, meta, randomUUID())));
    const { rows } = await pool().query("SELECT queue_pos FROM entries WHERE drop_id = $1 ORDER BY queue_pos", [id]);
    expect(rows.map((r) => r.queue_pos)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
  });
});
