/**
 * Eagleye — System routes
 *
 * Health, system statistics, industry metrics and the legacy sync key/value endpoints.
 * Split out of api.js; handlers are unchanged.
 */

const { getDB } = require('../db/connection');
const { getValue, setValue } = require('../db/user-data');
const { sendJSON, sendError, requireAdmin } = require('./_shared');
const { getSystemStats } = require('../services/system-stats');
const { healthDistribution, llmErrorClassSummary } = require('../services/source-health');
const { getSwitches, setSwitches } = require('../services/runtime-switches');
const { todayDigestDate } = require('../services/date-contract');

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
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
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
    const stats = getSystemStats(db);
    sendJSON(res, 200, { status: 'ok', stats });
  };

  // --- Degradation visibility (R0-09): source health + model-layer hook ---
  // Read-only; no timers. Source counts come from stored health_status fields
  // (migration 037); the LLM block aggregates llm_request_events (031) without
  // importing LLM internals. The scheduler owns refreshing health_status.
  routes['/api/system/degradation'] = (_req, res) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    sendJSON(res, 200, {
      status: 'ok',
      time: new Date().toISOString(),
      sources: healthDistribution(db),
      llm: llmErrorClassSummary(db),
    });
  };

  routes['/api/system/switches'] = (req, res, _parsed) => {
    if (req.method === 'GET') {
      return sendJSON(res, 200, { status: 'ok', switches: getSwitches() });
    }
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    if (requireAdmin(req, res)) return;
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1048576) req.destroy(); });
    req.on('end', () => {
      let patch;
      try {
        patch = JSON.parse(body);
      } catch {
        return sendError(res, 400, 'Invalid JSON');
      }
      try {
        sendJSON(res, 200, { status: 'ok', switches: setSwitches(patch) });
      } catch (err) {
        sendError(res, 400, err.message);
      }
    });
  };


  // --- Industry Metrics: pure aggregation for the dashboard (no new tables) ---
  routes['/api/metrics/industry'] = (_req, res) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const since30 = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return todayDigestDate(d);
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
