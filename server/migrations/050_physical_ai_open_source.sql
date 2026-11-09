-- Physical AI open-source (GitHub) discovery source. The GitHub search API is
-- keyless (User-Agent only), so unlike 049 the source starts ENABLED and the
-- existing scheduler/registry (server/connectors/index.js) picks it up by
-- slug on the next pipeline round.
INSERT OR IGNORE INTO sources
  (id, slug, label, description, homepage_url, feed_url, connector_type, is_active)
VALUES
  ('s-physical-ai-open-github', 'physical-ai-open-github', 'Physical AI — Open Source (GitHub)',
   'Embodied-AI and robotics open-source repositories created in the last 180 days',
   'https://github.com', NULL, 'github', 1);
