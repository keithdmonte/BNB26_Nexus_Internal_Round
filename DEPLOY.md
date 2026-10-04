# Deploying Fair Drop on Railway

Prepared but **not executed**. One service (this repo) plus one Railway Postgres.

## 1. Create the services
1. New project → **Deploy from GitHub repo** → this repository. Railway detects the `Dockerfile` and builds with it.
2. Add **PostgreSQL** to the project.
3. In the app service → *Variables*, add `DATABASE_URL = ${{Postgres.DATABASE_URL}}` (reference variable).
4. *Settings → Networking* → **Generate Domain**.

## 2. Environment variables
| Variable | Required | Value / notes |
|---|---|---|
| `DATABASE_URL` | yes | Reference to the Railway Postgres |
| `SESSION_SECRET` | yes | Random, ≥ 32 chars (`openssl rand -hex 32`). Signs user and admin cookies |
| `DRAW_KEY` | yes | Random, ≥ 32 chars. Encrypts draw secrets at rest. **Never change it while a drop is open or frozen**, or that drop can't be drawn |
| `ADMIN_TOKEN` | yes | Random. Used once at `/admin/login`, or as `X-Admin-Token` by scripts |
| `TRUST_PROXY` | **yes on Railway** | `true`. Railway's proxy sets `X-Forwarded-For`; without this every client looks like the proxy and shares one per-IP bucket |
| `DEV_LOGIN` | demo | `true` enables the demo sign-in (any unused email becomes a verified account). **Accounts are then free: no Sybil cost.** Set `false` for anything real |
| `SIM_MODE` | no | Keep `false` on a public URL. `true` enables `/api/sim/*` and the simulated-IP header (still requires `SIM_SECRET`) |
| `SIM_SECRET` | if SIM_MODE | Random |
| `PG_POOL_MAX` | no | Default 20. Keep below the Railway Postgres connection limit |
| `MAX_DB_QUEUE` | no | Default 500. Load-shedding threshold |
| `BEACON` | no | Default on (drand). `off` disables it (recorded as `disabled` in each draw) |
| `BEACON_TIMEOUT_S` | no | Default 30. How long a draw waits for drand before falling back to commit-reveal only |
| `DRAND_URL` | no | Default `https://api.drand.sh`. Needs outbound HTTPS from the container |

`PORT` and `HOSTNAME` are set by Railway / the Dockerfile.

## 3. Migrations
The container runs `scripts/migrate.ts` on every boot before starting the server. It is idempotent (tracked in `schema_migrations`). To run it by hand: `railway run npm run migrate`.

## 4. After the first deploy
```bash
curl https://<domain>/api/health                       # {"ok":true,"db":"ok",...}
open https://<domain>/admin/login                       # paste ADMIN_TOKEN, lands on /dashboard
railway run npm run seed:demo -- --first-open-in 120    # 4 demo events relative to now
```

## 5. Load testing a deployment
Keep the public service at `SIM_MODE=false`. To run the simulator against Railway, temporarily set `SIM_MODE=true` and a fresh `SIM_SECRET`, run `npm run sim -- --target https://<domain> --scenario S3 --scale 0.1` from your machine, then turn it off again. The free or hobby tier will not sustain the 50,000-user scenarios; full-scale numbers in this repo come from local runs.

## Constraints to remember
- **Run exactly one replica.** Rate limits, counters and caches are in process memory (ARCHITECTURE.md, Deliberate tradeoffs). Scheduling is safe with more replicas (advisory locks), but rate limiting is not.
- Sessions are stateless JWTs, so redeploys don't log anyone out.
