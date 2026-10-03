# API Spec

> **Deadline build:** BUILD_PLAN.md "Lean MVP" overrides this doc where they differ (single Next.js service + Postgres, no Redis, signed-cookie sessions, poll instead of SSE, auto-confirm, no drand). This doc describes the target design.

Base: `/api`. JSON only. Auth via the `sid` cookie unless stated otherwise. Time values are ISO 8601 UTC. Every response includes `serverTime`.

## Conventions

### Idempotency
- **Required** on every `POST` that changes state: header `Idempotency-Key: <uuid v4>`. A missing key returns 400 `IDEMPOTENCY_KEY_REQUIRED`.
- Scope: `(userId, key)`, stored in Redis for 24h with `reqHash = SHA256(method + path + body)`.

| Situation | Response |
|---|---|
| First request | Execute, store the response |
| Same key, same body, completed | Replay the stored status and body, header `Idempotent-Replayed: true` |
| Same key, same body, still in progress | 409 `IN_PROGRESS` + `Retry-After: 1` |
| Same key, different body | 422 `IDEMPOTENCY_KEY_MISMATCH` |
| Redis unavailable | Execute anyway. The DB unique constraints keep the result correct, but the response may differ (201 vs 200) |

Clients generate the key once per user intent and persist it in `sessionStorage`, so a retry after a refresh reuses it.

### Write requirements
Writes also need header `X-Requested-With: fairdrop` (CSRF defense).

### Errors
```json
{ "error": { "code": "RATE_LIMITED", "message": "...", "retryAfterMs": 1200 }, "serverTime": "..." }
```
| HTTP | Code | When |
|---|---|---|
| 400 | `VALIDATION`, `IDEMPOTENCY_KEY_REQUIRED` | Bad input |
| 401 | `UNAUTHENTICATED` | No or expired session |
| 403 | `NOT_VERIFIED` | Account is not verified |
| 403 | `CHALLENGE_FAILED` | Missing or invalid challenge / PoW |
| 403 | `FORBIDDEN` | Resource belongs to another user, or admin route without admin |
| 404 | `NOT_FOUND` | |
| 409 | `WINDOW_NOT_OPEN`, `WINDOW_CLOSED` | Entry outside the window |
| 409 | `IN_PROGRESS` | Idempotent duplicate in flight |
| 409 | `OFFER_EXPIRED`, `OFFER_NOT_ACTIVE` | Confirm too late or in the wrong state |
| 409 | `WRONG_MODE` | e.g. `purchase` on a lottery drop |
| 410 | `SOLD_OUT` | FCFS with no inventory left |
| 422 | `IDEMPOTENCY_KEY_MISMATCH` | |
| 429 | `RATE_LIMITED` | + `Retry-After` |
| 503 | `OVERLOADED`, `DEPENDENCY_DOWN` | + `Retry-After`. Global limit hit, or PG unavailable |

## Auth

### `POST /api/auth/request-otp`
Body `{ email }` → 202 `{ sent: true }`. Rate limited per email and per IP. In sim mode, OTP is disabled; see the sim endpoints.

### `POST /api/auth/verify`
Body `{ email, otp, deviceFp }` → 200 `{ user: { id, email, verified: true } }` + `Set-Cookie: sid`.

### `POST /api/auth/logout`
→ 204. Deletes the session.

### `GET /api/me`
→ 200 `{ user: { id, email, verified } }`.

## Drops

### `GET /api/drops/:id`
Public; no auth needed.
```json
{ "id": "...", "name": "...", "mode": "lottery", "status": "open",
  "inventory": 500, "opensAt": "...", "closesAt": "...", "claimTtlS": 300,
  "commit": "ab12...", "entrantCount": 31234, "serverTime": "..." }
```
`entrantCount` is approximate (from the Redis counter).

### `GET /api/drops/:id/challenge`
→ 200 `{ nonce, difficulty }`. Returns `difficulty: 0` when PoW is off. Single use, 120s TTL.

### `POST /api/drops/:id/entries`
Lottery mode only. Idempotent.
Body `{ challenge?: { nonce, solution }, deviceFp }`.
- 201 `{ entry: { publicId, createdAt }, state: "entered" }`: new entry.
- 200 same body with `"alreadyEntered": true`: the account had already entered (different idempotency key).
- Errors: 401, 403 `NOT_VERIFIED`/`CHALLENGE_FAILED`, 409 `WINDOW_*`/`WRONG_MODE`, 429, 503.

### `POST /api/drops/:id/purchase`
FCFS modes only. Idempotent.
- 201 `{ allocation: { id, seatNo, status: "confirmed" } }`
- 200 replay, or `alreadyPurchased: true`
- 410 `SOLD_OUT`, 429, 503

### `GET /api/drops/:id/me`
User's state for this drop. Supports `ETag` / `If-None-Match` (304).
```json
{ "state": "not_entered | entered | under_review | offered | confirmed | expired | waitlisted | lost | sold_out",
  "entry": { "publicId": "...", "createdAt": "..." },
  "allocation": { "id": "...", "seatNo": 17, "expiresAt": "..." },
  "waitlistPosition": 1203,
  "dropStatus": "claim", "serverTime": "..." }
```
Excluded entries are shown as `under_review`. We do not reveal detection details.

### `GET /api/drops/:id/events`
Server-Sent Events, auth required. Events: `status` (drop status change), `me` (the user's state changed), `heartbeat` every 15s. Supports `Last-Event-ID`; on reconnect the server sends the current `me` snapshot. Clients fall back to polling `/me` with jittered backoff (5–15s) when SSE fails.

### `POST /api/drops/:id/allocations/:allocationId/confirm`
Idempotent.
- 200 `{ allocation: { id, seatNo, status: "confirmed", confirmedAt } }`. Confirming again returns 200 with the same body.
- 403 `FORBIDDEN` (not your offer), 409 `OFFER_EXPIRED` / `OFFER_NOT_ACTIVE`.

### `POST /api/drops/:id/allocations/:allocationId/decline`
Idempotent. → 200. The seat is released to the waitlist immediately.

### `GET /api/drops/:id/audit`
Public. Available once the status is `drawn` or later; before that it returns the commit and parameters only.
```json
{ "dropId": "...", "rankFnVersion": "sha256-v1", "inventory": 500,
  "commit": "...", "secret": "...", "publicSalt": "...",
  "entriesHash": "...", "eligiblePublicIds": ["..."],
  "excluded": { "count": 812, "byReason": { "cluster_collapse": 700, "risk_threshold": 112 } },
  "beacon": { "source": "drand-quicknet", "round": 123, "value": "..." },
  "seed": "...", "winners": [{ "rank": 0, "publicId": "..." }],
  "promotions": [{ "rank": 503, "publicId": "...", "seatNo": 4, "at": "..." }] }
```
Large lists are also available as `GET /api/drops/:id/audit/entries.txt` (one per line, sorted).

## Admin
Requires a user with `role=admin` (env allowlist) or the `X-Admin-Token` header for scripts.

| Method & path | Body | Result |
|---|---|---|
| `POST /api/admin/drops` | `{ name, mode, inventory, opensAt, closesAt, claimTtlS, config }` | 201 drop. Creates seats and the commit |
| `POST /api/admin/drops/:id/open` | n/a | Force open (demo) |
| `POST /api/admin/drops/:id/close` | n/a | Force close |
| `POST /api/admin/drops/:id/draw` | n/a | Enqueue the draw. Idempotent, a no-op if already drawn |
| `POST /api/admin/drops/:id/reset` | n/a | **Sim mode only.** Wipe entries and allocations |
| `GET /api/admin/drops/:id/metrics` | `?runId=` | Live metrics JSON (METRICS.md) |
| `GET /api/admin/drops/:id/integrity` | n/a | `{ oversell, duplicates, inventoryConsistent, details }` |
| `GET /api/admin/runs` / `GET /api/admin/runs/:id` | n/a | Simulation run reports |

## Sim-only endpoints
Enabled only when `SIM_MODE=true` **and** the request has `X-Sim-Secret`.

| Method & path | Body | Result |
|---|---|---|
| `POST /api/sim/accounts` | `{ count, verified, createdAtOffsetS, signupIp?, deviceFp? }` | Bulk-create accounts. Returns `[{userId, sid}]` |
| `POST /api/sim/runs` | `{ scenario, seed, config, dropId }` | Register a run |
| `POST /api/sim/runs/:id/labels` | `[{ userId, actorType, operatorId }]` | Write ground truth |
| `POST /api/sim/runs/:id/report` | `{ clientMetrics }` | Attach client-side latency and outcomes |

`X-Sim-Client-IP` is honoured as the client IP only under the same conditions.
