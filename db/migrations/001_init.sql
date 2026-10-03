-- Fair Drop core schema (Lean MVP). See docs/DATA_MODEL.md.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE drop_mode AS ENUM ('lottery', 'fcfs', 'fcfs_unsafe');
CREATE TYPE drop_status AS ENUM ('scheduled', 'open', 'closed', 'frozen', 'drawn', 'claim', 'done');
CREATE TYPE entry_status AS ENUM ('active', 'excluded', 'collapsed');
CREATE TYPE allocation_status AS ENUM ('offered', 'confirmed', 'expired', 'released');

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE CHECK (email = lower(email)),
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  signup_ip   inet,
  device_fp   text,
  is_sim      boolean NOT NULL DEFAULT false
);
CREATE INDEX users_created_at ON users (created_at);
CREATE INDEX users_signup_ip ON users (signup_ip);
CREATE INDEX users_device_fp ON users (device_fp);

CREATE TABLE drops (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  mode            drop_mode NOT NULL,
  inventory       int NOT NULL CHECK (inventory > 0),
  status          drop_status NOT NULL DEFAULT 'scheduled',
  opens_at        timestamptz NOT NULL,
  closes_at       timestamptz NOT NULL,
  claim_ttl_s     int NOT NULL DEFAULT 0,
  config          jsonb NOT NULL DEFAULT '{}',
  public_salt     bytea NOT NULL DEFAULT gen_random_bytes(16),
  commit          text,
  secret_enc      bytea,
  secret_revealed bytea,
  entries_hash    text,
  eligible_count  int,
  excluded_count  int,
  beacon_round    bigint,
  beacon_value    text,
  seed            text,
  rank_fn_version text NOT NULL DEFAULT 'sha256-v1',
  frozen_at       timestamptz,
  drawn_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (closes_at > opens_at)
);

CREATE TABLE seats (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id uuid NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  seat_no int NOT NULL,
  UNIQUE (drop_id, seat_no)
);

CREATE TABLE entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id          uuid NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id),
  public_id        text NOT NULL,
  status           entry_status NOT NULL DEFAULT 'active',
  exclusion_reason text,
  cluster_id       text,
  risk_score       real,
  ip               inet,
  device_fp        text,
  challenge_ok     boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (drop_id, user_id),
  UNIQUE (drop_id, public_id)
);
CREATE INDEX entries_drop_status ON entries (drop_id, status);
CREATE INDEX entries_drop_ip ON entries (drop_id, ip);
CREATE INDEX entries_drop_fp ON entries (drop_id, device_fp);

-- Entries may only change while the drop is open or closed (pre-freeze).
CREATE FUNCTION entries_guard() RETURNS trigger AS $$
DECLARE s drop_status;
BEGIN
  SELECT status INTO s FROM drops WHERE id = NEW.drop_id;
  IF s IS NULL OR s NOT IN ('open', 'closed') THEN
    RAISE EXCEPTION 'entries are frozen for drop % (status %)', NEW.drop_id, s
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER entries_guard BEFORE INSERT OR UPDATE ON entries
  FOR EACH ROW EXECUTE FUNCTION entries_guard();

CREATE TABLE draw_ranks (
  drop_id  uuid NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  rank     int NOT NULL,
  rank_key bytea NOT NULL,
  PRIMARY KEY (drop_id, rank),
  UNIQUE (drop_id, entry_id)
);

CREATE TABLE allocations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id      uuid NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  seat_id      uuid NOT NULL REFERENCES seats(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  entry_id     uuid REFERENCES entries(id),
  rank         int,
  status       allocation_status NOT NULL,
  offered_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  confirmed_at timestamptz,
  request_id   text
);
CREATE UNIQUE INDEX one_active_per_seat ON allocations (seat_id)
  WHERE status IN ('offered', 'confirmed');
CREATE UNIQUE INDEX one_active_per_user ON allocations (drop_id, user_id)
  WHERE status IN ('offered', 'confirmed');
CREATE INDEX alloc_expiry ON allocations (drop_id, expires_at) WHERE status = 'offered';

-- Same shape, deliberately WITHOUT integrity indexes: fcfs_unsafe writes here
-- so the oversell it causes is visible instead of blocked.
CREATE TABLE allocations_unsafe (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id      uuid NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  seat_id      uuid NOT NULL REFERENCES seats(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  status       allocation_status NOT NULL,
  offered_at   timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  request_id   text
);
CREATE INDEX allocations_unsafe_drop ON allocations_unsafe (drop_id);

CREATE TABLE idempotency_keys (
  user_id      uuid NOT NULL,
  key          text NOT NULL,
  req_hash     text NOT NULL,
  state        text NOT NULL CHECK (state IN ('in_progress', 'done')),
  status_code  int,
  body         jsonb,
  locked_until timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at);

CREATE TABLE events (
  id      bigserial PRIMARY KEY,
  drop_id uuid,
  user_id uuid,
  ip      inet,
  type    text NOT NULL,
  reason  text,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_drop_type_at ON events (drop_id, type, at);

CREATE TABLE metric_snapshots (
  id      bigserial PRIMARY KEY,
  drop_id uuid NOT NULL,
  run_id  uuid,
  at      timestamptz NOT NULL DEFAULT now(),
  data    jsonb NOT NULL
);
CREATE INDEX metric_snapshots_drop_at ON metric_snapshots (drop_id, at);

-- Simulator ground truth. Defense code must never read sim_labels.
CREATE TABLE sim_runs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario   text NOT NULL,
  seed       bigint NOT NULL,
  config     jsonb NOT NULL DEFAULT '{}',
  drop_id    uuid REFERENCES drops(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz,
  report     jsonb
);

CREATE TABLE sim_labels (
  run_id      uuid NOT NULL REFERENCES sim_runs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  actor_type  text NOT NULL CHECK (actor_type IN ('human', 'fast_bot', 'flooder', 'retrier', 'multi', 'rotator')),
  operator_id text,
  PRIMARY KEY (run_id, user_id)
);
