# Fair Drop: Product Requirements

> **Deadline build:** BUILD_PLAN.md "Lean MVP" overrides this doc where they differ (single Next.js service + Postgres, no Redis, signed-cookie sessions, poll instead of SSE, auto-confirm, no drand). This doc describes the target design.

## Problem
500 seats, ~50,000 people competing for them. In a "first click wins" sale, the fastest clients win. Bots are always faster than people, can send more requests, and can retry without limit. Bots therefore win most of the seats. We need a system where bots get no significant advantage, inventory stays correct under load, and we can show this with numbers.

## Core idea
Speed should not matter. Fair Drop replaces "first click wins" with a **timed entry window followed by a verifiable random lottery**:

1. The entry window opens (for example, 10 minutes long; 60 to 120 seconds in the demo).
2. Each verified account can submit **one** entry at any point in the window. Entering at second 1 or at minute 9 gives the same odds.
3. When the window closes, the entry list is frozen and hashed. Then the random seed is revealed.
4. A deterministic shuffle ranks all eligible entries. The top 500 get seat offers and the rest go on an ordered waitlist.
5. Anyone can re-run the draw from the published inputs and check the result.

Once speed is irrelevant, request volume and retries also stop helping. An attacker can only improve their odds by **holding more accounts**. So the rest of the defense is about making extra accounts expensive and detecting clusters of them. We have the whole window to analyze entries before the draw, which "first click wins" never allows.

## Users
| User | Need |
|---|---|
| Participant (human) | Enter once, without racing. See clear status that survives refresh and reconnect. Learn the result. Confirm the seat. |
| Organiser (admin) | Create a drop, set inventory and the window, run the draw, see live metrics, export the audit. |
| Judge / auditor | Check that the draw was not rigged, nothing was oversold, and compare bot impact across scenarios. |
| Attacker (simulated) | Win more than a fair share through speed, volume, retries, multiple accounts, or IP rotation. |

## In scope
- Drop lifecycle: `scheduled → open → closed → frozen → drawn → claim → done`.
- Account sign-in with a verification flag. Verification is simulated for sim accounts; see OPEN_QUESTIONS Q5 for real users.
- One entry per account per drop, with idempotent writes.
- Rate limiting per user, per IP, and globally.
- Abuse signals and pre-draw risk scoring. Clusters can be excluded or collapsed.
- A commit-reveal seeded lottery with a public audit endpoint and a standalone verify script.
- Seat offers with a claim deadline. Unclaimed seats go to the waitlist in order.
- **Naive FCFS mode** (atomic but speed-based) and **FCFS-unsafe mode** (deliberate race, to prove the integrity checks catch overselling).
- A bot/load simulator with labelled actors and configurable scenarios.
- A fairness dashboard with side-by-side comparison of runs.
- Failure injection: kill the app instance or draw worker mid-flow and show the state stays consistent.

## Explicitly out of scope
- Real payments. "Confirm" stands in for checkout.
- Resale and scalping after allocation, and ticket transfer.
- Production-grade identity proofing (KYC, phone or SIM verification).
- CAPTCHA vendor integration. We may stub a challenge hook.
- High availability for Postgres or Redis. We use single managed instances.
- Real residential-proxy IP rotation. We simulate client IPs with a trusted header in sim mode only; see ABUSE_DEFENSE.
- Mobile apps, accessibility audit, and i18n.
- ML-based bot detection. We use rule-based signals only.

## Success criteria for the demo
Each item is measured by METRICS.md and shown on the dashboard.

| # | Criterion | Target |
|---|---|---|
| S1 | Oversell count in FCFS-safe and lottery modes, all scenarios | 0 |
| S2 | Duplicate allocations (a user holding more than one active seat) | 0 |
| S3 | Inventory consistency: active allocations + free seats = inventory | Holds at every check |
| S4 | Bot seat share, **naive FCFS** under the fast-bot attack | Far above bot account share. Expected: most seats |
| S5 | Bot advantage multiplier (P(win \| bot acct) / P(win \| human acct)), **Fair Drop** under the same attack | ≈ 1.0 or lower |
| S6 | Multi-account operator seat share with clustering on vs off | Measurably lower with clustering on |
| S7 | Human false-exclusion rate (humans excluded or blocked) | Reported. Target < 1% |
| S8 | Human p95 latency on the entry write during the flood scenario | Reported. Target set after milestone M12 |
| S9 | Draw verification: the independent script reproduces the winners | Pass |
| S10 | Kill the app or worker mid-window or mid-draw: no lost entries, no duplicate draw | Pass |
| S11 | Every scenario is reproducible from a seed and config file | Yes |

## Requirement coverage (problem statement → design)
| Requirement | Covered by | Gaps |
|---|---|---|
| High concurrency | Redis gate, Postgres unique constraints, horizontal app instances | 50k scale is unproven until M12. Hosting limits are unknown (OPEN_QUESTIONS) |
| Abuse handling | Lottery, rate limits, idempotency, risk scoring | **Multi-account (Sybil) is reduced, not solved.** See ABUSE_DEFENSE |
| Allocation integrity | Seat rows plus partial unique indexes, single transactional draw | None in design. Must be proven by the M3/M8 concurrency tests |
| Reliable sessions | Server-side state, idempotency keys, SSE with poll fallback, deterministic draw | Total Postgres outage is not survived (no HA) |
| Adversarial testing | Simulator scenarios S-0 to S-7 | IP rotation is simulated, not real |
| Fairness measurement | Ground-truth labels kept out of defense logic, METRICS.md | Detection is tuned against our own bots, so results may be optimistic |
