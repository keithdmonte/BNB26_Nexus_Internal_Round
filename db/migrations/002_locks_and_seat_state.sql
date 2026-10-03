-- Seats carry their own held flag so FCFS can claim one with FOR UPDATE SKIP LOCKED;
-- the update forces a recheck of `held` on concurrently modified rows.
ALTER TABLE seats ADD COLUMN held boolean NOT NULL DEFAULT false;
CREATE INDEX seats_free ON seats (drop_id, seat_no) WHERE NOT held;

-- FOR SHARE makes the close transition (UPDATE drops) wait for in-flight entry inserts,
-- so nothing can commit into a drop after it has been closed/frozen.
CREATE OR REPLACE FUNCTION entries_guard() RETURNS trigger AS $$
DECLARE s drop_status;
BEGIN
  SELECT status INTO s FROM drops WHERE id = NEW.drop_id FOR SHARE;
  IF TG_OP = 'INSERT' AND s IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'entries are frozen for drop % (status %)', NEW.drop_id, s
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (s IS NULL OR s NOT IN ('open', 'closed')) THEN
    RAISE EXCEPTION 'entries are frozen for drop % (status %)', NEW.drop_id, s
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
