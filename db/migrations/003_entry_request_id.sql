-- Entries are naturally idempotent on (drop_id, user_id). Storing the Idempotency-Key on the row lets a
-- same-key retry replay the original 201 in a single autocommit INSERT (no idempotency_keys round trips).
ALTER TABLE entries ADD COLUMN request_id text;
