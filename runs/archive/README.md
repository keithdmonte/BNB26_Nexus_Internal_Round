# Archived runs

Superseded reports kept for history; hidden from the dashboard (`sim_runs.archived = true`).

- `S3-seed1-scale1-2026-10-03T13-35-34-571Z.json`: S3 at full scale **before** the entry-path optimisation
  (one autocommit insert instead of a transaction plus an idempotency row, and load shedding moved after rate limiting).
  Human write p95 5.6s, 32.5% per-request 503s. Replaced by `S3-seed1-scale1-2026-10-03T13-38-04-456Z.json`.
