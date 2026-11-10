/**
 * Eagleye — Sources routes
 *
 * Source listing, per-source detail and per-source Atom feeds.
 * Split out of api.js; handlers are unchanged.
 */

const { escapeXML } = require('../services/utils');
const { getDB } = require('../db/connection');
const { sendJSON, sendError } = require('./_shared');
const { normalizeDigestDate, todayDigestDate } = require('../services/date-contract');
const { getConfig, expectedIntervalHours } = require('../services/scheduler');
const { expectedIntervalForSource } = require('../services/source-health');

const { groupFor, referenceSlugs, xNetworkSummary } = require('../services/source-architecture');

const PHYSICAL_AI_SLUG_PREFIX = 'physical-ai-';

function isPhysicalAiSlug(slug) {
  return typeof slug === 'string' && slug.startsWith(PHYSICAL_AI_SLUG_PREFIX);
}

function register(routes) {

  // --- Sources API ---
  routes['/api/sources'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const schedulerConfig = getConfig();
    const schedulerHours = expectedIntervalHours(schedulerConfig);

    const sources = db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM information_items WHERE source_id = s.id) as total_items,
        (SELECT COUNT(*) FROM information_items WHERE source_id = s.id AND digest_date = ?) as today_items,
        sp.source_type, sp.early_signal_rate, sp.noise_rate,
        sp.originality_rate, sp.last_30d_alpha_hits
      FROM sources s
      LEFT JOIN source_profiles sp ON sp.source_slug = s.slug
      WHERE ${_parsed?.query?.include_disabled === '1' ? '1 = 1' : 's.is_active = 1'}
      ORDER BY CASE s.slug
        WHEN 'x-following' THEN 0
        WHEN 'hacker-news' THEN 1
        WHEN 'github-trending' THEN 2
        WHEN 'hugging-face' THEN 3
        WHEN 'product-hunt' THEN 4
        ELSE 99
      END, s.label
    `).all(todayDigestDate());

    // Per-source 7-day trend: item count per day per source (for mini sparkline).
    const since7 = (() => {
      const d = new Date(); d.setDate(d.getDate() - 7);
      return todayDigestDate(d);
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

    for (const s of sources) {
      s.collection = db.prepare('SELECT * FROM source_collection_state WHERE slug = ?').get(s.slug) || null;
      s.group = groupFor(s.slug);
      s.reference_source = referenceSlugs.includes(s.slug);
      const cadence = process.env.COLLECTION_SCHEDULE_ENABLED === '1' && s.slug !== 'x-following'
        ? { hours: require('../services/collection-control').intervalHours(s), basis: 'independent_source_schedule' }
        : expectedIntervalForSource(s, schedulerHours);
      s.expected_interval_hours = cadence.hours;
      s.expected_interval_basis = cadence.basis;
    }


    // R0-09: health fields (last_attempt_at, last_success_at, last_new_content_at,
    // last_error_class, health_status) ride along via SELECT s.*. is_active
    // reflects user enablement only and does not promise the source is healthy.
    res.setHeader('Cache-Control', 'private, no-store');
    sendJSON(res, 200, {
      status: 'ok',
      x_network: req.user?.role === 'admin' ? xNetworkSummary() : null,
      semantics: {
        is_active: 'user enablement; does not promise the source is healthy',
        health_status: 'observed health (healthy | stale | failing | unknown), updated by the fetch scheduler',
        refresh_cron: 'stored source metadata only; no current scheduler executes it',
      },
      expected_cadence: {
        hours: schedulerHours,
        basis: schedulerHours ? 'scheduler_config' : 'no_active_scheduler',
        schedule: schedulerHours ? 'daily ' + schedulerConfig.time : null,
      },
      sources,
    });
  };
  routes['/api/source/:slug'] = (req, res, parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const slug = params?.slug || parsed.query.slug;
    const rawDate = parsed.query.date;
    const date = rawDate ? normalizeDigestDate(rawDate) : '';
    if (rawDate && !date) return sendError(res, 400, 'Invalid date: expected YYYY-MM-DD or YYYYMMDD');

    const source = db.prepare('SELECT * FROM sources WHERE slug = ?').get(slug);
    if (!source) return sendError(res, 404, 'Source not found');
    source.collection = db.prepare('SELECT * FROM source_collection_state WHERE slug = ?').get(slug) || null;

    let items;
    if (isPhysicalAiSlug(slug)) {
      // Filter before LIMIT so a large historical run of placeholders cannot
      // hide real stories. Invalid JSON is kept rather than hiding evidence.
      const archiveSql = `
        SELECT i.*, s.label as source_label
        FROM information_items i
        JOIN sources s ON i.source_id = s.id
        WHERE s.slug = ? ${date ? 'AND i.digest_date = ?' : ''}
          AND i.duplicate_of IS NULL
          AND COALESCE(json_extract(CASE WHEN json_valid(i.source_payload) THEN i.source_payload ELSE '{}' END, '$.is_placeholder'), 0) NOT IN (1, 'true')
        ORDER BY i.published_at DESC
        LIMIT 50
      `;
      items = date ? db.prepare(archiveSql).all(slug, date) : db.prepare(archiveSql).all(slug);
    } else if (date) {
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
      return todayDigestDate(d);
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
