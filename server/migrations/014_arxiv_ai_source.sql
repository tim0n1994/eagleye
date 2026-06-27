-- 014: Ensure arXiv AI source exists after local X source occupied s016.

INSERT OR IGNORE INTO sources
  (id, slug, label, description, homepage_url, feed_url, connector_type, is_active)
VALUES
  (
    's017',
    'arxiv-ai',
    'arXiv AI Papers',
    'Open AI, ML, NLP, CV, robotics, and statistical learning preprints from arXiv',
    'https://arxiv.org',
    NULL,
    'arxiv',
    1
  );

UPDATE sources
SET connector_type = 'arxiv'
WHERE slug = 'physical-ai-arxiv';
