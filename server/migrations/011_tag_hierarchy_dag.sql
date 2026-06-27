-- 011: Tag hierarchy DAG support
-- Allows one tag to belong to multiple parent concepts and stores edge semantics.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS tag_hierarchy_new (
  id TEXT PRIMARY KEY,
  tag_id TEXT REFERENCES tags(id),
  parent_node_id TEXT REFERENCES tag_hierarchy_new(id),
  topic_name_zh TEXT,
  topic_slug TEXT,
  domain_id TEXT REFERENCES knowledge_domains(id),
  level INTEGER NOT NULL DEFAULT 2,
  confidence REAL DEFAULT 0.7,
  assigned_by TEXT DEFAULT 'llm',
  prompt_version TEXT,
  relationship_type TEXT DEFAULT 'belongs_to',
  rationale_zh TEXT DEFAULT '',
  is_primary INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO tag_hierarchy_new (
  id, tag_id, parent_node_id, topic_name_zh, topic_slug, domain_id, level,
  confidence, assigned_by, prompt_version, relationship_type, rationale_zh,
  is_primary, created_at
)
SELECT
  id, tag_id, parent_node_id, topic_name_zh, topic_slug, domain_id, level,
  confidence, assigned_by, prompt_version, 'belongs_to', '', 1, created_at
FROM tag_hierarchy;

DROP TABLE tag_hierarchy;
ALTER TABLE tag_hierarchy_new RENAME TO tag_hierarchy;

CREATE INDEX IF NOT EXISTS idx_tag_hierarchy_tag ON tag_hierarchy(tag_id);
CREATE INDEX IF NOT EXISTS idx_tag_hierarchy_parent ON tag_hierarchy(parent_node_id);
CREATE INDEX IF NOT EXISTS idx_tag_hierarchy_domain ON tag_hierarchy(domain_id);
CREATE INDEX IF NOT EXISTS idx_tag_hierarchy_level ON tag_hierarchy(level);
CREATE INDEX IF NOT EXISTS idx_tag_hierarchy_primary ON tag_hierarchy(is_primary);

PRAGMA foreign_keys = ON;
