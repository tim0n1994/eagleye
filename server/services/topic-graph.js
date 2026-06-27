/**
 * Eagleye — Topic Graph Builder
 *
 * Phase 4: Live topic knowledge graph construction.
 *
 * Daily pipeline:
 *  1. Generate embeddings for items without them
 *  2. Match items to topics using embedding similarity (upgrade from keyword-based)
 *  3. Detect candidate topics from new clusters
 *  4. Update graph edges between items, entities, and topics
 *  5. Update growth scores for all topics
 *
 * Architecture doc §11: Topic Knowledge Graph Generation Algorithm
 */

const { getDB } = require('../db/connection');
const {
  generateEmbedding, cosineSimilarity, centroidOf,
  saveItemEmbedding, getItemEmbedding,
  saveTopicCentroid, getAllTopicCentroids,
  semanticFingerprint,
} = require('./embeddings');
const crypto = require('crypto');

function generateId() {
  return crypto.randomUUID();
}

function toDigestDate(input = new Date()) {
  if (input instanceof Date) {
    return input.toISOString().slice(0, 10).replace(/-/g, '');
  }
  const text = String(input || '').replace(/-/g, '');
  if (/^\d{8}$/.test(text)) return text;
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function digestDateDaysAgo(date, days) {
  const digest = toDigestDate(date);
  const d = new Date(`${digest.slice(0, 4)}-${digest.slice(4, 6)}-${digest.slice(6, 8)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return toDigestDate(d);
}

// ─── Constants ──────────────────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.65;    // Min similarity to assign to a topic
const CANDIDATE_MIN_ITEMS = 5;        // Min items to form a candidate topic
const CANDIDATE_MIN_SOURCES = 2;       // Min distinct sources for a candidate

// ─── Main Pipeline ──────────────────────────────────────────────────────

/**
 * Build/update the topic knowledge graph for a given date.
 * This is the main entry point called by the job system.
 */
async function buildTopicGraph(date, opts = {}) {
  const db = getDB();
  if (!db) {
    console.error('  ❌ No database available for topic graph build.');
    return { status: 'error', message: 'No database' };
  }

  console.log(`  📡 Building topic graph for ${date}...`);

  try {
    const deep = opts.deep === true || process.env.TOPIC_GRAPH_DEEP === 'true';
    if (!deep) {
      console.log('  Fast mode: using LLM topic/entity edges, skipping embeddings.');
      const edgeResult = updateGraphEdges(db, date);
      const growthResult = updateGrowthScores(db, date);
      const result = {
        mode: 'fast',
        embeddings_generated: 0,
        items_matched: 0,
        candidates_detected: 0,
        edges_updated: edgeResult,
        scores_updated: growthResult,
      };
      console.log(`  ✅ Topic graph fast build:`, JSON.stringify(result));
      return result;
    }

    // Step 1: Generate embeddings for items without them
    console.log('  Step 1: Generating embeddings...');
    const embedResult = await generateMissingEmbeddings(db, date);

    // Step 2: Match items to topics using embedding similarity
    console.log('  Step 2: Matching items to topics...');
    const matchResult = await matchItemsToTopics(db, date);

    // Step 3: Detect candidate topics
    console.log('  Step 3: Detecting candidate topics...');
    const candidateResult = detectCandidateTopics(db, date);

    // Step 4: Update graph edges
    console.log('  Step 4: Updating graph edges...');
    const edgeResult = updateGraphEdges(db, date);

    // Step 5: Update growth scores
    console.log('  Step 5: Updating growth scores...');
    const growthResult = updateGrowthScores(db, date);

    const result = {
      embeddings_generated: embedResult,
      items_matched: matchResult,
      candidates_detected: candidateResult,
      edges_updated: edgeResult,
      scores_updated: growthResult,
    };

    console.log(`  ✅ Topic graph built:`, JSON.stringify(result));
    return result;
  } catch (err) {
    console.error(`  ❌ Topic graph build failed:`, err.message);
    return { status: 'error', message: err.message };
  }
}

// ─── Step 1: Generate Embeddings ────────────────────────────────────────

/**
 * Generate embeddings for items that don't have them yet.
 * Uses the semantic fingerprint fallback if no embedding API is available.
 */
async function generateMissingEmbeddings(db, date) {
  const items = db.prepare(`
    SELECT i.id, i.title, i.original_summary, i.content_text
    FROM information_items i
    WHERE i.digest_date <= ? AND i.id NOT IN (SELECT item_id FROM item_vectors WHERE vector_type = 'semantic')
    ORDER BY i.digest_date DESC
    LIMIT 50
  `).all(date);

  return processEmbeddingsBatch(db, items);
}

async function processEmbeddingsBatch(db, items) {
  if (items.length === 0) return 0;

  let generated = 0;
  const hasApi = process.env.ENABLE_REMOTE_EMBEDDINGS === 'true'
    && !!(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);

  for (const item of items) {
    try {
      const text = [
        item.title || '',
        (item.original_summary || '').slice(0, 500),
        (item.content_text || '').slice(0, 500),
      ].join(' ').slice(0, 8000);

      let embedding;

      if (hasApi) {
        embedding = await generateEmbedding(text);
      }

      // Fallback to semantic fingerprint
      if (!embedding) {
        embedding = semanticFingerprint(text);
      }

      if (embedding && embedding.length > 0) {
        saveItemEmbedding(db, item.id, embedding);
        generated++;
      }

      // Rate limiting
      if (hasApi) {
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err) {
      console.error(`  ⚠  Embedding failed for item ${item.id?.slice(0, 8)}:`, err.message);
    }
  }

  console.log(`  📡 Generated ${generated} embeddings`);
  return generated;
}

// ─── Step 2: Match Items to Topics ──────────────────────────────────────

/**
 * Match recent items to topics using embedding similarity.
 * Also runs the keyword-based LLM topic assignment as a complement.
 */
async function matchItemsToTopics(db, date) {
  // Get all topic centroids
  const topicCentroids = getAllTopicCentroids(db);

  // Get recent items (last 7 days) that don't have topic assignments or are newly enriched
  const items = db.prepare(`
    SELECT i.id, i.title
    FROM information_items i
    WHERE i.digest_date >= ? AND i.digest_date <= ?
      AND i.id IN (SELECT item_id FROM item_vectors WHERE vector_type = 'semantic')
    ORDER BY i.score DESC
    LIMIT 100
  `).all(digestDateDaysAgo(date, 7), toDigestDate(date));

  if (items.length === 0 || topicCentroids.length === 0) return 0;

  let matched = 0;

  for (const item of items) {
    // Get item embedding
    const itemEmbedding = getItemEmbedding(db, item.id);
    if (!itemEmbedding) continue;

    // Find best matching topic
    let bestTopic = null;
    let bestScore = 0;

    for (const tc of topicCentroids) {
      const similarity = cosineSimilarity(itemEmbedding, tc.embedding);
      if (similarity > bestScore) {
        bestScore = similarity;
        bestTopic = tc;
      }
    }

    // Assign to topic if above threshold
    if (bestTopic && bestScore >= SIMILARITY_THRESHOLD) {
      const insertTopic = db.prepare(`
        INSERT OR IGNORE INTO item_topics (item_id, topic_id, relevance, assigned_by)
        VALUES (?, ?, ?, 'embedding')
      `);
      insertTopic.run(item.id, bestTopic.id, bestScore);

      // Create graph edge
      const edgeId = generateId();
      const evidenceIds = JSON.stringify([item.id]);
      db.prepare(`
        INSERT OR IGNORE INTO graph_edges (id, from_type, from_id, to_type, to_id, edge_type, weight, evidence_item_ids, first_seen_at, last_seen_at)
        VALUES (?, 'item', ?, 'topic', ?, 'item_belongs_topic', ?, ?, datetime('now'), datetime('now'))
      `).run(edgeId, item.id, bestTopic.id, bestScore, evidenceIds);

      // Update topic last_seen_at
      db.prepare(`UPDATE topics SET last_seen_at = datetime('now') WHERE id = ?`).run(bestTopic.id);

      matched++;
    }
  }

  console.log(`  📡 Matched ${matched} items to topics via embeddings`);
  return matched;
}

// ─── Step 3: Detect Candidate Topics ────────────────────────────────────

/**
 * Detect if new topic clusters have formed.
 * Looks for items that are tightly clustered but don't match existing topics well.
 */
function detectCandidateTopics(db, date) {
  const items = db.prepare(`
    SELECT i.id, i.title, i.source_id, i.digest_date
    FROM information_items i
    WHERE i.id NOT IN (
      SELECT item_id FROM item_topics WHERE assigned_by = 'embedding' AND relevance >= 0.5
    )
    AND i.id IN (SELECT item_id FROM item_vectors WHERE vector_type = 'semantic')
    AND i.digest_date >= ?
    ORDER BY i.score DESC
    LIMIT 50
  `).all(digestDateDaysAgo(date, 14));

  if (items.length < CANDIDATE_MIN_ITEMS) return 0;

  // Simple clustering: group items by embedding similarity
  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < items.length; i++) {
    if (assigned.has(i)) continue;

    const embI = getItemEmbedding(db, items[i].id);
    if (!embI) continue;

    const cluster = [i];
    assigned.add(i);

    for (let j = i + 1; j < items.length; j++) {
      if (assigned.has(j)) continue;

      const embJ = getItemEmbedding(db, items[j].id);
      if (!embJ) continue;

      const similarity = cosineSimilarity(embI, embJ);
      if (similarity >= 0.75) {
        cluster.push(j);
        assigned.add(j);
      }
    }

    if (cluster.length >= CANDIDATE_MIN_ITEMS) {
      clusters.push(cluster);
    }
  }

  // Evaluate clusters as candidate topics
  let candidatesCreated = 0;

  for (const cluster of clusters) {
    const clusterItems = cluster.map(i => items[i]);

    // Check source diversity
    const sources = new Set(clusterItems.map(it => it.source_id));
    if (sources.size < CANDIDATE_MIN_SOURCES) continue;

    // Extract common words for a topic name
    const titleWords = clusterItems.map(it => it.title || '').join(' ');
    const wordCounts = {};
    const words = titleWords.toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3 && !['this','that','with','from','have','been','what','which','their','about','would','could','should','https','http','the','and','for','are','not','was','but','you','all','can','has','its','new','how','use'].includes(w));

    for (const word of words) {
      wordCounts[word] = (wordCounts[word] || 0) + 1;
    }

    const topWords = Object.entries(wordCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);

    if (topWords.length < 2) continue;

    const candidateName = topWords.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' / ');
    const candidateSlug = topWords.slice(0, 3).join('-').toLowerCase()
      .replace(/[^a-z0-9-]/g, '');

    if (!candidateSlug || candidateSlug.length < 3) continue;

    // Check if this candidate already exists as a topic
    const existing = db.prepare('SELECT id FROM topics WHERE slug = ?').get(candidateSlug);
    if (existing) {
      // Update existing topic's growth score instead
      db.prepare(`UPDATE topics SET growth_score = growth_score + 0.1, last_seen_at = datetime('now') WHERE id = ?`).run(existing.id);
      continue;
    }

    // Create the candidate topic
    const topicId = generateId();
    const description = `Auto-generated topic from clustering ${clusterItems.length} items across ${sources.size} sources. Keywords: ${topWords.join(', ')}.`;

    db.prepare(`
      INSERT INTO topics (id, slug, name, description, status, auto_generated, confidence, first_seen_at, last_seen_at, growth_score)
      VALUES (?, ?, ?, ?, 'active', 1, ?, datetime('now'), datetime('now'), ?)
    `).run(topicId, candidateSlug, candidateName.slice(0, 100), description, 0.6, 0.5);

    // Compute centroid and save
    const embeddings = clusterItems.map(it => getItemEmbedding(db, it.id)).filter(Boolean);
    if (embeddings.length >= CANDIDATE_MIN_ITEMS) {
      const centroid = centroidOf(embeddings);
      if (centroid) {
        saveTopicCentroid(db, topicId, centroid);
      }
    }

    // Assign cluster items to the new topic
    for (const item of clusterItems) {
      db.prepare(`
        INSERT OR IGNORE INTO item_topics (item_id, topic_id, relevance, assigned_by)
        VALUES (?, ?, ?, 'auto-cluster')
      `).run(item.id, topicId, 0.9);

      const edgeId = generateId();
      db.prepare(`
        INSERT OR IGNORE INTO graph_edges (id, from_type, from_id, to_type, to_id, edge_type, weight, evidence_item_ids, first_seen_at, last_seen_at)
        VALUES (?, 'item', ?, 'topic', ?, 'item_belongs_topic', 0.9, ?, datetime('now'), datetime('now'))
      `).run(edgeId, item.id, topicId, JSON.stringify([item.id]));
    }

    candidatesCreated++;
    console.log(`  📡 Created candidate topic: ${candidateName} (${clusterItems.length} items, ${sources.size} sources)`);
  }

  return candidatesCreated;
}

// ─── Step 4: Update Graph Edges ──────────────────────────────────────────

/**
 * Update graph edges between entities, items, and topics.
 * Creates entity co-occurrence edges and topic relationship edges.
 */
function updateGraphEdges(db, _date) {
  let edgeCount = 0;

  // 4a: Entity co-occurrence edges
  // If two entities frequently appear in the same items, create entity_related_entity edges
  const entityPairs = db.prepare(`
    SELECT e1.id as entity1_id, e2.id as entity2_id, COUNT(*) as co_occurrences
    FROM graph_edges e1
    JOIN graph_edges e2 ON e1.from_id = e2.from_id AND e1.from_type = 'item' AND e2.from_type = 'item'
    WHERE e1.edge_type = 'item_mentions_entity'
      AND e2.edge_type = 'item_mentions_entity'
      AND e1.to_id < e2.to_id
    GROUP BY e1.to_id, e2.to_id
    HAVING co_occurrences >= 2
  `).all();

  for (const pair of entityPairs) {
    const existing = db.prepare(`
      SELECT id FROM graph_edges 
      WHERE from_type = 'entity' AND from_id = ? AND to_type = 'entity' AND to_id = ? AND edge_type = 'entity_related_entity'
    `).get(pair.entity1_id, pair.entity2_id);

    if (!existing) {
      const edgeId = generateId();
      db.prepare(`
        INSERT INTO graph_edges (id, from_type, from_id, to_type, to_id, edge_type, weight, evidence_item_ids, first_seen_at, last_seen_at)
        VALUES (?, 'entity', ?, 'entity', ?, 'entity_related_entity', ?, ?, datetime('now'), datetime('now'))
      `).run(edgeId, pair.entity1_id, pair.entity2_id, Math.min(pair.co_occurrences / 10, 1), '[]');
      edgeCount++;
    }
  }

  // 4b: Topic relationship edges (topic_related_topic)
  // Topics that share many items are related
  const topicPairs = db.prepare(`
    SELECT t1.topic_id as topic1_id, t2.topic_id as topic2_id, COUNT(*) as shared_items
    FROM item_topics t1
    JOIN item_topics t2 ON t1.item_id = t2.item_id AND t1.topic_id < t2.topic_id
    GROUP BY t1.topic_id, t2.topic_id
    HAVING shared_items >= 2
  `).all();

  for (const pair of topicPairs) {
    const existing = db.prepare(`
      SELECT id FROM graph_edges 
      WHERE from_type = 'topic' AND from_id = ? AND to_type = 'topic' AND to_id = ? AND edge_type = 'topic_related_topic'
    `).get(pair.topic1_id, pair.topic2_id);

    if (!existing) {
      const edgeId = generateId();
      db.prepare(`
        INSERT INTO graph_edges (id, from_type, from_id, to_type, to_id, edge_type, weight, evidence_item_ids, first_seen_at, last_seen_at)
        VALUES (?, 'topic', ?, 'topic', ?, 'topic_related_topic', ?, ?, datetime('now'), datetime('now'))
      `).run(edgeId, pair.topic1_id, pair.topic2_id, Math.min(pair.shared_items / 5, 1), '[]');
      edgeCount++;
    }
  }

  console.log(`  📡 Created/updated ${edgeCount} graph edges`);
  return edgeCount;
}

// ─── Step 5: Update Growth Scores ───────────────────────────────────────

/**
 * Update growth scores for all active topics.
 * Formula from architecture doc §11.3:
 *   growth_score = log(1 + items_last_7d) * 0.30
 *                + source_diversity_score * 0.20
 *                + average_item_score * 0.20
 *                + new_entity_count_last_7d * 0.15
 *                + graph_degree_delta * 0.15
 */
function updateGrowthScores(db, date = new Date()) {
  const v1Topics = db.prepare('SELECT id, slug, name FROM topics WHERE status = ?').all('active');
  const v2Topics = db.prepare("SELECT id, slug, name FROM dynamic_topics WHERE status != 'inactive'").all();
  const allInfo = [...v1Topics.map(t => ({ ...t, isV2: false })), ...v2Topics.map(t => ({ ...t, isV2: true }))];
  let updated = 0;

  for (const topic of allInfo) {
    const topicId = topic.id;
    const tableName = topic.isV2 ? 'item_topic_assignments' : 'item_topics';

    const items7d = db.prepare(`
      SELECT COUNT(*) as count, 
        AVG(i.score) as avg_score,
        COUNT(DISTINCT i.source_id) as source_count
      FROM ${tableName} it
      JOIN information_items i ON it.item_id = i.id
      WHERE it.topic_id = ? AND i.digest_date >= ?
    `).get(topicId, digestDateDaysAgo(date, 7));

    const itemCount = items7d?.count || 0;
    const avgScore = items7d?.avg_score || 0;
    const sourceCount = items7d?.source_count || 0;

    // Graph degree (number of edges)
    const degree = db.prepare(`
      SELECT COUNT(*) as count FROM graph_edges 
      WHERE (from_type = 'topic' AND from_id = ?) OR (to_type = 'topic' AND to_id = ?)
    `).get(topic.id, topic.id);

    const graphDegree = degree?.count || 0;

    // Compute growth score
    const growthScore = 
      Math.log(1 + itemCount) * 0.30 +
      Math.min(sourceCount / 10, 1) * 0.20 +
      Math.min(avgScore, 1) * 0.20 +
      Math.min(graphDegree / 20, 1) * 0.15 +
      0.10;

    const score = Math.round(growthScore * 100) / 100;
    if (topic.isV2) {
      db.prepare(`UPDATE dynamic_topics SET growth_score = ? WHERE id = ?`).run(score, topicId);
    } else {
      db.prepare(`UPDATE topics SET growth_score = ? WHERE id = ?`).run(score, topicId);
    }

    updated++;
  }

  console.log(`  📡 Updated growth scores for ${updated} topics (v1: ${v1Topics.length}, v2: ${v2Topics.length})`);
  return updated;
}

// ─── Topic Timeline Data ────────────────────────────────────────────────

/**
 * Get timeline data for a topic: item counts per day/week for the last 90 days.
 */
function getTopicTimeline(topicId, granularity = 'day') {
  const db = getDB();
  if (!db) return [];

  let groupBy;
  if (granularity === 'week') {
    groupBy = "substr(i.digest_date, 1, 4) || '-W' || printf('%02d', ((CAST(substr(i.digest_date, 5, 2) AS INTEGER) * 31 + CAST(substr(i.digest_date, 7, 2) AS INTEGER)) / 7))";
  } else if (granularity === 'month') {
    groupBy = "substr(i.digest_date, 1, 6)";
  } else {
    groupBy = 'i.digest_date';
  }

  const data = db.prepare(`
    SELECT ${groupBy} as period,
      COUNT(*) as item_count,
      COUNT(DISTINCT i.source_id) as source_count,
      AVG(i.score) as avg_score,
      AVG(it.relevance) as avg_relevance
    FROM item_topics it
    JOIN information_items i ON it.item_id = i.id
    WHERE it.topic_id = ? AND i.digest_date >= ?
    GROUP BY period
    ORDER BY period ASC
  `).all(topicId, digestDateDaysAgo(new Date(), 90));

  return data;
}

/**
 * Get the graph neighborhood for a topic (one-hop edges).
 */
function getTopicGraphNeighborhood(topicId) {
  const db = getDB();
  if (!db) return { nodes: [], edges: [] };

  const edges = db.prepare(`
    SELECT * FROM graph_edges 
    WHERE (from_type = 'topic' AND from_id = ?) 
       OR (to_type = 'topic' AND to_id = ?)
       OR (edge_type = 'topic_related_topic' AND (from_id = ? OR to_id = ?))
    ORDER BY weight DESC
    LIMIT 100
  `).all(topicId, topicId, topicId, topicId);

  // Collect all node IDs referenced
  const nodeIds = new Set();
  for (const edge of edges) {
    nodeIds.add(`${edge.from_type}:${edge.from_id}`);
    nodeIds.add(`${edge.to_type}:${edge.to_id}`);
  }

  // Fetch node details
  const nodes = [];
  for (const nodeKey of nodeIds) {
    const [type, id] = nodeKey.split(':');
    if (type === 'topic') {
      const topic = db.prepare('SELECT id, name as label, slug, description, growth_score FROM topics WHERE id = ?').get(id);
      if (topic) nodes.push({ ...topic, type: 'topic' });
    } else if (type === 'entity') {
      const entity = db.prepare('SELECT id, name as label, type as entity_type FROM entities WHERE id = ?').get(id);
      if (entity) nodes.push({ ...entity, type: 'entity' });
    } else if (type === 'item') {
      const item = db.prepare('SELECT id, title as label, canonical_url FROM information_items WHERE id = ?').get(id);
      if (item) nodes.push({ ...item, type: 'item' });
    } else if (type === 'tag') {
      const tag = db.prepare('SELECT id, name as label, type as tag_type FROM tags WHERE id = ?').get(id);
      if (tag) nodes.push({ ...tag, type: 'tag' });
    }
  }

  return { nodes, edges };
}

/**
 * Get entity relationships for full knowledge graph visualization.
 */
function getFullGraph() {
  const db = getDB();
  if (!db) return { nodes: [], edges: [] };

  // Topics as primary nodes
  const topics = db.prepare(`
    SELECT id, name as label, slug, 'topic' as type, growth_score as weight, 
      (SELECT COUNT(*) FROM item_topics WHERE topic_id = id) as item_count
    FROM topics WHERE status = 'active' ORDER BY growth_score DESC LIMIT 30
  `).all();

  // Top entities as secondary nodes
  const entities = db.prepare(`
    SELECT e.id, e.name as label, 'entity' as type, 
      (SELECT COUNT(*) FROM graph_edges WHERE to_type = 'entity' AND to_id = e.id) as weight
    FROM entities e 
    ORDER BY weight DESC LIMIT 50
  `).all();

  // Graph edges
  const edges = db.prepare(`
    SELECT * FROM graph_edges ORDER BY weight DESC LIMIT 200
  `).all();

  return { nodes: [...topics, ...entities], edges };
}

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

module.exports = {
  buildTopicGraph,
  getTopicTimeline,
  getTopicGraphNeighborhood,
  getFullGraph,
  getKG3DData,
};
