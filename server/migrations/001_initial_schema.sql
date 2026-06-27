-- Eagleye Schema Migration 001: Initial Schema
-- Based on architecture-design.md §6 Data Model

-- ============================================================
-- Core Tables
-- ============================================================

-- Sources: Each information source
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  homepage_url TEXT,
  feed_url TEXT,
  connector_type TEXT NOT NULL DEFAULT 'rss',
  is_active INTEGER NOT NULL DEFAULT 1,
  refresh_cron TEXT DEFAULT '0 */2 * * *',
  item_count INTEGER DEFAULT 0,
  last_fetched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Information Items: Normalized items from all sources
CREATE TABLE IF NOT EXISTS information_items (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES sources(id),
  canonical_url TEXT NOT NULL,
  external_id TEXT,
  title TEXT NOT NULL,
  original_summary TEXT,
  content_text TEXT,
  language TEXT DEFAULT 'en',
  author TEXT,
  published_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  digest_date TEXT NOT NULL,
  source_payload TEXT NOT NULL DEFAULT '{}',
  normalized_payload TEXT NOT NULL DEFAULT '{}',
  score REAL DEFAULT 0,
  popularity TEXT DEFAULT '{}',
  content_hash TEXT,
  duplicate_group_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_id, canonical_url, digest_date)
);

-- AI Summaries: LLM-generated structured summaries for each item
CREATE TABLE IF NOT EXISTS ai_summaries (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES information_items(id),
  model_provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  ai_title TEXT,
  one_liner TEXT NOT NULL DEFAULT '',
  short_summary TEXT NOT NULL DEFAULT '',
  deep_summary TEXT,
  key_points TEXT NOT NULL DEFAULT '[]',
  why_it_matters TEXT DEFAULT '',
  audience TEXT DEFAULT '[]',
  risks TEXT DEFAULT '[]',
  opportunities TEXT DEFAULT '[]',
  action_items TEXT DEFAULT '[]',
  confidence REAL,
  source_grounding TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Topics: Dynamic knowledge graph nodes
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  parent_topic_id TEXT REFERENCES topics(id),
  status TEXT NOT NULL DEFAULT 'active',
  auto_generated INTEGER NOT NULL DEFAULT 1,
  confidence REAL,
  first_seen_at TEXT,
  last_seen_at TEXT,
  growth_score REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tags: Content tags
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'general',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Entities: Named entities extracted from content
-- Note: uses 'name' instead of 'canonical_name' for backward compat with existing entities table
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',
  aliases TEXT DEFAULT '[]',
  url TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Item-Topic relationships
CREATE TABLE IF NOT EXISTS item_topics (
  item_id TEXT REFERENCES information_items(id),
  topic_id TEXT REFERENCES topics(id),
  relevance REAL NOT NULL DEFAULT 0,
  reason TEXT,
  assigned_by TEXT NOT NULL DEFAULT 'auto',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, topic_id)
);

-- Item-Tag relationships
CREATE TABLE IF NOT EXISTS item_tags (
  item_id TEXT REFERENCES information_items(id),
  tag_id TEXT REFERENCES tags(id),
  confidence REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, tag_id)
);

-- Graph Edges: Relationships between any graph nodes
CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  evidence_item_ids TEXT DEFAULT '[]',
  first_seen_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Research Reports: Deep research results
CREATE TABLE IF NOT EXISTS research_reports (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES information_items(id),
  topic_id TEXT REFERENCES topics(id),
  status TEXT NOT NULL DEFAULT 'queued',
  prompt TEXT NOT NULL,
  report_markdown TEXT,
  citations TEXT DEFAULT '[]',
  model_provider TEXT,
  model_name TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- Deployment Plans: One-click deploy analysis
CREATE TABLE IF NOT EXISTS deployment_plans (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES information_items(id),
  repo_url TEXT NOT NULL,
  repo_stars INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  eligibility TEXT NOT NULL DEFAULT 'unknown',
  prompt TEXT NOT NULL DEFAULT '',
  plan_markdown TEXT,
  commands TEXT DEFAULT '[]',
  env_vars TEXT DEFAULT '{}',
  detected_stack TEXT DEFAULT '{}',
  risk_notes TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- Saved Items: User bookmarks
CREATE TABLE IF NOT EXISTS saved_items (
  user_id TEXT NOT NULL DEFAULT 'anonymous',
  item_id TEXT REFERENCES information_items(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, item_id)
);

-- Daily Digests: Pre-built daily digests
CREATE TABLE IF NOT EXISTS daily_digests (
  id TEXT PRIMARY KEY,
  digest_date TEXT NOT NULL UNIQUE,
  headline TEXT,
  executive_summary TEXT,
  top_signals TEXT DEFAULT '[]',
  emerging_topics TEXT DEFAULT '[]',
  repo_watch TEXT DEFAULT '[]',
  paper_watch TEXT DEFAULT '[]',
  product_watch TEXT DEFAULT '[]',
  risk_watch TEXT DEFAULT '[]',
  ai_generated INTEGER DEFAULT 0,
  prompt_version TEXT,
  model_name TEXT,
  item_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Background Jobs: Trackable async tasks
CREATE TABLE IF NOT EXISTS background_jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  params TEXT DEFAULT '{}',
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_items_source_id ON information_items(source_id);
CREATE INDEX IF NOT EXISTS idx_items_digest_date ON information_items(digest_date);
CREATE INDEX IF NOT EXISTS idx_items_canonical_url ON information_items(canonical_url);
CREATE INDEX IF NOT EXISTS idx_items_created_at ON information_items(created_at);
CREATE INDEX IF NOT EXISTS idx_items_score ON information_items(score DESC);
CREATE INDEX IF NOT EXISTS idx_items_published_at ON information_items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_summaries_item_id ON ai_summaries(item_id);
CREATE INDEX IF NOT EXISTS idx_topics_slug ON topics(slug);
CREATE INDEX IF NOT EXISTS idx_topics_parent ON topics(parent_topic_id);
CREATE INDEX IF NOT EXISTS idx_item_topics_topic ON item_topics(topic_id);
CREATE INDEX IF NOT EXISTS idx_item_topics_item ON item_topics(item_id);
CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_edges_from ON graph_edges(from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON graph_edges(to_type, to_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON graph_edges(edge_type);
CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_reports_item ON research_reports(item_id);
CREATE INDEX IF NOT EXISTS idx_deploy_item ON deployment_plans(item_id);
CREATE INDEX IF NOT EXISTS idx_digests_date ON daily_digests(digest_date DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_type ON background_jobs(job_type);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON background_jobs(status);
CREATE INDEX IF NOT EXISTS idx_sources_slug ON sources(slug);

-- ============================================================
-- Seed: Initial Topic Seeds (from OrangeBot)
-- ============================================================
INSERT OR IGNORE INTO topics (id, slug, name, description, auto_generated, status) VALUES
  ('t001', 'llms-generative-ai', 'LLMs & Generative AI', 'Large language models, GPT, Claude, Gemini, and generative AI technologies', 0, 'active'),
  ('t002', 'ai-machine-learning', 'AI & Machine Learning', 'General AI/ML research, deep learning, reinforcement learning, and AI infrastructure', 0, 'active'),
  ('t003', 'ai-coding-tools', 'AI Coding Tools', 'AI-powered coding assistants, code generation, and developer productivity tools', 0, 'active'),
  ('t004', 'security', 'Security', 'Cybersecurity, vulnerabilities, exploits, and security tools', 0, 'active'),
  ('t005', 'web-development', 'Web Development', 'Web frameworks, browsers, JavaScript ecosystem, and frontend/backend web tech', 0, 'active'),
  ('t006', 'devops-infra', 'DevOps & Infra', 'Cloud infrastructure, CI/CD, containers, Kubernetes, and platform engineering', 0, 'active'),
  ('t007', 'startups', 'Startups', 'Startup news, funding, business models, and entrepreneurship', 0, 'active'),
  ('t008', 'robotics', 'Robotics', 'Robotics, embodied AI, humanoids, and automation', 0, 'active'),
  ('t009', 'crypto-web3', 'Crypto & Web3', 'Cryptocurrency, blockchain, DeFi, NFTs, and web3 technologies', 0, 'active'),
  ('t010', 'design', 'Design', 'UI/UX design, design systems, typography, and visual design', 0, 'active');

-- ============================================================
-- Seed: Initial Sources (from OrangeBot)
-- ============================================================
INSERT OR IGNORE INTO sources (id, slug, label, description, homepage_url, feed_url, connector_type, is_active) VALUES
  ('s001', 'hacker-news', 'Hacker News', 'Tech news and discussion from Y Combinator''s community', 'https://news.ycombinator.com', NULL, 'hn', 1),
  ('s002', 'github-trending', 'GitHub Trending', 'Trending repositories on GitHub', 'https://github.com/trending', NULL, 'github', 1),
  ('s003', 'product-hunt', 'Product Hunt', 'New product launches and tech products', 'https://www.producthunt.com', NULL, 'producthunt', 1),
  ('s004', 'hugging-face', 'Hugging Face', 'AI/ML papers and models', 'https://huggingface.co/papers', NULL, 'huggingface', 1),
  ('s005', 'techmeme', 'Techmeme', 'Tech industry news aggregation', 'https://www.techmeme.com', 'https://www.techmeme.com/feed.xml', 'rss', 1),
  ('s006', 'solidot', 'Solidot', 'Chinese tech and science news', 'https://www.solidot.org', 'https://www.solidot.org/index.rss', 'rss', 1),
  ('s007', 'startup-archive', 'Startup Archive', 'Startup stories and founder interviews', 'https://www.startuparchive.org', NULL, 'scrape', 1),
  ('s008', 'app-store-rank', 'App Store Rank', 'App Store rankings and trends (top free charts)', 'https://www.apple.com/app-store/', NULL, 'appstore', 1),
  ('s009', 'app-store-trend', 'App Store Trend', 'App Store trending apps (top grossing)', 'https://www.apple.com/app-store/', NULL, 'appstore', 1),
  ('s010', 'physical-ai-arxiv', 'Physical AI — arXiv', 'Physical AI, robotics, and embodied AI papers from arXiv', NULL, 'http://export.arxiv.org/api/query?search_query=all:physical+AI+OR+all:embodied+AI+OR+all:humanoid+OR+all:VLA&sortBy=submittedDate&sortOrder=descending&max_results=50', 'rss', 1),
  ('s011', 'physical-ai-humanoid', 'Physical AI — Humanoid', 'Humanoid robot company news from industry sources', NULL, NULL, 'humanoid', 1),
  ('s012', 'physical-ai-cn-photonics', 'Physical AI — CN Photonics', 'Chinese photonics and semiconductor announcements', NULL, NULL, 'cn-photonics', 1),
  ('s015', 'physical-ai-sec-8k', 'Physical AI — SEC 8-K', 'SEC 8-K filings for semiconductor, robotics, photonics companies', NULL, NULL, 'sec-8k', 1),
  ('s013', 'v2ex', 'V2EX', 'Chinese tech community hot topics', 'https://www.v2ex.com', NULL, 'v2ex', 1),
  ('s014', 'lobsters', 'Lobste.rs', 'Tech news aggregation with community voting', 'https://lobste.rs', NULL, 'lobsters', 1);
