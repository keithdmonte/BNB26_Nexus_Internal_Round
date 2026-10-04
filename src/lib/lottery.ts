import type pg from "pg";
import { pool, tx } from "@/lib/db";
import { computeSeed, entriesHash, publicId, rankEntries, RANK_FN_VERSION } from "@/lib/draw-core";
import { invalidateDrop, type Drop } from "@/lib/drops";
import { ApiError, inetOrNull } from "@/lib/http";
import { scoreEntries } from "@/lib/risk";
import { decryptSecret } from "@/lib/secret";
import { beaconEnabled, beaconTimeoutMs, fetchVerifiedBeacon, QUICKNET, roundAt, roundTime } from "@/lib/beacon";
import { inc } from "@/lib/counters";

function isFrozenError(e: unknown) {
  return (e as { code?: string; message?: string })?.code === "23514" && /entries are frozen/.test((e as Error).message);
}

/**
 * One entry per account. Entry time is recorded for metrics only and has no effect on the outcome.
 * Single autocommit INSERT: the unique (drop_id, user_id) index makes it idempotent, and the stored
 * request_id distinguishes a same-key replay (original 201) from a second attempt (200 alreadyEntered).
 */
export async function enter(
  drop: Drop,
  userId: string,
  meta: { ip: string; deviceFp: string | null },
  key: string,
) {
  if (drop.mode !== "lottery") throw new ApiError(409, "WRONG_MODE", "this drop is first-come-first-served");
  const now = Date.now();
  if (drop.status === "scheduled" || now < drop.opensAt.getTime()) throw new ApiError(409, "WINDOW_NOT_OPEN");
  if (drop.status !== "open" || now >= drop.closesAt.getTime()) throw new ApiError(409, "WINDOW_CLOSED");
  const pid = publicId(drop.publicSalt, userId);
  const p = pool();
  const body = (createdAt: Date) => ({ entry: { publicId: pid, createdAt }, state: "entered" });
  try {
    const ins = await p.query(
      `INSERT INTO entries (drop_id, user_id, public_id, ip, device_fp, request_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (drop_id, user_id) DO NOTHING RETURNING created_at`,
      [drop.id, userId, pid, inetOrNull(meta.ip), meta.deviceFp, key],
    );
    if (ins.rows[0]) {
      inc(drop.id, "entries");
      return { status: 201, body: body(ins.rows[0].created_at), replayed: false };
    }
  } catch (e) {
    if (isFrozenError(e)) {
      inc(drop.id, "window_closed");
      throw new ApiError(409, "WINDOW_CLOSED");
    }
    throw e;
  }
  const ex = await p.query("SELECT created_at, request_id FROM entries WHERE drop_id = $1 AND user_id = $2", [drop.id, userId]);
  inc(drop.id, "duplicate_absorbed");
  if (ex.rows[0].request_id === key) return { status: 201, body: body(ex.rows[0].created_at), replayed: true };
  return { status: 200, body: { ...body(ex.rows[0].created_at), alreadyEntered: true }, replayed: false };
}

async function lockDrop(c: pg.PoolClient, dropId: string, expect: string): Promise<boolean> {
  const l = await c.query("SELECT pg_try_advisory_xact_lock(hashtext('drop:' || $1)) AS ok", [dropId]);
  if (!l.rows[0].ok) return false;
  const s = await c.query("SELECT status FROM drops WHERE id = $1 FOR UPDATE", [dropId]);
  return s.rows[0]?.status === expect;
}

/** Runs risk scoring, fixes the eligible set and publishes its hash. After this no entry can change. */
export async function freeze(dropId: string): Promise<boolean> {
  const done = await tx(async (c) => {
    if (!(await lockDrop(c, dropId, "closed"))) return false;
    const { rows: d } = await c.query("SELECT opens_at, config FROM drops WHERE id = $1", [dropId]);
    const cfg = d[0].config ?? {};
    if (cfg.risk) {
      const { rows } = await c.query(
        `SELECT e.id, e.public_id, e.device_fp, host(u.signup_ip) AS signup_ip, u.created_at
         FROM entries e JOIN users u ON u.id = e.user_id WHERE e.drop_id = $1`,
        [dropId],
      );
      const decisions = scoreEntries(
        rows.map((r) => ({ entryId: r.id, publicId: r.public_id, deviceFp: r.device_fp, signupIp: r.signup_ip, accountCreatedAt: r.created_at })),
        d[0].opens_at,
        cfg.riskPolicy ?? "collapse",
      ).filter((x) => x.status !== "active" || x.clusterId);
      if (decisions.length) {
        await c.query(
          `UPDATE entries e SET status = x.status::entry_status, cluster_id = x.cluster_id, exclusion_reason = x.reason
           FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[]) AS x(id, status, cluster_id, reason)
           WHERE e.id = x.id`,
          [decisions.map((x) => x.entryId), decisions.map((x) => x.status), decisions.map((x) => x.clusterId), decisions.map((x) => x.reason)],
        );
      }
    }
    const { rows: elig } = await c.query("SELECT public_id FROM entries WHERE drop_id = $1 AND status = 'active'", [dropId]);
    const { rows: tot } = await c.query("SELECT count(*)::int n FROM entries WHERE drop_id = $1", [dropId]);
    // Commit to a drand round that is published only AFTER the entry set is fixed (2 periods ahead).
    const beaconRound = beaconEnabled() ? roundAt(Date.now()) + 2 : null;
    await c.query(
      `UPDATE drops SET status = 'frozen', entries_hash = $2, eligible_count = $3, excluded_count = $4, frozen_at = now(),
                        beacon_round = $5, beacon_status = $6
       WHERE id = $1`,
      [dropId, entriesHash(elig.map((r) => r.public_id)), elig.length, tot[0].n - elig.length, beaconRound, beaconRound ? "pending" : "disabled"],
    );
    return true;
  });
  invalidateDrop(dropId);
  return done;
}

type ResolvedBeacon = { status: "drand" | "fallback" | "disabled"; value: string; signature: string | null };

/**
 * Resolves the committed drand round for a frozen drop. Returns null while the draw must wait
 * (round not yet published, or drand unreachable and the retry window has not expired).
 * Never silently uses an empty beacon: fallback and disabled are recorded as such.
 */
async function resolveBeacon(dropId: string, timeoutMs: number): Promise<ResolvedBeacon | null> {
  const p = pool();
  const { rows } = await p.query(
    "SELECT status, beacon_round, beacon_status, beacon_first_try_at FROM drops WHERE id = $1",
    [dropId],
  );
  const d = rows[0];
  if (!d || d.status !== "frozen") return null;
  if (d.beacon_status === "disabled" || d.beacon_round == null) return { status: "disabled", value: "", signature: null };
  const round = Number(d.beacon_round);
  if (Date.now() < roundTime(round)) return null; // committed round not published yet
  try {
    const b = await fetchVerifiedBeacon(round);
    return { status: "drand", value: b.randomness, signature: b.signature };
  } catch (e) {
    const first = d.beacon_first_try_at
      ? new Date(d.beacon_first_try_at).getTime()
      : (await p.query("UPDATE drops SET beacon_first_try_at = coalesce(beacon_first_try_at, now()) WHERE id = $1 RETURNING beacon_first_try_at", [dropId])).rows[0].beacon_first_try_at.getTime();
    if (Date.now() - first >= timeoutMs) {
      console.warn(`[draw] drop ${dropId}: drand round ${round} unavailable after ${timeoutMs}ms (${(e as Error).message}); falling back to commit-reveal only`);
      return { status: "fallback", value: "", signature: null };
    }
    if (!d.beacon_first_try_at) console.warn(`[draw] drop ${dropId}: drand round ${round} not available (${(e as Error).message}); retrying for up to ${timeoutMs}ms`);
    return null;
  }
}

/**
 * The draw: one transaction. Deterministic in (secret, frozen entries, committed drand round), so a crash
 * simply means "run it again" and yields the identical result. `crashAfterRanks` is a test hook for that claim.
 * Returns false when there is nothing to do yet (not frozen, or still waiting for the beacon).
 */
export async function draw(dropId: string, opts: { crashAfterRanks?: boolean; beaconTimeoutMs?: number } = {}): Promise<boolean> {
  const beacon = await resolveBeacon(dropId, opts.beaconTimeoutMs ?? beaconTimeoutMs());
  if (!beacon) return false;
  const done = await tx(async (c) => {
    if (!(await lockDrop(c, dropId, "frozen"))) return false;
    const { rows: d } = await c.query("SELECT inventory, secret_enc, entries_hash FROM drops WHERE id = $1", [dropId]);
    const secretHex = decryptSecret(d[0].secret_enc).toString("hex");
    const { rows: entries } = await c.query(
      "SELECT id, user_id, public_id FROM entries WHERE drop_id = $1 AND status = 'active'",
      [dropId],
    );
    const pids = entries.map((e) => e.public_id);
    if (entriesHash(pids) !== d[0].entries_hash) throw new Error("eligible set changed after freeze");
    const seed = computeSeed(secretHex, d[0].entries_hash, beacon.value);
    const byPid = new Map(entries.map((e) => [e.public_id, e]));
    const ranked = rankEntries(seed, pids);
    await c.query(
      `INSERT INTO draw_ranks (drop_id, entry_id, rank, rank_key)
       SELECT $1, x.entry_id, x.rank, decode(x.k, 'hex') FROM unnest($2::uuid[], $3::int[], $4::text[]) AS x(entry_id, rank, k)`,
      [dropId, ranked.map((r) => byPid.get(r.publicId)!.id), ranked.map((_, i) => i), ranked.map((r) => r.key)],
    );
    if (opts.crashAfterRanks) throw new Error("injected crash mid-draw");
    const winners = ranked.slice(0, d[0].inventory).map((r) => byPid.get(r.publicId)!);
    // Auto-confirm (Lean MVP): winners get seat 1..k in rank order.
    await c.query(
      `WITH w AS (SELECT * FROM unnest($2::uuid[], $3::uuid[]) WITH ORDINALITY AS x(entry_id, user_id, ord)),
            s AS (UPDATE seats SET held = true WHERE drop_id = $1 AND seat_no <= $4 RETURNING id, seat_no)
       INSERT INTO allocations (drop_id, seat_id, user_id, entry_id, rank, status, confirmed_at)
       SELECT $1, s.id, w.user_id, w.entry_id, w.ord - 1, 'confirmed', now() FROM w JOIN s ON s.seat_no = w.ord`,
      [dropId, winners.map((w) => w.id), winners.map((w) => w.user_id), winners.length],
    );
    await c.query(
      `UPDATE drops SET status = 'drawn', seed = $2, beacon_value = $5, beacon_signature = $6, beacon_status = $7,
                        secret_revealed = $3, drawn_at = now(), rank_fn_version = $4
       WHERE id = $1`,
      [dropId, seed, Buffer.from(secretHex, "hex"), RANK_FN_VERSION, beacon.value, beacon.signature, beacon.status],
    );
    return true;
  });
  invalidateDrop(dropId);
  return done;
}

export async function audit(dropId: string) {
  const p = pool();
  const { rows } = await p.query(
    `SELECT id, inventory, status, commit, encode(secret_revealed, 'hex') AS secret, encode(public_salt, 'hex') AS salt,
            entries_hash, eligible_count, excluded_count, seed, beacon_value, beacon_round, beacon_status, beacon_signature,
            rank_fn_version, frozen_at, drawn_at
     FROM drops WHERE id = $1`,
    [dropId],
  );
  const d = rows[0];
  if (!d) return null;
  const beacon = {
    source: d.beacon_status === "drand" || d.beacon_status === "pending" ? "drand-quicknet" : "none",
    status: d.beacon_status ?? "none",
    chainHash: QUICKNET.chainHash,
    round: d.beacon_round == null ? null : Number(d.beacon_round),
    value: d.beacon_value ?? "",
    signature: d.beacon_signature ?? null,
  };
  const base = { dropId: d.id, rankFnVersion: d.rank_fn_version, inventory: d.inventory, status: d.status, commit: d.commit, beacon };
  if (!["drawn", "claim", "done"].includes(d.status)) return base;
  const [elig, excl, win] = await Promise.all([
    p.query("SELECT public_id FROM entries WHERE drop_id = $1 AND status = 'active' ORDER BY public_id", [dropId]),
    p.query("SELECT status, exclusion_reason, count(*)::int n FROM entries WHERE drop_id = $1 AND status <> 'active' GROUP BY 1, 2", [dropId]),
    p.query(
      `SELECT a.rank, e.public_id FROM allocations a JOIN entries e ON e.id = a.entry_id
       WHERE a.drop_id = $1 AND a.status = 'confirmed' ORDER BY a.rank`,
      [dropId],
    ),
  ]);
  return {
    ...base,
    secret: d.secret,
    entriesHash: d.entries_hash,
    eligibleCount: d.eligible_count,
    excluded: { count: d.excluded_count, byReason: excl.rows.map((r) => ({ status: r.status, reason: r.exclusion_reason, n: r.n })) },
    seed: d.seed,
    frozenAt: d.frozen_at,
    drawnAt: d.drawn_at,
    eligiblePublicIds: elig.rows.map((r) => r.public_id),
    winners: win.rows.map((r) => ({ rank: r.rank, publicId: r.public_id })),
  };
}

/** The user's state for this drop; the client rebuilds every screen from this. */
export async function myState(drop: Drop, userId: string) {
  const p = pool();
  const [alloc, entry] = await Promise.all([
    p.query(
      `SELECT a.id, s.seat_no, a.status FROM allocations a JOIN seats s ON s.id = a.seat_id
       WHERE a.drop_id = $1 AND a.user_id = $2 AND a.status IN ('offered','confirmed')`,
      [drop.id, userId],
    ),
    drop.mode === "lottery"
      ? p.query(
          `SELECT e.public_id, e.created_at, e.status, r.rank FROM entries e
           LEFT JOIN draw_ranks r ON r.entry_id = e.id WHERE e.drop_id = $1 AND e.user_id = $2`,
          [drop.id, userId],
        )
      : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
  ]);
  const a = alloc.rows[0];
  const e = entry.rows[0];
  const drawn = ["drawn", "claim", "done"].includes(drop.status);
  let state: string;
  if (a) state = "confirmed";
  else if (drop.mode !== "lottery") state = drop.status === "open" ? "not_purchased" : "sold_out";
  else if (!e) state = drop.status === "open" || drop.status === "scheduled" ? "not_entered" : "missed";
  else if (e.status !== "active") state = drawn ? "lost" : "under_review";
  else state = drawn ? "lost" : "entered";
  return {
    state,
    dropStatus: drop.status,
    entry: e ? { publicId: e.public_id, createdAt: e.created_at } : null,
    allocation: a ? { id: a.id, seatNo: a.seat_no, status: a.status } : null,
    rank: drawn && e?.rank != null ? e.rank : null,
  };
}
