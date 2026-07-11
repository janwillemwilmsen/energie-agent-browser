-- Key/value app settings (first consumer: the AI scenario-builder model).
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Every prompt executed through the "AI task" modal, per scenario — so a
-- prompt can be inspected and re-run later (e.g. after deleting bad steps).
CREATE TABLE agent_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  steps_added INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_agent_prompts_scenario ON agent_prompts(scenario_id, created_at DESC);
