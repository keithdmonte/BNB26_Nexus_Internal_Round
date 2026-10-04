# Fair Drop

500 seats, 50,000 people, bots in the crowd. Fair Drop replaces "first click wins" with a timed entry window and a
verifiable random draw, so speed, request volume and retries stop mattering. The remaining attack (many accounts)
is reduced by draw-time clustering.

## Results (50,000 simulated users, 500 seats, local run, seed 1)

| Scenario | Bot share of accounts | Bot share of seats | Bot advantage* | Integrity |
|---|---|---|---|---|
| S2 Naive FCFS under bot attack | 5% | 81.8% | 85x | OK |
| S3 Fair Drop, same attack | 5% | 4.4% | 0.87x | OK |
| S4a 2 operators x 1,000 accounts, clustering off | 4% | 3.8% | 0.95x | OK |
| S4b same, clustering on | 4% | 0% | 0x (0.5% humans falsely merged) | OK |
| S6 Deliberately unsafe FCFS | n/a | 100% | humans won 0 | 756/500 sold: detected |

\*P(win | bot account) / P(win | human account). 1.0 = no advantage. Raw reports: `runs/*.json`.

## Run it
```bash
npm install
cp .env.example .env            # set secrets; SIM_MODE=true and DEV_LOGIN=true for the demo
npm run migrate
npm run build && npm start      # http://localhost:3000
npm run sim -- --scenario S3 --scale 1 --seed 1    # scenarios: S0 S1 S2 S3 S4a S4b S4c S6
npm run verify -- http://localhost:3000/api/drops/<dropId>/audit
npm test
```
- Participant page: `/` (demo sign-in stands in for email OTP)
- Dashboard: `/dashboard?token=<ADMIN_TOKEN>`

## How integrity is guaranteed
- Exactly `inventory` seat rows; partial unique indexes allow one active allocation per seat and per user.
- FCFS claims seats with `FOR UPDATE SKIP LOCKED` in one transaction with its idempotency key.
- Entries: unique per (drop, user); a DB trigger rejects entries once the window closes.
- The draw is one transaction and deterministic: `seed = SHA256(secret || entriesHash)`, where the secret was
  committed (hash published) before entries opened. A crash means re-run with the identical result.

## Known limits
- Multi-account attacks are reduced, not solved (K undetected accounts give K x odds).
- IP rotation is simulated via a sim-only trusted header.
- Single instance: in-memory rate limiter (Redis is the scale-out path). Full-scale runs are local, not hosted.

Design docs: `docs/`. The Lean MVP section in `docs/BUILD_PLAN.md` lists what was cut for the deadline.
