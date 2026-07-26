-- 024_signal_indexes.sql — Performance: cover the signals radar query's ORDER BY
--
-- The /api/signals endpoint orders by alpha_score DESC over a date-filtered join.
-- Without an index on signal_scores.alpha_score, every request forces a TEMP
-- B-TREE sort. Adding it lets SQLite serve the ORDER BY from the index when the
-- date filter is narrow.
-- Also covers the entity_momentum sort queries (acceleration/growth/burst).

CREATE INDEX IF NOT EXISTS idx_signal_scores_alpha ON signal_scores (alpha_score DESC);
CREATE INDEX IF NOT EXISTS idx_entity_momentum_window_accel ON entity_momentum (window, acceleration DESC);
CREATE INDEX IF NOT EXISTS idx_entity_momentum_window_growth ON entity_momentum (window, growth_rate DESC);
CREATE INDEX IF NOT EXISTS idx_entity_momentum_window_burst ON entity_momentum (window, burst_score DESC);
