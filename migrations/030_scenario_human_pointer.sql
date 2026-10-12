-- Move the pointer to each click target along an eased curve from the
-- previous interaction (agent-browser `click --human`) instead of teleporting,
-- so a recording shows the mouse travelling between elements. Off by default.
ALTER TABLE scenarios ADD COLUMN human_pointer INTEGER NOT NULL DEFAULT 0;
