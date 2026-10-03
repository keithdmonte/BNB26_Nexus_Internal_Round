import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/lib/db";
import { migrate } from "../scripts/migrate";
import { insertEntry, makeDrop, makeUsers, resetDb, seatIds } from "./helpers";

beforeAll(async () => {
  await migrate(process.env.DATABASE_URL!, () => {});
});
beforeEach(resetDb);
afterAll(() => pool().end());

describe("drops and seats", () => {
  it("creates exactly `inventory` seats", async () => {
    const d = await makeDrop("lottery", 500);
    expect(await seatIds(d)).toHaveLength(500);
  });

  it("rejects inventory <= 0 and closes_at <= opens_at", async () => {
    await expect(
      pool().query("INSERT INTO drops (name, mode, inventory, opens_at, closes_at) VALUES ('x','fcfs',0,now(),now()+'1m')"),
    ).rejects.toThrow(/check/i);
    await expect(
      pool().query("INSERT INTO drops (name, mode, inventory, opens_at, closes_at) VALUES ('x','fcfs',1,now(),now())"),
    ).rejects.toThrow(/check/i);
  });
});

describe("entries", () => {
  it("one entry per (drop, user) under 50 parallel inserts", async () => {
    const d = await makeDrop("lottery", 10);
    const [u] = await makeUsers(1);
    await Promise.all(Array.from({ length: 50 }, () => insertEntry(d, u)));
    const { rows } = await pool().query("SELECT count(*)::int n FROM entries WHERE drop_id = $1", [d]);
    expect(rows[0].n).toBe(1);
  });

  it("plain duplicate insert violates the unique index", async () => {
    const d = await makeDrop("lottery", 10);
    const [u] = await makeUsers(1);
    const q = "INSERT INTO entries (drop_id, user_id, public_id) VALUES ($1, $2, $3)";
    await pool().query(q, [d, u, "a"]);
    await expect(pool().query(q, [d, u, "b"])).rejects.toThrow(/duplicate key/);
  });

  it.each(["scheduled", "frozen", "drawn", "done"])("guard rejects entry insert when drop is %s", async (status) => {
    const d = await makeDrop("lottery", 10, status);
    const [u] = await makeUsers(1);
    await expect(insertEntry(d, u)).rejects.toThrow(/entries are frozen/);
  });

  it("guard rejects exclusion updates after freeze", async () => {
    const d = await makeDrop("lottery", 10, "closed");
    const [u] = await makeUsers(1);
    await insertEntry(d, u);
    await pool().query("UPDATE entries SET status = 'excluded' WHERE drop_id = $1", [d]);
    await pool().query("UPDATE drops SET status = 'frozen' WHERE id = $1", [d]);
    await expect(
      pool().query("UPDATE entries SET status = 'active' WHERE drop_id = $1", [d]),
    ).rejects.toThrow(/entries are frozen/);
  });
});

describe("allocations integrity", () => {
  const ins = (d: string, seat: string, user: string, status = "confirmed") =>
    pool().query("INSERT INTO allocations (drop_id, seat_id, user_id, status) VALUES ($1, $2, $3, $4)", [
      d, seat, user, status,
    ]);

  it("one active allocation per seat", async () => {
    const d = await makeDrop("fcfs", 2);
    const [s1] = await seatIds(d);
    const [a, b] = await makeUsers(2);
    await ins(d, s1, a);
    await expect(ins(d, s1, b)).rejects.toThrow(/one_active_per_seat/);
  });

  it("one active allocation per user per drop", async () => {
    const d = await makeDrop("fcfs", 2);
    const [s1, s2] = await seatIds(d);
    const [a] = await makeUsers(1);
    await ins(d, s1, a);
    await expect(ins(d, s2, a)).rejects.toThrow(/one_active_per_user/);
  });

  it("released/expired allocations free the seat and the user", async () => {
    const d = await makeDrop("fcfs", 1);
    const [s1] = await seatIds(d);
    const [a, b] = await makeUsers(2);
    await ins(d, s1, a, "expired");
    await ins(d, s1, b, "offered");
    await pool().query("UPDATE allocations SET status = 'released' WHERE user_id = $1", [b]);
    await ins(d, s1, a);
  });

  it("allocations_unsafe has no integrity indexes (oversell is possible and visible)", async () => {
    const d = await makeDrop("fcfs_unsafe", 1);
    const [s1] = await seatIds(d);
    const [a, b] = await makeUsers(2);
    const q = "INSERT INTO allocations_unsafe (drop_id, seat_id, user_id, status) VALUES ($1, $2, $3, 'confirmed')";
    await pool().query(q, [d, s1, a]);
    await pool().query(q, [d, s1, b]);
    await pool().query(q, [d, s1, a]);
    const { rows } = await pool().query("SELECT count(*)::int n FROM allocations_unsafe WHERE drop_id = $1", [d]);
    expect(rows[0].n).toBe(3);
  });
});
