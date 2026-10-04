-- Seat selection after the draw (drops with config.seatSelect). The draw fixes queue order only;
-- users are admitted in rank order, pick up to 6 seats on a venue map, hold them, then pay (mock).

-- Venue geometry per seat. x/y are in the venue's own coordinate space (drops.config.venue).
ALTER TABLE seats ADD COLUMN section text,
                  ADD COLUMN row_label text,
                  ADD COLUMN seat_label text,
                  ADD COLUMN price int,
                  ADD COLUMN x real,
                  ADD COLUMN y real;

-- Queue state. serving_rank = number of ranks admitted so far (ranks are 0-based, so rank < serving_rank is in).
ALTER TABLE drops ADD COLUMN serving_rank int NOT NULL DEFAULT 0,
                  ADD COLUMN queue_started_at timestamptz,
                  ADD COLUMN queue_target_s real,
                  ADD COLUMN queue_pace_rank int;

ALTER TABLE draw_ranks ADD COLUMN admitted_at timestamptz;

CREATE TYPE order_status AS ENUM ('held', 'paid', 'expired');

CREATE TABLE orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id     uuid NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  status      order_status NOT NULL DEFAULT 'held',
  seat_count  int NOT NULL CHECK (seat_count BETWEEN 1 AND 6),
  total       int NOT NULL,
  expires_at  timestamptz NOT NULL,
  paid_at     timestamptz,
  payment_ref text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- One live order per user per drop.
CREATE UNIQUE INDEX one_live_order_per_user ON orders (drop_id, user_id) WHERE status IN ('held', 'paid');
CREATE INDEX orders_expiry ON orders (expires_at) WHERE status = 'held';

ALTER TABLE allocations ADD COLUMN order_id uuid REFERENCES orders(id);
CREATE INDEX allocations_order ON allocations (order_id);

-- Order seats share a user, so the one-seat-per-user rule now applies only outside orders.
DROP INDEX one_active_per_user;
CREATE UNIQUE INDEX one_active_per_user ON allocations (drop_id, user_id)
  WHERE status IN ('offered', 'confirmed') AND order_id IS NULL;
