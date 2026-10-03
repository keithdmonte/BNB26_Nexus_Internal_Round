import { ApiError } from "@/lib/http";
import { inc } from "@/lib/counters";

// In-memory token buckets. Correct only for a single app instance (the Lean MVP deployment);
// Redis is the documented path to scaling out.
interface Bucket {
  tokens: number;
  ts: number;
}
const g = globalThis as unknown as { __buckets?: Map<string, Bucket> };
const buckets = (g.__buckets ??= new Map());

export const LIMITS = {
  userWrite: { rate: 2, burst: 5 },
  userRead: { rate: 5, burst: 20 },
  ip: { rate: 50, burst: 200 },
} as const;

/** Returns 0 if allowed, otherwise milliseconds until a token is available. */
export function take(key: string, rate: number, burst: number, now = Date.now()): number {
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: burst, ts: now };
    buckets.set(key, b);
  }
  b.tokens = Math.min(burst, b.tokens + ((now - b.ts) / 1000) * rate);
  b.ts = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return 0;
  }
  return Math.ceil(((1 - b.tokens) / rate) * 1000);
}

export function enforce(dropId: string, userId: string, ip: string, kind: "write" | "read") {
  const u = kind === "write" ? LIMITS.userWrite : LIMITS.userRead;
  const wu = take(`u:${kind}:${userId}`, u.rate, u.burst);
  if (wu) {
    inc(dropId, "rate_limited_user");
    throw new ApiError(429, "RATE_LIMITED", "too many requests for this account", wu);
  }
  const wi = take(`ip:${ip}`, LIMITS.ip.rate, LIMITS.ip.burst);
  if (wi) {
    inc(dropId, "rate_limited_ip");
    throw new ApiError(429, "RATE_LIMITED", "too many requests from this network", wi);
  }
}

export function resetBuckets() {
  buckets.clear();
}

const sweep = setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [k, b] of buckets) if (b.ts < cutoff) buckets.delete(k);
}, 60_000);
sweep.unref?.();
