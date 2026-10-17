/**
 * Eagleye — Items routes
 *
 * Item listing, papers, per-item detail actions (summary, research, deploy plan, save) and the saved list.
 * Split out of api.js; handlers are unchanged.
 */

const { generateDeployPlan, checkDeployEligibility } = require('../services/deploy');
const { generateItemResearch, getResearchReport, answerItemResearchChat } = require('../services/research');
const { getDB } = require('../db/connection');
const { sendJSON, sendError } = require('./_shared');
const { normalizeDigestDate } = require('../services/date-contract');

function register(routes) {


  // --- Items API ---
  routes['/api/items'] = (req, res, parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const category = parsed.query.category;
    const source = parsed.query.source;
    const rawDate = parsed.query.date;
    let date;
    if (rawDate) {
      date = normalizeDigestDate(rawDate);
      if (!date) return sendError(res, 400, 'Invalid date: expected YYYY-MM-DD or YYYYMMDD');
    }
    const limit = parseInt(parsed.query.limit || '50', 10);
    const offset = parseInt(parsed.query.offset || '0', 10);

    let sql = `SELECT i.*, s.label as source_label, s.slug as source_slug FROM information_items i JOIN sources s ON i.source_id = s.id WHERE 1=1`;
    const params = [];

    // Build the WHERE clause once so we can reuse it for the COUNT.
    let whereSql = '';
    if (category && category !== 'All') {
      whereSql += ` AND i.id IN (SELECT it.item_id FROM item_topics it JOIN topics t ON it.topic_id = t.id WHERE t.slug = ?)`;
      params.push(category);
    }
    if (source) {
      whereSql += ` AND s.slug = ?`;
      params.push(source);
    }
    if (date) {
      whereSql += ` AND i.digest_date = ?`;
      params.push(date);
    }
    sql += whereSql;

    // True total count for the matching set (independent of limit/offset).
    // Previously returned page length, so the UI couldn't show "showing 50 of 843".
    const countRow = db.prepare(`SELECT COUNT(*) AS c FROM information_items i JOIN sources s ON i.source_id = s.id WHERE 1=1${whereSql}`).get(...params);

    sql += ` ORDER BY i.score DESC, i.published_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const items = db.prepare(sql).all(...params);

    // Attach summaries if available
    const getSummary = db.prepare('SELECT * FROM ai_summaries WHERE item_id = ?');
    const getTopics = db.prepare(`
      SELECT t.slug, t.name, it.relevance FROM item_topics it 
      JOIN topics t ON it.topic_id = t.id 
      WHERE it.item_id = ?
    `);
    const getTags = db.prepare(`
      SELECT tg.slug, tg.name, itg.confidence FROM item_tags itg
      JOIN tags tg ON itg.tag_id = tg.id
      WHERE itg.item_id = ?
    `);

    // Attach story-cluster info so cards can show "+N sources" dedup badges
    // (§16 duplicate-group UX). Cached lookup; no-op if no clusters for this date.
    let clusterMap = null;
    if (date) {
      try {
        const { getItemClusterMap } = require('../services/story-clusters');
        clusterMap = getItemClusterMap({ date, sinceDays: 1 });
      } catch { /* story-clusters absent → no badges */ }
    }

    // Batch-fetch summaries/topics/tags to avoid N+1 queries (was 150 round-trips
    // per 50-item page; now 3 batch queries using IN clauses).
    const itemIds = items.map(i => i.id);
    const idList = itemIds.length > 0 ? `'${itemIds.map(id => String(id).replace(/'/g, "''")).join("','")}'` : 'NULL';
    const summaryMap = new Map();
    const topicMap = new Map();
    const tagMap = new Map();
    try {
      db.prepare(`SELECT * FROM ai_summaries WHERE item_id IN (${idList})`).all().forEach(s => summaryMap.set(s.item_id, s));
      db.prepare(`SELECT it.item_id, t.slug, t.name, it.relevance FROM item_topics it JOIN topics t ON it.topic_id = t.id WHERE it.item_id IN (${idList})`).all().forEach(r => {
        if (!topicMap.has(r.item_id)) topicMap.set(r.item_id, []);
        topicMap.get(r.item_id).push({ slug: r.slug, name: r.name, relevance: r.relevance });
      });
      db.prepare(`SELECT itg.item_id, tg.slug, tg.name, itg.confidence FROM item_tags itg JOIN tags tg ON itg.tag_id = tg.id WHERE itg.item_id IN (${idList})`).all().forEach(r => {
        if (!tagMap.has(r.item_id)) tagMap.set(r.item_id, []);
        tagMap.get(r.item_id).push({ slug: r.slug, name: r.name, confidence: r.confidence });
      });
    } catch { /* fall back to per-item below if batch fails */ }

    const enriched = items.map(item => {
      // Use batch maps if populated; fall back to per-item query for safety.
      const summary = summaryMap.size > 0 ? summaryMap.get(item.id) : getSummary.get(item.id);
      const topics = topicMap.size > 0 ? (topicMap.get(item.id) || []) : getTopics.all(item.id);
      const tags = tagMap.size > 0 ? (tagMap.get(item.id) || []) : getTags.all(item.id);
      try {
        item.source_payload = JSON.parse(item.source_payload || '{}');
        item.normalized_payload = JSON.parse(item.normalized_payload || '{}');
        item.popularity = JSON.parse(item.popularity || '{}');
      } catch {}
      return {
        ...item,
        ai_summary: summary || null,
        topics: topics || [],
        tags: tags || [],
        story_cluster: clusterMap?.get(item.id) || null,
      };
    });

    sendJSON(res, 200, { status: 'ok', items: enriched, total: countRow.c, page_count: enriched.length, score_scale: { score: 'unbounded-legacy' } });
  };

  // --- Papers API ---
  routes['/api/papers'] = (req, res, parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const source = parsed.query.source || 'all';
    const limit = Math.min(parseInt(parsed.query.limit || '60', 10) || 60, 120);
    const offset = parseInt(parsed.query.offset || '0', 10) || 0;
    const params = [];
    let sourceFilter = '';
    if (source && source !== 'all') {
      sourceFilter = 'AND s.slug = ?';
      params.push(source);
    }

    const rows = db.prepare(`
      SELECT i.*, s.label as source_label, s.slug as source_slug,
             pm.paper_id, pm.provider, pm.arxiv_id, pm.doi, pm.abstract,
             pm.authors_json, pm.categories_json, pm.pdf_url, pm.landing_url,
             pm.code_url, pm.tasks_json, pm.venue,
             ais.ai_title_zh, ais.one_liner_zh, ais.short_summary_zh, ais.confidence
      FROM information_items i
      JOIN sources s ON s.id = i.source_id
      LEFT JOIN paper_metadata pm ON pm.item_id = i.id
      LEFT JOIN ai_summaries ais ON ais.item_id = i.id
      WHERE (
        pm.item_id IS NOT NULL
        OR s.slug IN ('hugging-face', 'arxiv-ai', 'physical-ai-arxiv')
      )
      ${sourceFilter}
      ORDER BY i.published_at DESC, i.score DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const getTags = db.prepare(`
      SELECT tg.slug, tg.name, itg.confidence FROM item_tags itg
      JOIN tags tg ON itg.tag_id = tg.id
      WHERE itg.item_id = ?
      ORDER BY itg.confidence DESC, tg.name ASC
    `);

    const parseJSON = (value, fallback) => {
      try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
    };

    const papers = rows.map(row => ({
      id: row.id,
      title: row.title,
      title_zh: row.ai_title_zh || '',
      one_liner_zh: row.one_liner_zh || '',
      short_summary_zh: row.short_summary_zh || '',
      abstract: row.abstract || row.original_summary || '',
      source_label: row.source_label,
      source_slug: row.source_slug,
      canonical_url: row.landing_url || row.canonical_url,
      pdf_url: row.pdf_url || '',
      code_url: row.code_url || '',
      paper_id: row.paper_id || row.external_id || '',
      provider: row.provider || row.source_slug,
      arxiv_id: row.arxiv_id || '',
      doi: row.doi || '',
      authors: parseJSON(row.authors_json, []),
      categories: parseJSON(row.categories_json, []),
      tasks: parseJSON(row.tasks_json, []),
      venue: row.venue || '',
      published_at: row.published_at,
      confidence: row.confidence || null,
      tags: getTags.all(row.id),
    }));

    const sources = db.prepare(`
      SELECT s.slug, s.label, COUNT(i.id) as count
      FROM sources s
      JOIN information_items i ON i.source_id = s.id
      LEFT JOIN paper_metadata pm ON pm.item_id = i.id
      WHERE pm.item_id IS NOT NULL OR s.slug IN ('hugging-face', 'arxiv-ai', 'physical-ai-arxiv')
      GROUP BY s.slug
      ORDER BY count DESC, s.slug ASC
    `).all();

    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN pm.pdf_url IS NOT NULL AND pm.pdf_url != '' THEN 1 ELSE 0 END) as with_pdf,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM item_tags it WHERE it.item_id = i.id) THEN 1 ELSE 0 END) as tagged
      FROM information_items i
      JOIN sources s ON s.id = i.source_id
      LEFT JOIN paper_metadata pm ON pm.item_id = i.id
      WHERE pm.item_id IS NOT NULL OR s.slug IN ('hugging-face', 'arxiv-ai', 'physical-ai-arxiv')
    `).get();

    sendJSON(res, 200, { status: 'ok', papers, sources, stats, offset, limit });
  };

  // --- Legacy items API (backward compat) ---
  routes['/api/items-legacy'] = (req, res, parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const category = parsed.query.category;
    let items;
    if (category && category !== 'All') {
      items = db.prepare('SELECT * FROM items WHERE category = ? ORDER BY created_at DESC LIMIT 100').all(category);
    } else {
      items = db.prepare('SELECT * FROM items ORDER BY created_at DESC LIMIT 100').all();
    }
    items.forEach(it => {
      try { it.tags = JSON.parse(it.tags || '[]'); } catch { it.tags = []; }
    });
    sendJSON(res, 200, { status: 'ok', items });
  };

  // --- Categories API ---
  routes['/api/categories'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    const categories = db.prepare('SELECT category, COUNT(*) as count FROM items GROUP BY category').all();
    sendJSON(res, 200, { status: 'ok', categories });
  };

  // --- Deploy Plan API ---
  routes['/api/deployment-plans/:id'] = (req, res, _parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    
    const plan = db.prepare('SELECT * FROM deployment_plans WHERE id = ?').get(params?.id || '');
    if (!plan) return sendError(res, 404, 'Plan not found');
    
    try {
      plan.commands = JSON.parse(plan.commands || '[]');
      plan.env_vars = JSON.parse(plan.env_vars || '{}');
      plan.detected_stack = JSON.parse(plan.detected_stack || '{}');
      plan.risk_notes = JSON.parse(plan.risk_notes || '[]');
    } catch {}
    
    sendJSON(res, 200, { status: 'ok', plan });
  };

  // ────────────────────────────────────────────────────────────────────────
  // §13: Missing API Endpoints
  // ────────────────────────────────────────────────────────────────────────

  // --- Single Item API (§13: GET /api/items/:id) ---
  routes['/api/items/:id'] = (req, res, _parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const itemId = params?.id || '';
    const item = db.prepare(`
      SELECT i.*, s.label as source_label, s.slug as source_slug
      FROM information_items i
      JOIN sources s ON i.source_id = s.id
      WHERE i.id = ?
    `).get(itemId);

    if (!item) return sendError(res, 404, 'Item not found');

    try {
      item.source_payload = JSON.parse(item.source_payload || '{}');
      item.normalized_payload = JSON.parse(item.normalized_payload || '{}');
      item.popularity = JSON.parse(item.popularity || '{}');
    } catch {}

    // Get summary
    const summary = db.prepare('SELECT * FROM ai_summaries WHERE item_id = ?').get(itemId);

    // Get topics
    const topics = db.prepare(`
      SELECT t.slug, t.name, it.relevance FROM item_topics it
      JOIN topics t ON it.topic_id = t.id
      WHERE it.item_id = ? ORDER BY it.relevance DESC
    `).all(itemId);

    // Get tags
    const tags = db.prepare(`
      SELECT tg.slug, tg.name, itg.confidence FROM item_tags itg
      JOIN tags tg ON itg.tag_id = tg.id
      WHERE itg.item_id = ?
    `).all(itemId);

    // Get deploy eligibility
    const deployInfo = checkDeployEligibility(itemId);

    sendJSON(res, 200, {
      status: 'ok',
      item: { ...item, ai_summary: summary, topics, tags },
      deploy: deployInfo,
    });
  };

  // --- Item Summary API (§13: GET /api/items/:id/summary) ---
  routes['/api/items/:id/summary'] = (req, res, _parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const itemId = params?.id || '';
    const summary = db.prepare('SELECT * FROM ai_summaries WHERE item_id = ?').get(itemId);
    if (!summary) return sendError(res, 404, 'Summary not found for this item');

    sendJSON(res, 200, { status: 'ok', summary });
  };

  // --- Trigger Research API (§13: POST /api/items/:id/research) ---
  routes['/api/items/:id/research'] = async (req, res, _parsed, params) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    const itemId = params?.id || '';
    if (!itemId) return sendError(res, 400, 'Item ID required');
    const force = _parsed?.query?.force === 'true' || _parsed?.query?.force === '1';

    // Check for existing completed research
    const db = getDB();
    const existing = !force
      ? db?.prepare("SELECT * FROM research_reports WHERE item_id = ? AND status = ? AND LENGTH(TRIM(COALESCE(report_markdown, ''), char(9) || char(10) || char(13) || ' ')) > 0 ORDER BY created_at DESC LIMIT 1").get(itemId, 'completed')
      : null;
    if (existing) {
      return sendJSON(res, 200, { status: 'ok', report: existing, cached: true });
    }

    // Generate new research
    try {
      const result = await generateItemResearch(itemId);
      if (result.error) return sendError(res, 500, result.error);
      const report = getResearchReport(result.id);
      sendJSON(res, 200, { status: 'ok', report, cached: false });
    } catch (err) {
      sendError(res, 500, `Research failed: ${err.message}`);
    }
  };

  // --- Research Chat API (§13: POST /api/items/:id/research/chat) ---
  routes['/api/items/:id/research/chat'] = (req, res, _parsed, params) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    const itemId = params?.id || '';
    if (!itemId) return sendError(res, 400, 'Item ID required');

    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1048576) req.destroy(); });
    req.on('end', async () => {
      let payload;
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        return sendError(res, 400, 'Invalid JSON body');
      }

      try {
        const result = await answerItemResearchChat(itemId, payload.message, payload.history || []);
        if (result?.error) return sendError(res, 400, result.error);
        sendJSON(res, 200, { status: 'ok', ...result });
      } catch (err) {
        sendError(res, 500, `Research chat failed: ${err.message}`);
      }
    });
  };

  // --- Trigger Deployment Plan API (§13: POST /api/items/:id/deployment-plan) ---
  routes['/api/items/:id/deployment-plan'] = async (req, res, _parsed, params) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    const itemId = params?.id || '';
    if (!itemId) return sendError(res, 400, 'Item ID required');

    try {
      const result = await generateDeployPlan(itemId);
      if (result.error) return sendError(res, 500, result.error);
      sendJSON(res, 200, { status: 'ok', plan_id: result.id, eligibility: result.eligibility, plan: result.plan });
    } catch (err) {
      sendError(res, 500, `Deploy plan failed: ${err.message}`);
    }
  };

  // --- Save Item API ---
  routes['/api/items/:id/save'] = (req, res, parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const itemId = params?.id || '';
    const note = parsed.query.note || '';

    if (!itemId) return sendError(res, 400, 'Item ID required');

    // Check if already saved
    const userId = req.user.id;
    const existing = db.prepare('SELECT * FROM saved_items WHERE user_id = ? AND item_id = ?').get(userId, itemId);
    if (existing) {
      // Unsave if already saved
      db.prepare('DELETE FROM saved_items WHERE user_id = ? AND item_id = ?').run(userId, itemId);
      // A save/unsave changes the user interest profile — invalidate the
      // relevance cache so For-You picks up the new signal immediately.
      try { require('../services/relevance').invalidateProfile(userId); } catch { /* relevance absent */ }
      return sendJSON(res, 200, { status: 'ok', saved: false, message: 'Item unsaved' });
    }

    db.prepare('INSERT OR IGNORE INTO saved_items (user_id, item_id, note) VALUES (?, ?, ?)')
      .run(userId, itemId, note);
    try { require('../services/relevance').invalidateProfile(userId); } catch { /* relevance absent */ }
    sendJSON(res, 200, { status: 'ok', saved: true, message: 'Item saved' });
  };

  // --- Get Saved Items API ---
  routes['/api/saved'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const items = db.prepare(`
      SELECT i.*, s.label as source_label, s.slug as source_slug, sv.note, sv.created_at as saved_at
      FROM saved_items sv
      JOIN information_items i ON sv.item_id = i.id
      JOIN sources s ON i.source_id = s.id
      WHERE sv.user_id = ?
      ORDER BY sv.created_at DESC
      LIMIT 100
    `).all(req.user.id);

    sendJSON(res, 200, { status: 'ok', items, total: items.length });
  };
}

module.exports = register;
