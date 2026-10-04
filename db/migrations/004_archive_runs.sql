-- Superseded simulator runs stay in the database for history but are hidden from the dashboard.
ALTER TABLE sim_runs ADD COLUMN archived boolean NOT NULL DEFAULT false;
