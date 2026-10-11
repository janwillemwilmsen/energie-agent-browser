-- "Auto diff" play option: after a successful play from the editor, diff the
-- run's screenshots against the scenario's previous run with screenshots.
ALTER TABLE scenarios ADD COLUMN auto_diff INTEGER NOT NULL DEFAULT 0;
