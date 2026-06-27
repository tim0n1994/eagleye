-- Alpha Radar: signal types, scores, entity momentum, source profiles

-- Signal type taxonomy
CREATE TABLE IF NOT EXISTS signal_types (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_zh TEXT,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  icon TEXT
);

INSERT OR IGNORE INTO signal_types VALUES
  ('origin_signal', 'Origin Signal', '源头信号', '核心开发者/创始人首次透露', 1, '🎯'),
  ('new_repo', 'New Repo', '新仓库', '首次发现的高价值开源仓库', 2, '📦'),
  ('new_paper', 'New Paper', '新论文', 'arXiv/HF 新出论文', 3, '📄'),
  ('model_release', 'Model Release', '模型发布', '新模型/权重/checkpoint', 4, '🧠'),
  ('benchmark_claim', 'Benchmark Claim', '基准声明', '性能声明/benchmark 变化', 5, '📊'),
  ('architecture_shift', 'Architecture Shift', '架构迁移', '技术架构范式变化', 6, '🏗️'),
  ('narrative_shift', 'Narrative Shift', '叙事迁移', '社区共识叙事变化', 7, '📡'),
  ('velocity_spike', 'Velocity Spike', '加速信号', '突然加速的话题', 8, '🚀'),
  ('novel_combination', 'Novel Combination', '新组合', '概念/实体新关联', 9, '🔗'),
  ('contradiction', 'Contradiction', '矛盾信号', '与主流叙事矛盾的证据', 10, '⚡'),
  ('funding_signal', 'Funding Signal', '融资信号', '融资/收购/投资动态', 11, '💰'),
  ('hiring_signal', 'Hiring Signal', '招聘信号', '关键招聘/团队变动', 12, '👥');

-- Signal scores per item
CREATE TABLE IF NOT EXISTS signal_scores (
  item_id TEXT PRIMARY KEY REFERENCES information_items(id),
  signal_type TEXT NOT NULL REFERENCES signal_types(slug),
  novelty_score REAL DEFAULT 0,
  velocity_score REAL DEFAULT 0,
  cross_source_score REAL DEFAULT 0,
  source_quality_score REAL DEFAULT 0,
  thesis_match_score REAL DEFAULT 0,
  actionability_score REAL DEFAULT 0,
  alpha_score REAL DEFAULT 0,
  consensus_penalty REAL DEFAULT 0,
  evidence_summary TEXT,
  scored_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_signal_scores_type ON signal_scores(signal_type);
CREATE INDEX IF NOT EXISTS idx_signal_scores_alpha ON signal_scores(alpha_score DESC);

-- Entity momentum tracking
CREATE TABLE IF NOT EXISTS entity_momentum (
  entity_id TEXT NOT NULL REFERENCES entities(id),
  window TEXT NOT NULL,
  mention_count INTEGER DEFAULT 0,
  unique_sources INTEGER DEFAULT 0,
  high_quality_mentions INTEGER DEFAULT 0,
  velocity_zscore REAL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (entity_id, window)
);

-- Source quality profiles
CREATE TABLE IF NOT EXISTS source_profiles (
  source_slug TEXT PRIMARY KEY,
  source_type TEXT DEFAULT 'amplifier',
  early_signal_rate REAL DEFAULT 0,
  confirmation_rate REAL DEFAULT 0,
  noise_rate REAL DEFAULT 0.5,
  originality_rate REAL DEFAULT 0,
  preferred_domains TEXT DEFAULT '[]',
  last_30d_alpha_hits INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);
