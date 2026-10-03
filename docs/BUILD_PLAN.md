# Build Plan

## Constraints (confirmed)
- **Solo builder.** Deadline is **Sun 4 Oct 2026, 10:00 IST**. Planning finished Sat 3 Oct around 16:40, so there are about 17h on the clock and about 11–12h of real build time once sleep is subtracted.
- Hosting is the Railway free plan (probably), which means small resources and few services.
- Judging criteria are unknown, so we optimise for **evidence**: a before/after comparison table, zero oversell, and a draw anyone can check.

## Lean MVP (overrides the full design where they differ)
The full design in the other docs stays as the target architecture and the "what we'd do next" story. For the deadline we build this:

| Area | Full design | Lean MVP | Why |
|---|---|---|---|
| Services | app replicas + worker + Redis + PG | **One Next.js service + Postgres** | Free plan, solo, fewer failure modes |
| Worker | Separate process | In-process scheduler (`setInterval` 1s) guarded by a `pg_advisory_lock`, plus admin buttons for close/draw | One service. The lock keeps it exactly-once even if two instances run |
| Rate limiting | Redis token bucket | In-memory token bucket | Correct only with a **single instance**, which is what we run. Redis is a drop-in later |
| Idempotency | Redis | PG table `idempotency_keys` | Durable and has one less dependency |
| Sessions | Redis | **Signed cookie** (JWT via `jose`) | No store, so it survives restarts. Fixes the Redis-outage gap (old Q16) |
| FCFS gate | Redis Lua | PG `UPDATE seats ... FOR UPDATE SKIP LOCKED` | Still atomic. Unsafe mode still does a naive read-then-write |
| Live updates | SSE + poll | **Poll only** (`/me` every 3–5s with ETag) | Saves about 1h |
| Claim / waitlist | Offer, TTL, promotion | **Auto-confirm** (`claim_ttl_s = 0`) | Saves 1.5h. The concurrency story is still covered by FCFS and entry tests |
| Beacon | drand | Commit-reveal only. drand only if spare time | Auditable enough. The weakness is documented |
| Auth | Email OTP | Sim accounts + dev login (pick any seeded user) | OTP is undecided (Q5) |
| PoW, S5, S8, full chaos suite | Yes | Cut. One chaos test kept (kill during draw, then re-run gives the same hash) | Time |
| Load scale | 50k on Railway | **50k locally** (docker PG), small-scale live run on Railway | The free plan is unlikely to absorb 50k. Be explicit about this in the demo |

**Stack change to approve:** drop Redis from the MVP. If you want Redis visible for the judges, add it last (rate limiter + idempotency cache) and budget about 1h.

## Hour-boxed plan
Every block ends with a runnable check. If a block overruns by more than 30 min, cut from the bottom of the cut list.

| Time (IST) | Milestone | Done when |
|---|---|---|
| 17:00–17:45 | **M0** Scaffold: Next.js + TS, docker-compose PG, migrations (`drops`, `seats`, `users`, `entries`, `allocations`, `allocations_unsafe`, `draw_ranks`, `idempotency_keys`, `events`, `sim_runs`, `sim_labels`), seed script | `GET /api/health` ok. Unique-index tests fail correctly |
| 17:45–19:00 | **M1** FCFS safe + unsafe purchase, integrity endpoint, concurrency test | 5k parallel purchases on safe mode give exactly 500 and 0 duplicates. Unsafe mode gives oversell > 0, which is detected |
| 19:00–20:30 | **M2** Simulator v1: bulk accounts, labels, `human`, `fast_bot`, `flooder`, run report JSON | S1 and S2 reports at 5k users. Bot seat share and multiplier computed |
| 20:30–21:00 | Break | |
| 21:00–22:30 | **M3** Lottery: window state machine, entry endpoint, idempotency, rate limit, signed-cookie session | Same-key replay test, 50 parallel same-key requests give 1 row, entry after close gives 409, and 429 includes Retry-After |
| 22:30–23:45 | **M4** Draw: commit-reveal, freeze + entries hash, single-transaction draw, audit endpoint, `verify` script | `verify` reproduces winners. A second draw is a no-op. S3 report produced |
| 23:45–01:00 | **M5** Multi-account: `multi` actor (shared device fingerprint / IP pool / fresh accounts), cluster collapse at freeze | S4a vs S4b reports. Human false-exclusion rate shown |
| 01:00–02:00 | **M6** Dashboard: headline row, run comparison table, integrity strip | S2 / S3 / S4a / S4b side by side |
| 02:00–02:30 | **M7** Participant UI: enter, status poll, refresh-safe (pending-intent replay) | Manual refresh at each state shows the correct screen |
| 02:30–03:00 | **M8** Railway deploy (1 service + PG). Smoke run at small scale | Live URL works. Integrity passes |
| 03:00–07:30 | Sleep | |
| 07:30–08:30 | **M9** Full runs at 50k locally with seeds 1–3; save JSON. One chaos test (kill during draw, re-run, same hash) | Run files saved. Chaos test passes |
| 08:30–09:30 | **M10** Demo script + README + rehearsal ×2 | Runs end to end without fixes |
| 09:30–10:00 | Buffer | |

## Cut order (first to go)
1. Chaos test (just explain the deterministic re-run instead)
2. Railway deploy (demo locally, show the deployment if it is up)
3. Participant UI polish (API + dashboard is enough)
4. S4b clustering (keep S4a, and present Sybil as an honestly documented limit)

**Never cut:** the S2 vs S3 comparison, the integrity checks, the verify script. These are the core evidence.

## Rules while building
- Every invariant gets a concurrency test before it is called done.
- The report JSON format is frozen at M2.
- Defense code never reads `sim_labels`.
