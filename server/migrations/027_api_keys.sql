-- 027_api_keys.sql — API keys for service-to-service authentication
--
-- Long-lived API keys for external systems (e.g. Argus) to access Eagleye API
-- without browser session cookies. Keys are bearer tokens: Authorization: Bearer <key>

CREATE TABLE IF NOT EXISTS api_keys (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,              -- human label, e.g. "Argus"
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at TEXT,                 -- NULL = never expires
  active INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
