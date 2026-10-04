import pg from "pg";

try { process.loadEnvFile(); } catch { /* no .env: rely on the environment */ }
import { createDrop } from "../src/lib/drops.ts";

const url = process.env.DATABASE_URL ?? "postgres://localhost:5432/fairdrop";
const users = Number(process.env.SEED_USERS ?? 1000);
const inventory = Number(process.env.SEED_INVENTORY ?? 500);

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN");
  const { rowCount } = await client.query(
    `INSERT INTO users (email, verified_at, is_sim, signup_ip)
     SELECT 'seed' || g || '@sim.fairdrop', now(), true, ('10.0.' || (g / 256) % 256 || '.' || g % 256)::inet
     FROM generate_series(1, $1) g
     ON CONFLICT (email) DO NOTHING`,
    [users],
  );
  const now = Date.now();
  const ids: Record<string, string> = {};
  for (const mode of ["lottery", "fcfs", "fcfs_unsafe"] as const) {
    ids[mode] = await createDrop(client, {
      name: `Demo ${mode}`,
      mode,
      inventory,
      opensAt: new Date(now + 60_000),
      closesAt: new Date(now + 180_000),
    });
  }
  await client.query("COMMIT");
  console.log(JSON.stringify({ usersInserted: rowCount, inventory, drops: ids }, null, 2));
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
