-- drand beacon bookkeeping. beacon_round / beacon_value already exist (001).
-- status: pending (round committed at freeze, not yet fetched), drand (verified round used),
--         fallback (drand unreachable past the timeout: commit-reveal only), disabled (BEACON=off).
ALTER TABLE drops ADD COLUMN beacon_status text CHECK (beacon_status IN ('pending', 'drand', 'fallback', 'disabled')),
                  ADD COLUMN beacon_signature text,
                  ADD COLUMN beacon_first_try_at timestamptz;
