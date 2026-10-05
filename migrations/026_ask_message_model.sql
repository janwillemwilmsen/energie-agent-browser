-- The model an assistant turn was actually generated with. The thread's model
-- is resolved per call (its own pick, else the admin default at that moment),
-- so without this a later change would misreport what an old reply cost.
-- '' on user turns and on rows from before this migration.
ALTER TABLE ask_messages ADD COLUMN model TEXT NOT NULL DEFAULT '';
