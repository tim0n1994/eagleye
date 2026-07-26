/**
 * Eagleye — Graph routes
 *
 * Knowledge-graph reads: legacy graph, KG v2, full graph, 3D view and KG metrics.
 * Split out of api.js; handlers are unchanged.
 */

const { getDB } = require('../db/connection');
const { getFullGraph, getKG3DData } = require('../services/topic-graph');
const { sendJSON, sendError } = require('./_shared');

function register(routes) {

  // --- Graph API ---
  routes['/api/graph'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    // Get entities (legacy)
    const entities = db.prepare('SELECT * FROM entities').all();
    
    // Get links from item_entities (legacy)
    const links = db.prepare(`
      SELECT ie.entity_id as source, ie.item_id as target, i.title, i.category
      FROM item_entities ie
      JOIN items i ON ie.item_id = i.id
    `).all();

    // Build entity co-occurrence links
    const entityLinks = [];
    const itemToEntities = {};
    links.forEach(l => {
      if (!itemToEntities[l.target]) itemToEntities[l.target] = [];
      itemToEntities[l.target].push(l.source);
    });
    
    Object.values(itemToEntities).forEach(ents => {
      for (let i = 0; i < ents.length; i++) {
        for (let j = i + 1; j < ents.length; j++) {
          entityLinks.push({ source: ents[i], target: ents[j] });
        }
      }
    });

    // New graph data
    const topics = db.prepare('SELECT id, name as title FROM topics LIMIT 20').all();
    const graphEdges = db.prepare('SELECT * FROM graph_edges ORDER BY weight DESC LIMIT 100').all();

    sendJSON(res, 200, { 
      status: 'ok', 
      nodes: entities, 
      links: entityLinks,
      topics,
      graph_edges: graphEdges,
    });
  };

  // --- Graph V2 API (new knowledge graph) ---
  routes['/api/graph/v2'] = (req, res, parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const topicId = parsed.query.topic_id;
    
    let nodes;
    let edges;

    if (topicId) {
      // Get neighborhood for a specific topic
      nodes = db.prepare(`
        SELECT id, name as label, 'topic' as type, status FROM topics WHERE id = ? OR parent_topic_id = ?
      `).all(topicId, topicId);
      
      edges = db.prepare(`
        SELECT * FROM graph_edges 
        WHERE (from_type = 'topic' AND from_id = ?) OR (to_type = 'topic' AND to_id = ?)
        LIMIT 100
      `).all(topicId, topicId);
    } else {
      // Get all topics as nodes
      const topics = db.prepare('SELECT id, name as label, \'topic\' as type, status FROM topics LIMIT 50').all();
      const tags = db.prepare('SELECT id, name as label, \'tag\' as type FROM tags LIMIT 50').all();
      nodes = [...topics, ...tags];
      edges = db.prepare('SELECT * FROM graph_edges ORDER BY weight DESC LIMIT 200').all();
    }

    sendJSON(res, 200, { status: 'ok', nodes, edges });
  };

  // --- KG v2 Metrics API ---
  routes['/api/kg/metrics'] = (_req, res) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const count = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    const coverageBySource = db.prepare(`
      SELECT s.slug,
             COALESCE(s.label_zh, s.label) AS label,
             COUNT(i.id) AS items,
             SUM(CASE WHEN f.item_id IS NOT NULL THEN 1 ELSE 0 END) AS with_features,
             SUM(CASE WHEN tags.item_id IS NOT NULL THEN 1 ELSE 0 END) AS with_tags,
             SUM(CASE WHEN topics.item_id IS NOT NULL THEN 1 ELSE 0 END) AS with_topics,
             SUM(CASE WHEN mentions.item_id IS NOT NULL THEN 1 ELSE 0 END) AS with_entities,
             SUM(CASE WHEN vectors.item_id IS NOT NULL THEN 1 ELSE 0 END) AS with_vectors
      FROM sources s
      LEFT JOIN information_items i ON i.source_id = s.id
      LEFT JOIN item_features f ON f.item_id = i.id
      LEFT JOIN (SELECT DISTINCT item_id FROM item_tag_assignments) tags ON tags.item_id = i.id
      LEFT JOIN (SELECT DISTINCT item_id FROM item_topic_assignments) topics ON topics.item_id = i.id
      LEFT JOIN (SELECT DISTINCT item_id FROM entity_mentions) mentions ON mentions.item_id = i.id
      LEFT JOIN (SELECT DISTINCT item_id FROM item_vectors) vectors ON vectors.item_id = i.id
      GROUP BY s.slug
      ORDER BY CASE s.slug
        WHEN 'x-following' THEN 0
        WHEN 'hacker-news' THEN 1
        WHEN 'github-trending' THEN 2
        WHEN 'hugging-face' THEN 3
        WHEN 'product-hunt' THEN 4
        ELSE 99
      END, s.slug
    `).all().map(row => {
      const items = Number(row.items || 0);
      const pct = (value) => items ? Math.round((Number(value || 0) / items) * 1000) / 10 : 0;
      return {
        ...row,
        feature_coverage_pct: pct(row.with_features),
        tag_coverage_pct: pct(row.with_tags),
        topic_coverage_pct: pct(row.with_topics),
        entity_coverage_pct: pct(row.with_entities),
        vector_coverage_pct: pct(row.with_vectors),
      };
    });

    const recentRuns = db.prepare(`
      SELECT id, scope, scope_value, status, extractor_version, metrics, error, created_at, completed_at
      FROM kg_extraction_runs
      ORDER BY created_at DESC
      LIMIT 10
    `).all().map(row => {
      try { row.metrics = JSON.parse(row.metrics || '{}'); } catch {}
      return row;
    });

    const vectorModels = db.prepare(`
      SELECT vector_type, model_name, dimension, COUNT(*) AS items
      FROM item_vectors
      GROUP BY vector_type, model_name, dimension
      ORDER BY items DESC, vector_type, model_name
    `).all();

    sendJSON(res, 200, {
      status: 'ok',
      tables: {
        information_items: count('information_items'),
        topic_taxonomy: count('topic_taxonomy'),
        dynamic_topics: count('dynamic_topics'),
        item_features: count('item_features'),
        kg_tags: count('kg_tags'),
        item_tag_assignments: count('item_tag_assignments'),
        entity_mentions: count('entity_mentions'),
        canonical_entities: count('canonical_entities'),
        item_topic_assignments: count('item_topic_assignments'),
        item_vectors: count('item_vectors'),
        kg_edges: count('kg_edges'),
      },
      coverage_by_source: coverageBySource,
      vector_models: vectorModels,
      recent_runs: recentRuns,
    });
  };

  // --- Full Knowledge Graph API ---
  routes['/api/graph/full'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const graph = getFullGraph();
    sendJSON(res, 200, { status: 'ok', ...graph });
  };

  // --- 3D Knowledge Graph (tag aggregation) ---
  routes['/api/kg3d'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    const data = getKG3DData(db);
    sendJSON(res, 200, { status: 'ok', nodes: data.nodes, edges: data.edges, tagItems: data.tagItems });
  };
}

module.exports = register;
