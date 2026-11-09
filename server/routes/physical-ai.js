/**
 * Eagleye — Physical AI routes
 *
 * GET /api/physical-ai — read-only, source-backed embodied-AI briefing.
 * Registering here inherits the standard /api/ auth gate in server.js.
 *
 * Query: category=all|research|humanoid|open|applications, days=1..180
 * (default 30), optional date=YYYY-MM-DD digest snapshot (date wins over
 * days), limit/offset pagination. Legacy photonics/filings queries still read
 * the original source archives. Counts and items share a read snapshot.
 */

const { getDB } = require('../db/connection');
const { sendJSON, sendError } = require('./_shared');
const {
  getPhysicalAiSnapshot, getPhysicalAiItems, getLegacySnapshot,
  CATEGORY_KEYS, LEGACY_CATEGORY_KEYS, isValidDigestDate, clampInt,
} = require('../services/physical-ai-feed');

function register(routes) {
  routes['/api/physical-ai'] = (req, res, parsed) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendError(res, 405, 'Method not allowed');
    }
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const q = (parsed && parsed.query) || {};
    const category = q.category || 'all';
    if (category !== 'all' && !CATEGORY_KEYS.includes(category) && !LEGACY_CATEGORY_KEYS.includes(category)) {
      return sendError(res, 400, 'Invalid category: expected all or one of ' + CATEGORY_KEYS.join(', '));
    }
    let date = null;
    if (q.date !== undefined && q.date !== '') {
      if (!isValidDigestDate(q.date)) {
        return sendError(res, 400, 'Invalid date: expected YYYY-MM-DD');
      }
      date = q.date;
    }
    const days = clampInt(q.days, 1, 180, 30);
    const limit = clampInt(q.limit, 1, 120, 50);
    const offset = clampInt(q.offset, 0, Number.MAX_SAFE_INTEGER, 0);

    try {
      const payload = db.transaction(() => {
        const snapshot = getPhysicalAiSnapshot(db, { date, days });
        const items = getPhysicalAiItems(db, {
          date, days, category: category === 'all' ? null : category, limit, offset,
        });
        const legacy = LEGACY_CATEGORY_KEYS.includes(category) ? getLegacySnapshot(db, { date, days, category }) : null;
        const total = legacy ? legacy.count : category === 'all'
          ? snapshot.total
          : (snapshot.categories.find((entry) => entry.key === category) || { count: 0 }).count;
        return { status: 'ok', items, categories: legacy ? [...snapshot.categories, legacy] : snapshot.categories,
          stats: { total }, offset, limit };
      }).deferred();
      return sendJSON(res, 200, payload);
    } catch (err) {
      return sendError(res, 500, 'Physical AI feed failed: ' + err.message);
    }
  };
}

module.exports = register;
