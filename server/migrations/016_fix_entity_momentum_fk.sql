-- 016: Fix entity_momentum FK to reference canonical_entities (KG v2)
-- instead of the legacy entities (KG v1) table.
--
-- The original migration 009 declared entity_momentum.entity_id → entities(id),
-- but entity data now lives in canonical_entities (KG v2, ids like 'kgec_...').
-- The wrong FK caused FOREIGN KEY constraint failures when inserting real data.
--
-- Since entity_momentum has always been empty (0 rows), we can safely drop
-- and recreate it with the correct foreign key. PRAGMA foreign_keys must be
-- OFF for the drop in environments where the old FK would block it, but
-- drop is safe here because the table has no dependents.

DROP TABLE IF EXISTS entity_momentum;

CREATE TABLE entity_momentum (
  entity_id TEXT NOT NULL REFERENCES canonical_entities(id),
  window TEXT NOT NULL,
  mention_count INTEGER DEFAULT 0,
  unique_sources INTEGER DEFAULT 0,
  high_quality_mentions INTEGER DEFAULT 0,
  velocity_zscore REAL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (entity_id, window)
);

CREATE INDEX IF NOT EXISTS idx_entity_momentum_window ON entity_momentum(window);
CREATE INDEX IF NOT EXISTS idx_entity_momentum_zscore ON entity_momentum(velocity_zscore DESC);
