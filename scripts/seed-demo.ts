// Fresh demo events relative to now. Usage:
//   npm run seed:demo -- [--first-open-in 0] [--gap 0] [--window 43200]  (each event also has its own openInS) [--keep-old] [--only <name text>]
import pg from "pg";
import { seedDemo } from "../src/lib/demo.ts";

try { process.loadEnvFile(); } catch { /* no .env: rely on the environment */ }

const argv = process.argv.slice(2);
const flag = (name: string, def: number) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : def;
};
const opts = {
  firstOpenInS: flag("first-open-in", 0),
  gapS: flag("gap", 0),
  windowS: flag("window", 12 * 3600),
  hideOld: !argv.includes("--keep-old"),
  only: argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined,
};
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/fairdrop" });
await client.connect();
try {
  await client.query("BEGIN");
  const out = await seedDemo(client, opts);
  await client.query("COMMIT");
  console.log(`hid ${out.hidden} old drop(s); created ${out.created.length} events:`);
  for (const e of out.created) {
    console.log(`  ${e.opensAt.toLocaleTimeString()} -> ${e.closesAt.toLocaleTimeString()}  ${e.name.split("|")[0].trim()}  (${e.id})`);
  }
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
