# Eagleye KG LLM 图谱构建原则

更新日期：2026-06-15

这份文档是给后续 LLM 执行 tag hierarchy / concept graph 构建时使用的经验内化。目标不是生成漂亮分类名，而是构建能被探索、能穿透 feed、能持续扩展的概念图谱。

## 1. 本体原则

1. 图谱不是单父树，而是有向无环图（DAG）。
2. `Tag` 是 feed 蒸馏出的知识原子，但一个 tag 可以属于多个上位概念。
3. `Topic` 不是固定层级，而是可递归展开的概念节点；当前 UI 可以显示 L1-L4，但语义上允许继续向下细分。
4. 不要把“信息源元数据”当作核心知识节点，例如“推文、社交媒体、X平台、用户动态、技术动态、待确认、非技术内容”只能作为弱信号或兜底，不应占据主干。
5. 上下位关系必须是“概念包含/方法从属/应用场景归属”，不能只是词面相似。

## 2. 命名原则

1. 父节点必须比子节点更抽象，不能同名或近同名嵌套。
2. 避免“AI应用与工具 -> AI应用与工具”这种自循环式命名。
3. Topic 名称应表达稳定方向，例如“大模型架构”“推理与部署”“智能体系统”“AI编程工具”。
4. SubTopic 名称应表达可继续探索的中间概念，例如“MoE与稀疏激活”“长上下文推理”“代码生成工作流”。
5. Domain 名称要少而稳定，通常 4-7 个即可。

## 3. 多父归属原则

允许一个 tag 挂到 1-3 个父概念：

- `MoE架构` 可以属于“大模型架构”，也可以属于“推理与部署”。
- `LoRA微调` 可以属于“模型训练”，也可以属于“开源模型生态”。
- `代码生成` 可以属于“AI编程工具”，也可以属于“智能体工作流”。

每个 tag 必须至少有一个 primary parent。secondary parent 只在确实有稳定语义关系时添加。

## 4. 边类型原则

默认边是 `belongs_to`。必要时可使用：

- `method_of`：方法属于某技术方向。
- `application_of`：应用属于某底层能力。
- `infrastructure_for`：基础设施支撑某能力。
- `related_to`：横向相关，但不要当作上下位。

当前数据库先落入 `relationship_type`，后续可升级为完整 `concept_edges`。

## 5. 构建流程原则

1. 先去噪，再聚类。低信号 tag 不应该驱动主干。
2. 先局部聚类，再全局重排。局部 cluster 解决 tag 近邻，全局 round 负责上位概念和跨簇多父。
3. 不追求每层数量固定，追求每条边有意义。
4. 如果模型不确定，使用“技术观察”兜底，但兜底比例必须被视为质量告警。
5. 每次构建要输出 coverage，让系统知道哪些 tag 被覆盖、哪些只被兜底。

## 6. 质量红线

以下结果应判定为失败，需要重跑或修 prompt：

- 大量同名 parent-child。
- 超过 15% tag 进入“未归类”。
- “推文/社交媒体/用户动态”等弱 tag 出现在核心 domain。
- 一个 domain 下 topic 数明显失衡，说明被单一来源污染。
- 多个 topic 只是同义词，没有实际分工。

## 7. 工程固化：Concept Graph Schema

后续所有 LLM 端点都应该把输出写入统一概念图谱，而不是写死四层树：

- `kg_concept_nodes`
  - `kind=domain`：最顶层锚点。
  - `kind=topic`：可继续递归展开的主题节点。
  - `kind=concept`：中间概念节点，不限定层数。
  - `kind=tag`：由 feed item 蒸馏出的知识原子，必须保留 `source_tag_id`。
- `kg_concept_edges`
  - `contains`：父子/上下位包含关系，方向为 child -> parent。
  - `primary_parent`：tag 或概念的主归属。
  - `secondary_parent`：tag 或概念的辅助归属。
  - `related_to`：横向关系，不用于树展开。
  - `co_occurs`：由 feed 共现产生的统计关系。

构建器可以临时输出 L1-L4，UI 也可以按 L1-L4 展示；但数据库不能再把层级写死。任何概念节点都可以继续向下展开，任何 tag 都可以有多个 parent edge。

## 8. LLM 端点兼容规则

不同 LLM 端点会在命名、slug、覆盖率和 JSON 稳定性上表现不同。系统必须把这些差异压进工程约束：

1. `domain`、`topic`、`concept` 节点的 canonical key 使用中文 `label_zh`，不能依赖模型生成的英文 slug 或上层 domain 前缀。
2. 同一个 child -> parent 层级关系只能保留一条边；如果后续发现 primary 关系，应升级原边，而不是新增重复边。
3. 所有构建都必须写入 `kg_concept_runs`，并记录 `selected_tags`、`unique_tags`、`node_count`、`edge_count`、`multiParentTags`。
4. 每次构建后必须用 SQL 验证：覆盖率、重复同名节点、重复父边、未归类比例、弱信号是否进入主干。
5. 如果某个端点 JSON 截断，先增大 `TAG_HIERARCHY_ROUND*_MAX_TOKENS`；仍不稳定时，减小 `TAG_HIERARCHY_CHUNK_SIZE`，不要降低标签覆盖目标。
