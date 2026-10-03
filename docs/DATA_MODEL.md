# Data Model

> **Deadline build:** BUILD_PLAN.md "Lean MVP" overrides this doc where they differ (single Next.js service + Postgres, no Redis, signed-cookie sessions, poll instead of SSE, auto-confirm, no drand). This doc describes the target design.

## Postgres

### Enums
```sql
drop_mode        : 'lottery' | 'fcfs' | 'fcfs_unsafe'
drop_status      : 'scheduled' | 'open' | 'closed' | 'frozen' | 'drawn' | 'claim' | 'done'
entry_status     : 'active' | 'excluded' | 'collapsed'
allocation_status: 'offered' | 'confirmed' | 'expired' | 'released'
```

### `users`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| email | citext UNIQUE | |
| verified_at | timestamptz NULL | Must be set before the user can enter |
| created_at | timestamptz default now() | Risk signal |
| signup_ip | inet | Risk signal |
| device_fp | text NULL | Last seen fingerprint hash |
| is_sim | boolean default false | Sim-created account (does not say bot vs human) |

Indexes: `(created_at)`, `(signup_ip)`, `(device_fp)`.

### `drops`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text | |
| mode | drop_mode | |
| inventory | int CHECK > 0 | |
| status | drop_status | |
| opens_at, closes_at | timestamptz | CHECK closes_at > opens_at |
| claim_ttl_s | int default 300 | 0 means auto-confirm |
| config | jsonb | Defense toggles, rate limits, risk policy, PoW on/off |
| public_salt | bytea | For `entry_public_id` |
| commit | text | SHA256(secret), hex |
| secret_enc | bytea | Encrypted with `DRAW_KEY`, readable by the worker only |
| secret_revealed | bytea NULL | Set after the draw |
| entries_hash | text NULL | |
| eligible_count, excluded_count | int NULL | |
| beacon_round | bigint NULL | |
| beacon_value | text NULL | |
| seed | text NULL | |
| rank_fn_version | text | `"sha256-v1"` |
| frozen_at, drawn_at | timestamptz NULL | |

### `seats`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| drop_id | uuid FK → drops | |
| seat_no | int | |

`UNIQUE (drop_id, seat_no)`. There are exactly `inventory` rows, created with the drop.

### `entries`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| drop_id | uuid FK | |
| user_id | uuid FK | |
| public_id | text | HMAC(public_salt, user_id), hex |
| status | entry_status default 'active' | |
| exclusion_reason | text NULL | |
| cluster_id | text NULL | |
| risk_score | real NULL | |
| ip | inet | |
| device_fp | text NULL | |
| challenge_ok | boolean | |
| created_at | timestamptz | Metrics only |

`UNIQUE (drop_id, user_id)`, `UNIQUE (drop_id, public_id)`, index `(drop_id, status)`, index `(drop_id, ip)`, index `(drop_id, device_fp)`.
Trigger `entries_guard`: reject INSERT/UPDATE unless the parent `drops.status IN ('open','closed')`. Exception: exclusion updates while `closed`.

### `draw_ranks`
| Column | Type |
|---|---|
| drop_id | uuid FK |
| entry_id | uuid FK |
| rank | int |
| rank_key | bytea |

PK `(drop_id, rank)`, `UNIQUE (drop_id, entry_id)`.

### `allocations`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| drop_id | uuid FK | |
| seat_id | uuid FK → seats | |
| user_id | uuid FK | |
| entry_id | uuid FK NULL | NULL in FCFS |
| rank | int NULL | Lottery rank |
| status | allocation_status | |
| offered_at | timestamptz | |
| expires_at | timestamptz NULL | |
| confirmed_at | timestamptz NULL | |
| request_id | text NULL | Idempotency key that created it (FCFS) |

**Integrity indexes:**
```sql
CREATE UNIQUE INDEX one_active_per_seat ON allocations (seat_id)
  WHERE status IN ('offered','confirmed');
CREATE UNIQUE INDEX one_active_per_user ON allocations (drop_id, user_id)
  WHERE status IN ('offered','confirmed');
CREATE INDEX alloc_expiry ON allocations (drop_id, expires_at) WHERE status = 'offered';
```
In `fcfs_unsafe` mode we write to `allocations_unsafe`, a copy **without** these unique indexes. Otherwise the DB would block the oversell we are trying to demonstrate.

### `events` (append-only, source for metrics)
| Column | Type |
|---|---|
| id | bigserial PK |
| drop_id | uuid |
| user_id | uuid NULL |
| ip | inet NULL |
| type | text (`entry_created`, `entry_duplicate`, `rate_limited`, `window_closed`, `purchase_ok`, `sold_out`, `confirmed`, `expired`, `promoted`, `excluded`, `draw_committed`, ...) |
| reason | text NULL |
| at | timestamptz |

Index `(drop_id, type, at)`. High-volume `rate_limited` events are counted in Redis and snapshotted, not inserted per request.

### `metric_snapshots`
`(drop_id, run_id NULL, at, data jsonb)`. Written by the worker every 5s while a drop is active.

### Simulator tables (ground truth, isolated)
- `sim_runs(id uuid PK, scenario text, seed bigint, config jsonb, drop_id uuid, started_at, ended_at, report jsonb)`
- `sim_labels(run_id, user_id, actor_type text ('human'|'fast_bot'|'flooder'|'retrier'|'multi'|'rotator'), operator_id text NULL)`, PK `(run_id, user_id)`.

The defense code's DB role has **no SELECT** on `sim_labels`. Only the metrics/report role can read it. This keeps detection honest.

## Redis
| Key | Type | TTL | Purpose |
|---|---|---|---|
| `sess:{sid}` | hash `{userId, createdAt}` | 24h sliding | Session |
| `rl:{scope}:{id}` | hash `{tokens, ts}` | 60s | Token bucket (Lua) |
| `idem:{userId}:{key}` | string JSON `{state, reqHash, status, body}` | 24h | Idempotency |
| `drop:{id}` | hash (status, window, mode, config) | 5s | Hot drop config cache |
| `fcfs:{id}:remaining` | int | none | FCFS gate counter |
| `fcfs:{id}:buyers` | set | none | FCFS one-per-user gate |
| `cnt:{dropId}` | hash of counters (`req_total`, `rate_limited_user`, `rate_limited_ip`, `entries`, `dupes`, `errors_5xx`, ...) | none | Live metrics |
| `sig:{dropId}:ip:{ip}` | set of userIds | drop lifetime | Clustering input |
| `sig:{dropId}:fp:{fp}` | set of userIds | drop lifetime | Clustering input |
| `sig:{dropId}:timing:{userId}` | list of last 20 request timestamps | drop lifetime | Timing regularity |
| `chal:{nonce}` | string `{userId, dropId}` | 120s | Challenge / PoW nonce (single use) |
| `status:{dropId}:{userId}` | string JSON | 10s | Cached result for polling |
| channel `drop:{id}:events` | pub/sub | n/a | Fan-out to SSE on all replicas |

Persistence: AOF `everysec` if Railway allows it. Correctness never depends on Redis surviving.

## Lean MVP additions (Postgres replaces Redis)
### `idempotency_keys`
| Column | Type | Notes |
|---|---|---|
| user_id | uuid | |
| key | text | |
| req_hash | text | SHA256(method+path+body) |
| state | text | `in_progress` \| `done` |
| status_code | int NULL | |
| body | jsonb NULL | |
| locked_until | timestamptz | Takeover allowed after 30s (crashed request) |
| created_at | timestamptz | Purged after 24h |

PK `(user_id, key)`. Claimed by `INSERT ... ON CONFLICT DO NOTHING`. Conflict means replay, `IN_PROGRESS`, or `MISMATCH`.

Other Redis uses in the MVP:
- Rate limits: in-memory token buckets (single instance).
- Sessions: signed JWT cookie, no store.
- FCFS gate: PG `SKIP LOCKED`.
- Counters: `events` table plus in-memory counters snapshotted to `metric_snapshots`.
