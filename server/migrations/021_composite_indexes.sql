-- 021_composite_indexes.sql — Performance: cover the main feed query's ORDER BY
--
-- /api/items orders by (score DESC, published_at DESC), but the existing
-- idx_items_score is single-column, forcing a TEMP B-TREE sort on every request.
-- A composite (score, published_at) index lets SQLite serve the ORDER BY directly.
-- Also add (source_id, digest_date) for the per-source and per-date filter paths.

CREATE INDEX IF NOT EXISTS idx_items_score_published ON information_items (score DESC, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_source_date ON information_items (source_id, digest_date);
