# Simulation Plan

> **Deadline build:** BUILD_PLAN.md "Lean MVP" overrides this doc where they differ (single Next.js service + Postgres, no Redis, signed-cookie sessions, poll instead of SSE, auto-confirm, no drand). This doc describes the target design.

## Simulator design
- `sim/` package: a Node + TypeScript CLI that uses `undici` with keep-alive pools.
- `fairdrop-sim run --scenario scenarios/S3.yaml --target https://... --seed 42`
- Steps:
  1. **Setup:** create the drop (admin API), bulk-create accounts (`/api/sim/accounts`), and write `sim_labels`.
  2. **Execute:** schedule each actor as an async task on a seeded event timeline. Every request is logged client-side as `{actorId, type, endpoint, t, latencyMs, status, code}`.
  3. **Await:** wait for the draw, then each actor reads `/me` (its real UI behaviour). Humans confirm offers with probability `p_confirm`.
  4. **Report:** fetch `/admin/.../metrics` and `/integrity`, join them with labels, write `runs/<scenario>-<ts>.json`, and POST it to `/api/sim/runs/:id/report`.
- Deterministic: one PRNG (seeded) drives all actor parameters and timings. Network nondeterminism remains.
- Runs from a Railway service in the same project for the big runs, and from a laptop for small ones.
- Sizing: the simulator's own capacity is measured first (M4). If one process cannot keep up, use N worker processes with sharded actors. `--max-sockets` is configurable.

## Actor types
| Actor | Behaviour (lottery mode) | Behaviour (FCFS mode) |
|---|---|---|
| `human` | Arrives at `opens_at + X`, with X drawn from a configurable distribution (default: 30% in the first 10s, rest spread over the window). Solves PoW. Enters once. On an error, retries the same key with backoff, up to 3 times. Refreshes the page with p=0.2. Then waits for SSE or polls every 10s | Clicks Buy at `opens_at + reaction`, reaction ~ lognormal(median 1.5s). Retries the same key on 5xx, up to 3 times, and gives up on SOLD_OUT |
| `fast_bot` | Enters at t=0 with ~0 reaction | Fires at t=0 with ~0 reaction (or before open, then spins) |
| `flooder` | Sends `R` req/s for `D` seconds with **new** idempotency keys each time | Same, on purchase |
| `retrier` | Retries every response, including 429, ignoring Retry-After | Same |
| `multi` | One operator controls `K` accounts. Configurable: `sharedDeviceFp`, `sharedIp` / `ipPool` size, `accountAgeS`, `timingJitter` | Same |
| `rotator` | Each request comes from a random IP in a pool of size `P` (via `X-Sim-Client-IP`) | Same |

## Configurable parameters
```yaml
seed: 42
target: http://localhost:3000
drop: { mode: lottery, inventory: 500, windowS: 120, claimTtlS: 60 }
defenses: { rateLimit: true, pow: false, powDifficulty: 18, risk: true, riskPolicy: collapse }
population:
  humans: 50000
  humanArrival: { firstBurstPct: 0.3, firstBurstS: 10 }
  humanIpPool: 2000          # simulate campus NAT: many humans share IPs
  humanConfirmP: 0.9
bots:
  - { type: fast_bot, operators: 50, accountsEach: 1 }
  - { type: flooder, operators: 5, accountsEach: 1, rps: 200, durationS: 30 }
  - { type: multi, operators: 2, accountsEach: 1000, sharedDeviceFp: 0.7, ipPool: 20, accountAgeS: 3600 }
  - { type: rotator, operators: 1, accountsEach: 200, ipPool: 5000 }
scale: 1.0                   # multiply all counts (use 0.1 for dev)
```

## Demo scenarios
All scenarios use 500 seats. "Bot accounts" = 2,500 (5% of 50k) unless noted. Each scenario runs 3× with seeds 1, 2, 3, and we report the mean and range.

| ID | Mode | Traffic | Defenses | What it shows | Expected |
|---|---|---|---|---|---|
| **S0** Normal | lottery | 50k humans, no bots | all on | Baseline performance and correctness | 500 offers, 0 oversell, p95 recorded |
| **S1** Naive normal | fcfs | 50k humans | none | FCFS works fine without bots | 500 sold, 0 oversell |
| **S2** Naive under attack | fcfs | 47.5k humans + 2.5k `fast_bot` + 5 `flooder` | none | **Before** | Bots win the large majority of 500 seats; advantage multiplier ≫ 1 |
| **S3** Fair Drop under attack | lottery | Same as S2 | rate limit, idempotency (risk off) | **After**: speed and volume neutralised | Bot seat share ≈ 5% (account share), multiplier ≈ 1. Flood → 429s, human p95 stable |
| **S4a** Multi-account, no clustering | lottery | 48k humans + 2 operators × 1,000 accounts | risk off | Sybil is the remaining attack | Operators win ≈ 2000/50000 × 500 ≈ 20 seats |
| **S4b** Multi-account, clustering | lottery | Same as S4a | risk on (`collapse`) | Clustering effect and its cost | Operator seats drop sharply; human false-exclusion rate reported |
| **S5** Flood + IP rotation | lottery | 48k humans + `rotator` 200 accts / 5000 IPs + `flooder` | all on | Per-IP limits are bypassed, but there's no outcome gain | Bot share ≈ account share; per-user limits still hold |
| **S6** Unsafe FCFS | fcfs_unsafe | 10k humans + bots burst | none | The integrity checker catches a real oversell | oversell > 0 detected and shown in red |
| **S7** Chaos | lottery | S3 traffic | all on | Reliability: kill an app replica mid-window and the worker mid-draw | 0 lost entries, identical draw hash, integrity pass |

Optional **S8:** S4a with PoW on, to measure what PoW costs bots versus human latency.

## Smaller rehearsal variant
Use `scale: 0.1` (5k users, 50 seats) on a laptop with docker-compose Postgres and Redis. Ratios should match the full run; this checks the pipeline before the hosted run.

## Validity notes
- Detection is rule-based and our bots are written by us, so S4b can overfit. To mitigate, write the `multi` bot config with "evasive" settings (`sharedDeviceFp: 0`, aged accounts) and **report the evasive case honestly** (S4c, optional).
- Client-side latency includes the simulator's own event-loop lag. We track sim CPU and event-loop delay and flag a run as invalid if lag > 50ms p95.
