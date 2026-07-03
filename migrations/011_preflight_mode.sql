-- How an attached preflight is applied when a scenario runs:
--   'steps'   → re-run the preflight's recorded steps in a CLEAN browser every
--               run (fresh login/consent). Default; matches prior behaviour.
--   'cookies' → skip the steps and just load the preflight's saved
--               cookies/localStorage state (fast). Requires that the preflight
--               has a saved state file (Save preflight / Replay).
-- Only meaningful when scenarios.preflight_id is set.
ALTER TABLE scenarios ADD COLUMN preflight_mode TEXT NOT NULL DEFAULT 'steps';
