-- First-come-first-served queue numbers for pre-sale queues: one counter per drop, bumped under the drop row lock.
ALTER TABLE drops ADD COLUMN queue_seq int NOT NULL DEFAULT 0;
