-- Video recording of scenario runs (agent-browser record start/stop → .webm).

-- Per-scenario opt-in. When 1, the runner wraps the scenario's steps in a
-- `record start <file> … record stop` and saves the webm under
-- data/recordings/<scenario_id>/.
ALTER TABLE scenarios ADD COLUMN record_enabled INTEGER NOT NULL DEFAULT 0;

-- One row per recorded run video. scenario_id / run_id are SOFT references (no
-- FK) so a recording — and its on-disk webm — survives deletion of the scenario
-- or run it came from; the file is removed only when the recording itself is
-- deleted from the Recordings page.
CREATE TABLE recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER,
  run_id INTEGER,
  file_path TEXT NOT NULL,          -- relative to dataDir
  size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_recordings_scenario ON recordings(scenario_id);
CREATE INDEX idx_recordings_created ON recordings(created_at DESC);
