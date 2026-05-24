CREATE TABLE scenarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  viewport_preset TEXT NOT NULL CHECK (viewport_preset IN ('desktop', 'mobile', 'both')) DEFAULT 'desktop',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE scenario_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('navigate','click','type','fill','scroll','screenshot','wait','evaluate')),
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_scenario_steps_scenario ON scenario_steps(scenario_id, position);

CREATE TABLE schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  cron_expr TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_status TEXT
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','success','failed')) DEFAULT 'queued',
  log_text TEXT NOT NULL DEFAULT '',
  screenshot_paths_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_runs_scenario_started ON runs(scenario_id, started_at DESC);
