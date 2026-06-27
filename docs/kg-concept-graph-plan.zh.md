# Eagleye 概念驱动知识图谱改进方案

更新日期：2026-06-15

## 1. 当前实测状态

本次从真实仓库和 SQLite 读取到的基线：

| 指标 | 当前值 |
|---|---:|
| `information_items` | 10106 |
| `ai_summaries` | 4622 |
| `tags` | 21761 |
| `item_tags` | 21489 |
| 中文 tags | 14289 |
| 平均 tags / 已打标 item | 5.30 |
| 现有层次节点 | 5 domains / 15 topics / 33 subtopics / 98 tags |

按信息源看，标签覆盖目前不均衡：

| Source | Items | Tagged | Coverage |
|---|---:|---:|---:|
| `x-following` | 6109 | 4057 | 66.4% |
| `hacker-news` | 1795 | 0 | 0% |
| `app-store-rank` | 584 | 0 | 0% |
| `hugging-face` | 367 | 0 | 0% |
| `github-trending` | 134 | 0 | 0% |

结论：标签粒度目标已经基本启动，`5.30 tags/item` 说明 enrich prompt 方向是对的；但知识图谱当前被 X 源主导，层次构建只覆盖 98 个 tag，没有达到“200+ 个知识原子”的目标。

## 2. 核心判断

不建议立刻推倒重来成 Neo4j / Graphiti / 重型 GraphRAG。你的初衷是“Feed -> 中文细粒度技术概念 -> LLM 涌现层次 -> 3D 可探索结构”，核心价值在概念抽象和交互穿透，不在图数据库品牌。

当前最优路线是保留 SQLite + Node UI + Python kg-worker 的轻架构，把 tag-driven KG 做成三件事：

1. 可覆盖：更多信息源进入 tag 抽取，不让 X 成为唯一信号。
2. 可重跑：每次层次构建返回 coverage、遗漏和层级数量，失败可恢复。
3. 可探索：3D 图谱支持折叠、展开、穿透 feed，而不是一次性展示一团点。

## 3. 目标架构

```text
Feed Items
  -> LLM item enrichment
     -> 4-6 个中文细粒度 tags
     -> item_tags
  -> Tag candidate ranking
     -> 频率、来源多样性、时效、去噪
  -> LLM batch clustering
     -> L4 Tag
     -> L3 SubTopic
     -> L2 Topic
     -> L1 Domain
  -> Graph materialization
     -> vertical hierarchy edges
     -> horizontal tag co-occurrence edges
  -> 3D interactive graph
     -> collapse / expand
     -> click tag -> feed items
     -> click parent -> child tree
```

## 4. 近期必须优化

### 4.1 层次构建覆盖

当前 `buildTagHierarchy()` 一次把最多 150 个 tag 塞进 Round1，实际只写入 98 个 L4 tags。应该改为：

- 默认候选 tag 提升到 240。
- Round1 按 120 个 tag 分批聚类，降低 JSON 截断风险。
- Round2 聚合所有 subtopics。
- 对 Round1 漏掉的 tag 自动补进“未归类技术标签”。
- 返回 `selectedTags / assignedTags / coverage`，作为完成标准。

完成标准：

- `/api/tags/build-hierarchy` 返回 `assignedTags >= 200` 或明确报告为什么达不到。
- `/api/kg3d` 返回 L1-L4 完整节点与边。

### 4.2 标签质量治理

当前高频 tag 里仍有“社交媒体、推文、用户动态、技术动态、AI动态”等弱概念。它们可以展示，但不应该占据 L4 核心图谱。下一步应加入 tag quality score：

- 降权 source/meta 类 tag：`推文`、`X平台`、`社交媒体`。
- 降权过泛 tag：`人工智能`、`AI动态`、`技术分享`。
- 提升具体技术 tag：`MoE架构`、`推理加速`、`模型压缩`、`视觉语言模型`、`LoRA微调`。

M1 可以先在 SQL 候选选择层过滤一批明显低信号词；M2 再建 `kg_tag_quality` 表。

### 4.3 多源覆盖

现在 HN/HF/GitHub 的 `tagged=0`，说明图谱视角被 X 主导。需要优先跑这些源的 enrich：

```text
hacker-news
hugging-face
github-trending
lobsters
physical-ai-*
```

完成标准：

- Top 5 sources 中至少 4 个 source 的 tag coverage > 50%。
- 3D 图谱中每个 domain 至少有 2 个 source 的 feed 证据。

### 4.4 3D 交互

3D 图谱应从“全量展示”升级为“可探索结构”：

- 点击 L1/L2/L3 节点：折叠或展开子树。
- 点击 tag：展示 feed items。
- 面板显示子节点数量、tag 数量、feed 数量。
- 后续增加“只看横向共现 / 只看纵向层级”切换。

## 5. 中期演进

等 v1 稳定后，再把 `docs/kg-redesign.md` 里的 KG v2 表逐步接入：

- `kg_extraction_runs`：记录每次图谱生成的版本和覆盖率。
- `kg_tags`：把 tags 从展示表升级为规范化概念字典。
- `item_tag_assignments`：记录 tag 证据、置信度、来源。
- `kg_edges`：替换旧 `graph_edges`，让边有 extractor/version/evidence。

这一步不改变产品体验，只增强可追溯、可重算和后续 GraphRAG 能力。

## 6. 本轮实施范围

本轮先做三个直接改善：

1. `tag-hierarchy.js`：分批聚类、240 tag、遗漏补全、coverage 返回。
2. `kg3d.js`：增加层级节点折叠/展开。
3. `settings`：隐藏单独 translate backfill，避免用户绕过 full pipeline。

这些改动不会推翻现有库，也不会要求新服务，符合“最小修改但最大贴近初衷”的路线。
