-- Durable collection checkpoints and next-run times; no credentials/raw payloads.
CREATE TABLE IF NOT EXISTS source_collection_state (
  slug TEXT PRIMARY KEY REFERENCES sources(slug),
  last_attempt_at TEXT,
  last_request_success_at TEXT,
  last_parse_success_at TEXT,
  last_commit_at TEXT,
  next_due_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  fetched INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  error_class TEXT
);
CREATE INDEX IF NOT EXISTS idx_collection_due ON source_collection_state(next_due_at);
