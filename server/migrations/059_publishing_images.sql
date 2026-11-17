-- Publishing draft images are per-user binary assets and are deleted with their owner or draft.
CREATE TABLE IF NOT EXISTS publishing_images (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  source_id TEXT,
  source_url TEXT,
  origin TEXT NOT NULL DEFAULT 'upload' CHECK (origin IN ('upload', 'source', 'generated')),
  data BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (draft_id) REFERENCES publishing_drafts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_publishing_images_draft ON publishing_images (user_id, draft_id, created_at, id);
