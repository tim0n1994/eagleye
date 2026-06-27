-- 010: Knowledge Graph Hierarchy
-- Four-level taxonomy: Domain → Topic → SubTopic → Tag
-- Enables hierarchical 3D knowledge graph visualization

CREATE TABLE IF NOT EXISTS knowledge_domains (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  name_zh TEXT NOT NULL,
  description_zh TEXT,
  display_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tag_hierarchy (
  id TEXT PRIMARY KEY,
  tag_id TEXT REFERENCES tags(id),
  parent_node_id TEXT REFERENCES tag_hierarchy(id),
  topic_name_zh TEXT,
  topic_slug TEXT,
  domain_id TEXT REFERENCES knowledge_domains(id),
  level INTEGER NOT NULL DEFAULT 2,
  confidence REAL DEFAULT 0.7,
  assigned_by TEXT DEFAULT 'llm',
  prompt_version TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tag_id, level)
);

CREATE INDEX IF NOT EXISTS idx_tag_hierarchy_tag ON tag_hierarchy(tag_id);
CREATE INDEX IF NOT EXISTS idx_tag_hierarchy_parent ON tag_hierarchy(parent_node_id);
CREATE INDEX IF NOT EXISTS idx_tag_hierarchy_domain ON tag_hierarchy(domain_id);
CREATE INDEX IF NOT EXISTS idx_tag_hierarchy_level ON tag_hierarchy(level);
CREATE INDEX IF NOT EXISTS idx_knowledge_domains_slug ON knowledge_domains(slug);
