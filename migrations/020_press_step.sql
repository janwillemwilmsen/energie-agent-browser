-- Allow `press` steps (agent-browser press <key>): a keyboard key or chord sent
-- to the focused element — Enter to submit, Tab to move focus, Escape to close
-- a dialog, Space to toggle a focused checkbox the mouse can't reach.
-- SQLite can't ALTER a CHECK constraint, so recreate scenario_steps with the
-- widened kind set (same recipe as 018_check_steps.sql).
CREATE TABLE scenario_steps_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'navigate','click','type','fill','select','check','uncheck','scroll','screenshot','wait','evaluate',
    'record_start','record_stop','close','press'
  )),
  payload_json TEXT NOT NULL DEFAULT '{}'
);

INSERT INTO scenario_steps_new (id, scenario_id, position, kind, payload_json)
  SELECT id, scenario_id, position, kind, payload_json FROM scenario_steps;

DROP TABLE scenario_steps;

ALTER TABLE scenario_steps_new RENAME TO scenario_steps;

CREATE INDEX idx_scenario_steps_scenario ON scenario_steps(scenario_id, position);
