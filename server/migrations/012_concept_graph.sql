-- 012: Unified Concept Graph
-- Replaces fixed tag hierarchy semantics with reusable concept nodes and edges.
-- Direction convention: concept edges point child -> parent for hierarchy-style
-- traversal, while relation edges can be lateral.

CREATE TABLE IF NOT EXISTS kg_concept_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'running',
  prompt_version TEXT NOT NULL,
  selected_tags INTEGER DEFAULT 0,
  unique_tags INTEGER DEFAULT 0,
  node_count INTEGER DEFAULT 0,
  edge_count INTEGER DEFAULT 0,
  metrics TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS kg_concept_nodes (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES kg_concept_runs(id),
  kind TEXT NOT NULL,                    -- domain|topic|concept|tag
  slug TEXT NOT NULL,
  label TEXT NOT NULL,
  label_zh TEXT NOT NULL,
  description_zh TEXT DEFAULT '',
  source_tag_id TEXT REFERENCES tags(id),
  status TEXT NOT NULL DEFAULT 'active',
  depth_hint INTEGER DEFAULT 0,
  prompt_version TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, kind, slug)
);

CREATE TABLE IF NOT EXISTS kg_concept_edges (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES kg_concept_runs(id),
  from_node_id TEXT NOT NULL REFERENCES kg_concept_nodes(id),
  to_node_id TEXT NOT NULL REFERENCES kg_concept_nodes(id),
  edge_type TEXT NOT NULL,                -- contains|primary_parent|secondary_parent|related_to|co_occurs
  weight REAL NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 0.8,
  is_primary INTEGER DEFAULT 1,
  rationale_zh TEXT DEFAULT '',
  evidence_item_ids TEXT NOT NULL DEFAULT '[]',
  prompt_version TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, from_node_id, to_node_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_kg_concept_nodes_run ON kg_concept_nodes(run_id);
CREATE INDEX IF NOT EXISTS idx_kg_concept_nodes_kind ON kg_concept_nodes(kind);
CREATE INDEX IF NOT EXISTS idx_kg_concept_nodes_source_tag ON kg_concept_nodes(source_tag_id);
CREATE INDEX IF NOT EXISTS idx_kg_concept_edges_run ON kg_concept_edges(run_id);
CREATE INDEX IF NOT EXISTS idx_kg_concept_edges_from ON kg_concept_edges(from_node_id);
CREATE INDEX IF NOT EXISTS idx_kg_concept_edges_to ON kg_concept_edges(to_node_id);
CREATE INDEX IF NOT EXISTS idx_kg_concept_edges_type ON kg_concept_edges(edge_type);
