# Allocation Design (as built)

## Modes
| Mode | Who wins | Purpose |
|---|---|---|
| `lottery` | Random among eligible entries | The Fair Drop design |
| `fcfs` | First successful request | Naive baseline. Correct inventory, unfair outcome |
| `fcfs_unsafe` | First successful request, with a race | Shows that the integrity checker detects overselling. It adds an artificial 0–10ms delay between check and write to widen the race. |

## Lottery algorithm
Code: `src/lib/lottery.ts`, `src/lib/draw-core.ts`, `src/lib/beacon.ts`.

### 1. Setup (`createDrop`)
- `secret` = 32 bytes from `crypto.randomBytes`, stored AES-256-GCM encrypted (`DRAW_KEY`).
- `commit = SHA256(secret)` is published immediately on `GET /api/drops/:id` and in the audit.
- Exactly `inventory` seat rows are created.

### 2. Entry window (`open`)
- One entry per `(drop_id, user_id)`, enforced by a unique index.
- `public_id = HMAC-SHA256(public_salt, user_id)`, so users can find themselves in the published list without exposing their account.
- Entry time is stored for metrics only. **The draw never reads it.**
- The window is enforced in the database: trigger `entries_guard` takes `FOR SHARE` on the drop row and rejects inserts unless `status = 'open'`. The scheduler moves `open → closed` with an UPDATE that **waits for every in-flight insert holding that share lock**, so nothing can commit into a closed drop. No drain interval is needed.

### 3. Freeze (`freeze`)
1. Optional clustering (`config.risk`, ABUSE_DEFENSE D6): entries are marked `collapsed` or `excluded` with a reason.
2. `entries_hash = SHA256(join("\n", sorted(public_id of active entries)))`.
3. **Beacon commitment:** `beacon_round = roundAt(now) + 2`, a drand quicknet round published about 3–6s *after* the entry set is fixed. `beacon_status = 'pending'`; with `BEACON=off` it is recorded as `disabled` instead.
4. `status = 'frozen'`. After this the trigger rejects any entry change.

### 4. Beacon (`resolveBeacon`, outside any transaction)
- Wait until `roundTime(beacon_round)` has passed.
- Fetch the round from `DRAND_URL` (default `https://api.drand.sh`) and **verify** it: `randomness == SHA256(signature)`, and a valid BLS signature (`bls-unchained-g1-rfc9380`) on `SHA256(uint64be(round))` under the quicknet public key. An unverified response is never used.
- If drand is unreachable or fails verification, retry each scheduler tick for `BEACON_TIMEOUT_S` (default 30s). Then fall back: `beacon_status = 'fallback'`, `beacon_value = ''`. **The fallback is recorded explicitly** and shown in the audit and the verifier output as "beacon: none (fallback)".

### 5. Seed
```
seed = SHA256( secret || entries_hash || beacon_randomness_hex )      // beacon part is "" only for fallback/disabled
```
- **The operator can't choose the outcome.** The secret was committed before entries existed, and the drand round is unknown until after the entry set (and its hash) is frozen. Adding or removing fake entries before freeze changes `entries_hash`, but without knowing the future randomness the operator can't tell which set would favour anyone.
- **Users can't predict it**, because the secret is hidden until the draw.
- **Fallback is weaker:** without the beacon, an operator who knows the secret could grind fake entries before freeze to steer the seed. The audit flags fallback draws so this is visible.

### 6. Ranking and commit (`draw`, one transaction)
```
rank_key(entry) = SHA256( seed + ":" + public_id )
ordered = sort active entries by rank_key ascending (tie-break by public_id)
winners = ordered[0 .. inventory-1]      // auto-confirmed into seats 1..k in rank order
```
Inside one transaction:
1. Advisory lock, then recheck `status = 'frozen'`.
2. Recheck `entries_hash`.
3. Insert every rank into `draw_ranks`.
4. Mark the seats held and insert the `confirmed` allocations.
5. Set `status = 'drawn'` and store the seed, the beacon fields and `secret_revealed`.

This is equivalent to a uniform random permutation as long as SHA-256 behaves as a random oracle, so each active entry wins with probability `inventory / eligible_count`.

### 7. Claim and waitlist: **not built**
Winners are auto-confirmed. `draw_ranks` keeps the full order, so waitlist promotion could be added later in published rank order.

### 8. Audit and verification
`GET /api/drops/:id/audit` returns the commit, the secret, the entries hash and full eligible `public_id` list, the exclusion counts by reason, the beacon (round, randomness, signature, status), the seed and the winners.

`npm run verify -- <audit URL>` (`src/lib/verify-core.ts`) checks:
- the secret against the commit;
- the hash against the list;
- the drand BLS signature, and that the randomness matches an **independent fetch from drand**;
- the seed;
- the winners, by recomputing the ranking.

**The audit does not prove** that exclusions were fair (rules are published, per-entry evidence is not), or that accounts are distinct people.

## Integrity guarantees
| Invariant | Enforcement |
|---|---|
| No overselling | Exactly `inventory` seat rows; allocations FK to seats; partial unique `one_active_per_seat`. FCFS claims seats with `UPDATE seats SET held = true WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`. |
| No double allocation | Partial unique `one_active_per_user (drop_id, user_id)`. |
| One entry per account | `UNIQUE (drop_id, user_id)` on `entries`. |
| No entry after close | Trigger `entries_guard` (FOR SHARE on the drop row). |
| Draw happens once | Advisory lock, status recheck, `UNIQUE (drop_id, entry_id)` on `draw_ranks`. |
| Consistent inventory | `checkIntegrity()`: active allocations = held seats ≤ inventory, no duplicate users or seats. Run at the end of every simulator run and live on the dashboard. |

## Race conditions considered
| Race | Outcome |
|---|---|
| Same user, 50 parallel entries, different keys | One row (unique index). Live check: 1×201, 4×200 already entered, 45×429. |
| Same user, same key in parallel | Lottery: one insert, the rest read the row and replay 201. FCFS: the second transaction blocks on the idempotency row, then replays. |
| Entry in flight while the window closes | The close UPDATE waits for it. It either commits before close (counted in freeze) or is rejected afterwards with 409 `WINDOW_CLOSED`. |
| Stale 250ms drop cache says open | The trigger is authoritative and rejects with `WINDOW_CLOSED` (tested). |
| Two scheduler ticks or instances draw at once | `pg_try_advisory_xact_lock` plus status recheck; the loser is a no-op. |
| Crash mid-draw | Rollback; the re-run uses the same secret, entries and committed round, so the result is identical (tested with an injected crash, including the drand path). |
| drand returns a forged or tampered round | BLS verification fails, so it is never used; the draw waits, then falls back explicitly (tested). |
| FCFS: thousands race for the last seats | `SKIP LOCKED` hands each free seat to one transaction; up to 4 retries when the claim comes up empty while other transactions hold seats. Exactly 500 sold out of 2,000 racers (tested). |
| Clock skew | Window transitions compare against the database `now()` in the scheduler. Clients use a server-time offset for display only. |
