-- Allow `check` / `uncheck` steps (agent-browser check/uncheck <ref>). They are
-- the state-aware way to drive checkboxes: `click` toggles blindly, while
-- check/uncheck assert the desired end state (a no-op when already there), so a
-- re-run or retry can't accidentally flip a box back.
-- SQLite can't ALTER a CHECK constraint, so recreate scenario_steps with the
-- widened kind set. scenario_steps is a leaf table (nothing FK-references it),
-- so recreating it with foreign keys enforced is safe; rows are copied verbatim.
CREATE TABLE scenario_steps_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'navigate','click','type','fill','select','check','uncheck','scroll','screenshot','wait','evaluate',
    'record_start','record_stop','close'
  )),
  payload_json TEXT NOT NULL DEFAULT '{}'
);

INSERT INTO scenario_steps_new (id, scenario_id, position, kind, payload_json)
  SELECT id, scenario_id, position, kind, payload_json FROM scenario_steps;

DROP TABLE scenario_steps;

ALTER TABLE scenario_steps_new RENAME TO scenario_steps;

CREATE INDEX idx_scenario_steps_scenario ON scenario_steps(scenario_id, position);
