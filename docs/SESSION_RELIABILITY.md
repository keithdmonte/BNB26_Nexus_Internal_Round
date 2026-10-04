# Session Reliability (as built)

Principle: **the server owns all state; the client is a view.** Every participant screen is rebuilt from `GET /api/drops/:id` plus `GET /api/drops/:id/me`.

## Refresh
- The session is a signed JWT cookie (`fd_sid`, 24h) with no server store, so a refresh keeps it.
- Before sending a write, the page stores `{dropId, idempotencyKey}` in `sessionStorage` (`write()` in `src/app/drop/page.tsx`). After a refresh it re-sends with the **same key**: the server returns the original 201 (lottery, from `entries.request_id`; FCFS, from `idempotency_keys`) or 200 "already entered".
- The countdown uses a server-time offset (`serverTime` on every response).

## Reconnect / flaky network
- **No SSE.** The page polls the drop and `/me` every 3s; `/me` supports ETag/304.
- Writes retry with the same key using exponential backoff (0.5s → 8s, 5 tries) and honour `Retry-After` on 429/503.
- In lottery mode a retry costs nothing: entry time doesn't affect the odds, and the window is minutes long.

## App process restart / crash
| Case | Effect |
|---|---|
| Restart between requests | Sessions survive (stateless JWT). Verified: kill -9 and restart, then the same cookie still returns `"state":"entered"`. |
| Crash during an entry insert | It's an autocommit insert, so either it committed (a retry gets 201 replay / 200) or it didn't (a retry inserts). Never two rows: `UNIQUE (drop_id, user_id)`. |
| Crash during an FCFS purchase | The transaction holds both the idempotency row and the seat claim, so it fully commits or fully rolls back; the retry re-executes or replays. |
| Crash during the draw | The single transaction rolls back and the status stays `frozen`. The next tick re-runs it with the same secret, entries and committed drand round, giving an identical result (tested with an injected crash; a real `kill -9` mid-draw has not been tested). |
| Crash after the draw commit | Nothing pending: the secret is revealed in the same transaction. |
| Lost on restart | Rate-limit buckets, live counters, read caches. These are protection and telemetry only; correctness doesn't depend on them. |

## Dependency failure
| Failure | Behaviour |
|---|---|
| Postgres slow / pool exhausted | 503 `OVERLOADED` with Retry-After once more than `MAX_DB_QUEUE` queries are waiting. Clients retry with the same key. |
| Postgres down | Writes and status calls error (500/503). **Not survived.** An outage across `closes_at` loses entries that would have arrived. An admin can move the window (`/api/admin/drops/:id/close` only shortens it; extending needs SQL). |
| drand unreachable at draw time | The draw waits and retries for `BEACON_TIMEOUT_S` (default 30s), then proceeds commit-reveal only with `beacon_status = 'fallback'`, shown in the audit and the verify output. |

## Known gaps
- Sessions can't be revoked server-side (logout only clears the cookie).
- No live push; results appear within about 3s of the draw.
- Single process: a crash pauses scheduling until restart. No data is lost; transitions resume on the next tick.
