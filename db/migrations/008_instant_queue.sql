-- Instant demo queue (drops with config.instantQueue): each entrant gets a random queue number at
-- entry time and is admitted to seat selection queue_admit_at (a few seconds later). No shared draw.
ALTER TABLE entries ADD COLUMN queue_pos int,
                    ADD COLUMN queue_admit_at timestamptz;
