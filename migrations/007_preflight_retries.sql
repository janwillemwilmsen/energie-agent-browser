-- Per-preflight retry/restart policy, mirroring the scenario columns from
-- migrations 004/005. Applied whenever a preflight runs as a whole:
--   - Replay (clean) on the /preflight page, and
--   - the preflight prefix executed at the start of a scenario run.
-- `retries` re-attempts a failing step (with optional before/after pauses);
-- `restart_on_failure` re-runs the entire preflight from the top after resetting
-- the browser connection.
ALTER TABLE preflights ADD COLUMN retries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preflights ADD COLUMN retry_wait_before_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preflights ADD COLUMN retry_wait_after_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preflights ADD COLUMN restart_on_failure INTEGER NOT NULL DEFAULT 0;
