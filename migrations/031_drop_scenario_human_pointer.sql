-- Human pointer movement moved from the scenario to the record_start step
-- (`human: true` in its payload): it is a property of a recording, not of
-- the scenario. The column was live for one day; nothing to migrate.
ALTER TABLE scenarios DROP COLUMN human_pointer;
