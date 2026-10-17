CREATE INDEX IF NOT EXISTS idx_summaries_valid_items
  ON ai_summaries(item_id, translation_status)
  WHERE LENGTH(TRIM(COALESCE(short_summary, '') || COALESCE(short_summary_zh, '') ||
    COALESCE(one_liner, '') || COALESCE(one_liner_zh, '') || COALESCE(deep_summary, ''), char(9) || char(10) || char(13) || ' ')) > 0;

CREATE INDEX IF NOT EXISTS idx_items_quality_metadata
  ON information_items(source_id, digest_date, fetched_at, enrichment_attempts, id);
