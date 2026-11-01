-- Eagleye Schema Migration 045: Explicit per-source health cadence.
--
-- sources.expected_interval_hours is an optional, operator-set cadence used by
-- source-health evaluation before the enabled scheduler cadence. NULL keeps
-- the shared scheduler contract (or the conservative fallback when no source
-- fetching scheduler is active). It does not schedule fetching and does not
-- assign meaning to legacy sources.refresh_cron.

ALTER TABLE sources ADD COLUMN expected_interval_hours REAL;
