# Metrics

> **Deadline build:** BUILD_PLAN.md "Lean MVP" overrides this doc where they differ (single Next.js service + Postgres, no Redis, signed-cookie sessions, poll instead of SSE, auto-confirm, no drand). This doc describes the target design.

Sources:
- **[S]** Server: Redis counters, PG events, snapshotted every 5s into `metric_snapshots`.
- **[C]** Client: simulator request logs.
- **[L]** Labels: `sim_labels`, joined **only** in the report and metrics layer.

## Fairness
| Metric | Definition | Source | Dashboard |
|---|---|---|---|
| Bot seat share | seats held (confirmed or offered at end) by bot-labelled accounts / inventory | S+L | Big number + stacked bar (human vs each bot type) |
| Bot account share | bot accounts that entered (or attempted to buy) / all accounts that did | S+L | Shown beside the seat share |
| **Advantage multiplier** | P(win \| bot account) / P(win \| human account). 1.0 = no advantage per account. FCFS P(win) = bought / attempted accounts | S+L | Headline number per run, coloured green ≤ 1.2, amber ≤ 2, red > 2 |
| Per-operator seats | seats won per operator_id, compared with the expected fair share (`accounts × inventory/eligible`) | S+L | Table, top 10 operators |
| Human success rate | humans with a seat / humans who tried | S+L | Number |
| Human false-exclusion rate | humans with an `excluded`/`collapsed` entry, or blocked on every attempt / humans who tried | S+L | Number, red if > 1% |
| Bot exclusion recall | bot accounts excluded or collapsed / bot accounts entered | S+L | Number |
| Draw uniformity (lottery) | Chi-square of win counts across human arrival-time deciles. Expect p > 0.05 (arrival time doesn't matter) | S+L | Bar chart: win rate by arrival decile |

## Abuse handling
| Metric | Definition | Source | Dashboard |
|---|---|---|---|
| Requests blocked, by reason | counts of 429 user / 429 ip / 503 global / 403 challenge / 409 duplicate or in-progress | S | Stacked area over time |
| Block share by actor | share of blocked requests sent by bots vs humans | S+C+L | Two bars. Humans should be ≈ 0 |
| Duplicate writes absorbed | idempotent replays + `already_entered` | S | Number |
| Clusters found | number and size distribution | S | Histogram |

## Performance and reliability
| Metric | Definition | Source | Dashboard |
|---|---|---|---|
| Throughput | requests/s handled (2xx + 4xx), per endpoint | S | Line over time |
| Latency p50 / p95 / p99 | client-observed, per endpoint, **humans only** and all | C | Line plus a per-run table |
| Error rate | 5xx + timeouts / total | C | Line; per run |
| Human-perceived failure | humans who never got a successful entry/purchase response for a non-business reason (5xx, timeout, retries exhausted) | C+L | Number |
| SSE delivery | time from `draw_committed` until a human client sees its result (p50/p95) | C | Number |

## Integrity (must be 0 or "true"; shown red otherwise)
| Metric | Definition | Source |
|---|---|---|
| Oversell count | `max(0, active allocations − inventory)` per drop (unsafe mode: from `allocations_unsafe`) | S |
| Duplicate allocations | users with more than one active allocation in a drop | S |
| Seat double-booking | seats with more than one active allocation (should be impossible by index; checked anyway) | S |
| Inventory consistency | `active + free == inventory` and, for FCFS, Redis `remaining == free seats` when idle | S |
| Lost writes | simulator successes (2xx) without a matching PG row | C+S |
| Draw verified | `verify` script output: pass/fail | audit |

Integrity is checked every 5s during a run and once at the end. The dashboard shows a green/red strip.

## Dashboard layout (`/admin/dashboard`)
1. **Run picker**: live drop, or saved runs (multi-select for comparison).
2. **Headline row**: advantage multiplier, bot seat share vs account share, human success rate, oversell, duplicates, draw verified.
3. **Comparison table**: one row per selected run (S2 vs S3 vs S4a vs S4b), with columns for the headline metrics plus p95 and error rate. **This is the main judging artifact.**
4. **Live charts**: throughput, blocked requests by reason, latency percentiles.
5. **Fairness detail**: win rate by arrival decile, per-operator table, cluster histogram.
6. **Export**: the run JSON and the audit link.

The dashboard polls `/api/admin/drops/:id/metrics` every 2s. Charts use a lightweight library such as Recharts.
