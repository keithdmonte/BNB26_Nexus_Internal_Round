// drand public randomness beacon (League of Entropy "quicknet").
// The draw commits to a FUTURE round at freeze time, so nobody (including the operator) can know the
// randomness while the eligible entry set can still change. Spec: docs/ALLOCATION_DESIGN.md.
import { createHash } from "node:crypto";
import { bls12_381 } from "@noble/curves/bls12-381.js";

export const QUICKNET = {
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  publicKey:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  genesis: 1692803367,
  period: 3,
  scheme: "bls-unchained-g1-rfc9380",
};
const DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

export interface Beacon {
  round: number;
  randomness: string; // hex, = SHA256(signature)
  signature: string; // hex, BLS signature on SHA256(round as uint64 big-endian)
}

export type BeaconStatus = "pending" | "drand" | "fallback" | "disabled";

/** First round whose publication time is >= t. */
export function roundAt(tMs: number): number {
  return Math.max(1, Math.ceil((tMs / 1000 - QUICKNET.genesis) / QUICKNET.period) + 1);
}

export function roundTime(round: number): number {
  return (QUICKNET.genesis + (round - 1) * QUICKNET.period) * 1000;
}

/** Verifies a quicknet beacon: randomness = SHA256(signature) and a valid BLS signature for that round. */
export function verifyBeacon(b: Beacon): { ok: boolean; reason?: string } {
  try {
    const sig = Buffer.from(b.signature, "hex");
    if (createHash("sha256").update(sig).digest("hex") !== b.randomness) return { ok: false, reason: "randomness != SHA256(signature)" };
    const r = Buffer.alloc(8);
    r.writeBigUInt64BE(BigInt(b.round));
    const msg = createHash("sha256").update(r).digest();
    const ss = bls12_381.shortSignatures;
    const ok = ss.verify(ss.Signature.fromHex(b.signature), ss.hash(msg, DST), bls12_381.G2.Point.fromHex(QUICKNET.publicKey));
    return ok ? { ok: true } : { ok: false, reason: "BLS signature invalid" };
  } catch (e) {
    return { ok: false, reason: `malformed beacon: ${(e as Error).message}` };
  }
}

export type BeaconFetcher = (round: number) => Promise<Beacon>;

export const httpFetcher: BeaconFetcher = async (round) => {
  const base = (process.env.DRAND_URL ?? "https://api.drand.sh").replace(/\/$/, "");
  const res = await fetch(`${base}/${QUICKNET.chainHash}/public/${round}`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`drand HTTP ${res.status}`);
  const j = (await res.json()) as Beacon;
  return { round: j.round, randomness: j.randomness, signature: j.signature };
};

const g = globalThis as unknown as { __beaconFetcher?: BeaconFetcher | null };

/** Test hook: replace the network fetcher. Pass null to restore. */
export function setBeaconFetcher(f: BeaconFetcher | null) {
  g.__beaconFetcher = f;
}

/** Fetches a round and refuses it unless it verifies. */
export async function fetchVerifiedBeacon(round: number): Promise<Beacon> {
  const b = await (g.__beaconFetcher ?? httpFetcher)(round);
  if (b.round !== round) throw new Error(`drand returned round ${b.round}, wanted ${round}`);
  const v = verifyBeacon(b);
  if (!v.ok) throw new Error(`drand round ${round} failed verification: ${v.reason}`);
  return b;
}

/** BEACON=off disables drand (status "disabled", recorded explicitly). Default: drand. */
export function beaconEnabled(): boolean {
  return process.env.BEACON !== "off";
}

export function beaconTimeoutMs(): number {
  return 1000 * Number(process.env.BEACON_TIMEOUT_S ?? 30);
}
