# Allocation Design

> **Deadline build:** BUILD_PLAN.md "Lean MVP" overrides this doc where they differ (single Next.js service + Postgres, no Redis, signed-cookie sessions, poll instead of SSE, auto-confirm, no drand). This doc describes the target design.

## Modes
| Mode | Who wins | Purpose |
|---|---|---|
| `lottery` | Random among eligible entries | The Fair Drop design |
| `fcfs` | First successful request | Naive baseline. Correct inventory, unfair outcome |
| `fcfs_unsafe` | First successful request, with a race | Shows that the integrity checks detect overselling |

## Lottery algorithm

### 1. Setup (before `opens_at`)
- Generate `secret` = 32 random bytes from `crypto.randomBytes`.
- Store `secret` encrypted (or in a worker-only env-scoped table column) and publish `commit = SHA256(secret)` on `GET /api/drops/:id`.
- Publish the parameters: `inventory`, `opens_at`, `closes_at`, `beacon` source and how the round will be chosen, and the ranking function version.

### 2. Entry window (`open`)
- Accept at most one entry per `(drop_id, user_id)`, enforced by a unique index.
- Entry time is recorded for metrics only. **It has no effect on the outcome.**
- The window is enforced server-side: the app checks `drop.status = 'open'`, and the worker flips the status at `closes_at` using the DB clock. Client clocks are display-only.

### 3. Close and freeze
1. At `closes_at` the worker sets `status = closed`. Inserts that are in flight finish. Any insert that commits after the flip is still accepted if it started before the flip; the freeze step reads the committed set after a short drain of `max_request_time` (5s).
2. Risk scoring runs (ABUSE_DEFENSE.md) and sets `entries.status = excluded` with a reason, or collapses clusters.
3. `entries_hash = SHA256(join("\n", sorted(entry_public_id for eligible entries)))`. `entry_public_id = HMAC(drop_salt, user_id)`, which is published so users can check their inclusion without exposing their identity.
4. `status = frozen`. No entry can be added or excluded after this point (a DB trigger rejects changes when the drop is frozen or later).

### 4. Seed
```
beacon = drand round value for the first round whose timestamp > frozen_at   (optional)
seed   = SHA256( secret || entries_hash || beacon )
```
- The server cannot choose a favourable seed. `secret` was committed before entries existed, the entry set is fixed before `beacon` is known, and `beacon` is public and unpredictable.
- Users cannot predict the seed, because `secret` is hidden until after the draw.
- If drand is unreachable, `beacon = ""` and that fact is recorded. This mode is weaker: the operator could in theory insert entries before freeze, which the commit alone does not prevent. Listed in OPEN_QUESTIONS.

### 5. Ranking
```
rank_key(entry) = SHA256( seed || entry_public_id )      // 32 bytes
ordered = sort eligible entries by rank_key ascending (ties impossible in practice; tie-break by entry_public_id)
winners  = ordered[0 .. inventory-1]
waitlist = ordered[inventory ..]
```
- This is equivalent to a uniform random permutation as long as SHA256 behaves as a random oracle. There is no PRNG state and no Fisher-Yates implementation detail to get wrong.
- Each eligible entry has the same probability, `inventory / eligible_count`.

### 6. Commit draw (single transaction, worker)
```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('draw:' || $drop_id));
-- abort if drops.status <> 'frozen'  (already drawn: no-op)
INSERT INTO draw_ranks (drop_id, entry_id, rank, rank_key) VALUES ... ;       -- all eligible
INSERT INTO allocations (drop_id, seat_id, user_id, entry_id, status, rank, expires_at)
  SELECT ... top N joined to seats ordered by seat_no;                          -- status 'offered'
UPDATE drops SET status='drawn', seed=$seed, beacon_round=$r, beacon_value=$b, drawn_at=now();
COMMIT;
```
After commit: `UPDATE drops SET secret_revealed=secret, status='claim'`, then publish `result_ready`.

### 7. Claim and waitlist
- An offer expires at `expires_at` (configurable `claim_ttl_s`; 0 means auto-confirm, which skips claiming).
- `confirm` is a conditional `UPDATE ... WHERE status='offered' AND expires_at > now()`. Exactly one of "confirm" and "expire" can win, because both update the same row with mutually exclusive predicates.
- The expiry job runs in one transaction per seat: mark the offer `expired`, select the next waitlist entry by rank that has no active allocation (`FOR UPDATE SKIP LOCKED`), and insert a new `offered` allocation for the same seat.
- Promotion order is the published ranking, so it is auditable too.

### 8. Auditability
`GET /api/drops/:id/audit` returns: `commit`, `secret` (after reveal), `entries_hash`, the full eligible `entry_public_id` list, the excluded count by reason, the beacon round and value, `seed`, the ranked winner list, and the ranking function version. `scripts/verify` recomputes everything offline and diffs.

**What the audit does not prove:** that excluded entries were excluded fairly (the exclusion rules are published, but per-entry evidence is private), and that accounts are real people.

## Integrity guarantees

| Invariant | Enforcement |
|---|---|
| No overselling | Allocations must reference a `seats` row (FK). There are exactly `inventory` seat rows. A partial unique index `(seat_id) WHERE status IN ('offered','confirmed')` permits only one active holder per seat. |
| No double allocation | Partial unique index `(drop_id, user_id) WHERE status IN ('offered','confirmed')`. |
| One entry per account | Unique `(drop_id, user_id)` on `entries`. |
| No entry after freeze | App check plus a DB trigger on `entries` that rejects insert/update when `drops.status NOT IN ('open','closed')`. |
| Draw happens once | Advisory lock plus a status check inside the transaction, plus unique `(drop_id, entry_id)` on `draw_ranks`. |
| Consistent inventory | Checker query: `count(active allocations) + count(free seats) = inventory`, and the Redis FCFS counter equals the PG free-seat count when idle. Runs every 5s during scenarios and is reported as a metric. |

## Race conditions considered
| Race | Outcome |
|---|---|
| Same user double-clicks Enter (two requests in parallel) | The idempotency `SET NX` lets one proceed. The other gets 409 `IN_PROGRESS` and the client retries, receiving the replayed response. Even without idempotency, the unique index keeps one row. |
| Same user, two tabs, different idempotency keys | The unique index wins; the second request gets 200 `already_entered`. |
| Entry arrives during the close flip | The app status check plus the trigger decide. Accepted rows are counted before freeze because freeze waits out a drain interval. Rejected requests get 409 `WINDOW_CLOSED`. |
| Two workers both try to draw | The advisory lock serialises them. The second sees `status <> 'frozen'` and exits. |
| Worker crashes mid-draw | The transaction rolls back. On restart the status is still `frozen`, and re-running gives the same seed and the same result (deterministic). |
| Worker crashes after commit, before revealing the secret | On restart: `status='drawn'` and the secret is not revealed, so it reveals. Idempotent. |
| Confirm races with expiry | Mutually exclusive conditional updates on one row. Exactly one succeeds. |
| Two promotions grab the same waitlist user | `SKIP LOCKED` plus the per-user partial unique index. |
| FCFS: 10k parallel purchases for the last seat | The Lua script is atomic, so exactly one passes the gate. The PG seat claim `SKIP LOCKED` is the backstop. |
| FCFS: Redis says success, PG insert fails | The app runs `INCR` compensation, removes the user from buyers, and returns 503. The user is not shown success unless PG committed. |
| Redis restarts mid FCFS sale | Counter rebuilt from PG free seats. The PG constraints still prevent any oversell. |
| Clock skew between app replicas | Window decisions use `drops.status` set by the worker from the DB `now()`, not local clocks. |
