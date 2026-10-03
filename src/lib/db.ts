import pg from "pg";

const globalForPool = globalThis as unknown as { __pgPool?: pg.Pool };

export function pool(): pg.Pool {
  if (!globalForPool.__pgPool) {
    globalForPool.__pgPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/fairdrop",
      max: Number(process.env.PG_POOL_MAX ?? 20),
    });
  }
  return globalForPool.__pgPool;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool().connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
