# Eagleye 论文流与知识图谱架构

更新日期：2026-06-15

## 1. 目标

论文不应成为一个孤立页面。论文源要像 X、HN、GitHub 一样进入 Eagleye 的统一 feed 流水线，并且进入同一套中文 tag 与 3D 知识图谱。

核心路径：

```text
arXiv / Hugging Face Papers / OpenReview / 其他开放预印本
  -> information_items
  -> paper_metadata
  -> LLM enrichment
  -> tags / item_tags
  -> kg_concept_nodes / kg_concept_edges
  -> /papers
  -> /kg3d
```

## 2. 设计原则

1. 论文是 `Feed Item`，不是另一套内容模型。
2. 论文专属字段写入 `paper_metadata`，不要污染 `information_items` 的通用字段。
3. tag 系统保持统一：X 中出现的 `VLA模型` 和 arXiv 中出现的 `VLA模型` 必须汇聚到同一个 tag。
4. 3D 图谱保持统一：论文只增加证据和权重，不生成独立“论文图谱”。
5. connector 只负责抓取和规范化，LLM 负责中文技术抽象，KG builder 负责概念归纳。

## 3. 数据模型

### 3.1 `information_items`

论文仍然写入现有表：

- `title`：论文英文标题。
- `original_summary`：abstract。
- `canonical_url`：论文主页，优先 Hugging Face / arXiv landing page。
- `published_at`：论文发布时间。
- `source_payload`：原始 provider 字段。
- `normalized_payload`：轻量规范化字段。

### 3.2 `paper_metadata`

新增论文专属表：

```sql
paper_metadata (
  item_id TEXT PRIMARY KEY,
  paper_id TEXT,
  source_slug TEXT,
  provider TEXT,
  arxiv_id TEXT,
  doi TEXT,
  title TEXT NOT NULL,
  abstract TEXT,
  authors_json TEXT,
  categories_json TEXT,
  published_at TEXT,
  updated_at TEXT,
  pdf_url TEXT,
  landing_url TEXT,
  code_url TEXT,
  datasets_json TEXT,
  tasks_json TEXT,
  venue TEXT,
  dedupe_key TEXT,
  metadata_json TEXT
)
```

`dedupe_key` 优先级：

```text
doi -> arxiv_id -> normalized title hash
```

## 4. 论文源规划

第一阶段启用：

- `hugging-face`：Hugging Face Daily Papers，已有 connector，补 metadata 写入。
- `physical-ai-arxiv`：具身 AI / robotics / humanoid / VLA，改用结构化 arXiv connector。
- `arxiv-ai`：cs.AI / cs.LG / cs.CL / cs.CV / cs.RO / stat.ML 的通用 AI 论文流。

后续可扩展：

- `openreview`：ICLR/NeurIPS/ICML 等开放评审。
- `biorxiv-medrxiv`：AI for Science / biomedical AI。
- `papers-with-code` 或 Semantic Scholar：补充 code、dataset、benchmark，不一定作为主 feed。

## 5. LLM Enrichment

现有 `enrichItems()` 可继续处理论文，但 prompt 必须给论文明确指导：

论文输入优先使用：

- title
- abstract
- authors
- categories
- tasks
- source payload

论文输出 tag 应偏向：

- 方法：`扩散策略`、`稀疏注意力`、`参数高效微调`
- 任务：`视觉语言导航`、`代码生成`、`多模态检索`
- 模型/系统：`VLA模型`、`世界模型`、`检索增强生成`
- 数据集/基准：`机器人操作基准`、`多模态评测`
- 应用场景：`人形机器人`、`医学影像分析`

禁止只输出：

- `论文`
- `AI论文`
- `机器学习`
- `研究分享`

## 6. 图谱接入

论文进入 `tags` 和 `item_tags` 后，现有 `tag-hierarchy.js` 会自动吸收论文 tag。

后续 KG candidate ranking 可加入论文证据权重：

```text
tag_score =
  item_count
  + source_diversity_bonus
  + paper_evidence_bonus
  + recency_bonus
  - weak_signal_penalty
```

本阶段先保证论文 tag 进入统一图谱；下一阶段再调整 ranking。

## 7. `/papers` 页面

`/papers` 是论文阅读入口，不是独立系统。

页面结构：

- 顶部：论文数、来源数、最近更新时间。
- 筛选：全部、Hugging Face、arXiv AI、Physical AI arXiv、有 PDF。
- 列表：标题、中文一句话、abstract 摘要、authors、categories、tags、PDF / 原文 / 研究按钮。

## 8. API

新增：

```text
GET /api/papers
```

参数：

- `source=all|hugging-face|arxiv-ai|physical-ai-arxiv`
- `limit`
- `offset`

返回：

```json
{
  "status": "ok",
  "papers": [],
  "sources": [],
  "stats": {
    "total": 0,
    "with_pdf": 0,
    "tagged": 0
  }
}
```

## 9. 实施阶段

### M1：论文 tab 与 API

- 新增 `/papers` 页面。
- 新增 `GET /api/papers`。
- 聚合 `hugging-face` 与 `physical-ai-arxiv`。

### M2：论文元数据

- 新增 `paper_metadata` migration。
- `BaseConnector.saveItems()` 支持保存 `paper_metadata`。
- Hugging Face connector 写入论文 metadata。

### M3：结构化 arXiv connector

- 新增 `ArxivConnector`。
- `physical-ai-arxiv` 改用结构化 connector。
- 新增 `arxiv-ai` source。

### M4：论文 LLM prompt 固化

- 批量 enrichment prompt 增加 paper-specific 规则。
- tags 继续写入统一 tag 系统。

### M5：KG 权重与可视化增强

- 给 KG candidate ranking 加 paper evidence。
- `/api/kg3d` 后续可返回 `paperEvidenceCount`。

## 10. 验收标准

最低验收：

- `/papers` 可打开并显示论文。
- `paper_metadata` 有数据。
- 论文 item 可以被 enrich，并生成中文细粒度 tags。
- 跑完整流水线后，论文 tags 进入 `/api/kg3d`。
- 不出现独立论文图谱和主图谱割裂。
