// Quick GET load test: npm run loadtest -- <url> [requests=2000] [concurrency=200]
import { Agent, request } from "undici";

const [url, nArg, cArg] = process.argv.slice(2);
if (!url) {
  console.error("usage: npm run loadtest -- <url> [requests] [concurrency]");
  process.exit(2);
}
const n = Number(nArg ?? 2000), conc = Number(cArg ?? 200);
const dispatcher = new Agent({ connections: conc });
const lat: number[] = [];
const codes: Record<number, number> = {};
let next = 0;
const t0 = performance.now();
await Promise.all(Array.from({ length: conc }, async () => {
  while (next < n) {
    next++;
    const s = performance.now();
    const r = await request(url, { dispatcher });
    await r.body.dump();
    lat.push(performance.now() - s);
    codes[r.statusCode] = (codes[r.statusCode] ?? 0) + 1;
  }
}));
const secs = (performance.now() - t0) / 1000;
lat.sort((a, b) => a - b);
const p = (q: number) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(1);
console.log(`${url}\n  n=${lat.length} conc=${conc} rps=${(lat.length / secs).toFixed(0)} p50=${p(0.5)}ms p95=${p(0.95)}ms p99=${p(0.99)}ms codes=${JSON.stringify(codes)}`);
await dispatcher.close();
