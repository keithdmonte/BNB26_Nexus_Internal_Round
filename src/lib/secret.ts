import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Draw secrets are stored encrypted so a DB read before the draw cannot reveal the seed.
function key() {
  const k = process.env.DRAW_KEY;
  if (!k || k.length < 16) throw new Error("DRAW_KEY missing or too short");
  return createHash("sha256").update(k).digest();
}

export function encryptSecret(secret: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(secret), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

export function decryptSecret(blob: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", key(), blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}
