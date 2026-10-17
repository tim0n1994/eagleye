CREATE TABLE IF NOT EXISTS llm_request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  endpoint_id TEXT,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_llm_request_events_created ON llm_request_events(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_request_events_trace ON llm_request_events(trace_id);
