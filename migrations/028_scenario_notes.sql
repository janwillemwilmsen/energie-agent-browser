-- Free-text notes about a scenario, for the editor's own reference. Shown
-- behind a "notes" toggle in the scenario editor; not used by runs.
ALTER TABLE scenarios ADD COLUMN notes TEXT NOT NULL DEFAULT '';
