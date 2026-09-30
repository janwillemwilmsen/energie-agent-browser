-- Ask: chat threads reviewing one or more scenarios with an LLM (visual /
-- copy / conversion feedback over run artifacts). A thread pins the scenarios
-- and runs it was opened with; messages store the content parts as sent to
-- the model (text, and image references for the first user turn) plus the
-- model's usage so cost per turn is visible.
CREATE TABLE ask_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  scenario_ids_json TEXT NOT NULL DEFAULT '[]',
  run_ids_json TEXT NOT NULL DEFAULT '[]',
  model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ask_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES ask_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  -- Plain text of the turn (what the UI renders). Images are not stored here:
  -- they are re-derived from the thread's run_ids when the model is called.
  text TEXT NOT NULL DEFAULT '',
  -- 0/1: this user turn carried the context pack (screenshots + narrative).
  with_context INTEGER NOT NULL DEFAULT 0,
  usage_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ask_messages_thread ON ask_messages(thread_id, id);
