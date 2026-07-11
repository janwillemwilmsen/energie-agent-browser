-- Per-browser opt-in for success notifications, alongside the existing
-- failure alerts. success_scenario_ids_json is the set of scenario ids the
-- browser wants a push for when a run finishes successfully.
ALTER TABLE push_subscriptions ADD COLUMN success_scenario_ids_json TEXT NOT NULL DEFAULT '[]';
