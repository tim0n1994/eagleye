-- Eagleye migration 058: personal publishing notes and drafts.
--
-- Notes are independent from saved_items bookmarks. Draft source data is an
-- immutable JSON snapshot, so later edits to information_items or notes cannot
-- rewrite an existing generated draft.

CREATE TABLE IF NOT EXISTS publishing_notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(user_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_publishing_notes_user_item
  ON publishing_notes(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS publishing_drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  brief TEXT NOT NULL DEFAULT '',
  theme TEXT NOT NULL DEFAULT 'paper' CHECK (theme IN ('paper', 'ink', 'mint')),
  status TEXT NOT NULL DEFAULT 'generating'
    CHECK (status IN ('generating', 'ready', 'failed')),
  status_message TEXT NOT NULL DEFAULT '',
  wechat_json TEXT NOT NULL DEFAULT '{}',
  xiaohongshu_json TEXT NOT NULL DEFAULT '{}',
  sources_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_publishing_drafts_user_updated
  ON publishing_drafts(user_id, updated_at DESC);
