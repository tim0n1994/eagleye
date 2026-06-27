# Eagleye KG v2 精密设计

更新日期：2026-06-06  
状态：设计冻结前草案  
目标：把 Eagleye 从“信息流 + 简单 LLM 标签”升级为性能优先、可解释、可增量构建的动态知识图谱系统。

---

## 1. 当前结论

当前实现不适合继续小修。它把摘要、tag、entity、topic assignment 混在同一个 enrich 步骤里，导致图谱质量依赖 LLM 单次输出，缺少独立的知识工程流水线。

当前数据库实测：

| 表 | 数量 |
|---|---:|
| `information_items` | 5605 |
| `ai_summaries` | 2729 |
| `topics` | 10 |
| `tags` | 6296 |
| `entities` | 252 |
| `item_topics` | 582 |
| `item_tags` | 10569 |
| `graph_edges` | 1630 |

重点源覆盖缺口：

| Source | Items | Enriched | Topic links |
|---|---:|---:|---:|
| X | 2680 | 105 | 36 |
| Hacker News | 2466 | 2398 | 696 |
| GitHub Trending | 198 | 196 | 81 |
| Hugging Face | 223 | 2 | 0 |
| Product Hunt | 10 | 0 | 0 |

主要问题：

- Topic 只有 10 个 seed category，不是动态主题系统。
- Tag 全部是 `llm-extracted`，没有类型、来源、置信度、层级、归一化。
- Entity 缺少 mention 层、canonical 层和 alias 层。
- Embedding 现在塞在 `normalized_payload._embedding`，不适合查询、重算和版本管理。
- Graph edge schema 过宽泛，缺少 extractor/version/confidence/temporal/provenance。
- 当前 topic graph builder 的 deep mode 每次最多处理几十条，且 fallback embedding 是 256 维词频指纹，不足以做高质量聚类。
- LLM 既负责摘要又负责结构抽取，性能和质量不可控。

---

## 2. 设计原则

1. 性能优先  
   大部分 item 必须通过 deterministic / embedding / lightweight model 路径处理，LLM 只用于低置信度补强、主题命名和复杂关系解释。

2. 原始事实不可污染  
   `information_items` 保留 source truth。任何 AI 输出都进入独立表，带 extractor、model、version、confidence、evidence。

3. Tag、Entity、Topic 分层  
   Tag 是轻量标签，Entity 是可归一对象，Topic 是可演化主题。三者不能混用。

4. 图谱是独立流水线  
   `sync/enrich` 可以触发 KG job，但 KG 不能被摘要逻辑绑死。

5. 每条 feed 都必须可分类  
   每个 item 至少要有：
   - 1 个 source tag
   - 1 个 content tag
   - 1 个 taxonomy topic 或 `uncategorized-low-confidence`
   - 可选动态 topic
   - 可选 entities

6. 支持增量、重跑、版本化  
   Prompt、extractor、embedding model、topic model 都要可重跑，不破坏原始 item。

---

## 3. 组件选型

### 3.1 推荐路线

第一阶段采用：

`Node Web/App + SQLite truth store + Python kg-worker + FastEmbed + GLiNER + BERTopic + optional Qdrant`

原因：

- Eagleye 当前规模是几千到几十万 item 级别，SQLite 仍适合做事实库和控制面。
- 真正瓶颈是抽取质量、主题发现和调度，不是图数据库本身。
- Python NLP 生态更成熟，BERTopic/GLiNER/FastEmbed 都是 Python-first。
- Qdrant 可作为可选向量索引，先本地文件/SQLite 存 embedding，后续无缝升级。

### 3.2 组件职责

| 组件 | 用途 | 是否 M1 引入 | 备注 |
|---|---|---:|---|
| FastEmbed | 本地 dense embedding / sparse embedding | 是 | 快速、轻量，适合批处理 |
| GLiNER | 零样本/轻量实体抽取 | 是 | 抽 company/repo/model/paper/person/product/technology |
| BERTopic | 动态主题发现和 topic representation | 是 | 用 embedding + clustering + c-TF-IDF |
| Qdrant | 向量/稀疏混合检索 | 可选 | M1 可先不强依赖，M2 上 |
| 本地 LLM | 中文卡片、复杂关系、topic 命名 | 是 | 只处理批量摘要和低置信补强 |
| Neo4j GraphRAG | 重型 property graph / GraphRAG | 否 | M2/M3 评估 |
| Graphiti | temporal KG engine | 否 | M2/M3 评估，适合长期演化关系 |

### 3.3 为什么不立刻上 Neo4j / Graphiti

Neo4j GraphRAG 和 Graphiti 都成熟，但当前不应作为第一步：

- 当前 schema 和 ontology 尚未稳定，过早换图数据库会把设计不确定性放大成运维复杂度。
- 现有 UI/API 都围绕 SQLite/Node，先把抽取和主题质量做对更重要。
- Graphiti 很适合 temporal KG，但它会引入新的服务、Python runtime、图后端和搜索语义；应在 KG v2 数据模型稳定后作为后端升级。

M1 目标是做出高质量、可重跑的 KG 数据层；M2 再决定是否把 `graph_edges_v2` 镜像到 Neo4j/Graphiti。

---

## 4. KG v2 数据模型

保留旧表用于兼容，新增 v2 表。第一阶段不删除 `topics/tags/entities/graph_edges`。

### 4.1 `kg_extraction_runs`

每次 KG job 的运行记录。

```sql
CREATE TABLE kg_extraction_runs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,                 -- source|date|all|item_ids
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
```

### 4.2 `item_features`

每条 feed 的规范化特征。这里放可重复计算、非 LLM 的字段。

```sql
CREATE TABLE item_features (
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
```

示例 `source_features`：

- X：`handle, is_retweet, has_link, mentioned_handles, hashtags`
- HN：`points, comments, hn_url, domain`
- GitHub：`owner, repo, language, stars, stars_today, topics`
- Hugging Face：`paper_id, authors, upvotes, task, model_or_paper`

### 4.3 `kg_tags`

规范化 tag 字典。

```sql
CREATE TABLE kg_tags (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  label_zh TEXT,
  type TEXT NOT NULL,                  -- source|technology|product|company|repo|model|paper|method|market|noise|other
  parent_tag_id TEXT REFERENCES kg_tags(id),
  canonical_entity_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 4.4 `item_tag_assignments`

item 到 tag 的证据化映射。

```sql
CREATE TABLE item_tag_assignments (
  item_id TEXT NOT NULL REFERENCES information_items(id),
  tag_id TEXT NOT NULL REFERENCES kg_tags(id),
  confidence REAL NOT NULL DEFAULT 0,
  assigned_by TEXT NOT NULL,           -- source-rule|keyword|gliner|llm|topic-model
  evidence TEXT NOT NULL DEFAULT '{}',
  run_id TEXT REFERENCES kg_extraction_runs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, tag_id, assigned_by)
);
```

### 4.5 `entity_mentions`

实体 mention 层，保留原文片段和位置。

```sql
CREATE TABLE entity_mentions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES information_items(id),
  mention_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  entity_type TEXT NOT NULL,           -- company|repo|paper|model|person|product|technology|org|other
  start_char INTEGER,
  end_char INTEGER,
  extractor TEXT NOT NULL,             -- gliner|llm|source-rule
  confidence REAL NOT NULL DEFAULT 0,
  run_id TEXT REFERENCES kg_extraction_runs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 4.6 `canonical_entities`

归一后的实体。

```sql
CREATE TABLE canonical_entities (
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
```

### 4.7 `entity_links`

mention 到 canonical entity。

```sql
CREATE TABLE entity_links (
  mention_id TEXT NOT NULL REFERENCES entity_mentions(id),
  entity_id TEXT NOT NULL REFERENCES canonical_entities(id),
  link_confidence REAL NOT NULL DEFAULT 0,
  linker TEXT NOT NULL,                -- exact|alias|embedding|llm
  evidence TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (mention_id, entity_id)
);
```

### 4.8 `topic_taxonomy`

稳定主题分类。人工维护为主，LLM 可建议但不能随意改。

```sql
CREATE TABLE topic_taxonomy (
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
```

首批 taxonomy 建议 18 个：

1. `llms-generative-ai`
2. `ai-agents`
3. `ai-coding-tools`
4. `ai-infra`
5. `ml-research`
6. `developer-tools`
7. `web-platform`
8. `devops-cloud`
9. `security`
10. `databases-data-infra`
11. `open-source`
12. `startups-funding`
13. `product-launches`
14. `robotics-physical-ai`
15. `semiconductors-hardware`
16. `crypto-web3`
17. `design-ux`
18. `policy-society`

### 4.9 `dynamic_topics`

自动发现的动态主题。

```sql
CREATE TABLE dynamic_topics (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  name_zh TEXT,
  description TEXT,
  description_zh TEXT,
  parent_taxonomy_id TEXT REFERENCES topic_taxonomy(id),
  status TEXT NOT NULL DEFAULT 'candidate', -- candidate|active|merged|rejected|archived
  discovery_method TEXT NOT NULL,           -- bertopic|cluster|llm
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
```

### 4.10 `item_topic_assignments`

统一记录 item 到 taxonomy / dynamic topic。

```sql
CREATE TABLE item_topic_assignments (
  item_id TEXT NOT NULL REFERENCES information_items(id),
  topic_kind TEXT NOT NULL,             -- taxonomy|dynamic
  topic_id TEXT NOT NULL,
  relevance REAL NOT NULL DEFAULT 0,
  assigned_by TEXT NOT NULL,            -- source-rule|embedding|bertopic|llm|manual
  reason TEXT,
  run_id TEXT REFERENCES kg_extraction_runs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, topic_kind, topic_id, assigned_by)
);
```

### 4.11 `item_vectors`

不要再把 embedding 塞进 `normalized_payload`。

```sql
CREATE TABLE item_vectors (
  item_id TEXT NOT NULL REFERENCES information_items(id),
  vector_type TEXT NOT NULL,            -- title|content|summary|hybrid
  model_name TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, vector_type, model_name)
);
```

如果启用 Qdrant，则 SQLite 只保留 vector metadata：

```sql
CREATE TABLE vector_index_refs (
  item_id TEXT NOT NULL,
  vector_type TEXT NOT NULL,
  backend TEXT NOT NULL,                -- qdrant|sqlite-json
  collection_name TEXT NOT NULL,
  point_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, vector_type, backend)
);
```

### 4.12 `kg_edges`

替代旧 `graph_edges`。

```sql
CREATE TABLE kg_edges (
  id TEXT PRIMARY KEY,
  from_kind TEXT NOT NULL,              -- item|tag|entity|taxonomy_topic|dynamic_topic|source
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
```

允许的 edge types：

| Edge type | 含义 |
|---|---|
| `item_has_tag` | item 被标记 tag |
| `item_mentions_entity` | item 提到实体 |
| `item_belongs_taxonomy_topic` | item 属于稳定主题 |
| `item_belongs_dynamic_topic` | item 属于动态主题 |
| `entity_co_occurs_entity` | 实体共现 |
| `entity_related_entity` | 归纳关系 |
| `dynamic_topic_under_taxonomy` | 动态主题挂到稳定主题 |
| `topic_related_topic` | 主题相似或共现 |
| `source_discusses_topic` | 信息源近期讨论某主题 |
| `tag_maps_entity` | tag 映射到 canonical entity |

---

## 5. KG v2 流水线

### 5.1 总体路径

```text
sync source
  -> normalize item
  -> fast feature extraction
  -> source-aware rule tags
  -> embedding
  -> GLiNER entity mentions
  -> entity resolution
  -> taxonomy topic assignment
  -> dynamic topic discovery
  -> graph edge materialization
  -> metrics + UI API
```

摘要链路独立：

```text
item
  -> Chinese knowledge card
  -> display fields
```

KG 链路可以使用摘要，但不能依赖摘要先完成。

### 5.2 Stage A：快速特征抽取

输入：`information_items` + `sources`

输出：

- `item_features`
- source tags
- basic quality score

实现：

- Node 或 Python 均可。建议 Python worker 统一处理。
- 规则必须 source-aware。

X 规则：

- handle -> `source:x-following`, `author:@name`
- hashtags -> tag candidates
- URL domain -> domain tag
- 去掉低信号动作标题，例如 `@xxx posted`

GitHub 规则：

- repo owner/name -> canonical repo entity
- language -> technology tag
- stars/stars_today -> popularity feature
- repo topics -> source tags

Hugging Face 规则：

- paper title -> paper mention
- authors -> person mentions
- task/model/dataset 信息 -> method/model tags

HN 规则：

- domain、points、comments、title keywords

### 5.3 Stage B：Embedding

默认 M1：

- FastEmbed dense model：用于 item/title/content embedding。
- Sparse / BM25：M1 可先用 SQLite FTS5，M2 接 Qdrant sparse vectors。

文本拼接策略：

```text
title
ai_title_zh if exists
one_liner_zh if exists
original_summary/content_text
source-specific fields
```

向量类型：

- `title`: 标题短文本聚类
- `content`: 内容语义检索
- `hybrid`: 标题 + 摘要 + source fields

性能要求：

- embedding 批处理，默认 batch 64-256。
- 只对 `content_hash` 变化的 item 重算。
- 前 4 个源优先。

### 5.4 Stage C：实体抽取

默认使用 GLiNER，labels：

```json
[
  "company",
  "repository",
  "paper",
  "model",
  "person",
  "product",
  "technology",
  "organization",
  "dataset",
  "framework",
  "programming language"
]
```

LLM 只处理：

- GLiNER 低置信实体
- 多实体关系抽取
- 需要中文解释的 canonical description

实体归一规则：

1. exact normalized match
2. alias match
3. source-specific key
   - GitHub: `github:owner/repo`
   - Hugging Face: `hf:paper_id` / `hf:model_id`
   - X: `x:@handle`
4. embedding similarity candidate
5. LLM resolver for conflict cases

### 5.5 Stage D：稳定主题分类

每条 item 必须落到至少一个 `topic_taxonomy`。

组合评分：

```text
score = source_rule_score * 0.25
      + keyword_score * 0.20
      + embedding_similarity * 0.35
      + entity_prior * 0.10
      + LLM_hint * 0.10
```

阈值：

- `>= 0.70`: 自动接受
- `0.45 - 0.70`: 接受但标记 low-confidence
- `< 0.45`: 放入 `uncategorized-low-confidence`

source-aware 约束：

- GitHub Trending：repo language / repo topics 权重更高。
- X：短文本噪声高，作者和 URL domain 权重更高。
- HN：标题和 domain 权重高，评论/points 只影响 signal strength。
- Hugging Face：paper title / abstract / task words 权重高。

### 5.6 Stage E：动态主题发现

周期：

- 快速增量：每次 sync 后对新增 item 做 assignment。
- 批量发现：每天/手动对 7-30 天窗口跑 BERTopic。

候选 topic 创建条件：

- cluster item count >= 5
- source diversity >= 2，或单源高质量 >= 8
- centroid 与现有 dynamic topic 相似度 < merge threshold
- c-TF-IDF keywords 清晰
- 代表 item 中低质量标题占比 < 50%

动态 topic 状态：

- `candidate`: 刚发现
- `active`: 通过自动规则或人工确认
- `merged`: 合并到已有 topic
- `rejected`: 噪声
- `archived`: 长期无新信息

LLM 用途：

- 给 cluster 命名中文/英文
- 生成 topic description
- 判断是否与已有 topic 重复

LLM 输入必须包含：

- top keywords
- representative items
- source distribution
- nearest existing topics

### 5.7 Stage F：边构建

边来自四类 extractor：

1. `source-rule`
2. `keyword`
3. `embedding`
4. `llm`

每条边必须带：

- `confidence`
- `weight`
- `evidence_item_ids`
- `extractor`
- `extractor_version`
- `run_id`

禁止无证据边。

---

## 6. kg-worker 设计

### 6.1 目录结构

```text
kg-worker/
  pyproject.toml
  README.md
  eagleye_kg/
    __init__.py
    config.py
    db.py
    models.py
    features.py
    embeddings.py
    ner.py
    entity_resolution.py
    taxonomy.py
    dynamic_topics.py
    edges.py
    pipeline.py
    cli.py
  tests/
    test_features.py
    test_taxonomy.py
    test_entity_resolution.py
```

### 6.2 CLI

```bash
uv run --project kg-worker eagleye-kg status
uv run --project kg-worker eagleye-kg migrate
uv run --project kg-worker eagleye-kg extract --sources x-following,hacker-news,github-trending,hugging-face --limit 2000
uv run --project kg-worker eagleye-kg topics discover --window-days 30
uv run --project kg-worker eagleye-kg backfill --priority-only
uv run --project kg-worker eagleye-kg metrics
```

### 6.3 Node 调用方式

新增 job type：

- `KG_EXTRACT_ITEMS`
- `KG_DISCOVER_TOPICS`
- `KG_BACKFILL_PRIORITY`
- `KG_BUILD_EDGES`

Node job 只负责：

- 创建 `background_jobs`
- spawn Python worker
- 读取 stdout JSONL 进度
- 写 job progress
- 返回 UI stream

Python worker 负责：

- 数据处理
- 模型加载
- 批处理
- 写 KG v2 表

### 6.4 JSONL 进度协议

```json
{"phase":"features","processed":100,"total":2000,"items_per_sec":320}
{"phase":"embedding","processed":500,"total":2000,"items_per_sec":80}
{"phase":"ner","processed":500,"mentions":1200,"entities":430}
{"phase":"taxonomy","processed":700,"assigned":690,"low_confidence":10}
{"phase":"dynamic_topics","clusters":24,"candidates":7,"active":3}
{"phase":"done","processed":2000,"edges":8500,"seconds":42}
```

---

## 7. API 设计

### 7.1 Metrics

`GET /api/kg/metrics`

返回：

```json
{
  "items_total": 5605,
  "items_with_tags": 0,
  "items_with_taxonomy_topic": 0,
  "items_with_dynamic_topic": 0,
  "entities": 0,
  "entity_mentions": 0,
  "dynamic_topics": 0,
  "edges": 0,
  "coverage_by_source": []
}
```

### 7.2 Item KG

`GET /api/items/:id/kg`

返回 item 的：

- tags
- entity mentions
- canonical entities
- taxonomy topics
- dynamic topics
- graph neighbors

### 7.3 Topic APIs

```text
GET /api/kg/topics
GET /api/kg/topics/:slug
GET /api/kg/topics/:slug/items
GET /api/kg/topics/:slug/timeline
GET /api/kg/topics/:slug/graph
```

### 7.4 Entity APIs

```text
GET /api/kg/entities
GET /api/kg/entities/:slug
GET /api/kg/entities/:slug/items
GET /api/kg/entities/:slug/graph
```

### 7.5 Operations

```text
POST /api/kg/extract?priority_only=true&limit=2000
POST /api/kg/topics/discover?window_days=30
POST /api/kg/backfill?source=x-following
POST /api/kg/rebuild-edges
```

---

## 8. UI 设计影响

### 8.1 Sources 页面

每个 source 显示：

- item count
- KG coverage
- tag coverage
- taxonomy coverage
- dynamic topic coverage
- entity coverage
- top tags
- top topics

### 8.2 News 页面

每张卡片显示：

- 中文知识卡片
- source badge
- 2-4 个 typed tags
- taxonomy topic
- dynamic topic
- entity chips

### 8.3 Topics 页面

重做为三栏：

1. 左栏：taxonomy tree + dynamic topics
2. 中间：topic graph / cluster graph
3. 右栏：选中 topic/entity/tag 的 items、timeline、来源分布、趋势解释

### 8.4 Deep Research 页面

研究上下文优先来自 KG：

- item summary
- taxonomy topic
- dynamic topic
- related entities
- related items
- source distribution
- timeline
- graph neighbors

---

## 9. 性能策略

### 9.1 快路径

不调用 LLM：

- source rule tags
- keyword candidates
- feature extraction
- basic taxonomy assignment
- exact/alias entity resolution
- edge materialization

### 9.2 中路径

轻量模型：

- FastEmbed
- GLiNER
- BERTopic

### 9.3 慢路径

本地 LLM：

- 中文摘要
- 主题命名
- 低置信实体消歧
- 复杂关系解释

### 9.4 优先队列

默认顺序：

1. X
2. Hacker News
3. GitHub Trending
4. Hugging Face
5. Product Hunt
6. 其它

首批目标：

- X：2680 条全部 feature/tag/topic
- HN：补齐 topic 覆盖
- GitHub：补齐 repo/entity/topic
- Hugging Face：优先摘要 + paper/model/entity/topic

### 9.5 指标门槛

M1 完成标准：

- 前 4 个源 `item_features` 覆盖率 >= 95%
- 前 4 个源 `item_tag_assignments` 覆盖率 >= 95%
- 前 4 个源 `item_topic_assignments` 覆盖率 >= 90%
- 前 4 个源 `entity_mentions` 覆盖率按来源合理：
  - X >= 40%
  - HN >= 50%
  - GitHub >= 90%
  - Hugging Face >= 80%
- 动态 topic 至少发现 20 个 candidate，人工/自动激活 8 个以上。
- KG backfill 2000 条 item 在本地机器上应以分钟级完成，不应以小时计。

---

## 10. 迁移计划

### Phase 0：设计与审计

已完成/当前进行：

- 审计旧 schema 和 topic graph builder。
- 审计当前数据覆盖率。
- 确定组件路线。
- 写本文档。

### Phase 1：KG v2 Schema

新增 migration：

`server/migrations/006_kg_v2.sql`

包含：

- `kg_extraction_runs`
- `item_features`
- `kg_tags`
- `item_tag_assignments`
- `entity_mentions`
- `canonical_entities`
- `entity_links`
- `topic_taxonomy`
- `dynamic_topics`
- `item_topic_assignments`
- `item_vectors`
- `vector_index_refs`
- `kg_edges`
- 必要索引

同时 seed `topic_taxonomy` 18 个稳定主题。

### Phase 2：kg-worker Scaffold

新增 Python worker：

- SQLite 连接
- CLI
- features extractor
- source-aware rules
- metrics
- tests

先不接 GLiNER/BERTopic，只做 deterministic coverage。

### Phase 3：前 4 源快速 Backfill

运行：

```bash
uv run --project kg-worker eagleye-kg extract --sources x-following,hacker-news,github-trending,hugging-face --limit 5000
```

目标：

- 所有前 4 源 item 至少有 source tag、content tag、taxonomy topic。
- 输出 `/api/kg/metrics`。

### Phase 4：NER 与实体归一

引入 GLiNER：

- 写 `entity_mentions`
- 写 `canonical_entities`
- 写 `entity_links`
- 写 `kg_edges item_mentions_entity`

优先 GitHub/Hugging Face/X。

### Phase 5：Embedding 与动态 topic

引入 FastEmbed + BERTopic：

- 写 `item_vectors`
- 发现 `dynamic_topics`
- 写 `item_topic_assignments`
- 写 dynamic topic edges

### Phase 6：Node API 与 UI

新增 `/api/kg/*`。

UI：

- source coverage
- card tags/topics/entities
- topics workbench v2

### Phase 7：可选 Qdrant / Graphiti / Neo4j

判断条件：

- SQLite vector JSON 查询成为瓶颈
- 需要跨 topic/entity 多跳复杂检索
- 需要 temporal relation lifecycle

升级路线：

1. Qdrant：先接 hybrid retrieval。
2. Neo4j：镜像 `kg_edges` 做 property graph。
3. Graphiti：接 temporal KG，用于 evolving relations。

---

## 11. 实施顺序

建议下一步直接做 Phase 1 + Phase 2：

1. 新增 `006_kg_v2.sql`。
2. 新增 `kg-worker` scaffold。
3. 实现 deterministic feature/tag/taxonomy assignment。
4. 新增 `GET /api/kg/metrics`。
5. 跑前 4 源 backfill。
6. 用 metrics 验收覆盖率。

先不要立刻接 BERTopic/GLiNER。原因：

- 先把 schema 和 deterministic pipeline 打通，能马上让所有 feed 有 tag 和 topic。
- GLiNER/BERTopic 的模型依赖和性能参数需要在稳定数据结构上调优。
- 第一轮 backfill 的 metrics 会告诉我们哪些来源最需要模型补强。

---

## 12. 风险与对策

### 12.1 Tag 爆炸

风险：X 和 HN 会产生大量短噪声 tag。

对策：

- tag 必须 typed。
- 低频 tag 不进入主图，只留 assignment。
- 只把高置信、高频、跨源 tag 提升为 graph node。

### 12.2 Topic 漂移

风险：动态 topic 每天重复创建相似主题。

对策：

- dynamic topic 创建前查 nearest centroid。
- 相似 topic 进入 merge candidate。
- topic 状态机必须存在，不直接自动 active。

### 12.3 LLM 输出污染

风险：LLM 编造 entity/relation。

对策：

- 所有 LLM 边必须有 evidence text 或 item ids。
- 低置信只做 candidate。
- LLM 不直接写 canonical entity，先写 proposal。

### 12.4 性能失控

风险：对每条 item 调 LLM 或大模型 NER。

对策：

- 默认 fast path 不调用 LLM。
- Python worker batch 处理。
- 每个 stage 都记录 items/sec。
- UI 显示当前吞吐和剩余量。

---

## 13. 验收清单

Phase 1 验收：

- migration 可重复运行。
- 所有 KG v2 表和索引存在。
- seed taxonomy 18 个主题存在。

Phase 2 验收：

- `eagleye-kg status` 能读 DB。
- `eagleye-kg extract --limit 20` 能写 `item_features`、`kg_tags`、`item_tag_assignments`、`item_topic_assignments`。
- 不依赖 LLM。

Phase 3 验收：

- 前 4 源 tag coverage >= 95%。
- 前 4 源 taxonomy coverage >= 90%。
- `/api/kg/metrics` 返回 source coverage。

Phase 4 验收：

- GitHub/Hugging Face 实体 mention 覆盖显著提高。
- `canonical_entities` 有 alias 和 source refs。
- entity duplicate rate 可检查。

Phase 5 验收：

- 至少 20 个 dynamic topic candidate。
- 至少 8 个 active dynamic topic。
- topic detail 页面能看到 timeline 和代表 items。

---

## 14. 参考依据

- Neo4j GraphRAG Python：成熟 KG 构建、entity/relation extraction、embedding、retriever，但当前阶段不作为第一实现后端。
- Graphiti / Zep：适合 temporal KG 和持续演化关系，适合作为后续 temporal backend。
- BERTopic：embedding + clustering + c-TF-IDF 的主题发现方案，适合动态 topic。
- GLiNER：轻量零样本 NER，适合 typed entity mentions。
- Qdrant + FastEmbed：适合 dense/sparse/hybrid retrieval，后续可接入向量索引。
