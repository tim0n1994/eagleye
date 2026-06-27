# Eagleye Concept Graph 运行手册

更新日期：2026-06-15

这份手册用于让后续任意 LLM 端点继续构建同一套知识图谱，而不是重新发明分类体系。核心目标是：Feed 只提供原料，Tag 是知识原子，Concept Graph 负责表达可递归、多父、可追溯的概念关系。

## 1. 当前架构

```text
information_items
  -> ai_summaries / tags / item_tags
  -> buildTagHierarchy()
  -> kg_concept_runs
  -> kg_concept_nodes
  -> kg_concept_edges
  -> /api/kg3d
  -> js/modules/kg3d.js
```

`tag_hierarchy` 和 `knowledge_domains` 仍然保留，用于旧 UI 和回退。真正的长期结构是 `kg_concept_*`。

## 2. 节点模型

`kg_concept_nodes.kind`：

- `domain`：少而稳定的 3D 锚点。
- `topic`：上层主题，可继续拆分。
- `concept`：中间概念，不绑定固定层级。
- `tag`：从 feed item 蒸馏出的知识原子，必须保留 `source_tag_id`。

`domain`、`topic`、`concept` 的 canonical slug 必须由中文 `label_zh` 生成。不要相信 LLM 返回的英文 slug，也不要把上层 domain 拼进 canonical key，因为不同端点会把同一个中文概念翻成不同 slug 或不同上下文前缀。

## 3. 边模型

方向约定：层级边统一为 `child -> parent`。

`kg_concept_edges.edge_type`：

- `contains`：topic 属于 domain。
- `primary_parent`：主归属。
- `secondary_parent`：辅助归属。
- `related_to`：横向语义关系。
- `co_occurs`：由 feed 共现计算出的统计关系。

同一个 child -> parent 只能保留一条层级边。如果先写入 secondary，后面发现 primary，应升级原边。

## 4. LLM 构建准则

Round 1 负责 `Tag -> Concept`：

- 输入 120 个左右 tag 一批。
- 每个 tag 必须至少出现一次。
- 一个 tag 可以有 1-3 个父概念。
- 弱信号 tag 只能边缘化，不能进入核心主干。

Round 2 负责 `Concept -> Topic -> Domain`：

- Topic 不是分类桶，而是可继续展开的概念节点。
- Domain 只做宏观锚点，通常 4-7 个。
- Concept 可以多父挂载到多个 Topic。
- 不允许同名或近同名父子嵌套。

## 5. 运行命令

构建图谱：

```bash
node -e "const { buildTagHierarchy } = require('./server/services/tag-hierarchy'); buildTagHierarchy().then(r=>{console.log(JSON.stringify(r,null,2));}).catch(e=>{console.error(e.stack||e.message); process.exit(1);});"
```

可调环境变量：

```bash
TAG_HIERARCHY_MAX_TAGS=240
TAG_HIERARCHY_CHUNK_SIZE=120
TAG_HIERARCHY_ROUND1_MAX_TOKENS=16384
TAG_HIERARCHY_ROUND2_MAX_TOKENS=16384
```

如果端点容易 JSON 截断，优先调大 max tokens；仍失败时把 chunk size 降到 80 或 60。

## 6. 验收 SQL

最新 run：

```sql
SELECT id, status, selected_tags, unique_tags, node_count, edge_count, metrics
FROM kg_concept_runs
WHERE status = 'completed'
ORDER BY completed_at DESC
LIMIT 1;
```

节点分布：

```sql
SELECT kind, COUNT(*) AS count
FROM kg_concept_nodes
WHERE run_id = ?
GROUP BY kind
ORDER BY kind;
```

边分布：

```sql
SELECT edge_type, COUNT(*) AS count
FROM kg_concept_edges
WHERE run_id = ?
GROUP BY edge_type
ORDER BY edge_type;
```

同名节点告警：

```sql
SELECT kind, label_zh, COUNT(*) AS count
FROM kg_concept_nodes
WHERE run_id = ?
GROUP BY kind, label_zh
HAVING count > 1;
```

重复父边告警：

```sql
SELECT from_node_id, to_node_id, COUNT(*) AS count
FROM kg_concept_edges
WHERE run_id = ?
  AND edge_type IN ('primary_parent', 'secondary_parent', 'contains')
GROUP BY from_node_id, to_node_id
HAVING count > 1;
```

多父 tag 数：

```sql
SELECT COUNT(*) AS multi_parent_tags
FROM (
  SELECT n.id
  FROM kg_concept_nodes n
  JOIN kg_concept_edges e ON e.from_node_id = n.id
  WHERE n.run_id = ?
    AND n.kind = 'tag'
    AND e.edge_type IN ('primary_parent', 'secondary_parent')
  GROUP BY n.id
  HAVING COUNT(*) > 1
);
```

## 7. 失败红线

出现以下情况应判定为坏图谱：

- `unique_tags / selected_tags < 0.85`。
- 同名节点告警非空。
- 重复父边告警非空。
- “推文、社交媒体、用户动态、待确认、非技术内容”等弱信号进入 domain 或核心 topic。
- 大量 tag 只挂到“未归类技术标签”。
- Topic 和 Concept 名称高度重复，导致视觉上父子无信息增益。

## 8. API 验证

```bash
curl -s http://127.0.0.1:3001/api/kg3d -o /tmp/kg3d.json
node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync('/tmp/kg3d.json','utf8')); console.log({nodes:d.nodes.length, edges:d.edges.length, tags:d.nodes.filter(n=>n.type==='tag').length, multi:d.nodes.filter(n=>n.type==='tag'&&n.multiParent).length, runId:d.runId});"
```

最低验收：

- `tags >= 200`
- `multi > 0`
- `runId` 存在
- `edges` 同时包含纵向层级边和横向 `tag_cooccur`

## 9. 后续演进

下一步不要继续加固定层数，而是让 `concept` 节点递归展开：

- `concept -> concept` 表达更细分的技术概念。
- `tag -> concept` 保持多父。
- `related_to` 表达跨领域横向关系。
- UI 可以只显示当前 viewport 附近的子图，而不是一次展开全图。
