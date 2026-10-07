-- Settle policy for interactive Steps (click, type, fill, select, check,
-- uncheck). When step_scroll_into_view is 1 the Step executor scrolls the
-- target into view before acting; step_settle_ms is how long it pauses after
-- each of those Steps. Both off by default: existing scenarios run unchanged.
ALTER TABLE scenarios ADD COLUMN step_scroll_into_view INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scenarios ADD COLUMN step_settle_ms INTEGER NOT NULL DEFAULT 0;
