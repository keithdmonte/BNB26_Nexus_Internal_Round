// Independent draw verifier. Needs only the public audit JSON; no database access.
//   npm run verify -- http://localhost:3000/api/drops/<id>/audit
//   npm run verify -- audit.json
import { readFileSync } from "node:fs";
import { commitOf, computeSeed, entriesHash, rankEntries, RANK_FN_VERSION } from "../src/lib/draw-core.ts";

const src = process.argv[2];
if (!src) {
  console.error("usage: npm run verify -- <audit URL or file>");
  process.exit(2);
}
const a = src.startsWith("http") ? await (await fetch(src)).json() : JSON.parse(readFileSync(src, "utf8"));

const checks: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, detail?: string) => checks.push([name, ok, detail]);

check("rank function version", a.rankFnVersion === RANK_FN_VERSION, a.rankFnVersion);
check("draw has happened", typeof a.secret === "string" && a.secret.length === 64, a.status);
if (a.secret) {
  check("secret matches pre-published commit", commitOf(a.secret) === a.commit);
  check("entries hash matches published entry list", entriesHash(a.eligiblePublicIds) === a.entriesHash, `${a.eligiblePublicIds.length} entries`);
  check("eligible count matches list", a.eligiblePublicIds.length === a.eligibleCount);
  const seed = computeSeed(a.secret, a.entriesHash, a.beacon?.value ?? "");
  check("seed = SHA256(secret || entriesHash || beacon)", seed === a.seed);
  const expected = rankEntries(seed, a.eligiblePublicIds).slice(0, a.inventory).map((r) => r.publicId);
  const got = [...a.winners].sort((x: { rank: number }, y: { rank: number }) => x.rank - y.rank).map((w: { publicId: string }) => w.publicId);
  const same = expected.length === got.length && expected.every((p, i) => p === got[i]);
  check("winners = top-N of recomputed ranking", same, `${got.length} winners`);
  check("no duplicate winners", new Set(got).size === got.length);
  check("winners <= inventory", got.length <= a.inventory, `${got.length}/${a.inventory}`);
}

let ok = true;
for (const [name, pass, detail] of checks) {
  ok &&= pass;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
console.log(ok ? "\nDRAW VERIFIED" : "\nVERIFICATION FAILED");
process.exit(ok ? 0 : 1);
