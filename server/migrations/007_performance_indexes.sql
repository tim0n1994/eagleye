-- Performance indexes for translation backfill, enrichment, and KG operations.

-- Translation backfill: helps the complex WHERE clause with NULL/empty checks on ai_summaries
CREATE INDEX IF NOT EXISTS idx_ai_summaries_translation_coverage
  ON ai_summaries(item_id, translation_status, ai_title_zh, one_liner_zh, short_summary_zh);

-- Title_zh empty check for backfill COUNT query
DROP INDEX IF EXISTS idx_items_title_zh;
CREATE INDEX IF NOT EXISTS idx_items_title_zh_needed
  ON information_items(title_zh_status, title_zh);

-- KG edges (v2): extractor column for reset_semantic_lite_topics DELETE
CREATE INDEX IF NOT EXISTS idx_kg_edges_extractor ON kg_edges(extractor);

-- Topic graph (v1 graph_edges): composite index for updateGraphEdges self-join
CREATE INDEX IF NOT EXISTS idx_edges_from_type_edge
  ON graph_edges(from_type, from_id, edge_type);
