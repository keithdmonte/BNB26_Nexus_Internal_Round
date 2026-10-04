# Abuse Defense (as built)

Each defense below is marked **Built**, **Partial** or **Not built**.

## Principle
Make **speed worthless** (lottery), make **volume worthless** (one entry per account, idempotency), and make **accounts expensive and detectable** (verification plus clustering). Each defense below lists what it costs real users and what it does not stop.

## Threat model
| ID | Attacker | Capability | Goal |
|---|---|---|---|
| T1 | Fast bot | Fires at t=0 with ~10ms reaction | Win by being first |
| T2 | Flooder | Thousands of req/s from one or a few IPs | Win by volume, or starve humans |
| T3 | Retrier | Retries on every error or 429, polls aggressively | Win by persistence |
| T4 | Multi-account operator | K verified accounts (bought or bulk-made) | K× odds |
| T5 | IP rotator | Each request or account from a different IP | Evade per-IP limits and clustering |
| T6 | Replay / tamper | Re-sends captured requests, edits payloads, guesses IDs | Double allocation, or confirming another user's offer |
| T7 | Insider / operator | Controls the server | Rig the draw |

Out of scope: DDoS at the network layer (that is the platform's job), compromised user devices, and resale after allocation.

## Defenses

### D1. Timed window + lottery (against T1, T3): **Built**
- **How:** entry time has no effect on the outcome (ALLOCATION_DESIGN).
- **Cost to real user:** they wait for the draw instead of knowing instantly, and some lose who would have won a fast race. The UI says "no need to hurry".
- **Does not stop:** T4. With K accounts the odds are still K×.

### D2. One entry per account + idempotency (against T2, T3, T6): **Built**
- **How:** unique `(drop_id,user_id)`. `Idempotency-Key` is required on writes; the same key replays the original response (lottery: from `entries.request_id`; FCFS: from `idempotency_keys`).
- **Cost:** none. A double-click is safe.
- **Does not stop:** T4.

### D3. Rate limiting (against T2, T3): **Built (single instance)**
In-memory token buckets in `src/lib/ratelimit.ts`. They are correct only with one app instance; Redis is the scale-out path (ARCHITECTURE.md, Deliberate tradeoffs).

| Scope | Rate | Burst | Applies to |
|---|---|---|---|
| Per user, writes | 2/s | 5 | entries, confirm, purchase |
| Per user, reads | 5/s | 20 | status, poll |
| Per IP | 50/s | 200 | all. Set high because campus NAT puts many real users behind one IP |
| Global | n/a | n/a | Load shedding: 503 + Retry-After when more than `MAX_DB_QUEUE` (500) queries wait for a DB connection. Runs **after** the per-user/IP checks, so flooders are rejected before they consume capacity |

- **Client IP:** `X-Forwarded-For` is trusted only with `TRUST_PROXY=true`. Otherwise the TCP socket address stamped by `server.mjs` is used, so a client can't spoof its IP to dodge per-IP limits.
- **Response:** 429 + `Retry-After`. (Not built: using 429 history as a clustering signal.)
- **Cost:** a shared campus or hostel IP may hit the per-IP limit when everyone enters at once. Mitigation: a high per-IP ceiling, the per-user limit is the main lever, and in lottery mode a 429 costs nothing because there is time to retry.
- **Does not stop:** T5, or slow and patient multi-account attacks. Rate limiting is not needed for fairness in lottery mode; it protects capacity.

### D4. Cheap status reads (against T3 read load): **Partial**
- **Built:** ETag/304 on `/me`, 250ms caches on the drop and listing counts, and a read rate limit.
- **Not built:** SSE push. Clients poll every 3s.

### D5. Account verification gate (against T4): **Not built on main**
- Entry requires `verified` in the session, but the only sign-in is **demo login** (`DEV_LOGIN=true`), which verifies any unused email. **In the demo build, accounts cost nothing.** Demo login can't take over an existing email (409 `EMAIL_TAKEN`).
- Phone OTP (one account per number) exists on the unreviewed `feature/phone-verification` branch.
- **Cost:** friction at signup. An allowlisted domain excludes legitimate outsiders.
- **Does not stop:** an attacker who can mint many emails on an accepted domain, or buy verified accounts.

### D6. Pre-draw clustering (against T4, T5): **Partial**
`scoreEntries()` in `src/lib/risk.ts` runs at freeze when `config.risk` is on. It reads only request and account metadata, **never `sim_labels`**.

| Signal | Built? | Rule |
|---|---|---|
| Same device fingerprint | Built | ≥ 2 entries with the same `X-Device-Fp` are linked. **Client-supplied and spoofable**; the browser value is a weak hash (UA, screen, timezone, language), so identical phones could collide |
| Fresh accounts from the same /24 | Built | ≥ 3 accounts created < 24h before open, same signup /24. Old accounts behind one NAT are never linked (campus Wi-Fi) |
| Timing regularity, challenge token, 429 history, email similarity | Not built | n/a |

- **Action:** linked entries form a cluster (union-find). `collapse` (the default) keeps the entry with the lowest `public_id` (arbitrary but deterministic); `exclude` drops the whole cluster. Affected users see "under review". There is no appeal flow.
- **Measured** (full scale): clustering-on with cooperative bots (S4b) gives bots 0% of seats with 0.5% of humans falsely merged. The 0.5% comes from synthetic "roommate" pairs, so it is not a real-world estimate. Evasive bots (S4c: distinct devices, aged accounts, spread IPs) are **not caught**: bot seat share ≈ account share.
- **Does not stop:** a careful operator using distinct devices, residential IPs, aged accounts, and human-like timing. **Sybil resistance is fundamentally about the cost of identity. We raise that cost; we do not eliminate the attack.**

### D7. Optional proof-of-work on entry (against T2, T4, partially): **Not built**
- The client solves a hashcash puzzle (~1–2s on a phone) bound to `(user, drop, nonce)`. It is a toggle so we can measure its effect.
- **Cost:** battery and delay on slow phones; accessibility concern.
- **Does not stop:** a funded attacker. It costs seconds of CPU per account, which is trivial next to the price of an account. Weak against T4; useful against floods of unverified junk.

### D8. Authorization and tamper resistance (against T6): **Built**
- **Sessions:** a signed JWT cookie (`HttpOnly`, `SameSite=Lax`, `Secure` in production). CSRF: SameSite plus a required `X-Requested-With` header on writes.
- **Admin:** a one-time `/admin/login` exchanges `ADMIN_TOKEN` for an `HttpOnly; SameSite=Strict` cookie signed with a separate key. Tokens in URLs are rejected. Scripts may send `X-Admin-Token`.
- **IDs:** writes act only on the session's own user. Public IDs are UUIDv4 or HMACs, never sequential.
- **Key reuse:** FCFS rejects reusing an idempotency key with a different body (422).
- **Does not stop:** a stolen session cookie (out of scope).

### D9. Commit-reveal + drand beacon (against T7): **Built**
- The secret is committed at creation. At freeze the draw commits to a *future* drand quicknet round, then fetches and BLS-verifies it at draw time. `npm run verify` re-fetches the round from drand independently.
- **Stops:** steering the seed, including by grinding fake entries before freeze, because the randomness is unknown until after the entry set is fixed.
- **Does not stop:** fake accounts entered as ordinary entrants (they get ordinary odds, and the public list and counts make them visible), or biased exclusion. If drand is unreachable for 30s the draw falls back to commit-reveal only, **recorded and shown as "beacon: none (fallback)"**.

## Simulated IP rotation (honest limitation)
From one load generator, every request has the same source IP. To test per-IP limits and IP clustering, the simulator sends `X-Sim-Client-IP`. The app trusts it **only** when `SIM_MODE=true` **and** the request carries a valid `X-Sim-Secret`. In production mode the header is ignored. Results for T5 therefore show what our logic does with rotating IPs, not how a real proxy network behaves.

## Attack vs defense matrix
Built defenses only (D5 and D7 are not built on main):

| | D1 | D2 | D3 | D6 | D8 | D9 | Residual risk |
|---|---|---|---|---|---|---|---|
| T1 fast bot | ✔ | | | | | | none |
| T2 flooder | ✔ | ✔ | ✔ | | | | capacity only |
| T3 retrier | ✔ | ✔ | ✔ | | | | none |
| T4 multi-account | | | | ~ | | | **high**: K undetected accounts give K× odds; accounts are free in the demo build |
| T5 IP rotator | ✔ | ✔ | ✘ | ~ | | | same as T4 |
| T6 replay/tamper | | ✔ | | | ✔ | | stolen session |
| T7 insider | | | | | | ✔ | fake entrants with ordinary odds; biased exclusion; fallback draws |
