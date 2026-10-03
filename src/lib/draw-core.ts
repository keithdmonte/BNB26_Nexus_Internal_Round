// Pure, dependency-free draw math. Shared verbatim by the server and scripts/verify.ts,
// so anyone holding the audit JSON can recompute the result. Spec: docs/ALLOCATION_DESIGN.md.
import { createHash, createHmac } from "node:crypto";

export const RANK_FN_VERSION = "sha256-v1";

const sha256hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Pseudonymous entry id: users can find themselves in the published list without exposing user ids. */
export function publicId(saltHex: string, userId: string): string {
  return createHmac("sha256", Buffer.from(saltHex, "hex")).update(userId).digest("hex");
}

export function commitOf(secretHex: string): string {
  return sha256hex(Buffer.from(secretHex, "hex"));
}

export function entriesHash(publicIds: string[]): string {
  return sha256hex([...publicIds].sort().join("\n"));
}

/** seed = SHA256(secret || entries_hash || beacon). Secret committed before entries; entries fixed before reveal. */
export function computeSeed(secretHex: string, entriesHashHex: string, beacon = ""): string {
  return sha256hex(Buffer.concat([Buffer.from(secretHex, "hex"), Buffer.from(entriesHashHex, "utf8"), Buffer.from(beacon, "utf8")]));
}

export function rankKey(seedHex: string, pid: string): string {
  return sha256hex(`${seedHex}:${pid}`);
}

/** Uniform random permutation: sort by SHA256(seed:publicId). Ties (practically impossible) break by publicId. */
export function rankEntries(seedHex: string, publicIds: string[]): { publicId: string; key: string }[] {
  return publicIds
    .map((p) => ({ publicId: p, key: rankKey(seedHex, p) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.publicId < b.publicId ? -1 : 1));
}
