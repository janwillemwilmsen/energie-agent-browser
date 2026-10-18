-- Projects: a top-level container that separates topics and brands. Every
-- scenario belongs to exactly one; schedules and ask threads carry theirs too
-- (denormalised; the routes keep them in step with their scenarios);
-- preflights optionally (NULL = shared across projects, since a preflight's
-- name is a global session-state file). Project 1 "Default" absorbs everything
-- that exists, so nothing changes until a second project is created.
--
-- The NOT NULL columns carry no REFERENCES clause: SQLite refuses to add a
-- referencing column with a non-NULL default while foreign keys are on. The
-- projects routes enforce the integrity (a project with scenarios, schedules
-- or threads cannot be deleted).
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO projects (id, name, position) VALUES (1, 'Default', 0);

ALTER TABLE scenarios ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX idx_scenarios_project ON scenarios(project_id);

ALTER TABLE schedules ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ask_threads ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1;

ALTER TABLE preflights ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
