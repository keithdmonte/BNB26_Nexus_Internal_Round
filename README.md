# Fair Drop

500 seats, 50,000 people, bots in the crowd. Fair Drop replaces "first click wins" with a timed entry window and a
verifiable random draw, so speed, request volume and retries stop mattering. The remaining attack (many accounts)
is reduced by draw-time clustering.

## Results (50,000 simulated accounts, 500 seats, local, 5–6 seeds each)

| Scenario | Bot share of accounts | Bot share of seats, mean [range] | Bot advantage*, mean [range] | Integrity |
|---|---|---|---|---|
| S2 Naive FCFS under bot attack (6 seeds) | 5% | 100% [100–100] | ∞ (humans won 0) | OK |
| S3 Fair Drop, same attack (6 seeds) | 5% | 4.3% [3.4–5.2] | 0.85× [0.67–1.04] | OK |
| S4a 2 operators × 1,000 accounts, clustering off (5 seeds) | 4% | 4.2% [2.8–5.2] | 1.05× [0.69–1.32] | OK |
| S4b same, clustering on (5 seeds) | 4% | 0% | 0× (0.5% humans falsely merged) | OK |
| S4c evasive multi-account, clustering on (1 seed) | 4% | 4.2% | 1.05× (not caught) | OK |
| S6 Deliberately unsafe FCFS | n/a | 100% | humans won 0 | 756/500 sold: detected |

\*P(win | bot account) / P(win | human account). 1.0 = no advantage. Raw reports: `runs/*.json`.
P(win) by arrival decile (S2 vs S3, seed 6): FCFS 10% for the first decile and 0% after; lottery 0.9–1.3% in every decile.

## Run it
```bash
npm install
cp .env.example .env            # set secrets; SIM_MODE=true and DEV_LOGIN=true for the demo
npm run migrate
npm run build && npm start      # http://localhost:3000  (server.mjs; stamps the socket IP)
npm run seed:demo               # 4 demo events relative to now
npm run sim -- --scenario S3 --scale 1 --seed 1    # scenarios: S0 S1 S2 S3 S4a S4b S4c S6 S7 S8
npm run verify -- http://localhost:3000/api/drops/<dropId>/audit
npm test
```
- Participant pages: `/` (events) and `/drop?drop=<id>`. Demo sign-in stands in for email OTP.
- Dashboard: `/admin/login` (paste `ADMIN_TOKEN`), then `/dashboard`.
- Presenting: DEMO.md. Hard questions: JUDGE_QA.md. Deploying: DEPLOY.md.

## How integrity is guaranteed
- Exactly `inventory` seat rows; partial unique indexes allow one active allocation per seat and per user.
- FCFS claims seats with `FOR UPDATE SKIP LOCKED` in one transaction with its idempotency key.
- Entries: unique per (drop, user); a DB trigger rejects entries once the window closes.
- The draw is one transaction and deterministic: `seed = SHA256(secret || entriesHash || drandRandomness)`. The secret
  is committed before entries open, and the drand round is committed at freeze, before it exists. A crash means
  re-run with the identical result.

## Known limits
- Multi-account attacks are reduced, not solved: K undetected accounts give K× odds (S4c), and demo login makes accounts free.
- IP rotation is simulated via a sim-only trusted header.
- Single instance: in-memory rate limiter (Redis is the scale-out path). Full-scale runs are local, not hosted.
- See docs/ARCHITECTURE.md, "Deliberate tradeoffs".

Design docs: `docs/`. The Lean MVP section in `docs/BUILD_PLAN.md` lists what was cut for the deadline.
