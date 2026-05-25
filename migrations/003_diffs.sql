-- Visual-diff feature.
--
-- An "artifact" is any comparable PNG: a copied run screenshot, or the diff
-- image produced by a comparison. Because a diff output is itself an artifact,
-- a comparison can reference a previous diff as one of its inputs ("diff a
-- diff again").
--
-- source_run_id is a SOFT reference only — deliberately NOT a foreign key to
-- runs. Deleting a run hard-removes its screenshot folder, but artifacts own a
-- COPY of the image (under data/diffs/), so existing comparisons stay viewable.
CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('run_screenshot', 'diff')),
  file_path TEXT NOT NULL,            -- relative to dataDir
  scenario_id INTEGER,                -- soft ref, for filtering/listing
  source_run_id INTEGER,              -- soft ref; null for diff outputs / deleted runs
  label TEXT,                         -- slot key: NNN-label-viewport (for run_screenshot)
  viewport TEXT,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_artifacts_scenario ON artifacts(scenario_id);
CREATE INDEX idx_artifacts_run ON artifacts(source_run_id);

CREATE TABLE comparisons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER,
  baseline_artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  target_artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  diff_artifact_id INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
  threshold REAL NOT NULL DEFAULT 0.1,
  mismatch_ratio REAL,                -- changed pixels / compared pixels (0..1)
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'size_mismatch', 'error')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_comparisons_scenario ON comparisons(scenario_id, created_at DESC);
