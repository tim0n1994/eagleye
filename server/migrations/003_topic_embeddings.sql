-- Eagleye Schema Migration 003: Topic Embeddings
-- Phase 4: Adds embedding storage for the topic knowledge graph.

CREATE TABLE IF NOT EXISTS topic_embeddings (
  topic_id TEXT PRIMARY KEY REFERENCES topics(id),
  embedding TEXT NOT NULL,  -- JSON array of floats
  dimension INTEGER NOT NULL DEFAULT 768,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for topic graph queries
CREATE INDEX IF NOT EXISTS idx_topic_embeddings_dim ON topic_embeddings(dimension);
