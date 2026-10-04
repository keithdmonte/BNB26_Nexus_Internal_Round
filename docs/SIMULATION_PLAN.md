# Simulation Plan (as built)

## Simulator
`npm run sim -- --scenario <id> [--scale 1] [--seed 1] [--target http://localhost:3000] [--connections 512]`

Code: `scripts/sim/run.ts`, scenarios in `scripts/sim/scenarios.ts`.
1. **Setup:** creates the drop and run through `/api/sim/runs`, then bulk-creates labelled, pre-verified accounts (10k per call) and receives a session token per account.
2. **Execute:** each actor is an async task. Human arrival times are drawn up front from a seeded PRNG (mulberry32), so the population and timeline are reproducible from `--seed`. The draw secret is fresh per drop, so draw outcomes are **not** bit-for-bit reproducible.
3. **Await:** polls the drop until it is `drawn` or `done`, then a sample of up to 2,000 humans fetch `/me`.
4. **Report:** posts client latency and code histograms plus every account's first-request time. The server computes the fairness report and writes `runs/*.json`.

`--scale` multiplies populations and inventory together, so `0.1` means 5,000 users and 50 seats.

## Actor types
| Actor | Behaviour | Options |
|---|---|---|
| `human` | Lottery: 30% arrive in the first 10% of the window, the rest uniform. FCFS: lognormal reaction time, median 1.5s. 20% refresh `/me` first. Up to 6 tries with the **same** key, exponential backoff, honours Retry-After. IPs from a shared pool (campus NAT); 0.5% share a device fingerprint with another human ("roommates", clustering false-positive bait) | `humans`, `humanIpPool`, `humanSharedFp` |
| `fast_bot` | Fires at open + 0–30ms; retries every 20–50ms with **new** keys, ignores Retry-After, up to 400 tries | `operators`, `accountsEach` |
| `flooder` | `rps` requests per second for `durationS`, new key each time | `rps`, `durationS` |
| `retrier` | Fires at open, then resends the **same** request with the **same** key every 50ms, ignoring Retry-After and every response, up to 200 times | `operators`, `accountsEach` |
| `rotator` | Floods at `rps` for `durationS` with a **new simulated client IP and new key on every request** (`X-Sim-Client-IP`) | `rps`, `durationS` |
| `multi` | Fast-bot behaviour; an operator's accounts share its device fingerprint with probability `sharedFp`, use `ipPool` IPs (one /24 when ≤ 254, otherwise spread), and have age `ageS` | `sharedFp`, `ipPool`, `ageS` |

## Scenarios
50,000 accounts and 500 seats at scale 1. Bots are 5% of accounts unless noted.

| ID | Mode | Traffic | Defenses | Shows |
|---|---|---|---|---|
| S0 | lottery | 50k humans | rate limit, clustering | Baseline |
| S1 | fcfs | 50k humans | none | FCFS without bots |
| **S2** | fcfs | 47.5k humans, 2,450 fast bots, 50 flooders | none | **Before**: speed wins |
| **S3** | lottery | same as S2 | rate limit | **After**: speed and volume neutralised |
| S4a | lottery | 48k humans, 2 operators × 1,000 `multi` (70% shared device, 20 IPs in one /24, accounts 1h old) | rate limit | Multi-account, clustering off |
| S4b | lottery | same as S4a | rate limit, clustering (collapse) | Clustering against cooperative bots |
| S4c | lottery | 48k humans, 2 × 1,000 `multi`, distinct devices, 1,000 spread IPs, 90-day-old accounts | rate limit, clustering | **Evasive** multi-account: the honest limit |
| S6 | fcfs_unsafe | 10k humans, 2,000 fast bots | none | The integrity checker catching a real oversell |
| S7 | lottery | 47.5k humans, 2,500 `retrier` | rate limit | Same-key retry storms gain nothing |
| S8 | lottery | 47.5k humans, 2,450 fast bots, 50 `rotator` (40 rps each, new IP per request) | rate limit | IP rotation dodges per-IP limits, but per-account limits and one-entry-per-account still hold |

## Validity notes
- The simulator and server share one laptop; latency is client-observed with no real network. The simulator's event-loop delay is recorded, and a run is flagged if its p95 exceeds 50ms.
- Detection is rule-based and our bots are written by us. S4b shows what clustering does against cooperative bots; S4c (evasive) is the honest number.
- With 500 seats and about 2,500 bot accounts, bots expect about 25 seats, so run-to-run noise is about ±5 seats, which moves the multiplier by about ±0.2. The dashboard's across-seeds table shows the range.
- IP rotation uses a trusted simulator-only header; real proxy networks are not exercised.
