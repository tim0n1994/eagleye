/**
 * Eagleye — System routes
 *
 * Health, system statistics, industry metrics and the legacy sync key/value endpoints.
 * Split out of api.js; handlers are unchanged.
 */

const { getDB } = require('../db/connection');
const { getValue, setValue } = require('../db/user-data');
const { sendJSON, sendError } = require('./_shared');

function register(routes) {

  // --- Sync Get API ---
  routes['/api/sync/get'] = (req, res, _parsed) => {
    const bookmarks = getValue('bookmarks', req.user.id) || [];
    const read = getValue('read', req.user.id) || [];
    const customRss = getValue('custom-rss', req.user.id) || [];
    sendJSON(res, 200, { bookmarks, read, customRss });
  };

  // --- Sync Set API ---
  routes['/api/sync/set'] = (req, res, _parsed) => {
    let body = '';
    // Unbounded body: readBody's cap applies here too.
    req.on('data', chunk => { body += chunk; if (body.length > 1048576) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.bookmarks) setValue('bookmarks', data.bookmarks, req.user.id);
        if (data.read) setValue('read', data.read, req.user.id);
        if (data.customRss) setValue('custom-rss', data.customRss, req.user.id);
        sendJSON(res, 200, { status: 'ok' });
      } catch {
        sendError(res, 400, 'Invalid JSON');
      }
    });
  };

  // --- Health API ---
  routes['/api/health'] = (req, res, _parsed) => {
    const db = getDB();
    const dbStatus = db ? 'connected' : 'disconnected';
    const itemCount = db ? db.prepare('SELECT COUNT(*) as count FROM information_items').get().count : 0;
    const legacyCount = db ? db.prepare('SELECT COUNT(*) as count FROM items').get().count : 0;
    
    sendJSON(res, 200, { 
      status: 'ok', 
      time: new Date().toISOString(),
      database: dbStatus,
      items: { information_items: itemCount, legacy_items: legacyCount },
      apiKey: process.env.GEMINI_API_KEY ? 'configured' : 'not set',
    });
  };

  // --- System Stats: enrichment/translation backlog, coverage, DB size ---
  routes['/api/system/stats'] = (_req, res) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    const stats = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM information_items) AS total_items,
        (SELECT COUNT(*) FROM information_items WHERE id NOT IN (SELECT item_id FROM ai_summaries) AND enrichment_attempts < 3) AS enrichment_backlog,
        (SELECT COUNT(*) FROM information_items WHERE enrichment_attempts >= 3) AS poisoned_items,
        (SELECT COUNT(*) FROM ai_summaries) AS summaries,
        (SELECT COUNT(*) FROM ai_summaries WHERE translation_status != 'translated') AS translation_backlog,
        (SELECT COUNT(*) FROM signal_scores) AS scored,
        (SELECT COUNT(*) FROM signal_scores WHERE signal_type = 'uncategorized') AS uncategorized,
        (SELECT COUNT(*) FROM research_reports WHERE status = 'completed') AS research_reports,
        (SELECT COUNT(*) FROM saved_items) AS saved_items,
        (SELECT COUNT(*) FROM seen_items) AS seen_items,
        (SELECT COUNT(*) FROM canonical_entities) AS entities,
        (SELECT COUNT(*) FROM dynamic_topics) AS dynamic_topics
    `).get();
    // DB file size
    try {
      const fs = require('fs');
      const dbPath = require('path').join(__dirname, '..', '..', 'eagleye.db');
      stats.db_size_mb = Math.round(fs.statSync(dbPath).size / 1048576);
    } catch { stats.db_size_mb = null; }
    // Connector health: per-source last 7d item counts + last_fetched_at.
    stats.connectors = db.prepare(`
      SELECT s.slug, s.label, s.last_fetched_at,
        (SELECT COUNT(*) FROM information_items i WHERE i.source_id = s.id AND i.digest_date >= ?) AS items_7d,
        (SELECT COUNT(*) FROM information_items i WHERE i.source_id = s.id) AS total_items
      FROM sources s WHERE s.is_active = 1 ORDER BY items_7d DESC
    `).all(((() => {
      const d = new Date(); d.setDate(d.getDate() - 7);
      return d.toISOString().slice(0, 10).replace(/-/g, '');
    })()));
    sendJSON(res, 200, { status: 'ok', stats });
  };


  // --- Industry Metrics: pure aggregation for the dashboard (no new tables) ---
  routes['/api/metrics/industry'] = (_req, res) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const since30 = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return d.toISOString().slice(0, 10).replace(/-/g, '');
    })();

    const corpus = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM information_items) AS items,
        (SELECT COUNT(*) FROM signal_scores) AS scored,
        (SELECT COUNT(*) FROM ai_summaries) AS summaries,
        (SELECT COUNT(*) FROM research_reports) AS reports,
        (SELECT COUNT(*) FROM signal_types) AS signalTypes,
        (SELECT COUNT(*) FROM canonical_entities) AS entities
    `).get();

    // Source diversity: per-source 30d item volume + source_profiles trust/noise.
    const sources = db.prepare(`
      SELECT s.label,
        (SELECT COUNT(*) FROM information_items i WHERE i.source_id = s.id AND i.digest_date >= ?) AS items_30d,
        sp.source_type AS trust, sp.noise_rate
      FROM sources s
      LEFT JOIN source_profiles sp ON sp.source_slug = s.slug
      WHERE s.is_active = 1
      ORDER BY items_30d DESC
      LIMIT 20
    `).all(since30);

    // Signal-type distribution over the trailing 30 days.
    const signalTypes = db.prepare(`
      SELECT COALESCE(ss.signal_type, 'uncategorized') AS type,
             COUNT(*) AS count
      FROM signal_scores ss
      JOIN information_items i ON i.id = ss.item_id
      WHERE i.digest_date >= ?
      GROUP BY type
      ORDER BY count DESC
    `).all(since30).map(r => ({
      type: r.type,
      label: r.type === 'uncategorized' ? 'uncategorized' : r.type.replace(/_/g, ' '),
      count: r.count,
    }));

    const kg = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM item_features) AS features,
        (SELECT COUNT(*) FROM kg_tags) AS tags,
        (SELECT COUNT(*) FROM dynamic_topics) AS topics
    `).get();

    sendJSON(res, 200, { status: 'ok', corpus, sources, signalTypes, kg });
  };
}

module.exports = register;
