/**
 * Eagleye — Digest routes
 *
 * Daily digest and the by-year archive.
 * Split out of api.js; handlers are unchanged.
 */

const { getDB } = require('../db/connection');
const { sendJSON, sendError, cacheGet, cacheSet } = require('./_shared');
const { normalizeDigestDate, todayDigestDate } = require('../services/date-contract');

function register(routes) {

  // --- Digest API ---
  routes['/api/digest'] = (req, res, parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const rawDate = parsed.query.date || '';
    const date = rawDate ? normalizeDigestDate(rawDate) : todayDigestDate();
    if (rawDate && !date) return sendError(res, 400, 'Invalid date: expected YYYY-MM-DD or YYYYMMDD');

    // Get digest from daily_digests table or build on the fly
    const digest = db.prepare('SELECT * FROM daily_digests WHERE digest_date = ?').get(date);
    
    // Get items for this date
    const items = db.prepare(`
      SELECT i.*, s.label as source_label, s.slug as source_slug
      FROM information_items i 
      JOIN sources s ON i.source_id = s.id 
      WHERE i.digest_date = ?
      ORDER BY s.label, i.score DESC
      LIMIT 100
    `).all(date);

    // Attach summaries and topics
    const getSummary = db.prepare('SELECT * FROM ai_summaries WHERE item_id = ?');
    const getTopics = db.prepare(`
      SELECT t.name, t.slug FROM topics t 
      JOIN item_topics it ON t.id = it.topic_id 
      WHERE it.item_id = ?
    `);
    const enriched = items.map(item => {
      const summary = getSummary.get(item.id);
      const itemTopics = getTopics.all(item.id) || [];
      try {
        item.source_payload = JSON.parse(item.source_payload || '{}');
        item.popularity = JSON.parse(item.popularity || '{}');
      } catch {}
      return { ...item, ai_summary: summary || null, topics: itemTopics };
    });

    // Group by source
    const bySource = {};
    for (const item of enriched) {
      const src = item.source_label || 'Other';
      if (!bySource[src]) bySource[src] = [];
      bySource[src].push(item);
    }

    sendJSON(res, 200, {
      status: 'ok',
      date,
      digest: digest || null,
      by_source: bySource,
      total: enriched.length,
    });
  };

  // --- Digest Coverage API (daily counts for last 30 days) ---
  routes['/api/digest/coverage'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const coverage = db.prepare(`
      SELECT digest_date, COUNT(*) as count
      FROM information_items
      GROUP BY digest_date
      ORDER BY digest_date DESC
      LIMIT 30
    `).all();

    const coverageMap = {};
    coverage.forEach(row => {
      coverageMap[row.digest_date] = row.count;
    });

    sendJSON(res, 200, { status: 'ok', coverage: coverageMap });
  };

  // --- By Year archive (§7.8) ---
  // GET /api/year          → list of years with item counts
  // GET /api/year/:year    → year detail: by-month, by-source, top topics, top items
  routes['/api/year'] = (_req, res) => {
    const cached = cacheGet('year:list');
    if (cached) return sendJSON(res, 200, cached);
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    const years = db.prepare(`
      SELECT substr(digest_date, 1, 4) AS year, COUNT(*) AS items,
             COUNT(DISTINCT source_id) AS sources,
             COUNT(DISTINCT ss.item_id) AS scored
      FROM information_items i
      LEFT JOIN signal_scores ss ON ss.item_id = i.id
      GROUP BY year ORDER BY year DESC
    `).all();
    const data = { status: 'ok', years };
    cacheSet('year:list', data, 5 * 60 * 1000); // 5min — year list rarely changes
    sendJSON(res, 200, data);
  };

  routes['/api/year/:year'] = (req, res, parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    const year = String(params?.year || '').replace(/[^0-9]/g, '').slice(0, 4);
    if (!year) return sendError(res, 400, 'Year required');
    const from = year + '-01-01';
    const to = year + '-12-31';

    const byMonth = db.prepare(`
      SELECT substr(digest_date, 6, 2) AS month, COUNT(*) AS items
      FROM information_items WHERE digest_date >= ? AND digest_date <= ?
      GROUP BY month ORDER BY month
    `).all(from, to);

    const bySource = db.prepare(`
      SELECT s.slug, s.label, COUNT(*) AS items,
             SUM(CASE WHEN ss.alpha_score >= 0.7 THEN 1 ELSE 0 END) AS high_alpha
      FROM information_items i
      JOIN sources s ON i.source_id = s.id
      LEFT JOIN signal_scores ss ON ss.item_id = i.id
      WHERE i.digest_date >= ? AND i.digest_date <= ?
      GROUP BY s.id ORDER BY items DESC LIMIT 20
    `).all(from, to);

    // Top signal types
    const topTypes = db.prepare(`
      SELECT ss.signal_type, COUNT(*) AS count
      FROM signal_scores ss
      JOIN information_items i ON i.id = ss.item_id
      WHERE i.digest_date >= ? AND i.digest_date <= ? AND ss.signal_type != 'uncategorized'
      GROUP BY ss.signal_type ORDER BY count DESC LIMIT 10
    `).all(from, to);

    // Top items by alpha
    const topItems = db.prepare(`
      SELECT i.id, i.title, i.canonical_url, i.digest_date,
             s.label AS source_label, ss.alpha_score, ss.signal_type
      FROM information_items i
      JOIN sources s ON i.source_id = s.id
      JOIN signal_scores ss ON ss.item_id = i.id
      WHERE i.digest_date >= ? AND i.digest_date <= ?
      ORDER BY ss.alpha_score DESC LIMIT 20
    `).all(from, to);

    const total = bySource.reduce((s, r) => s + r.items, 0);
    sendJSON(res, 200, {
      status: 'ok',
      year,
      total,
      by_month: byMonth,
      by_source: bySource,
      top_types: topTypes,
      top_items: topItems,
    });
  };
}

module.exports = register;
