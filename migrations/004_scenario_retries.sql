-- Per-scenario step retry policy. When a step fails, the runner re-attempts it
-- up to `retries` times, pausing `retry_wait_before_ms` before each retry and
-- `retry_wait_after_ms` after a retry that succeeds.
ALTER TABLE scenarios ADD COLUMN retries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scenarios ADD COLUMN retry_wait_before_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scenarios ADD COLUMN retry_wait_after_ms INTEGER NOT NULL DEFAULT 0;
