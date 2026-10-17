CREATE INDEX IF NOT EXISTS idx_item_topic_assignments_item_scope
ON item_topic_assignments(item_id, topic_kind, assigned_by, relevance DESC, topic_id);
