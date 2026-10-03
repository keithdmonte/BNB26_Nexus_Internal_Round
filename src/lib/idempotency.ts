import { createHash } from "node:crypto";
import type pg from "pg";
import { tx } from "@/lib/db";
import { ApiError, isUniqueViolation } from "@/lib/http";

export interface Outcome {
  status: number;
  body: Record<string, unknown>;
}

export function requestHash(method: string, path: string, body: string): string {
  return createHash("sha256").update(`${method}\n${path}\n${body}`).digest("hex");
}

/**
 * Runs `fn` and records its outcome under (userId, key) in the SAME transaction.
 * - A concurrent request with the same key blocks on the key's unique index until the first commits,
 *   then replays its stored outcome. A crash rolls back both the work and the key, so a retry re-executes.
 * - `fn` throwing ApiError stores nothing (e.g. WINDOW_NOT_OPEN can be retried later with the same key).
 * - A unique violation from `fn` (same user, different key, racing) is retried once; `fn` must then
 *   observe the existing row and return the "already done" outcome.
 */
export async function idempotent(
  userId: string,
  key: string,
  reqHash: string,
  fn: (c: pg.PoolClient) => Promise<Outcome>,
): Promise<Outcome & { replayed: boolean }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await tx(async (c) => {
        const claimed = await c.query(
          `INSERT INTO idempotency_keys (user_id, key, req_hash, state, locked_until)
           VALUES ($1, $2, $3, 'in_progress', now() + interval '30 seconds')
           ON CONFLICT DO NOTHING RETURNING 1`,
          [userId, key, reqHash],
        );
        if (claimed.rowCount === 0) {
          const { rows } = await c.query(
            "SELECT req_hash, status_code, body FROM idempotency_keys WHERE user_id = $1 AND key = $2",
            [userId, key],
          );
          if (rows[0].req_hash !== reqHash) throw new ApiError(422, "IDEMPOTENCY_KEY_MISMATCH");
          return { status: rows[0].status_code, body: rows[0].body, replayed: true };
        }
        const out = await fn(c);
        await c.query(
          "UPDATE idempotency_keys SET state = 'done', status_code = $3, body = $4 WHERE user_id = $1 AND key = $2",
          [userId, key, out.status, out.body],
        );
        return { ...out, replayed: false };
      });
    } catch (e) {
      if (attempt === 0 && isUniqueViolation(e)) continue;
      throw e;
    }
  }
}
