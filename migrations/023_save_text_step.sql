-- Allow `save_text` steps: save the rendered page's readable text (agent-browser
-- read) as a Markdown file next to the run's screenshots. Same recreate recipe
-- as 020_press_step.sql, since SQLite can't ALTER a CHECK constraint.
CREATE TABLE scenario_steps_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'navigate','click','type','fill','select','check','uncheck','scroll','screenshot','wait','evaluate',
    'record_start','record_stop','close','press','save_text'
  )),
  payload_json TEXT NOT NULL DEFAULT '{}'
);

INSERT INTO scenario_steps_new (id, scenario_id, position, kind, payload_json)
  SELECT id, scenario_id, position, kind, payload_json FROM scenario_steps;

DROP TABLE scenario_steps;

ALTER TABLE scenario_steps_new RENAME TO scenario_steps;

CREATE INDEX idx_scenario_steps_scenario ON scenario_steps(scenario_id, position);

-- The text files a run saved, in capture order (filenames under the run's
-- artifact dir, like screenshot_paths_json).
ALTER TABLE runs ADD COLUMN text_paths_json TEXT NOT NULL DEFAULT '[]';
