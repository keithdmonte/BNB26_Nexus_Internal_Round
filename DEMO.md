# Fair Drop: Demo Script (about 7 minutes)

All numbers are from local full-scale runs: 50,000 simulated accounts, 500 seats, 5–6 seeds per scenario. Raw reports are in `runs/`.

## Before you present (T-10 minutes)
```bash
pg_isready                                  # Postgres up
npm run build && npm start                  # http://localhost:3000 (server.mjs; do NOT use `next start`)
npm run seed:demo -- --first-open-in 120 --gap 60 --window 600   # 4 fresh events
```
1. Open `http://localhost:3000/admin/login` and paste `ADMIN_TOKEN` from `.env`. You land on `/dashboard`.
2. Open a second tab at `http://localhost:3000/` (event listing).
3. Keep a terminal ready in the repo.
4. **Use `localhost`, not the LAN IP.** Cookies are `Secure`, so sign-in won't stick over `http://192.168…`.
5. **Don't restart the server after this point.** The live 429 counters are in memory.

## 1. The problem (30s)
"500 seats, 50,000 people. In first-click-wins, bots are faster, so bots win."

## 2. Naive FCFS under attack (1 min): dashboard, S2 row
- Bots are **5.0%** of accounts and won **100%** of seats in all 6 runs. Advantage: **∞** (humans won zero).
- Integrity is OK: inventory is never wrong. **The problem is fairness, not correctness.**
- Point at the arrival chart: under FCFS, only the first 10% of arrivals win anything (10% P(win)); everyone else has 0%.

## 3. Fair Drop under the same attack (1 min): S3 row and across-seeds table
- Same bots: **4.3% of seats on average (range 3.4–5.2%) for 5.0% of accounts**, advantage **0.85× (range 0.67–1.04)**.
- Arrival chart: the lottery line is flat at about 1% for every decile. Arriving early buys nothing.
- Flooders got about 19,000 429 responses per run; no human was left without an answer.
- "Why not exactly 1.0? 500 seats is a small sample. Bots expect about 25 seats, ±5 run to run. The range across seeds is shown."

## 4. Multi-account attacks: the honest part (1.5 min): S4a, S4b, S4c
- **S4a** (2 operators × 1,000 accounts, clustering off): bots get **4.2%**, i.e. their account share. "The lottery stops speed, not accounts."
- **S4b** (same bots, clustering on): **0%** of seats, 99.9% of bot entries caught, **0.5% of humans falsely merged** (planted roommates sharing a device).
- **S4c** (evasive: separate devices, 90-day-old accounts, spread IPs): **4.2%**, multiplier **1.05**, **0% caught**.
- "With K accounts that look like real people, you get K× the odds. The fix is account cost (phone or ID verification). That's on a separate branch, not shown."

## 5. Integrity proof (30s): S6 row
- The deliberately broken mode (no locks, no constraints) sold **756 of 500** seats, with 32 double-booked. The checker flags it in red.
- Every real mode, every run: **0 oversell, 0 duplicate seats, 0 duplicate users**.

## 6. Trust the draw (1 min): terminal
```bash
npm run verify -- http://localhost:3000/api/drops/2c4c076e-c591-4a4b-9230-a5fed0fdb674/audit
```
Expect 11 × PASS, including "drand beacon signature valid" and "drand round matches independent fetch", then `DRAW VERIFIED`.

"We published a hash of our secret before entries opened. At close we froze the entry list and committed to a *future* drand round from the League of Entropy. Nobody, including us, could know the result until after the list was fixed. This script uses only public data and drand itself."

## 7. Live (1 min, optional): event listing
1. Click an event that's live (green LIVE), sign in with any email, and click **Enter the queue**.
2. Refresh: still "You're in the draw".
3. On the dashboard, Demo controls → **Close & draw now** next to that event, or wait for its window to end. The page shows the result within about 3s.
   - The draw waits about 6–9s for the committed drand round.

## Fallbacks if something fails live
| Failure | Do this |
|---|---|
| Server won't start or crashes | Show the screenshots and run JSONs in `runs/`. Restart with `npm start`; sessions survive the restart. |
| Dashboard empty or broken | Open `runs/S2-seed6-scale1-*.json` and `runs/S3-seed6-scale1-*.json`, and point at `summary` and `arrivalDecilesAll`. |
| No internet (drand) | Live draws wait 30s, then fall back and say so ("beacon: none (fallback)") in the audit and verify output. Say: "it's designed to tell you when it couldn't get public randomness." |
| `verify` can't reach drand | That check fails visibly; the rest still pass. Run it on any older draw: it verifies with a "commit-reveal only" note. |
| Demo events already closed | `npm run seed:demo -- --first-open-in 30 --gap 30 --window 300` (hides the old ones). |
| Laptop too slow for a live 50k run | Don't run one live. A 5k run takes about 70s: `npm run sim -- --scenario S3 --scale 0.1`. |
