-- Email notification recipients (sent via Resend). One row per address.
-- scenario_ids_json / success_scenario_ids_json mirror push_subscriptions:
-- the sets of scenario ids this address wants failure / success alerts for.
-- daily_digest opts the address into the 09:00 all-runs status digest.
CREATE TABLE email_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  scenario_ids_json TEXT NOT NULL DEFAULT '[]',
  success_scenario_ids_json TEXT NOT NULL DEFAULT '[]',
  daily_digest INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
