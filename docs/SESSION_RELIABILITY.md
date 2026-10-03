# Session Reliability

> **Deadline build:** BUILD_PLAN.md "Lean MVP" overrides this doc where they differ (single Next.js service + Postgres, no Redis, signed-cookie sessions, poll instead of SSE, auto-confirm, no drand). This doc describes the target design.

Principle: **the server owns all state; the client is a view.** Every screen can be rebuilt from `GET /api/drops/:id/me` plus `GET /api/drops/:id`.

## Refresh
- The session is an opaque `sid` cookie that maps to Redis `sess:*`. A refresh keeps the cookie.
- On load, the page fetches `/me` and renders the state. Nothing important lives only in client memory.
- Pending writes: before sending, the client stores `{intent, idempotencyKey}` in `sessionStorage`. After a refresh, if there is a pending intent and `/me` does not show it applied, the client re-sends it with the **same key**. The server either replays the result or executes it once.
- The countdown uses the `serverTime` offset, so a refresh does not reset or distort it.

## Reconnect / flaky network
- SSE reconnects with `Last-Event-ID`. On every (re)connect the server pushes a full `me` snapshot, so missed events don't matter.
- If SSE fails 3 times, the client polls `/me` every 5–15s with jitter. ETag/304 keeps polling cheap.
- If a write times out, the client retries with the same idempotency key using exponential backoff (0.5s, 1s, 2s, 4s; max 5 tries). A 409 `IN_PROGRESS` means "wait and retry the same key".
- Lottery mode makes retries low-pressure: there are minutes left in the window, and the UI says so.

## Session loss
| Case | Effect |
|---|---|
| Redis flushed or restarted | Sessions are lost and the user must sign in again. Entries and allocations are untouched (PG). After sign-in, `/me` shows the correct state. |
| Cookie cleared or new device | Same as above |
| Session expires mid-claim | 401, sign in, then `/me` shows the offer if it is still within `expires_at` |

Mitigation to consider: a longer claim TTL than the typical time to sign in again (default 5 min).

## App instance failure
- App replicas are stateless. If one dies mid-request:
  - Before the PG commit, nothing is written, and the client retry (same key) executes fresh. The Redis `idem` "in_progress" marker has a 30s lock TTL, so it unblocks.
  - After the PG commit, before the response, the client retry hits either the stored idem response or the unique constraint, so it gets the same outcome.
- SSE clients on the dead instance reconnect to another replica and get the snapshot.

## Worker failure
| When | Recovery |
|---|---|
| During the window | No effect on entries (the app writes them). Railway restarts the worker. Missed scheduled transitions run on start: the worker reconciles `status` against `now()`. |
| During risk scoring (before freeze) | Scoring is a pure function of the entries and signals, and is re-run from scratch. The exclusion updates happen in one transaction together with `status=frozen`. |
| During the draw transaction | Rolls back. On restart the status is still `frozen`, and the re-run is deterministic (same secret, entries, and beacon round), so the result is identical. |
| After the draw commit, before the secret reveal | Restart sees `drawn` with the secret not revealed, so it reveals. |
| During expiry / promotion | Each seat is handled in its own transaction. A partial run leaves some offers unexpired, and the next tick picks them up. |
| Two workers running at once (bad deploy) | The advisory lock plus status checks make every job safe to run twice. |

**Beacon determinism:** the beacon round is fixed when freezing (stored in `drops.beacon_round`) **before** it is fetched, so a retry fetches the same round. If drand is unreachable for more than 60s, the worker records `beacon=""` and proceeds. This is shown on the audit page.

## Dependency failure
| Failure | Behaviour |
|---|---|
| Redis down | Rate limiting falls back to an in-process limiter per replica (looser). Idempotency falls back to the DB constraints. Sessions fail, so returning users get 401 (known gap). FCFS mode returns 503 (the gate is unavailable), which is safe but unavailable. Lottery entries still work for users who already have a session. **Known gap:** sessions depend on Redis. An option is signed-cookie sessions so auth survives a Redis outage (OPEN_QUESTIONS). |
| Postgres down | Writes return 503 `DEPENDENCY_DOWN` + Retry-After. Reads of drop status come from the Redis cache. The window does not close early, but entries made during the outage are lost to the user until they retry. **Not survived:** a PG outage spanning the window close. An admin can extend `closes_at` (logged in `events` and visible on the audit). |

## Tests that prove this (BUILD_PLAN M7, M11)
1. Enter, refresh during the in-flight request, and confirm exactly one entry exists and the UI shows `entered`.
2. 50 parallel identical requests with one key produce 1 execution and 49 replays or `IN_PROGRESS`.
3. Kill the SSE connection, push a state change, reconnect, and check the client shows the new state.
4. `kill -9` the worker inside the draw transaction (via a test hook that pauses after inserting half the ranks). Restart, and the result hash equals the result from an uninterrupted run.
5. Kill an app replica during a 2k rps entry burst. Afterwards the success count reported by the simulator equals the entries count in PG.
6. FLUSHALL Redis mid-window. There are no lost entries, and the integrity check passes.
