# Judge Q&A: short, honest answers

## Can a bot just create 1,000 accounts?
**Yes, and that's the one attack the lottery alone doesn't stop.** A lottery removes the advantage of speed, request volume and retries, but each account is one ticket.

| Scenario (50k accounts, 500 seats) | Bot accounts | Bot seats | Multiplier | Bots caught | Humans wrongly merged |
|---|---|---|---|---|---|
| S4a: 2 × 1,000 accounts, clustering off (5 seeds) | 4.0% | 4.2% (2.8–5.2) | 1.05× (0.69–1.32) | 0% | 0% |
| S4b: same bots, clustering on (5 seeds) | 4.0% | **0%** | 0× | 99.9% | 0.5% |
| S4c: evasive bots (separate devices, aged accounts, spread IPs) | 4.0% | **4.2%** | **1.05×** | **0%** | 0.5% |

- Clustering (shared device, or 3+ fresh accounts from one /24) catches lazy operators and stops nothing better than that.
- The 0.5% false merges come from simulated roommates sharing a device. A real-world rate would differ.
- In this demo, accounts are **free** (demo login). The real lever is **making accounts expensive**: phone OTP (one account per number; on branch `feature/phone-verification`, unreviewed), college email, or ID.
- Even then, an attacker who owns K genuinely distinct identities gets K× the odds, never more.

## Can the operator rig the draw?
Short answer: not without it being detectable.
1. The secret's SHA-256 is **published when the drop is created**, before any entry.
2. At close, the entry list is **frozen and hashed**, and the draw **commits to a future drand round** (League of Entropy quicknet, published every 3s).
3. `seed = SHA256(secret || entries_hash || drand_randomness)`. The randomness doesn't exist yet when the list is fixed, so the operator can't try entry lists until one favours a friend.
4. `npm run verify` checks, from public data only:
   - the secret against its commitment;
   - the list against its hash;
   - the drand BLS signature against the League of Entropy key, plus a **fresh fetch from drand**;
   - the recomputed winners.

What it **can't** prove:
- that the operator didn't register fake accounts as ordinary entrants (they get ordinary odds, and the public list and counts make them visible);
- that exclusions were fair.

If drand is unreachable for 30s, the draw proceeds commit-reveal only and **says so** ("beacon: none (fallback)").

## Why no Redis? Will this scale to multiple instances?
- **Postgres provides all the correctness**: unique indexes, row locks, `SKIP LOCKED`, transactions. Redis would have been an accelerator, not a source of truth. For a one-day solo build, a second stateful service was more risk than benefit.
- **What doesn't scale today:** the rate limiter, counters and read caches are in process memory. Run **one instance**; with several, each enforces its own limits. Scheduling *is* safe across instances (advisory locks plus status rechecks).
- **To scale out:** move the token buckets and counters to Redis (the modules are already isolated), run the scheduler as a separate worker (same `tick()`), and put a pooler in front of Postgres.
- **Locally**, one Node process served the 50k-account flash crowd with human entry p50 about 2–3ms and p95 1.7–2.3s at the opening burst, with no human left without an answer. That's single-machine evidence, not a hosted benchmark.

## Why is the multiplier not exactly 1.0?
Sampling noise. Bots hold about 2,500 of 50,000 accounts, so with 500 seats they expect about 25 seats, with a standard deviation of about 5. A ±5-seat swing moves the multiplier by about ±0.2.

Across 6 full-scale S3 runs: **0.85× on average, range 0.67–1.04**. Bot seat share averaged 4.3% against a 5.0% account share. A test also confirms that early and late arrivals win at the same rate, and the dashboard's arrival chart is flat at about 1% per decile.

## What happens if the server crashes mid-draw?
- The draw is **one database transaction**. A crash rolls it back and the drop stays `frozen`.
- On restart the scheduler re-runs it with the **same secret, the same frozen entry list and the same committed drand round**, so the result is **identical**. It's a pure function of those inputs.
- Tested by injecting a crash after the ranks are written (with and without drand), then re-running and checking the winners against an independent recomputation. A real `kill -9` mid-draw hasn't been tested.
- Sessions are stateless signed cookies, so users stay signed in across the restart (verified with `kill -9` and restart: same cookie, same "entered" state).
- Entries and purchases are idempotent, so retries after a crash never create duplicates.
