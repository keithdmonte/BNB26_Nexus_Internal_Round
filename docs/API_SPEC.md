# API Spec (as built)

JSON in and out. Every JSON response includes `serverTime`. Errors look like
`{ "error": { "code", "message", "retryAfterMs"? }, "serverTime" }`, and 429/503 include `Retry-After`.

## Conventions
- **Auth:** the `fd_sid` cookie (signed JWT), or `Authorization: Bearer <same token>` (used by the simulator).
- **CSRF:** writes require `X-Requested-With: fairdrop`.
- **Idempotency:** writes require `Idempotency-Key` (≤ 100 chars); otherwise 400 `IDEMPOTENCY_KEY_REQUIRED`.
  - Lottery entry: one row per (drop, user). The same key replays the original 201 with `Idempotent-Replayed: true`; a different key returns 200 `alreadyEntered`. There is no body-mismatch check (the body is empty).
  - FCFS purchase: key and outcome are stored in `idempotency_keys` inside the purchase transaction. The same key replays; the same key with a different body returns 422 `IDEMPOTENCY_KEY_MISMATCH`. A concurrent duplicate waits for the first and then replays.

## Error codes
| HTTP | Code |
|---|---|
| 400 | `VALIDATION`, `IDEMPOTENCY_KEY_REQUIRED` |
| 401 | `UNAUTHENTICATED` |
| 403 | `NOT_VERIFIED`, `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 409 | `WINDOW_NOT_OPEN`, `WINDOW_CLOSED`, `WRONG_MODE`, `EMAIL_TAKEN` |
| 410 | `SOLD_OUT` |
| 422 | `IDEMPOTENCY_KEY_MISMATCH` (FCFS) |
| 429 | `RATE_LIMITED` |
| 503 | `OVERLOADED` |
| 500 | `INTERNAL` |

## Public / participant
| Method & path | Notes |
|---|---|
| `GET /api/health` | `{ ok, db, dbTime }` |
| `POST /api/auth/dev-login` `{email}` | **Demo only** (`DEV_LOGIN=true`). Creates a verified account for an unused email. Returns 409 `EMAIL_TAKEN` for an existing email unless the caller's session already owns it. |
| `POST /api/auth/logout` | Clears the cookie. Tokens are not revocable server-side. |
| `GET /api/me` | Current user. |
| `GET /api/drops` | Up to 24 recent non-simulator, non-hidden drops with `entries` and `sold` counts (250ms cache). |
| `GET /api/drops/:id` | Drop info, `commit`, `entrantCount` (250ms cache). |
| `POST /api/drops/:id/entries` | Lottery entry. 201 / 200 `alreadyEntered` / 409 window / 429 / 503. |
| `POST /api/drops/:id/purchase` | FCFS. 201 / 200 `alreadyPurchased` / 410 `SOLD_OUT` / 409 / 429 / 503. |
| `GET /api/drops/:id/me` | `{ state, dropStatus, entry, allocation, rank }`. States: `not_entered`, `entered`, `under_review`, `confirmed`, `lost`, `missed`, `not_purchased`, `sold_out`. Supports `ETag` / 304. |
| `GET /api/drops/:id/audit` | Always: `commit`, `beacon` (`source`, `status`, `round`, `value`, `signature`, `chainHash`). After the draw also: `secret`, `entriesHash`, `eligiblePublicIds`, `excluded` breakdown, `seed`, `winners`. |

## Admin
Auth is the `X-Admin-Token` header (scripts) or the `fd_admin` cookie set by `POST /api/admin/login {token}` (HttpOnly, SameSite=Strict, 8h). Tokens in URLs are not accepted.

| Method & path | Notes |
|---|---|
| `POST /api/admin/login`, `POST /api/admin/logout` | Cookie exchange (login is rate-limited). |
| `POST /api/admin/drops` | `{ name, mode, inventory, opensInS, windowS, config }` |
| `POST /api/admin/drops/:id/open` / `close` / `tick` | Move the window edge to now and run a scheduler tick. |
| `GET /api/admin/drops/:id/integrity` | `{ inventory, activeAllocations, heldSeats, oversell, duplicateUsers, doubleBookedSeats, inventoryConsistent, ok }` |
| `GET /api/admin/runs`, `GET /api/admin/runs/:id` | Non-archived simulator runs. |

## Simulator only
Requires `SIM_MODE=true` **and** `X-Sim-Secret: $SIM_SECRET`. Under the same conditions, `X-Sim-Client-IP` overrides the client IP.

| Method & path | Notes |
|---|---|
| `POST /api/sim/runs` | Creates a drop and run. |
| `POST /api/sim/runs/:id/accounts` | Up to 10k labelled, pre-verified accounts. Returns `{userId, token}` per account. |
| `POST /api/sim/runs/:id/report` | `{ client, arrivals? }`. The server computes the fairness report (including P(win) by arrival decile) and stores it. |
