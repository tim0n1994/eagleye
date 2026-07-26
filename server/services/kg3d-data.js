/**
 * Eagleye — KG3D data builders
 *
 * Shapes the knowledge graph for the 3D viewer in three modes: concept layer,
 * flat tag graph and the domain/topic/sub-topic hierarchy. Read-only; the graph
 * itself is built by topic-graph.js.
 */

const { getDB } = require('../db/connection');

function getKG3DData(dbOverride) {
  const db = dbOverride || getDB();
  if (!db) return { nodes: [], edges: [], tagItems: {} };

  let hasConceptGraph = false;
  try {
    hasConceptGraph = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM kg_concept_runs r
      JOIN kg_concept_nodes n ON n.run_id = r.id
      WHERE r.status = 'completed'
    `).get().cnt > 0;
  } catch { /* concept graph tables not migrated yet */ }

  if (hasConceptGraph) {
    return getKG3DConceptData(db);
  }

  // Check if tag_hierarchy table exists and has data
  let hasHierarchy = false;
  try {
    hasHierarchy = db.prepare('SELECT COUNT(*) as cnt FROM tag_hierarchy').get().cnt > 0;
  } catch { /* table doesn't exist yet */ }

  if (hasHierarchy) {
    return getKG3DHierarchyData(db);
  }
  return getKG3DFlatData(db);
}

// ── Unified concept graph mode ──────────────────────────────

function getKG3DConceptData(db) {
  const run = db.prepare(`
    SELECT id FROM kg_concept_runs
    WHERE status = 'completed'
    ORDER BY completed_at DESC, created_at DESC
    LIMIT 1
  `).get();
  if (!run?.id) return getKG3DFlatData(db);

  const conceptRows = db.prepare(`
    SELECT n.*,
      CASE WHEN n.kind = 'tag' THEN (
        SELECT COUNT(*) FROM item_tags it WHERE it.tag_id = n.source_tag_id
      ) ELSE 0 END as item_count
    FROM kg_concept_nodes n
    WHERE n.run_id = ? AND n.status = 'active'
  `).all(run.id);

  const nodes = [];
  const conceptIdToNodeId = new Map();
  const tagItems = {};

  for (const row of conceptRows) {
    const nodeId = `concept:${row.id}`;
    conceptIdToNodeId.set(row.id, nodeId);
    const type = row.kind === 'concept' ? 'subtopic' : row.kind;
    nodes.push({
      id: nodeId,
      label: row.label_zh || row.label,
      labelZh: row.label_zh || row.label,
      type,
      conceptKind: row.kind,
      slug: row.slug,
      description: row.description_zh || '',
      itemCount: row.kind === 'tag' ? row.item_count || 0 : undefined,
      sourceTagId: row.source_tag_id || undefined,
    });
  }

  const edges = [];
  const edgeRows = db.prepare(`
    SELECT e.*, fn.kind as from_kind, tn.kind as to_kind
    FROM kg_concept_edges e
    JOIN kg_concept_nodes fn ON fn.id = e.from_node_id
    JOIN kg_concept_nodes tn ON tn.id = e.to_node_id
    WHERE e.run_id = ?
  `).all(run.id);

  const parentIdsByTagNode = new Map();
  for (const edge of edgeRows) {
    const source = conceptIdToNodeId.get(edge.from_node_id);
    const target = conceptIdToNodeId.get(edge.to_node_id);
    if (!source || !target) continue;

    let type = edge.edge_type;
    if (edge.from_kind === 'topic' && edge.to_kind === 'domain') type = 'topic_belongs_domain';
    else if (edge.from_kind === 'concept') type = 'subtopic_belongs_topic';
    else if (edge.from_kind === 'tag') {
      type = edge.confidence < 0.5 ? 'tag_weak_signal_subtopic' : 'tag_belongs_subtopic';
      if (!parentIdsByTagNode.has(source)) parentIdsByTagNode.set(source, []);
      parentIdsByTagNode.get(source).push(target);
    }

    edges.push({
      source,
      target,
      type,
      weight: edge.weight || 0.5,
      relationshipType: edge.edge_type,
      rationaleZh: edge.rationale_zh || '',
      isPrimary: edge.is_primary === 1,
    });
  }

  for (const node of nodes) {
    if (node.type !== 'tag') continue;
    const parentIds = parentIdsByTagNode.get(node.id) || [];
    node.parentIds = parentIds;
    node.parentId = parentIds[0];
    node.multiParent = parentIds.length > 1;
    if (!node.sourceTagId) continue;
    const items = db.prepare(`
      SELECT ii.id, ii.title, ii.title_zh, ii.canonical_url, s.label as source_label
      FROM information_items ii
      JOIN item_tags it ON it.item_id = ii.id
      LEFT JOIN sources s ON s.id = ii.source_id
      WHERE it.tag_id = ?
      ORDER BY ii.published_at DESC
      LIMIT 30
    `).all(node.sourceTagId);
    tagItems[node.id] = items.map(i => ({
      id: i.id,
      title: i.title_zh || i.title || '',
      url: i.canonical_url || '',
      sourceLabel: i.source_label || '',
    }));
  }

  const tagNodes = nodes.filter(n => n.type === 'tag' && n.sourceTagId);
  for (let i = 0; i < tagNodes.length; i++) {
    for (let j = i + 1; j < tagNodes.length; j++) {
      const a = tagNodes[i], b = tagNodes[j];
      const shared = db.prepare('SELECT COUNT(*) as cnt FROM (SELECT it1.item_id FROM item_tags it1 WHERE it1.tag_id=? INTERSECT SELECT it2.item_id FROM item_tags it2 WHERE it2.tag_id=?)').get(a.sourceTagId, b.sourceTagId);
      if (shared && shared.cnt >= 3) {
        edges.push({ source: a.id, target: b.id, type: 'tag_cooccur', weight: shared.cnt, relationshipType: 'co_occurs' });
      }
    }
  }

  return { nodes, edges, tagItems, runId: run.id };
}

// ── Flat mode (fallback: topics + tags) ────────────────────

function getKG3DFlatData(db) {
  const allNodes = [];
  const allEdges = [];
  const tagItems = {};
  const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

  const topicRows = db.prepare(`
    SELECT t.id, t.slug, t.name, COALESCE(t.name_zh, t.name) as name_zh,
           t.growth_score, t.parent_topic_id,
           (SELECT COUNT(*) FROM item_topics WHERE topic_id = t.id) as item_count
    FROM topics t WHERE t.status = 'active' ORDER BY t.growth_score DESC LIMIT 20
  `).all();

  const topicIds = new Set();
  for (const t of topicRows) {
    const nodeId = 'topic:' + t.id;
    topicIds.add(t.id);
    allNodes.push({
      id: nodeId, label: t.name, labelZh: t.name_zh || t.name,
      type: 'topic', growthScore: t.growth_score || 0,
      itemCount: t.item_count || 0, slug: t.slug,
    });
  }

  const tagRows = db.prepare(`
    SELECT t.id, t.slug, t.name as label, COUNT(it.item_id) as item_count
    FROM tags t JOIN item_tags it ON it.tag_id = t.id
    WHERE t.type IN ('llm-extracted', 'general') GROUP BY t.id ORDER BY item_count DESC
  `).all();

  const tags = tagRows.filter(t => CJK_RE.test(t.label)).slice(0, 30);

  for (const tag of tags) {
    const tagNodeId = 'tag:' + tag.id;
    allNodes.push({ id: tagNodeId, label: tag.label, labelZh: tag.label, type: 'tag', itemCount: tag.item_count });

    const items = db.prepare(`
      SELECT ii.id, ii.title, ii.title_zh, ii.canonical_url, s.label as source_label
      FROM information_items ii JOIN item_tags it ON it.item_id = ii.id
      LEFT JOIN sources s ON s.id = ii.source_id
      WHERE it.tag_id = ? ORDER BY ii.published_at DESC LIMIT 30
    `).all(tag.id);
    tagItems[tagNodeId] = items.map(i => ({
      id: i.id, title: i.title_zh || i.title || '', url: i.canonical_url || '', sourceLabel: i.source_label || '',
    }));
  }

  // tag_belongs_topic edges
  const tagTopicLinks = db.prepare(`
    SELECT ipt.topic_id, it.tag_id, COUNT(*) as shared_items
    FROM item_tags it JOIN item_topics ipt ON ipt.item_id = it.item_id
    JOIN topics t ON t.id = ipt.topic_id WHERE t.status = 'active'
    GROUP BY ipt.topic_id, it.tag_id HAVING shared_items >= 3 ORDER BY shared_items DESC
  `).all();

  const includedTagIds = new Set(tags.map(t => t.id));
  for (const row of tagTopicLinks) {
    if (!includedTagIds.has(row.tag_id) || !topicIds.has(row.topic_id)) continue;
    allEdges.push({ source: 'tag:' + row.tag_id, target: 'topic:' + row.topic_id, type: 'tag_belongs_topic', weight: Math.min(1, row.shared_items / 20) });
  }

  // tag_cooccur edges
  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) {
      const shared = db.prepare('SELECT COUNT(*) as cnt FROM (SELECT it1.item_id FROM item_tags it1 WHERE it1.tag_id=? INTERSECT SELECT it2.item_id FROM item_tags it2 WHERE it2.tag_id=?)').get(tags[i].id, tags[j].id);
      if (shared && shared.cnt >= 2) allEdges.push({ source: 'tag:' + tags[i].id, target: 'tag:' + tags[j].id, type: 'tag_cooccur', weight: shared.cnt });
    }
  }

  // topic_related_topic edges
  const topicEdges = db.prepare("SELECT from_id, to_id, weight FROM graph_edges WHERE edge_type='topic_related_topic' LIMIT 100").all();
  for (const e of topicEdges) {
    if (topicIds.has(e.from_id) && topicIds.has(e.to_id)) {
      allEdges.push({ source: 'topic:' + e.from_id, target: 'topic:' + e.to_id, type: 'topic_related_topic', weight: e.weight || 0.5 });
    }
  }

  return { nodes: allNodes, edges: allEdges, tagItems };
}

// ── 4-level hierarchy mode ──────────────────────────────────

function getKG3DHierarchyData(db) {
  const allNodes = [];
  const allEdges = [];
  const tagItems = {};

  // L1: Domains
  const domains = db.prepare('SELECT * FROM knowledge_domains ORDER BY display_order').all();
  const domainIds = new Set();
  for (const d of domains) {
    domainIds.add(d.id);
    allNodes.push({ id: 'domain:' + d.id, label: d.name_zh, labelZh: d.name_zh, type: 'domain', description: d.description_zh || '' });
  }

  // L2: Topics (level=1 in tag_hierarchy)
  const topics = db.prepare(`
    SELECT th.*, d.name_zh as domain_name
    FROM tag_hierarchy th JOIN knowledge_domains d ON th.domain_id = d.id
    WHERE th.level = 1 ORDER BY d.display_order, th.topic_name_zh
  `).all();

  const topicIds = new Set();
  for (const t of topics) {
    if (!domainIds.has(t.domain_id)) continue;
    topicIds.add(t.id);
    allNodes.push({
      id: 'topic:' + t.id, label: t.topic_name_zh, labelZh: t.topic_name_zh,
      type: 'topic', domainId: t.domain_id,
    });
    allEdges.push({ source: 'topic:' + t.id, target: 'domain:' + t.domain_id, type: 'topic_belongs_domain', weight: 0.9 });
  }

  // L3: SubTopics (level=2)
  const subTopics = db.prepare(`
    SELECT th.* FROM tag_hierarchy th WHERE th.level = 2 ORDER BY th.topic_name_zh
  `).all();

  const subTopicIds = new Set();
  for (const st of subTopics) {
    if (!st.parent_node_id || !topicIds.has(st.parent_node_id)) continue;
    subTopicIds.add(st.id);
    allNodes.push({
      id: 'subtopic:' + st.id, label: st.topic_name_zh, labelZh: st.topic_name_zh,
      type: 'subtopic', domainId: st.domain_id, parentId: 'topic:' + st.parent_node_id,
    });
    allEdges.push({ source: 'subtopic:' + st.id, target: 'topic:' + st.parent_node_id, type: 'subtopic_belongs_topic', weight: 0.85 });
  }

  // L4: Tags (level=3). In DAG mode a tag can have multiple parent concepts,
  // so de-duplicate nodes but keep every parent edge.
  const tagNodes = db.prepare(`
    SELECT th.*, t.name as tag_name, COUNT(it.item_id) as item_count
    FROM tag_hierarchy th
    JOIN tags t ON th.tag_id = t.id
    LEFT JOIN item_tags it ON it.tag_id = t.id
    WHERE th.level = 3
    GROUP BY th.id
  `).all();

  const includedTagNodeIds = new Set();
  for (const tn of tagNodes) {
    if (!tn.parent_node_id || !subTopicIds.has(tn.parent_node_id)) continue;
    const tagNodeId = 'tag:' + tn.tag_id;
    if (!includedTagNodeIds.has(tagNodeId)) {
      includedTagNodeIds.add(tagNodeId);
      const parentIds = tagNodes
        .filter(row => row.tag_id === tn.tag_id && row.parent_node_id && subTopicIds.has(row.parent_node_id))
        .map(row => 'subtopic:' + row.parent_node_id);
      allNodes.push({
        id: tagNodeId,
        label: tn.tag_name,
        labelZh: tn.tag_name,
        type: 'tag',
        itemCount: tn.item_count || 0,
        parentId: parentIds[0],
        parentIds,
        multiParent: parentIds.length > 1,
      });
    }
    allEdges.push({
      source: tagNodeId,
      target: 'subtopic:' + tn.parent_node_id,
      type: tn.relationship_type === 'weak_signal' ? 'tag_weak_signal_subtopic' : 'tag_belongs_subtopic',
      weight: tn.relationship_type === 'weak_signal' ? 0.25 : 0.8,
      relationshipType: tn.relationship_type || 'belongs_to',
      rationaleZh: tn.rationale_zh || '',
    });

    // Fetch items for this tag
    if (!tagItems[tagNodeId]) {
      const items = db.prepare(`
        SELECT ii.id, ii.title, ii.title_zh, ii.canonical_url, s.label as source_label
        FROM information_items ii JOIN item_tags it ON it.item_id = ii.id
        LEFT JOIN sources s ON s.id = ii.source_id
        WHERE it.tag_id = ? ORDER BY ii.published_at DESC LIMIT 30
      `).all(tn.tag_id);
      tagItems[tagNodeId] = items.map(i => ({
        id: i.id, title: i.title_zh || i.title || '', url: i.canonical_url || '', sourceLabel: i.source_label || '',
      }));
    }
  }

  // tag_cooccur cross-links
  const tagNodesArr = [];
  const seenCooccurTagIds = new Set();
  for (const tn of tagNodes) {
    if (!subTopicIds.has(tn.parent_node_id) || seenCooccurTagIds.has(tn.tag_id)) continue;
    seenCooccurTagIds.add(tn.tag_id);
    tagNodesArr.push(tn);
  }
  for (let i = 0; i < tagNodesArr.length; i++) {
    for (let j = i + 1; j < tagNodesArr.length; j++) {
      const a = tagNodesArr[i], b = tagNodesArr[j];
      if (a.parent_node_id === b.parent_node_id) continue; // same subtopic, already connected
      const shared = db.prepare('SELECT COUNT(*) as cnt FROM (SELECT it1.item_id FROM item_tags it1 WHERE it1.tag_id=? INTERSECT SELECT it2.item_id FROM item_tags it2 WHERE it2.tag_id=?)').get(a.tag_id, b.tag_id);
      if (shared && shared.cnt >= 3) {
        allEdges.push({ source: 'tag:' + a.tag_id, target: 'tag:' + b.tag_id, type: 'tag_cooccur', weight: shared.cnt });
      }
    }
  }

  return { nodes: allNodes, edges: allEdges, tagItems };
}

module.exports = { getKG3DData };
