-- 018: Phase 1 — enrich entity_momentum with growth, acceleration, burst.
--
-- updateEntityMomentum (server/services/source-profiles.js) already writes
-- per-window mention counts + a cross-entity velocity z-score. These additions
-- turn the "Rising Entities" board from "most-mentioned" into "accelerating /
-- spiking right now", per the Alpha Radar Phase 1 design:
--   growth_rate   — week-over-week: count(last 7d) / count(prev 7d) - 1
--   acceleration  — is today heating up vs the week average:
--                   (count(24h) - count(7d)/7) / max(count(7d)/7, 1)
--   burst_score   — Kleinberg 2-state burst weight (0 unless the most recent
--                   day is in a burst state). Computed from the entity's daily
--                   mention series within the window.
--   prev_window_count — raw count from the preceding comparison window (debug).
--
-- Columns are nullable/0-default so existing rows and the 24h/30d windows
-- (where a given metric is N/A) stay clean. ALTER TABLE preserves the 2,549
-- existing rows.

ALTER TABLE entity_momentum ADD COLUMN growth_rate REAL DEFAULT 0;
ALTER TABLE entity_momentum ADD COLUMN acceleration REAL DEFAULT 0;
ALTER TABLE entity_momentum ADD COLUMN burst_score REAL DEFAULT 0;
ALTER TABLE entity_momentum ADD COLUMN prev_window_count INTEGER DEFAULT 0;

-- The Rising Entities board ranks by acceleration / growth_rate; index both.
CREATE INDEX IF NOT EXISTS idx_entity_momentum_accel ON entity_momentum(acceleration DESC);
CREATE INDEX IF NOT EXISTS idx_entity_momentum_growth ON entity_momentum(growth_rate DESC);
