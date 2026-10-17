ALTER TABLE llm_request_events ADD COLUMN error_class TEXT;
ALTER TABLE llm_request_events ADD COLUMN retry_after_ms INTEGER;
CREATE INDEX IF NOT EXISTS idx_llm_request_events_error_class ON llm_request_events(error_class, created_at);
