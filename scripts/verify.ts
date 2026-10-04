// Independent draw verifier. Needs only the public audit JSON (and drand, for drand-backed draws).
//   npm run verify -- http://localhost:3000/api/drops/<id>/audit
//   npm run verify -- audit.json
import { readFileSync } from "node:fs";
import { httpFetcher, verifyBeacon } from "../src/lib/beacon.ts";
import { verifyAudit } from "../src/lib/verify-core.ts";

const src = process.argv[2];
if (!src) {
  console.error("usage: npm run verify -- <audit URL or file>");
  process.exit(2);
}
const a = src.startsWith("http") ? await (await fetch(src)).json() : JSON.parse(readFileSync(src, "utf8"));

// Independent fetch straight from drand (not from our server), verified before comparison.
const fetchRound = async (round: number) => {
  const b = await httpFetcher(round);
  const v = verifyBeacon(b);
  if (!v.ok) throw new Error(`drand response failed verification: ${v.reason}`);
  return b;
};

const { checks, notice } = await verifyAudit(a, fetchRound);
let ok = true;
for (const c of checks) {
  ok &&= c.ok;
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
}
if (notice) console.log(`\nNOTE  ${notice}`);
console.log(ok ? "\nDRAW VERIFIED" : "\nVERIFICATION FAILED");
process.exit(ok ? 0 : 1);
