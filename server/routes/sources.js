/**
 * Eagleye — Sources routes
 *
 * Source listing, per-source detail and per-source Atom feeds.
 * Split out of api.js; handlers are unchanged.
 */

const { escapeXML } = require('../services/utils');
const { getDB } = require('../db/connection');
const { sendJSON, sendError } = require('./_shared');

function register(routes) {

  // --- Sources API ---
  routes['/api/sources'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const sources = db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM information_items WHERE source_id = s.id) as total_items,
        (SELECT COUNT(*) FROM information_items WHERE source_id = s.id AND digest_date = ?) as today_items,
        sp.source_type, sp.early_signal_rate, sp.noise_rate,
        sp.originality_rate, sp.last_30d_alpha_hits
      FROM sources s
      LEFT JOIN source_profiles sp ON sp.source_slug = s.slug
      WHERE s.is_active = 1
      ORDER BY CASE s.slug
        WHEN 'x-following' THEN 0
        WHEN 'hacker-news' THEN 1
        WHEN 'github-trending' THEN 2
        WHEN 'hugging-face' THEN 3
        WHEN 'product-hunt' THEN 4
        ELSE 99
      END, s.label
    `).all(new Date().toISOString().slice(0, 10).replace(/-/g, ''));

    // Per-source 7-day trend: item count per day per source (for mini sparkline).
    const since7 = (() => {
      const d = new Date(); d.setDate(d.getDate() - 7);
      return d.toISOString().slice(0, 10).replace(/-/g, '');
    })();
    const trendRows = db.prepare(`
      SELECT s.slug, i.digest_date, COUNT(*) AS cnt
      FROM information_items i JOIN sources s ON i.source_id = s.id
      WHERE i.digest_date >= ?
      GROUP BY s.slug, i.digest_date
    `).all(since7);
    const trendMap = {};
    for (const r of trendRows) {
      if (!trendMap[r.slug]) trendMap[r.slug] = [];
      trendMap[r.slug].push({ date: r.digest_date, count: r.cnt });
    }
    for (const s of sources) s.trend = trendMap[s.slug] || [];

    sendJSON(res, 200, { status: 'ok', sources });
  };
  routes['/api/source/:slug'] = (req, res, parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const slug = params?.slug || parsed.query.slug;
    const date = parsed.query.date;

    const source = db.prepare('SELECT * FROM sources WHERE slug = ?').get(slug);
    if (!source) return sendError(res, 404, 'Source not found');

    let items;
    if (date) {
      items = db.prepare(`
        SELECT i.*, s.label as source_label 
        FROM information_items i 
        JOIN sources s ON i.source_id = s.id 
        WHERE s.slug = ? AND i.digest_date = ?
        ORDER BY i.score DESC
        LIMIT 50
      `).all(slug, date);
    } else {
      items = db.prepare(`
        SELECT i.*, s.label as source_label 
        FROM information_items i 
        JOIN sources s ON i.source_id = s.id 
        WHERE s.slug = ?
        ORDER BY i.published_at DESC
        LIMIT 50
      `).all(slug);
    }

    const getTopics = db.prepare(`
      SELECT t.name, t.slug FROM topics t 
      JOIN item_topics it ON t.id = it.topic_id 
      WHERE it.item_id = ?
    `);
    items = items.map(item => ({
      ...item,
      topics: getTopics.all(item.id) || []
    }));

    // Per-source signal-type distribution (last 30d) for the detail page.
    const signalDist = db.prepare(`
      SELECT ss.signal_type, COUNT(*) AS count
      FROM signal_scores ss
      JOIN information_items i ON i.id = ss.item_id
      JOIN sources s ON i.source_id = s.id
      WHERE s.slug = ? AND i.digest_date >= ?
      GROUP BY ss.signal_type ORDER BY count DESC
    `).all(slug, (() => {
      const d = new Date(); d.setDate(d.getDate() - 30);
      return d.toISOString().slice(0, 10).replace(/-/g, '');
    })());

    sendJSON(res, 200, { exists: true, source, items, total: items.length, signal_dist: signalDist });
  };

  // --- Source Feed API (§13: GET /api/feed/:source) ---
  routes['/api/feed/:source'] = (req, res, parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const sourceSlug = params?.source || '';
    const source = db.prepare('SELECT * FROM sources WHERE slug = ?').get(sourceSlug);
    if (!source) return sendError(res, 404, 'Source not found');

    const format = parsed.query.format || 'json';
    const limit = parseInt(parsed.query.limit || '20', 10);

    const items = db.prepare(`
      SELECT i.*, s.label as source_label
      FROM information_items i
      JOIN sources s ON i.source_id = s.id
      WHERE s.slug = ?
      ORDER BY i.published_at DESC
      LIMIT ?
    `).all(sourceSlug, limit);

    if (format === 'xml' || format === 'atom') {
      // Return Atom XML feed
      let atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXML(source.label)} — Eagleye</title>
  <link href="/feed/${sourceSlug}"/>
  <link rel="self" href="/feed/${sourceSlug}?format=atom"/>
  <updated>${escapeXML(new Date().toISOString())}</updated>
  <id>urn:eagleye:source:${escapeXML(sourceSlug)}</id>`;
      for (const item of items) {
        atom += `
  <entry>
    <id>${escapeXML(item.canonical_url || item.id)}</id>
    <title>${escapeXML(item.title)}</title>
    <link href="${escapeXML(item.canonical_url || '')}"/>
    <updated>${escapeXML(item.published_at || item.created_at)}</updated>
    <summary>${escapeXML(item.original_summary || '')}</summary>
  </entry>`;
      }
      atom += '\n</feed>';
      res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
      res.end(atom);
    } else {
      // Return JSON
      sendJSON(res, 200, { status: 'ok', source, items, total: items.length });
    }
  };
}

module.exports = register;
