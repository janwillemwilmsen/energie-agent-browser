-- A schedule can run an ordered chain of scenarios, executed sequentially.
-- scenario_ids_json holds the ordered id list. The legacy scenario_id column
-- stays NOT NULL (FK + back-compat) and mirrors the first scenario of the chain.
ALTER TABLE schedules ADD COLUMN scenario_ids_json TEXT NOT NULL DEFAULT '[]';
UPDATE schedules SET scenario_ids_json = '[' || scenario_id || ']';
