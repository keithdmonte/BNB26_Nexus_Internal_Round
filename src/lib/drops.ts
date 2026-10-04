import { randomBytes } from "node:crypto";
import type pg from "pg";
import { commitOf } from "@/lib/draw-core";
import { encryptSecret } from "@/lib/secret";
import { buildVenue, venueKindFor } from "@/lib/venue";

export type DropMode = "lottery" | "fcfs" | "fcfs_unsafe";

export interface NewDrop {
  name: string;
  mode: DropMode;
  inventory: number;
  opensAt: Date;
  closesAt: Date;
  config?: Record<string, unknown>;
}

/** Creates a drop and exactly `inventory` seat rows in one statement batch. Caller owns the transaction. */
export async function createDrop(c: pg.ClientBase, d: NewDrop): Promise<string> {
  const secret = randomBytes(32);
  // Seat-select drops get a venue map: the layout meta lives in config, the seats carry geometry.
  const venue = d.config?.seatSelect ? buildVenue(venueKindFor(d.name), d.inventory) : null;
  const config = venue ? { ...d.config, venue: venue.meta } : d.config ?? {};
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO drops (name, mode, inventory, opens_at, closes_at, config, commit, secret_enc)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [d.name, d.mode, d.inventory, d.opensAt, d.closesAt, config, commitOf(secret.toString("hex")), encryptSecret(secret)],
  );
  const id = rows[0].id;
  if (venue) {
    const v = venue.seats;
    await c.query(
      `INSERT INTO seats (drop_id, seat_no, section, row_label, seat_label, price, x, y)
       SELECT $1, ord, section, row_label, seat_label, price, x, y
       FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::real[], $7::real[])
            WITH ORDINALITY AS t(section, row_label, seat_label, price, x, y, ord)`,
      [id, v.map((s) => s.section), v.map((s) => s.row), v.map((s) => s.label), v.map((s) => s.price), v.map((s) => s.x), v.map((s) => s.y)],
    );
  } else {
    await c.query(
      "INSERT INTO seats (drop_id, seat_no) SELECT $1, g FROM generate_series(1, $2) g",
      [id, d.inventory],
    );
  }
  return id;
}

export type DropStatus = "scheduled" | "open" | "closed" | "frozen" | "drawn" | "claim" | "done";

export interface DropConfig {
  rateLimit?: boolean; // default true
  risk?: boolean; // pre-draw clustering, default false
  riskPolicy?: "collapse" | "exclude";
  seatSelect?: boolean; // after the draw: queue by rank, pick seats on a venue map, mock pay
  demo?: boolean; // demo pacing: bots fill the queue and every human is admitted within ~40s
  bots?: number; // demo: bot entrants added while the window is open
  instantQueue?: boolean; // demo: random queue number at entry, admitted queueWaitS later, no shared draw
  queueWaitS?: number; // instantQueue: seconds from entry to seat selection (default 10)
  saleOpensAt?: string; // instantQueue: ISO time the sale starts; before it the queue is open but nobody is admitted
  venue?: import("@/lib/venue").VenueMeta;
}

export interface Drop {
  id: string;
  name: string;
  mode: DropMode;
  inventory: number;
  status: DropStatus;
  opensAt: Date;
  closesAt: Date;
  config: DropConfig;
  commit: string | null;
  publicSalt: string;
}

const g = globalThis as unknown as { __dropCache?: Map<string, { at: number; drop: Drop | null }> };
const cache = (g.__dropCache ??= new Map());
const CACHE_MS = 250;

/** Hot-path read with a 250ms cache. Never trust it for correctness: the entries trigger and seat locks are authoritative. */
export async function getDrop(c: pg.ClientBase | pg.Pool, id: string, fresh = false): Promise<Drop | null> {
  const hit = cache.get(id);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.drop;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await c.query(
    `SELECT id, name, mode, inventory, status, opens_at, closes_at, config, commit, encode(public_salt, 'hex') AS salt FROM drops WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  const drop: Drop | null = r
    ? {
        id: r.id,
        name: r.name,
        mode: r.mode,
        inventory: r.inventory,
        status: r.status,
        opensAt: r.opens_at,
        closesAt: r.closes_at,
        config: r.config,
        commit: r.commit,
        publicSalt: r.salt,
      }
    : null;
  cache.set(id, { at: Date.now(), drop });
  return drop;
}

export function invalidateDrop(id: string) {
  cache.delete(id);
}
