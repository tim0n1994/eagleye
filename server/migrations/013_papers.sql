-- 013: Paper feed metadata
-- Papers remain information_items, while paper-specific fields live here.

CREATE TABLE IF NOT EXISTS paper_metadata (
  item_id TEXT PRIMARY KEY REFERENCES information_items(id),
  paper_id TEXT,
  source_slug TEXT,
  provider TEXT,
  arxiv_id TEXT,
  doi TEXT,
  title TEXT NOT NULL,
  abstract TEXT,
  authors_json TEXT NOT NULL DEFAULT '[]',
  categories_json TEXT NOT NULL DEFAULT '[]',
  published_at TEXT,
  updated_at TEXT,
  pdf_url TEXT,
  landing_url TEXT,
  code_url TEXT,
  datasets_json TEXT NOT NULL DEFAULT '[]',
  tasks_json TEXT NOT NULL DEFAULT '[]',
  venue TEXT,
  dedupe_key TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at_row TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_paper_metadata_source ON paper_metadata(source_slug);
CREATE INDEX IF NOT EXISTS idx_paper_metadata_provider ON paper_metadata(provider);
CREATE INDEX IF NOT EXISTS idx_paper_metadata_arxiv ON paper_metadata(arxiv_id);
CREATE INDEX IF NOT EXISTS idx_paper_metadata_dedupe ON paper_metadata(dedupe_key);

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
