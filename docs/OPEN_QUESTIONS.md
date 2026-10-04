# Open Questions and Assumptions

## Answered
| # | Question | Answer | Impact |
|---|---|---|---|
| Q1 | Duration | Deadline Sun 4 Oct 2026, 10:00 IST (about 17h from the end of planning) | Lean MVP in BUILD_PLAN |
| Q2 | Team size | Solo | One service, hour-boxed plan, cut order |
| Q3 | Judging criteria | Unknown | Optimise for evidence: the comparison table, integrity, the verify script |
| Q4 | Hosting | Railway free plan (probably) | Single instance + PG. Full-scale runs are done locally |
| Q5 | Real-user auth | Decide later | MVP uses sim accounts + dev login. OTP is a stretch goal |

## Still open (defaults apply if no answer)
| # | Question | Default |
|---|---|---|
| Q6 | Is a lottery acceptable for a "sale"? | Yes. FCFS kept as the baseline |
| Q7 | Confirm/checkout step? | **Auto-confirm** (built that way) |
| Q8 | Assigned seats vs general admission? | General admission |
| Q9 | Literal 50k simulation? | 50k locally, smaller live on Railway. Stated openly in the demo |
| Q10 | Live demo or recorded? | Live S3 at small scale + recorded full-scale runs |
| Q11 | drand reachable? | **Resolved:** drand quicknet integrated with BLS verification; 30s wait, then a recorded fallback |
| Q12 | Policy for suspected multi-accounts | `collapse` to one entry |
| Q14 | Privacy rules for IP/fingerprint storage | Sim data only |
| Q15 | UI expectations | Minimal participant UI, focus on the dashboard |
| Q17 | Drop Redis from the MVP? | **Resolved:** dropped (ARCHITECTURE.md, Deliberate tradeoffs) |
| Q18 | Will the Railway free plan allow 2 services (app + PG) with enough RAM for Next.js? | Verify at M8. Fallback: demo locally |

## Assumptions
- One drop at a time. Single region. No HA.
- The demo window is 60–120s.
- Bots make up 5% of accounts in the scenarios.
- Admins are trusted except for the draw.

## Requirements not fully covered (flagged)
1. **Multi-account attacks:** reduced, not eliminated. K undetected accounts give K× odds.
2. **IP rotation:** simulated via a sim-only trusted header.
3. **Temporary failures:** the app restarting is safe (state is in PG, sessions are signed cookies, the draw is deterministic and re-runnable). A PG outage during close is not survived.
4. **High concurrency at 50k:** shown locally only. The hosted free plan will not be load-tested at full scale.
5. **Horizontal scaling:** the MVP's in-memory rate limiter assumes a single instance. Redis is the documented path to scaling out.
6. **Bot detection validity:** tuned against our own bots, so the results are optimistic.
7. **Claim/waitlist:** cut from the MVP (auto-confirm).
8. **Account cost:** demo login makes accounts free; real verification (email or phone OTP) isn't on main.
