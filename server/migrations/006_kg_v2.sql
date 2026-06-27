-- Eagleye Schema Migration 006: Knowledge Graph v2
-- Adds a versioned, evidence-grounded KG pipeline schema.
-- Existing v1 tables remain intact for compatibility.

-- ============================================================
-- KG Job / Run Tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS kg_extraction_runs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_value TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  extractor_version TEXT NOT NULL,
  embedding_model TEXT,
  ner_model TEXT,
  topic_model TEXT,
  llm_model TEXT,
  params TEXT NOT NULL DEFAULT '{}',
  metrics TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

-- ============================================================
-- Per-item Features
-- ============================================================

CREATE TABLE IF NOT EXISTS item_features (
  item_id TEXT PRIMARY KEY REFERENCES information_items(id),
  source_slug TEXT NOT NULL,
  domain TEXT,
  author_norm TEXT,
  language_detected TEXT,
  content_hash TEXT,
  title_tokens TEXT NOT NULL DEFAULT '[]',
  keyword_candidates TEXT NOT NULL DEFAULT '[]',
  source_features TEXT NOT NULL DEFAULT '{}',
  quality_score REAL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Typed Tags
-- ============================================================

CREATE TABLE IF NOT EXISTS kg_tags (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  label_zh TEXT,
  type TEXT NOT NULL,
  parent_tag_id TEXT REFERENCES kg_tags(id),
  canonical_entity_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS item_tag_assignments (
  item_id TEXT NOT NULL REFERENCES information_items(id),
  tag_id TEXT NOT NULL REFERENCES kg_tags(id),
  confidence REAL NOT NULL DEFAULT 0,
  assigned_by TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}',
  run_id TEXT REFERENCES kg_extraction_runs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, tag_id, assigned_by)
);

-- ============================================================
-- Entities
-- ============================================================

CREATE TABLE IF NOT EXISTS entity_mentions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES information_items(id),
  mention_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  start_char INTEGER,
  end_char INTEGER,
  extractor TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  run_id TEXT REFERENCES kg_extraction_runs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS canonical_entities (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  canonical_slug TEXT UNIQUE NOT NULL,
  entity_type TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  homepage_url TEXT,
  external_refs TEXT NOT NULL DEFAULT '{}',
  description TEXT,
  description_zh TEXT,
  confidence REAL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT 'resolver',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entity_links (
  mention_id TEXT NOT NULL REFERENCES entity_mentions(id),
  entity_id TEXT NOT NULL REFERENCES canonical_entities(id),
  link_confidence REAL NOT NULL DEFAULT 0,
  linker TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (mention_id, entity_id)
);

-- ============================================================
-- Stable Taxonomy + Dynamic Topics
-- ============================================================

CREATE TABLE IF NOT EXISTS topic_taxonomy (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  name_zh TEXT,
  description TEXT,
  description_zh TEXT,
  parent_topic_id TEXT REFERENCES topic_taxonomy(id),
  level INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  seed_keywords TEXT NOT NULL DEFAULT '[]',
  negative_keywords TEXT NOT NULL DEFAULT '[]',
  centroid_vector_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dynamic_topics (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  name_zh TEXT,
  description TEXT,
  description_zh TEXT,
  parent_taxonomy_id TEXT REFERENCES topic_taxonomy(id),
  status TEXT NOT NULL DEFAULT 'candidate',
  discovery_method TEXT NOT NULL,
  topic_model_version TEXT,
  keywords TEXT NOT NULL DEFAULT '[]',
  representative_item_ids TEXT NOT NULL DEFAULT '[]',
  centroid_vector_id TEXT,
  source_diversity REAL DEFAULT 0,
  item_count INTEGER DEFAULT 0,
  growth_score REAL DEFAULT 0,
  confidence REAL DEFAULT 0,
  first_seen_at TEXT,
  last_seen_at TEXT,
  merged_into_topic_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS item_topic_assignments (
  item_id TEXT NOT NULL REFERENCES information_items(id),
  topic_kind TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  relevance REAL NOT NULL DEFAULT 0,
  assigned_by TEXT NOT NULL,
  reason TEXT,
  run_id TEXT REFERENCES kg_extraction_runs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, topic_kind, topic_id, assigned_by)
);

-- ============================================================
-- Vectors
-- ============================================================

CREATE TABLE IF NOT EXISTS item_vectors (
  item_id TEXT NOT NULL REFERENCES information_items(id),
  vector_type TEXT NOT NULL,
  model_name TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, vector_type, model_name)
);

CREATE TABLE IF NOT EXISTS vector_index_refs (
  item_id TEXT NOT NULL REFERENCES information_items(id),
  vector_type TEXT NOT NULL,
  backend TEXT NOT NULL,
  collection_name TEXT NOT NULL,
  point_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, vector_type, backend)
);

-- ============================================================
-- Evidence-grounded Graph Edges
-- ============================================================

CREATE TABLE IF NOT EXISTS kg_edges (
  id TEXT PRIMARY KEY,
  from_kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 0,
  evidence_item_ids TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '{}',
  extractor TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  run_id TEXT REFERENCES kg_extraction_runs(id),
  first_seen_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_kind, from_id, to_kind, to_id, edge_type, extractor)
);

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_kg_runs_status ON kg_extraction_runs(status);
CREATE INDEX IF NOT EXISTS idx_kg_runs_scope ON kg_extraction_runs(scope, scope_value);

CREATE INDEX IF NOT EXISTS idx_item_features_source ON item_features(source_slug);
CREATE INDEX IF NOT EXISTS idx_item_features_hash ON item_features(content_hash);
CREATE INDEX IF NOT EXISTS idx_item_features_quality ON item_features(quality_score DESC);

CREATE INDEX IF NOT EXISTS idx_kg_tags_type ON kg_tags(type);
CREATE INDEX IF NOT EXISTS idx_kg_tags_status ON kg_tags(status);
CREATE INDEX IF NOT EXISTS idx_item_tag_assignments_tag ON item_tag_assignments(tag_id);
CREATE INDEX IF NOT EXISTS idx_item_tag_assignments_assigned_by ON item_tag_assignments(assigned_by);

CREATE INDEX IF NOT EXISTS idx_entity_mentions_item ON entity_mentions(item_id);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_norm ON entity_mentions(normalized_text);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_type ON entity_mentions(entity_type);
CREATE INDEX IF NOT EXISTS idx_canonical_entities_slug ON canonical_entities(canonical_slug);
CREATE INDEX IF NOT EXISTS idx_canonical_entities_type ON canonical_entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entity_links_entity ON entity_links(entity_id);

CREATE INDEX IF NOT EXISTS idx_topic_taxonomy_parent ON topic_taxonomy(parent_topic_id);
CREATE INDEX IF NOT EXISTS idx_topic_taxonomy_status ON topic_taxonomy(status);
CREATE INDEX IF NOT EXISTS idx_dynamic_topics_parent ON dynamic_topics(parent_taxonomy_id);
CREATE INDEX IF NOT EXISTS idx_dynamic_topics_status ON dynamic_topics(status);
CREATE INDEX IF NOT EXISTS idx_dynamic_topics_growth ON dynamic_topics(growth_score DESC);
CREATE INDEX IF NOT EXISTS idx_item_topic_assignments_topic ON item_topic_assignments(topic_kind, topic_id);
CREATE INDEX IF NOT EXISTS idx_item_topic_assignments_assigned_by ON item_topic_assignments(assigned_by);

CREATE INDEX IF NOT EXISTS idx_item_vectors_model ON item_vectors(model_name);
CREATE INDEX IF NOT EXISTS idx_item_vectors_hash ON item_vectors(content_hash);
CREATE INDEX IF NOT EXISTS idx_vector_refs_backend ON vector_index_refs(backend, collection_name);

CREATE INDEX IF NOT EXISTS idx_kg_edges_from ON kg_edges(from_kind, from_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_to ON kg_edges(to_kind, to_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_type ON kg_edges(edge_type);
CREATE INDEX IF NOT EXISTS idx_kg_edges_confidence ON kg_edges(confidence DESC);

-- ============================================================
-- Seed Stable Taxonomy
-- ============================================================

INSERT OR IGNORE INTO topic_taxonomy
  (id, slug, name, name_zh, description, description_zh, level, status, seed_keywords, negative_keywords)
VALUES
  ('kt001', 'llms-generative-ai', 'LLMs & Generative AI', '大模型与生成式 AI',
   'Large language models, multimodal models, prompting, reasoning, agents, and generative AI applications.',
   '大语言模型、多模态模型、提示词、推理、智能体和生成式 AI 应用。',
   0, 'active',
   '["llm","gpt","claude","gemini","qwen","deepseek","reasoning","multimodal","prompt","生成式AI","大模型"]',
   '[]'),
  ('kt002', 'ai-agents', 'AI Agents', 'AI 智能体',
   'Agent frameworks, tool use, memory, planning, workflow automation, and agentic applications.',
   '智能体框架、工具调用、记忆、规划、工作流自动化和 agentic 应用。',
   0, 'active',
   '["agent","agents","tool use","memory","mcp","workflow","planner","automation","智能体"]',
   '[]'),
  ('kt003', 'ai-coding-tools', 'AI Coding Tools', 'AI 编程工具',
   'AI coding assistants, code generation, developer copilots, IDE tools, and software engineering agents.',
   'AI 编程助手、代码生成、开发者 copilot、IDE 工具和软件工程智能体。',
   0, 'active',
   '["code","coding","developer","ide","copilot","cursor","codex","claude code","devtools","编程"]',
   '[]'),
  ('kt004', 'ai-infra', 'AI Infrastructure', 'AI 基础设施',
   'Inference, training, serving, evaluation, observability, vector databases, and model infrastructure.',
   '推理、训练、服务化、评测、可观测性、向量数据库和模型基础设施。',
   0, 'active',
   '["inference","training","serving","eval","observability","vector database","rag","gpu","推理","训练"]',
   '[]'),
  ('kt005', 'ml-research', 'ML Research', '机器学习研究',
   'Machine learning papers, methods, benchmarks, datasets, and research results.',
   '机器学习论文、方法、基准、数据集和研究成果。',
   0, 'active',
   '["paper","arxiv","benchmark","dataset","method","research","论文","数据集"]',
   '[]'),
  ('kt006', 'developer-tools', 'Developer Tools', '开发者工具',
   'CLI tools, SDKs, frameworks, build tools, testing, debugging, and productivity tools.',
   'CLI 工具、SDK、框架、构建工具、测试、调试和效率工具。',
   0, 'active',
   '["cli","sdk","framework","testing","debugging","build","package","developer tool","开发者工具"]',
   '[]'),
  ('kt007', 'web-platform', 'Web Platform', 'Web 平台',
   'Browsers, frontend frameworks, JavaScript, CSS, Web APIs, and web application architecture.',
   '浏览器、前端框架、JavaScript、CSS、Web API 和 Web 应用架构。',
   0, 'active',
   '["browser","javascript","typescript","css","react","vue","frontend","web api","web"]',
   '[]'),
  ('kt008', 'devops-cloud', 'DevOps & Cloud', 'DevOps 与云',
   'Cloud platforms, containers, Kubernetes, CI/CD, deployment, observability, and platform engineering.',
   '云平台、容器、Kubernetes、CI/CD、部署、可观测性和平台工程。',
   0, 'active',
   '["kubernetes","docker","ci","cd","platform engineering","云平台","云计算"]',
   '[]'),
  ('kt009', 'security', 'Security', '安全',
   'Security vulnerabilities, privacy, authentication, supply chain, malware, and defensive tooling.',
   '安全漏洞、隐私、认证、供应链、恶意软件和防御工具。',
   0, 'active',
   '["security","vulnerability","privacy","auth","malware","supply chain","cve","安全","漏洞"]',
   '[]'),
  ('kt010', 'databases-data-infra', 'Databases & Data Infra', '数据库与数据基础设施',
   'Databases, data warehouses, search, streaming, analytics, ETL, and data engineering.',
   '数据库、数据仓库、搜索、流处理、分析、ETL 和数据工程。',
   0, 'active',
   '["database","postgres","sqlite","search","streaming","analytics","etl","warehouse","数据"]',
   '[]'),
  ('kt011', 'open-source', 'Open Source', '开源',
   'Open-source projects, maintainers, licensing, community governance, and project sustainability.',
   '开源项目、维护者、许可证、社区治理和项目可持续性。',
   0, 'active',
   '["open source","github","license","maintainer","community","oss","开源"]',
   '[]'),
  ('kt012', 'startups-funding', 'Startups & Funding', '创业与融资',
   'Startups, funding, acquisitions, business models, founder lessons, and company building.',
   '创业公司、融资、收购、商业模式、创始人经验和公司建设。',
   0, 'active',
   '["startup","funding","acquisition","founder","yc","business model","创业","融资"]',
   '[]'),
  ('kt013', 'product-launches', 'Product Launches', '产品发布',
   'New product launches, growth, go-to-market, app launches, and product discovery.',
   '新产品发布、增长、市场进入、应用发布和产品发现。',
   0, 'active',
   '["launch","product","product hunt","app","release","growth","发布","产品"]',
   '[]'),
  ('kt014', 'robotics-physical-ai', 'Robotics & Physical AI', '机器人与具身智能',
   'Robotics, embodied AI, humanoids, autonomous systems, control, and robot learning.',
   '机器人、具身智能、人形机器人、自主系统、控制和机器人学习。',
   0, 'active',
   '["robot","robotics","humanoid","embodied","physical ai","autonomous","机器人","具身智能"]',
   '[]'),
  ('kt015', 'semiconductors-hardware', 'Semiconductors & Hardware', '半导体与硬件',
   'Chips, GPUs, semiconductors, photonics, hardware acceleration, devices, and manufacturing.',
   '芯片、GPU、半导体、光电、硬件加速、设备和制造。',
   0, 'active',
   '["chip","gpu","semiconductor","hardware","photonics","accelerator","芯片","半导体","硬件"]',
   '[]'),
  ('kt016', 'crypto-web3', 'Crypto & Web3', '加密与 Web3',
   'Cryptocurrency, blockchains, wallets, DeFi, stablecoins, and decentralized applications.',
   '加密货币、区块链、钱包、DeFi、稳定币和去中心化应用。',
   0, 'active',
   '["crypto","web3","blockchain","wallet","defi","stablecoin","加密","区块链"]',
   '[]'),
  ('kt017', 'design-ux', 'Design & UX', '设计与用户体验',
   'Product design, UX, UI, design systems, typography, interaction design, and creative tools.',
   '产品设计、UX、UI、设计系统、字体、交互设计和创意工具。',
   0, 'active',
   '["design","ux","ui","typography","figma","interaction","设计"]',
   '[]'),
  ('kt018', 'policy-society', 'Policy & Society', '政策与社会',
   'Regulation, law, labor, education, public policy, ethics, and social impact of technology.',
   '监管、法律、劳动、教育、公共政策、伦理和技术社会影响。',
   0, 'active',
   '["policy","regulation","law","ethics","education","labor","society","政策","监管","法律"]',
   '[]'),
  ('kt999', 'uncategorized-low-confidence', 'Uncategorized Low Confidence', '低置信未分类',
   'Fallback bucket for items that cannot yet be confidently assigned.',
   '无法高置信归类的信息流兜底主题。',
   0, 'active',
   '[]',
   '[]');
