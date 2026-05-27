-- Whole-run restart policy. If a run fails after a step exhausts its retries,
-- the runner resets the browser connection and re-runs the entire scenario
-- from the top, up to `restart_on_failure` times.
ALTER TABLE scenarios ADD COLUMN restart_on_failure INTEGER NOT NULL DEFAULT 0;
