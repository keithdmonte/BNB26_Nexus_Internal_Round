import type pg from "pg";

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
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO drops (name, mode, inventory, opens_at, closes_at, config)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [d.name, d.mode, d.inventory, d.opensAt, d.closesAt, d.config ?? {}],
  );
  const id = rows[0].id;
  await c.query(
    "INSERT INTO seats (drop_id, seat_no) SELECT $1, g FROM generate_series(1, $2) g",
    [id, d.inventory],
  );
  return id;
}
