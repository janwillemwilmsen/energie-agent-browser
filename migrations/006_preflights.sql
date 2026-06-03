-- Preflight scenarios: reusable step sequences that establish browser state
-- (cookies/localStorage) under an agent-browser --session-name. Scenarios opt
-- in via scenarios.preflight_id, and the runner loads the matching session-name
-- so the scenario starts already logged in / cookie-consent already dismissed.
CREATE TABLE preflights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Doubles as the agent-browser --session-name. Restricted to a small char set
  -- at the API layer so it's always safe in a CLI arg and as a filename under
  -- ~/.agent-browser/sessions/.
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  steps_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Soft delete: row hides from listings and from scenarios' dropdowns, but the
  -- on-disk auth.json under ~/.agent-browser/sessions/<name> is kept so an
  -- accidental delete is recoverable without re-recording.
  deleted_at TEXT
);

-- Name must be unique among active rows. Soft-deleted rows free up the slot so
-- you can record a replacement with the same name. SQLite supports partial
-- unique indexes since 3.8.
CREATE UNIQUE INDEX idx_preflights_name_active ON preflights(name) WHERE deleted_at IS NULL;

-- Per-scenario opt-in. ON DELETE SET NULL so soft-deleting a preflight (or even
-- a future hard delete) doesn't cascade-break the scenarios that reference it.
ALTER TABLE scenarios ADD COLUMN preflight_id INTEGER
  REFERENCES preflights(id) ON DELETE SET NULL;
