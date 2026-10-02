-- Assets the user removed from a thread's context: JSON array of "<runId>/<file>"
-- keys. The context pack is rebuilt on every call, so an exclusion applies to
-- the whole conversation from the next message on.
ALTER TABLE ask_threads ADD COLUMN excluded_json TEXT NOT NULL DEFAULT '[]';
