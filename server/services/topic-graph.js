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
const { getKG3DData } = require('./kg3d-data');
const {
  generateEmbedding, cosineSimilarity, centroidOf,
  saveItemEmbedding, getItemEmbedding,
  saveTopicCentroid, getAllTopicCentroids,
  semanticFingerprint,
} = require('./embeddings');
const crypto = require('crypto');
const { normalizeDigestDate, todayDigestDate } = require('./date-contract');

function generateId() {
  return crypto.randomUUID();
}

// R0 date contract: digest_date comparisons use canonical YYYY-MM-DD anchors.
// Dates follow the local calendar (the writer's timezone basis); strings accept
// both canonical and legacy compact forms and normalize to canonical.
function toDigestDate(input = new Date()) {
  if (input instanceof Date) return todayDigestDate(input);
  return normalizeDigestDate(String(input || '')) || todayDigestDate();
}

function digestDateDaysAgo(date, days) {
  const digest = toDigestDate(date);
  const [y, m, d] = digest.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
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

  date = toDigestDate(date); // R0: canonical digest_date anchor for every comparison.
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
    SELECT e1.to_id as entity1_id, e2.to_id as entity2_id, COUNT(*) as co_occurrences
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
    groupBy = "substr(i.digest_date, 1, 4) || '-W' || printf('%02d', ((CAST(substr(i.digest_date, 6, 2) AS INTEGER) * 31 + CAST(substr(i.digest_date, 9, 2) AS INTEGER)) / 7))";
  } else if (granularity === 'month') {
    groupBy = "substr(i.digest_date, 1, 7)";
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

module.exports = {
  buildTopicGraph,
  getTopicTimeline,
  getTopicGraphNeighborhood,
  getFullGraph,
  getKG3DData,
};
