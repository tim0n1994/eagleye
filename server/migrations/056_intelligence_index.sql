-- Durable asynchronous analytics; no model calls or destructive article merges.
CREATE TABLE intelligence_queue (item_id TEXT PRIMARY KEY REFERENCES information_items(id) ON DELETE CASCADE);
CREATE TABLE intelligence_events (
  id TEXT PRIMARY KEY,
  anchor_id TEXT NOT NULL,
  title TEXT NOT NULL,
  tokens TEXT NOT NULL,
  numbers TEXT NOT NULL,
  event_time TEXT NOT NULL
);
CREATE TABLE intelligence_event_keys (
  key TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES intelligence_events(id) ON DELETE CASCADE,
  PRIMARY KEY(key,event_id)
);
CREATE TABLE intelligence_items (
  item_id TEXT PRIMARY KEY REFERENCES information_items(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES intelligence_events(id),
  match_reason TEXT NOT NULL,
  confidence REAL NOT NULL,
  physical INTEGER NOT NULL,
  education INTEGER NOT NULL,
  neuroscience INTEGER NOT NULL,
  eligible INTEGER NOT NULL,
  content_time TEXT NOT NULL,
  date_inferred INTEGER NOT NULL,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_intelligence_time ON intelligence_items(content_time,source_id);
CREATE INDEX idx_intelligence_event ON intelligence_items(event_id);
-- Insert trigger covers every ingestion path, including external/import jobs.
CREATE TRIGGER intelligence_enqueue AFTER INSERT ON information_items BEGIN
  INSERT OR IGNORE INTO intelligence_queue(item_id) VALUES (NEW.id);
END;
INSERT OR IGNORE INTO intelligence_queue SELECT id FROM information_items;
