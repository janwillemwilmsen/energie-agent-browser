-- Allow `pause` steps: the run stops at that step, keeps the browser session
-- alive, and waits for Resume (or Abort / a timeout) from the UI. Same
-- recreate recipe as 023_save_text_step.sql.
CREATE TABLE scenario_steps_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'navigate','click','type','fill','select','check','uncheck','scroll','screenshot','wait','evaluate',
    'record_start','record_stop','close','press','save_text','pause'
  )),
  payload_json TEXT NOT NULL DEFAULT '{}'
);

INSERT INTO scenario_steps_new (id, scenario_id, position, kind, payload_json)
  SELECT id, scenario_id, position, kind, payload_json FROM scenario_steps;

DROP TABLE scenario_steps;

ALTER TABLE scenario_steps_new RENAME TO scenario_steps;

CREATE INDEX idx_scenario_steps_scenario ON scenario_steps(scenario_id, position);
