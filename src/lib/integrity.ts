import type pg from "pg";

export interface Integrity {
  inventory: number;
  activeAllocations: number;
  heldSeats: number;
  oversell: number;
  duplicateUsers: number;
  doubleBookedSeats: number;
  inventoryConsistent: boolean;
  ok: boolean;
}

/** Independent invariant check. Reads the ledger only; works for both the safe and the unsafe table. */
export async function checkIntegrity(c: pg.Pool | pg.ClientBase, dropId: string): Promise<Integrity> {
  const { rows: d } = await c.query("SELECT mode, inventory FROM drops WHERE id = $1", [dropId]);
  if (!d[0]) throw new Error("drop not found");
  const table = d[0].mode === "fcfs_unsafe" ? "allocations_unsafe" : "allocations";
  const { rows } = await c.query(
    `SELECT
       (SELECT count(*)::int FROM ${table} WHERE drop_id = $1 AND status IN ('offered','confirmed')) AS active,
       (SELECT count(*)::int FROM seats WHERE drop_id = $1 AND held) AS held,
       (SELECT count(*)::int FROM (SELECT user_id FROM ${table} WHERE drop_id = $1 AND status IN ('offered','confirmed')
          GROUP BY user_id HAVING count(*) > 1) x) AS dup_users,
       (SELECT count(*)::int FROM (SELECT seat_id FROM ${table} WHERE drop_id = $1 AND status IN ('offered','confirmed')
          GROUP BY seat_id HAVING count(*) > 1) x) AS dup_seats`,
    [dropId],
  );
  const r = rows[0];
  const inventory = d[0].inventory;
  const oversell = Math.max(0, r.active - inventory);
  // Unsafe mode never maintains seats.held, so only the safe ledger is held to that equality.
  const inventoryConsistent = table === "allocations" ? r.active === r.held && r.held <= inventory : oversell === 0;
  return {
    inventory,
    activeAllocations: r.active,
    heldSeats: r.held,
    oversell,
    duplicateUsers: r.dup_users,
    doubleBookedSeats: r.dup_seats,
    inventoryConsistent,
    ok: oversell === 0 && r.dup_users === 0 && r.dup_seats === 0 && inventoryConsistent,
  };
}
