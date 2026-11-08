-- A focused research source for the AI education briefing. It follows the
-- existing arXiv connector and scheduled ingestion pipeline.
INSERT OR IGNORE INTO sources
  (id, slug, label, description, homepage_url, feed_url, connector_type, is_active)
VALUES
  ('s-ai-education-arxiv', 'education-arxiv', 'AI Education — arXiv',
   'Research on artificial intelligence in education from arXiv',
   'https://arxiv.org', NULL, 'arxiv', 1);
