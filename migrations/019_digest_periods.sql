-- Weekly and monthly run digests alongside the existing daily one.
-- weekly_digest  → Monday 09:00, all runs of the last 7 days.
-- monthly_digest → 1st of the month 09:00, all runs of the last month.
ALTER TABLE email_recipients ADD COLUMN weekly_digest INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_recipients ADD COLUMN monthly_digest INTEGER NOT NULL DEFAULT 0;
