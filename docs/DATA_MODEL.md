# Data Model (as built)

Postgres only; there is no Redis. Migrations are in `db/migrations/` (001–004, 006), applied by `npm run migrate`. `005` is reserved by the `feature/phone-verification` branch.

## Enums
```
drop_mode         lottery | fcfs | fcfs_unsafe
drop_status       scheduled | open | closed | frozen | drawn | claim | done   (claim is unused)
entry_status      active | excluded | collapsed
allocation_status offered | confirmed | expired | released                  (only confirmed is written today)
```

## Tables
### `users`
`id uuid PK`, `email text UNIQUE (lowercase)`, `verified_at`, `created_at`, `signup_ip inet NULL`, `device_fp text NULL`, `is_sim bool`.
Indexes: `created_at`, `signup_ip`, `device_fp`.

### `drops`
| Column | Notes |
|---|---|
| `id`, `name`, `mode`, `inventory > 0`, `status`, `opens_at < closes_at` | |
| `config jsonb` | `rateLimit` (default on), `risk`, `riskPolicy` (`collapse`/`exclude`), `hidden`, `demo` |
| `public_salt bytea` | For `entries.public_id = HMAC(salt, user_id)` |
| `commit` | SHA-256 of the draw secret, published at creation |
| `secret_enc` / `secret_revealed` | AES-GCM encrypted secret / plaintext after the draw |
| `entries_hash`, `eligible_count`, `excluded_count`, `frozen_at` | Set at freeze |
| `beacon_round`, `beacon_status`, `beacon_value`, `beacon_signature`, `beacon_first_try_at` | drand commitment and result (006). Status: `pending`, `drand`, `fallback`, `disabled` |
| `seed`, `rank_fn_version`, `drawn_at` | Set at draw |
| `claim_ttl_s` | Unused (no claim step) |

### `seats`
`id`, `drop_id`, `seat_no`, `held bool`. `UNIQUE (drop_id, seat_no)`. Exactly `inventory` rows per drop. Partial index `seats_free (drop_id, seat_no) WHERE NOT held`.

### `entries`
`id`, `drop_id`, `user_id`, `public_id`, `status`, `exclusion_reason`, `cluster_id`, `risk_score` (unused), `ip inet NULL`, `device_fp`, `challenge_ok` (unused), `request_id` (idempotency key), `created_at` (metrics only; never read by the draw).
`UNIQUE (drop_id, user_id)`, `UNIQUE (drop_id, public_id)`, indexes on `(drop_id, status)`, `(drop_id, ip)`, `(drop_id, device_fp)`.
**Trigger `entries_guard`:** takes `SELECT … FOR SHARE` on the drop row. INSERT is allowed only while `open`; UPDATE only while `open` or `closed`.

### `draw_ranks`
`(drop_id, rank)` PK, `UNIQUE (drop_id, entry_id)`, `rank_key bytea`. Full ordering of every eligible entry.

### `allocations`
`id`, `drop_id`, `seat_id → seats`, `user_id`, `entry_id NULL`, `rank NULL`, `status`, `offered_at`, `expires_at` (unused), `confirmed_at`, `request_id`.
```sql
UNIQUE (seat_id)          WHERE status IN ('offered','confirmed')   -- one_active_per_seat
UNIQUE (drop_id, user_id) WHERE status IN ('offered','confirmed')   -- one_active_per_user
```

### `allocations_unsafe`
Same shape **without** the unique indexes. Written only by `fcfs_unsafe`, so its oversell is visible to the checker.

### `idempotency_keys`
`(user_id, key)` PK, `req_hash`, `state`, `status_code`, `body`, `locked_until`, `created_at`. Used by FCFS purchase inside the purchase transaction. Lottery entries use `entries.request_id` instead.

### `sim_runs` / `sim_labels`
- `sim_runs`: `id`, `scenario`, `seed`, `config`, `drop_id`, `started_at`, `ended_at`, `report jsonb`, `archived bool` (004).
- `sim_labels`: `(run_id, user_id)` PK, `actor_type`, `operator_id`. Ground truth. Read only by `src/lib/report.ts`, never by defense code.

### Present but unused
`events`, `metric_snapshots` (counters are in memory), `entries.risk_score`, `entries.challenge_ok`, `drops.claim_ttl_s`, `allocations.expires_at`.

## In-memory state (per process, lost on restart)
| What | Module |
|---|---|
| Token buckets `u:{write|read}:{userId}`, `ip:{ip}`, `admin-login` | `src/lib/ratelimit.ts` |
| Per-drop counters (`entries`, `rate_limited_user`, `rate_limited_ip`, `duplicate_absorbed`, …) | `src/lib/counters.ts` |
| Drop row cache (250ms), count caches `drops:list` and `entries:{id}` (250ms, single-flight) | `src/lib/drops.ts`, `src/lib/cache.ts` |
| FCFS sold-out flag | `src/lib/fcfs.ts` |
