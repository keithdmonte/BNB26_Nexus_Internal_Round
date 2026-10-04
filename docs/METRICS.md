# Metrics (as built)

Sources:
- **[S]** Server: Postgres ledger, plus in-memory counters in `src/lib/counters.ts` (reset on restart).
- **[C]** Client: simulator request logs, so latency is client-observed on the same machine.
- **[L]** Labels: `sim_labels`, joined **only** in `src/lib/report.ts` (`fairnessReport`).

Every simulator run writes `runs/<scenario>-seed<seed>-scale<scale>-<time>.json` and stores the same report in `sim_runs.report`.

## Fairness
| Metric | Definition | Source | Dashboard |
|---|---|---|---|
| Bot account share | bot-labelled accounts / all participating accounts | L | Chart and tables |
| Bot seat share | seats held by bot accounts / seats allocated | S+L | Chart and tables |
| P(win), human / bot | accounts holding a seat / accounts in group | S+L | "Human P(win)" column |
| **Advantage multiplier** | P(win \| bot account) / P(win \| human account). 1.0 = no per-account advantage. Shown as ∞ when humans win nothing | S+L | Headline column, across-seeds mean [min–max] |
| Per-operator seats | seats per `operator_id` against its fair share (`accounts × seats / total accounts`) | S+L | In the report JSON (`operators`) |
| Human false-flag rate | humans whose entry was collapsed or excluded / humans who entered | S+L | Column |
| Bot flag recall | bot entries collapsed or excluded / bot entries | S+L | Column |
| P(win) by arrival decile | Accounts sorted by first-request time into 10 equal groups; P(win) per group (`arrivalDeciles` humans only, `arrivalDecilesAll` humans + bots) | C+S+L | Arrival-decile chart (FCFS vs lottery) |

## Abuse handling
| Metric | Definition | Source | Dashboard |
|---|---|---|---|
| Blocked requests | 429 + 503 responses to write requests | C | "Blocked" column |
| Codes by actor and endpoint | full status-code histogram per actor type | C | Report JSON (`client.endpoints`) |
| Live 429 counter | server-side, per drop | S (memory) | Live drop cards (resets on restart) |
| Duplicates absorbed | already-entered / already-purchased responses | S (memory) | Report JSON (`serverCounters`) |

## Performance and reliability
| Metric | Definition | Source | Dashboard |
|---|---|---|---|
| Latency p50 / p95 / p99 | client-observed, per actor type and endpoint | C | "Human p95" column; full detail in JSON |
| Per-request error rate | (5xx + network errors) / requests | C | "Err" column |
| Humans without an answer | humans whose final response was not 2xx / 410 / window-closed after all retries | C | Report JSON (`client.humanUnresolvedRate`) |
| Simulator validity | simulator event-loop delay p95 < 50ms, else latency figures are flagged unreliable | C | Printed by the simulator |

## Integrity (must be 0 / true)
| Metric | Definition |
|---|---|
| Oversell | `max(0, active allocations − inventory)` (unsafe mode reads `allocations_unsafe`) |
| Duplicate users | users with more than one active allocation in a drop |
| Double-booked seats | seats with more than one active allocation |
| Inventory consistent | safe ledger: active allocations = held seats ≤ inventory |
| Draw verified | `npm run verify` against the audit, including the independent drand fetch |

Computed by `checkIntegrity()` at the end of every run and on each dashboard refresh (live drop cards).

## Not built
Server-side latency histograms, time-series charts, the `metric_snapshots`/`events` pipeline, and a chi-square uniformity statistic (uniformity is covered by a test and the arrival-decile chart).
