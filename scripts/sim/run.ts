// Fair Drop bot/load simulator. Usage:
//   npm run sim -- --scenario S3 [--scale 0.1] [--seed 1] [--target http://localhost:3000]
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Agent, request } from "undici";
import { SCENARIOS, type ActorType, type Scenario } from "./scenarios.ts";

try { process.loadEnvFile(); } catch { /* no .env */ }

const args = Object.fromEntries(
  process.argv.slice(2).reduce<[string, string][]>((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "true" : all[i + 1]]);
    return acc;
  }, []),
);
const TARGET = (args.target ?? process.env.SIM_TARGET ?? "http://localhost:3000").replace(/\/$/, "");
const SCALE = Number(args.scale ?? 1);
const SEED = Number(args.seed ?? 1);
const SIM_SECRET = process.env.SIM_SECRET ?? "";
const scenario: Scenario = SCENARIOS[args.scenario ?? "S3"];
if (!scenario) throw new Error(`unknown scenario ${args.scenario}; have ${Object.keys(SCENARIOS).join(", ")}`);

// ---------- deterministic randomness ----------
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const pick = <T>(xs: T[]) => xs[Math.floor(rng() * xs.length)];
const lognormal = (median: number, sigma: number) => {
  const u = 1 - rng(), v = rng();
  return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
};

// ---------- HTTP + client metrics ----------
const dispatcher = new Agent({ connections: Number(args.connections ?? 512), keepAliveTimeout: 30_000, headersTimeout: 20_000, bodyTimeout: 20_000 });
interface Stat { lat: number[]; codes: Record<string, number> }
const stats = new Map<string, Stat>();
const record = (k: string, ms: number, code: string) => {
  let s = stats.get(k);
  if (!s) stats.set(k, (s = { lat: [], codes: {} }));
  s.lat.push(ms);
  s.codes[code] = (s.codes[code] ?? 0) + 1;
};

interface Res { status: number; code: string; body: any; retryAfterMs: number }
async function call(
  actor: ActorType, endpoint: string, method: "GET" | "POST", path: string,
  o: { token?: string; ip?: string; fp?: string; key?: string; body?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-requested-with": "fairdrop", "x-sim-secret": SIM_SECRET };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.ip) headers["x-sim-client-ip"] = o.ip;
  if (o.fp) headers["x-device-fp"] = o.fp;
  if (o.key) headers["idempotency-key"] = o.key;
  const t0 = performance.now();
  try {
    const r = await request(TARGET + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), dispatcher });
    const text = await r.body.text();
    const body = text ? JSON.parse(text) : null;
    const code = r.statusCode < 400 ? String(r.statusCode) : `${r.statusCode}:${body?.error?.code ?? "?"}`;
    record(`${actor}|${endpoint}`, performance.now() - t0, code);
    return { status: r.statusCode, code, body, retryAfterMs: Number(r.headers["retry-after"] ?? 0) * 1000 };
  } catch (e) {
    record(`${actor}|${endpoint}`, performance.now() - t0, `ERR:${(e as { code?: string }).code ?? "net"}`);
    return { status: 0, code: "ERR", body: null, retryAfterMs: 0 };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// ---------- population ----------
interface Actor { type: ActorType; operatorId?: string; ip: string; fp: string; ageS: number; token?: string; rps?: number; durationS?: number; arrivalMs?: number; refresh?: boolean }

function buildPopulation(s: Scenario): Actor[] {
  const actors: Actor[] = [];
  const humans = Math.round(s.humans * SCALE);
  const natIps = Array.from({ length: Math.max(1, Math.round(s.humanIpPool * SCALE)) }, (_, i) => `100.64.${(i >> 8) & 255}.${i & 255}`);
  for (let i = 0; i < humans; i++) {
    actors.push({ type: "human", ip: pick(natIps), fp: `h-${SEED}-${i}`, ageS: 86400 * (30 + Math.floor(rng() * 365)) });
  }
  // Roommates: a few humans share a device with another human (false-positive bait for clustering).
  const shared = Math.floor(humans * s.humanSharedFp);
  for (let i = 0; i < shared; i++) actors[humans - 1 - i].fp = actors[i].fp;

  let opIdx = 0;
  for (const b of s.bots) {
    const ops = Math.max(1, Math.round(b.operators * Math.min(1, SCALE * 2)));
    const each = Math.max(1, Math.round((b.accountsEach * b.operators * SCALE) / ops));
    for (let o = 0; o < ops; o++, opIdx++) {
      const opId = `${b.type}-${o}`;
      const opFp = `op-${SEED}-${opIdx}`;
      const opIps = Array.from({ length: b.ipPool ?? 1 }, (_, i) => `203.0.${opIdx & 255}.${(i % 254) + 1}`);
      for (let a = 0; a < each; a++) {
        const fp = b.type === "multi" && rng() < (b.sharedFp ?? 0) ? opFp : `${opFp}-${a}`;
        const ip = b.type === "multi" && (b.ipPool ?? 1) > 254
          ? `${11 + Math.floor(rng() * 200)}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}.${1 + Math.floor(rng() * 254)}`
          : pick(opIps);
        actors.push({ type: b.type, operatorId: opId, ip, fp, ageS: b.ageS ?? 86400 * 60, rps: b.rps, durationS: b.durationS });
      }
    }
  }
  return actors;
}

// ---------- behaviours ----------
const isFinal = (r: Res) => (r.status >= 200 && r.status < 300) || r.status === 410 || r.code.includes("WINDOW_CLOSED") || r.code.includes("WRONG_MODE") || r.status === 401 || r.status === 403 || r.status === 422;

let opensAtLocal = 0, closesAtLocal = 0;
let writePath = "";
let mePath = "";
const outcome = new Map<Actor, string>();

// Arrival times and refresh behaviour are drawn up-front (sync) so a seed fully determines them.
function planHumans(actors: Actor[], lottery: boolean, windowMs: number) {
  for (const a of actors) {
    if (a.type !== "human") continue;
    a.arrivalMs = lottery
      ? (rng() < 0.3 ? rng() * Math.min(10_000, windowMs * 0.1) : rng() * windowMs * 0.9)
      : Math.min(lognormal(1500, 0.6), windowMs * 0.9);
    a.refresh = rng() < 0.2;
  }
}

async function human(a: Actor) {
  await sleep(opensAtLocal + a.arrivalMs! - Date.now());
  if (a.refresh) await call("human", "me", "GET", mePath, { token: a.token, ip: a.ip });
  const key = randomUUID();
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await call("human", "write", "POST", writePath, { token: a.token, ip: a.ip, fp: a.fp, key, body: {} });
    outcome.set(a, r.code);
    if (isFinal(r)) return;
    if (r.code.includes("WINDOW_NOT_OPEN")) { await sleep(250); continue; }
    if (Date.now() > closesAtLocal) return;
    await sleep(Math.max(r.retryAfterMs, 500 * 2 ** attempt) * (0.5 + rng()));
  }
}

async function fastBot(a: Actor) {
  await sleep(opensAtLocal + rng() * 30 - Date.now());
  for (let i = 0; i < 400 && Date.now() < closesAtLocal; i++) {
    const r = await call(a.type, "write", "POST", writePath, { token: a.token, ip: a.ip, fp: a.fp, key: randomUUID(), body: {} });
    outcome.set(a, r.code);
    if (isFinal(r)) return;
    await sleep(r.code.includes("WINDOW_NOT_OPEN") ? 20 : 50); // ignores Retry-After
  }
}

async function flooder(a: Actor) {
  await sleep(opensAtLocal - Date.now());
  const end = Math.min(closesAtLocal, Date.now() + (a.durationS ?? 20) * 1000);
  const gap = 1000 / (a.rps ?? 20);
  const inflight: Promise<unknown>[] = [];
  while (Date.now() < end) {
    inflight.push(call(a.type, "write", "POST", writePath, { token: a.token, ip: a.ip, fp: a.fp, key: randomUUID(), body: {} }).then((r) => {
      if (r.status >= 200 && r.status < 300) outcome.set(a, r.code);
      else if (!outcome.has(a)) outcome.set(a, r.code);
    }));
    await sleep(gap);
  }
  await Promise.all(inflight);
}

// ---------- main ----------
function pct(xs: number[], p: number) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
}

async function main() {
  const s = scenario;
  const lottery = s.mode === "lottery";
  const actors = buildPopulation(s);
  const inventory = Math.max(5, Math.round(s.inventory * SCALE));
  console.log(`[sim] ${s.id} "${s.title}" scale=${SCALE} seed=${SEED} actors=${actors.length} inventory=${inventory} target=${TARGET}`);

  const h = await request(`${TARGET}/api/health`, { dispatcher });
  const health = (await h.body.json()) as { serverTime: string };
  const skew = new Date(health.serverTime).getTime() - Date.now();

  const leadS = 5 + Math.ceil(actors.length / 4000);
  const run = await call("human", "setup", "POST", "/api/sim/runs", {
    body: { scenario: s.id, seed: SEED, config: { mode: s.mode, inventory, windowS: s.windowS, leadS, defenses: s.defenses, scale: SCALE, title: s.title } },
  });
  if (run.status !== 201) throw new Error(`run create failed: ${run.code} ${JSON.stringify(run.body)}`);
  const { runId, dropId } = run.body;
  opensAtLocal = new Date(run.body.opensAt).getTime() - skew;
  closesAtLocal = new Date(run.body.closesAt).getTime() - skew;
  writePath = `/api/drops/${dropId}/${lottery ? "entries" : "purchase"}`;
  mePath = `/api/drops/${dropId}/me`;

  for (let i = 0; i < actors.length; i += 10_000) {
    const batch = actors.slice(i, i + 10_000);
    const r = await call("human", "setup", "POST", `/api/sim/runs/${runId}/accounts`, {
      body: { accounts: batch.map((a) => ({ actorType: a.type, operatorId: a.operatorId, deviceFp: a.fp, signupIp: a.ip, ageS: a.ageS + leadS })) },
    });
    if (r.status !== 201) throw new Error(`accounts failed: ${r.code}`);
    r.body.accounts.forEach((x: { token: string }, j: number) => (batch[j].token = x.token));
  }
  stats.clear();
  console.log(`[sim] run=${runId} drop=${dropId} opens in ${((opensAtLocal - Date.now()) / 1000).toFixed(1)}s, window ${s.windowS}s`);

  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const t0 = Date.now();
  planHumans(actors, lottery, closesAtLocal - opensAtLocal);
  await Promise.all(actors.map((a) =>
    a.type === "human" ? human(a) : a.type === "flooder" ? flooder(a) : fastBot(a),
  ));
  loop.disable();
  const activeS = (Date.now() - t0) / 1000;

  // Wait for the server to finish the drop (lottery: freeze + draw; fcfs: window end).
  process.stdout.write("[sim] waiting for draw/close");
  for (;;) {
    const d = await call("human", "setup", "GET", `/api/drops/${dropId}`);
    if (["drawn", "done", "claim"].includes(d.body?.status)) break;
    process.stdout.write(".");
    await sleep(1000);
  }
  console.log();

  // Humans check their result (sampled) to measure result-fetch latency.
  const humansList = actors.filter((a) => a.type === "human");
  const sample = humansList.filter(() => rng() < Math.min(1, 2000 / humansList.length));
  await Promise.all(sample.map((a) => call("human", "result", "GET", `/api/drops/${dropId}/me`, { token: a.token, ip: a.ip })));

  // Did each human end with a definitive answer (entered/bought/sold out/closed), or give up on errors?
  const humanFinal = humansList.map((a) => outcome.get(a) ?? "none");
  const unresolved = humanFinal.filter((c) => !(c.startsWith("2") || c.startsWith("410") || c.includes("WINDOW_CLOSED"))).length;
  const client: Record<string, unknown> = {
    activeSeconds: activeS,
    humanUnresolvedRate: humansList.length ? unresolved / humansList.length : 0,
    eventLoopDelayP95Ms: Math.round(loop.percentile(95) / 1e6),
    simValid: loop.percentile(95) / 1e6 < 50,
    endpoints: Object.fromEntries([...stats.entries()].filter(([k]) => !k.endsWith("|setup")).map(([k, v]) => [k, {
      requests: v.lat.length, p50: pct(v.lat, 50), p95: pct(v.lat, 95), p99: pct(v.lat, 99), codes: v.codes,
      errorRate: (Object.entries(v.codes).filter(([c]) => c.startsWith("5") || c.startsWith("ERR")).reduce((n, [, x]) => n + x, 0)) / v.lat.length,
    }])),
  };
  const rep = await call("human", "setup", "POST", `/api/sim/runs/${runId}/report`, { body: { client } });
  const report = rep.body.report;
  mkdirSync("runs", { recursive: true });
  const file = `runs/${s.id}-seed${SEED}-scale${SCALE}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2));

  const sm = report.summary;
  const f = (x: number | null, d = 3) => (x === null || x === undefined ? "n/a" : Number(x).toFixed(d));
  const humanW = (client.endpoints as Record<string, { p95: number; errorRate: number }>)["human|write"];
  console.log(`
== ${s.id}: ${s.title}
seats allocated      ${report.seatsAllocated} / ${report.inventory}
bot account share    ${f(sm.botAccountShare)}
bot seat share       ${f(sm.botSeatShare)}
advantage multiplier ${sm.humansWonNothing ? "inf (humans won 0 seats)" : f(sm.advantageMultiplier, 2)}   (P(win|bot acct) / P(win|human acct); 1.0 = fair)
human success rate   ${f(sm.humanSuccessRate)}
human false-flag     ${f(sm.humanFalseFlagRate)}
bot flag recall      ${f(sm.botFlagRecall)}
oversell / dup users / double-booked seats ${sm.oversell} / ${sm.duplicateUsers} / ${report.integrity.doubleBookedSeats}   integrity ${sm.integrityOk ? "OK" : "VIOLATED"}
human write p95      ${humanW?.p95 ?? "n/a"} ms, per-request error rate ${f(humanW?.errorRate ?? null)}
humans w/o answer    ${f(client.humanUnresolvedRate as number)}   (gave up after retries)
sim event-loop p95   ${client.eventLoopDelayP95Ms} ms ${client.simValid ? "" : "(SIM OVERLOADED: latency numbers unreliable)"}
report               ${file}`);
  await dispatcher.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
