-- Eagleye Schema Migration 041: Source empty-round streak (Round 1 D4)
--
-- sources.consecutive_empty counts back-to-back fetch rounds that produced
-- no new content. It is written by connectors/base.js saveItems on every
-- completed round alongside last_attempt_at (037): rounds with output reset
-- the streak to 0, empty rounds increment it. Round 1.1 semantic ruling
-- (定案2): an all-duplicate round — every item skipped by cross-day dedup —
-- is NOT empty (the source is alive: base.js still refreshes
-- last_success_at), so it leaves the streak unchanged; only rounds with
-- zero items (not even duplicates) increment it. Additive only — one NOT
-- NULL counter defaulting to 0, no rewrites, safe via the standard
-- migration runner (fresh installs and existing databases both get the
-- default 0).
--
-- Consumers: source health evaluation (/sources staleness badge reads
-- last_fetched_at at d4a8e9b; Round 1.1 switches it to last_success_at).
-- The streak gives evaluators a consecutive-failure signal without
-- another join.

ALTER TABLE sources ADD COLUMN consecutive_empty INTEGER NOT NULL DEFAULT 0;
