/**
 * Eagleye — Taxonomy routes
 *
 * Topics, tags and knowledge domains — the taxonomy layer over the corpus.
 * Split out of api.js; handlers are unchanged.
 */

const { escapeXML } = require('../services/utils');
const { getDB } = require('../db/connection');
const { runJob, JOB_TYPES } = require('../services/jobs');
const { getTopicTimeline, getTopicGraphNeighborhood } = require('../services/topic-graph');
const { sendJSON, sendError } = require('./_shared');
const { requireAdminPost } = require('./_validation');
const { normalizeDigestDate, todayDigestDate } = require('../services/date-contract');

function validDigestDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === value;
}

function register(routes) {

  // --- Topics API ---
  routes['/api/topics'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const topics = db.prepare(`SELECT t.*, 
      (SELECT COUNT(*) FROM item_topics WHERE topic_id = t.id) as item_count
      FROM topics t ORDER BY t.growth_score DESC, t.name`).all();

    // Get edge counts for each topic
    const edgeCount = db.prepare(`SELECT COUNT(*) as count FROM graph_edges WHERE 
      (from_type = 'topic' AND from_id = ?) OR (to_type = 'topic' AND to_id = ?)`);

    const enriched = topics.map(t => ({
      ...t,
      edge_count: edgeCount.get(t.id, t.id)?.count || 0,
    }));

    sendJSON(res, 200, { status: 'ok', topics: enriched });
  };

  // --- Single Topic API ---
  routes['/api/topics/:slug'] = (req, res, parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const slug = params?.slug || parsed.query.slug;
    const topic = db.prepare(`SELECT t.*, 
      (SELECT COUNT(*) FROM item_topics WHERE topic_id = t.id) as item_count,
      (SELECT COUNT(*) FROM topics WHERE parent_topic_id = t.id) as child_count
      FROM topics t WHERE t.slug = ?`).get(slug);

    if (!topic) return sendError(res, 404, 'Topic not found');

    // Get top items for this topic
    const items = db.prepare(`
      SELECT i.*, s.label as source_label, it.relevance 
      FROM information_items i 
      JOIN item_topics it ON i.id = it.item_id 
      JOIN sources s ON i.source_id = s.id
      WHERE it.topic_id = ? 
      ORDER BY it.relevance DESC, i.score DESC 
      LIMIT 20
    `).all(topic.id);

    // Get graph neighbors
    const neighbors = db.prepare(`
      SELECT * FROM graph_edges 
      WHERE (from_type = 'topic' AND from_id = ?) OR (to_type = 'topic' AND to_id = ?)
      LIMIT 50
    `).all(topic.id, topic.id);

    sendJSON(res, 200, { status: 'ok', topic, items, neighbors });
  };

  // --- Topic Timeline API ---
  routes['/api/topics/:slug/timeline'] = (req, res, parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const slug = params?.slug || '';
    const granularity = parsed.query.granularity || 'day';
    const topic = db.prepare('SELECT id FROM topics WHERE slug = ?').get(slug);
    if (!topic) return sendError(res, 404, 'Topic not found');

    const timeline = getTopicTimeline(topic.id, granularity);
    sendJSON(res, 200, { status: 'ok', timeline, granularity });
  };

  // --- Topic Graph Neighborhood API ---
  routes['/api/topics/:slug/graph'] = (req, res, _parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const slug = params?.slug || '';
    const topic = db.prepare('SELECT id FROM topics WHERE slug = ?').get(slug);
    if (!topic) return sendError(res, 404, 'Topic not found');

    const neighborhood = getTopicGraphNeighborhood(topic.id);
    sendJSON(res, 200, { status: 'ok', ...neighborhood });
  };

  // --- Tag List API ---
  routes['/api/tags'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const tags = db.prepare(`
      SELECT t.id, t.slug, t.name, t.name as name_zh, t.type,
             COUNT(it.item_id) as item_count
      FROM tags t
      JOIN item_tags it ON it.tag_id = t.id
      WHERE t.type IN ('llm-extracted', 'general')
      GROUP BY t.id
      ORDER BY item_count DESC
      LIMIT 200
    `).all();

    sendJSON(res, 200, { status: 'ok', tags });
  };

  // --- Tag Detail API ---
  routes['/api/tags/:slug'] = (req, res, parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const slug = params?.slug || '';
    const offset = parseInt(parsed.query.offset || '0', 10) || 0;
    const limit = Math.min(parseInt(parsed.query.limit || '30', 10) || 30, 100);

    const tag = db.prepare(`
      SELECT t.id, t.slug, t.name, t.name as name_zh, t.type,
             COUNT(it.item_id) as item_count
      FROM tags t
      JOIN item_tags it ON it.tag_id = t.id
      WHERE t.slug = ? OR t.name = ?
      GROUP BY t.id
    `).get(slug, slug);

    if (!tag) return sendError(res, 404, 'Tag not found');

    const items = db.prepare(`
      SELECT ii.*, s.label as source_label, s.slug as source_slug,
             ais.ai_title_zh, ais.short_summary_zh, ais.one_liner_zh, ais.confidence
      FROM information_items ii
      JOIN item_tags it ON it.item_id = ii.id
      LEFT JOIN sources s ON s.id = ii.source_id
      LEFT JOIN ai_summaries ais ON ais.item_id = ii.id
      WHERE it.tag_id = ?
      ORDER BY ii.published_at DESC
      LIMIT ? OFFSET ?
    `).all(tag.id, limit, offset);

    const getTopics = db.prepare(`
      SELECT t.slug, t.name, t.name_zh, it.relevance
      FROM item_topics it
      JOIN topics t ON t.id = it.topic_id
      WHERE it.item_id = ?
      ORDER BY it.relevance DESC
      LIMIT 5
    `);
    const getTags = db.prepare(`
      SELECT tg.slug, tg.name, itg.confidence
      FROM item_tags itg
      JOIN tags tg ON tg.id = itg.tag_id
      WHERE itg.item_id = ?
      ORDER BY itg.confidence DESC, tg.name ASC
      LIMIT 8
    `);
    const enrichedItems = items.map(item => {
      try {
        item.source_payload = JSON.parse(item.source_payload || '{}');
        item.normalized_payload = JSON.parse(item.normalized_payload || '{}');
        item.popularity = JSON.parse(item.popularity || '{}');
      } catch {}
      return {
        ...item,
        ai_summary: {
          ai_title_zh: item.ai_title_zh || '',
          short_summary_zh: item.short_summary_zh || '',
          one_liner_zh: item.one_liner_zh || '',
          confidence: item.confidence || null,
        },
        topics: getTopics.all(item.id),
        tags: getTags.all(item.id),
      };
    });

    const conceptRun = db.prepare(`
      SELECT id FROM kg_concept_runs
      WHERE status = 'completed'
      ORDER BY completed_at DESC, created_at DESC
      LIMIT 1
    `).get();
    let graph = null;
    const related = db.prepare(`
      SELECT other.name as label_zh, other.slug, COUNT(*) as shared_items
      FROM item_tags a
      JOIN item_tags b ON b.item_id = a.item_id AND b.tag_id != a.tag_id
      JOIN tags other ON other.id = b.tag_id
      WHERE a.tag_id = ?
      GROUP BY other.id
      ORDER BY shared_items DESC, other.name ASC
      LIMIT 12
    `).all(tag.id);
    if (conceptRun?.id) {
      const tagNode = db.prepare(`
        SELECT id, label_zh, description_zh, slug
        FROM kg_concept_nodes
        WHERE run_id = ? AND kind = 'tag' AND source_tag_id = ?
        LIMIT 1
      `).get(conceptRun.id, tag.id);
      if (tagNode?.id) {
        const parents = db.prepare(`
          SELECT p.id, p.kind, p.label_zh, p.slug, e.edge_type, e.confidence, e.weight, e.is_primary
          FROM kg_concept_edges e
          JOIN kg_concept_nodes p ON p.id = e.to_node_id
          WHERE e.run_id = ? AND e.from_node_id = ?
            AND e.edge_type IN ('primary_parent', 'secondary_parent', 'contains')
          ORDER BY e.is_primary DESC, e.confidence DESC, p.kind ASC
        `).all(conceptRun.id, tagNode.id);
        graph = { runId: conceptRun.id, node: tagNode, parents, related };
      }
    }
    if (!graph) {
      graph = {
        runId: conceptRun?.id || null,
        node: { id: tag.id, label_zh: tag.name, slug: tag.slug },
        parents: [],
        related,
      };
    }

    sendJSON(res, 200, { status: 'ok', tag, items: enrichedItems, graph, offset, limit });
  };

  // --- Build Tag Hierarchy (LLM clustering) ---
  routes['/api/tags/build-hierarchy'] = async (req, res, parsed) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }
    if (req.method !== 'POST') {
      return sendError(res, 405, 'Method not allowed. Use POST to build tag hierarchy.');
    }
    if (requireAdminPost(req, res)) return;
    const background = parsed.query.background !== 'false';
    if (background) {
      const jobId = await runJob(JOB_TYPES.BUILD_TAG_HIERARCHY, {});
      return sendJSON(res, 200, { status: 'ok', job_id: jobId, message: 'Tag hierarchy build queued' });
    }
    try {
      const { buildTagHierarchy } = require('../services/tag-hierarchy');
      const result = await buildTagHierarchy();
      sendJSON(res, 200, { status: 'ok', result });
    } catch (err) {
      sendError(res, 500, `Hierarchy build failed: ${err.message}`);
    }
  };

  // --- Domains API ---
  routes['/api/domains'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    const domains = db.prepare(`
      SELECT d.*,
        (SELECT COUNT(*) FROM tag_hierarchy th WHERE th.domain_id = d.id AND th.level = 1) as topic_count,
        (SELECT COUNT(*) FROM tag_hierarchy th WHERE th.domain_id = d.id AND th.level = 3) as tag_count
      FROM knowledge_domains d
      ORDER BY d.display_order
    `).all();
    sendJSON(res, 200, { status: 'ok', domains });
  };

  // --- Build Topic Graph (trigger) ---
  routes['/api/topics/build'] = async (req, res, parsed) => {
    if (requireAdminPost(req, res)) return;
    const date = normalizeDigestDate(parsed.query.date ?? todayDigestDate());
    if (!date || !validDigestDate(date)) return sendError(res, 400, 'Invalid date: expected YYYY-MM-DD or YYYYMMDD');
    const background = parsed.query.background !== 'false';
    const deep = parsed.query.deep === 'true' || parsed.query.deep === '1';

    if (background) {
      const jobId = await runJob(JOB_TYPES.BUILD_TOPIC_GRAPH, { date, deep });
      sendJSON(res, 200, { status: 'ok', job_id: jobId, message: `Topic graph build queued for ${date}` });
    } else {
      try {
        const { buildTopicGraph } = require('../services/topic-graph');
        const result = await buildTopicGraph(date, { deep });
        sendJSON(res, 200, { status: 'ok', result, date });
      } catch (err) {
        sendError(res, 500, `Topic graph build failed: ${err.message}`);
      }
    }
  };

  // --- Topic Feed API (§13: GET /api/topics/:slug/feed.xml) ---
  routes['/api/topics/:slug/feed.xml'] = (req, res, _parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const slug = params?.slug || '';
    const topic = db.prepare('SELECT * FROM topics WHERE slug = ?').get(slug);
    if (!topic) return sendError(res, 404, 'Topic not found');

    const items = db.prepare(`
      SELECT i.*, s.label as source_label
      FROM information_items i
      JOIN item_topics it ON i.id = it.item_id
      JOIN sources s ON i.source_id = s.id
      WHERE it.topic_id = ?
      ORDER BY i.published_at DESC
      LIMIT 20
    `).all(topic.id);

    const summaries = db.prepare('SELECT item_id, one_liner, short_summary FROM ai_summaries');
    const summaryMap = {};
    summaries.all().forEach(s => { summaryMap[s.item_id] = s; });

    let atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXML(topic.name)} — Eagleye Topics</title>
  <link href="/topics/${escapeXML(slug)}"/>
  <link rel="self" href="/topics/${escapeXML(slug)}/feed.xml"/>
  <updated>${escapeXML(new Date().toISOString())}</updated>
  <id>urn:eagleye:topic:${escapeXML(slug)}</id>`;

    for (const item of items) {
      const summary = summaryMap[item.id] || {};
      atom += `
  <entry>
    <id>${escapeXML(item.canonical_url || item.id)}</id>
    <title>${escapeXML(item.title)}</title>
    <link href="${escapeXML(item.canonical_url || '')}"/>
    <published>${escapeXML(item.published_at || item.created_at)}</published>
    <updated>${escapeXML(item.published_at || item.created_at)}</updated>
    <summary type="text">${escapeXML(summary.one_liner || summary.short_summary || '')}</summary>
    <category term="${escapeXML(topic.slug)}"/>
  </entry>`;
    }
    atom += '\n</feed>';

    res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
    res.end(atom);
  };
}

module.exports = register;
