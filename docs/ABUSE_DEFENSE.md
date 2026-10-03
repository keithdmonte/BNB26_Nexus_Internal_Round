# Abuse Defense

> **Deadline build:** BUILD_PLAN.md "Lean MVP" overrides this doc where they differ (single Next.js service + Postgres, no Redis, signed-cookie sessions, poll instead of SSE, auto-confirm, no drand). This doc describes the target design.

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

### D1. Timed window + lottery (against T1, T3)
- **How:** entry time has no effect on the outcome (ALLOCATION_DESIGN).
- **Cost to real user:** they wait for the draw instead of knowing instantly, and some lose who would have won a fast race. The UI says "no need to hurry".
- **Does not stop:** T4. With K accounts the odds are still K×.

### D2. One entry per account + idempotency (against T2, T3, T6)
- **How:** unique `(drop_id,user_id)`; `Idempotency-Key` on all writes; duplicate requests return the original response.
- **Cost:** none. A double-click is safe.
- **Does not stop:** T4.

### D3. Rate limiting (against T2, T3)
Redis token bucket implemented as an atomic Lua script. Starting values, to tune in M12:

| Scope | Rate | Burst | Applies to |
|---|---|---|---|
| Per user, writes | 2/s | 5 | entries, confirm, purchase |
| Per user, reads | 5/s | 20 | status, poll |
| Per IP | 50/s | 200 | all. Set high because campus NAT puts many real users behind one IP |
| Global, writes | sized to PG capacity | n/a | Returns 503 + Retry-After instead of falling over |

- **Response:** 429 + `Retry-After`. Repeated 429s raise a `flood` signal for that user/IP.
- **Cost:** a shared campus or hostel IP may hit the per-IP limit when everyone enters at once. Mitigation: a high per-IP ceiling, the per-user limit is the main lever, and in lottery mode a 429 costs nothing because there is time to retry.
- **Does not stop:** T5, or slow and patient multi-account attacks. Rate limiting is not needed for fairness in lottery mode; it protects capacity.

### D4. Push instead of poll (against T3 read load)
- SSE `result_ready` event plus an ETag'd status endpoint. A human never needs to poll fast.
- **Cost:** none. **Does not stop:** anything adversarial; it only reduces load.

### D5. Account verification gate (against T4)
- Only `verified_at IS NOT NULL` accounts can enter. Real mode: email OTP (provider TBD, OPEN_QUESTIONS). Optional stronger tiers: college email domain allowlist, phone OTP.
- **Cost:** friction at signup. An allowlisted domain excludes legitimate outsiders.
- **Does not stop:** an attacker who can mint many emails on an accepted domain, or buy verified accounts.

### D6. Pre-draw risk scoring and clustering (against T4, T5)
Runs at freeze over all entries. It reads only request/account metadata, **never `sim_labels`**.

| Signal | Weight (initial) | Notes |
|---|---|---|
| Account created < 24h before drop / during window | medium | Bulk-registration pattern. In the demo, sim bot accounts register in a burst |
| Same device fingerprint across accounts | high | Fingerprint from a client-side hash (UA + screen + timezone + canvas, cheap). Spoofable |
| Same signup IP or /24 across accounts in a short time | medium | Campus NAT gives false positives; capped weight |
| Inter-request timing regularity (low coefficient of variation) | medium | Scripted clients |
| Missing or invalid client challenge token | high | Token from a JS challenge (stub, or proof-of-work, D7) |
| Flood/429 history in this drop | medium | |
| Email pattern similarity (`name+1`, sequential local parts) | low | |

- **Action:** accounts linked by strong signals form a **cluster**. Policy (configurable per drop): `collapse` (the cluster gets one entry, the lowest-risk account's) or `exclude` (score ≥ threshold is excluded). The default is `collapse`, because it limits harm from a false positive: a wrongly clustered human keeps one entry instead of zero.
- **Cost:** false positives (roommates on one laptop, a family sharing a device, a campus NAT). Measured as the human false-exclusion rate (METRICS). Excluded users see "entry under review" plus an appeal stub.
- **Does not stop:** a careful operator using distinct devices, residential IPs, aged accounts, and human-like timing. **Sybil resistance is fundamentally about the cost of identity. We raise that cost; we do not eliminate the attack.**

### D7. Optional proof-of-work on entry (against T2, T4, partially)
- The client solves a hashcash puzzle (~1–2s on a phone) bound to `(user, drop, nonce)`. It is a toggle so we can measure its effect.
- **Cost:** battery and delay on slow phones; accessibility concern.
- **Does not stop:** a funded attacker. It costs seconds of CPU per account, which is trivial next to the price of an account. Weak against T4; useful against floods of unverified junk.

### D8. Authorization and tamper resistance (against T6)
- Session cookie is `HttpOnly`, `Secure`, `SameSite=Lax`. CSRF: SameSite plus a custom-header requirement on writes.
- Every allocation write checks `user_id = session.user_id`. Public IDs are UUIDv4 or HMAC values, never sequential.
- Idempotency key reuse with a different body gives 422.
- **Does not stop:** a stolen session cookie (out of scope).

### D9. Commit-reveal + public beacon (against T7)
- See ALLOCATION_DESIGN. The operator cannot pick the seed after seeing entries.
- **Does not stop:** an operator inserting fake accounts as entrants before freeze. The published entry list and counts make this visible but not preventable. It also does not stop biased exclusion.

## Simulated IP rotation (honest limitation)
From one load generator, every request has the same source IP at the Railway proxy. To test per-IP limits and IP clustering, the simulator sends `X-Sim-Client-IP`. The app trusts it **only** when `SIM_MODE=true` **and** the request carries a valid `X-Sim-Secret`. In production mode the header is ignored. Results for T5 therefore show what our logic does with rotating IPs, not how a real proxy network behaves.

## Attack vs defense matrix
| | D1 | D2 | D3 | D5 | D6 | D7 | Residual risk |
|---|---|---|---|---|---|---|---|
| T1 fast bot | ✔ | | | | | | none |
| T2 flooder | ✔ | ✔ | ✔ | | ✔ | ~ | capacity only |
| T3 retrier | ✔ | ✔ | ✔ | | ~ | | none |
| T4 multi-account | | | | ~ | ~ | ~ | **high**: proportional to accounts that evade D5/D6 |
| T5 IP rotator | ✔ | ✔ | ✘ | | ~ | | same as T4 |
| T6 replay/tamper | | ✔ | | | | | stolen session |
| T7 insider | | | | | | | fake entrants before freeze (D9 makes them visible only) |
