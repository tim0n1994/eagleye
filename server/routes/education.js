/**
 * Eagleye — Education routes
 *
 * GET /api/education — AI-education briefing derived from information_items.
 * Registering here inherits the standard /api/ auth gate in server.js; no
 * route-local exemptions. Read-only: two bounded index walks + 60s cache.
 */

const { getDB } = require('../db/connection');
const { sendJSON, sendError, cacheGet, cacheSet } = require('./_shared');
const { getEducationFeed, CATEGORY_KEYS } = require('../services/education-feed');

function register(routes) {
  routes['/api/education'] = (req, res, parsed) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendError(res, 405, 'Method not allowed');
    }
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const q = (parsed && parsed.query) || {};
    const rawCategory = q.category || 'all';
    if (rawCategory !== 'all' && !CATEGORY_KEYS.includes(rawCategory)) {
      return sendError(res, 400, 'Invalid category: expected all or one of ' + CATEGORY_KEYS.join(', '));
    }
    const source = q.source && q.source !== 'all' ? q.source : null;
    if (source && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(source)) {
      return sendError(res, 400, 'Invalid source: expected a source slug');
    }

    const days = Math.min(180, Math.max(1, parseInt(q.days, 10) || 30));
    const limit = Math.min(120, Math.max(1, parseInt(q.limit, 10) || 50));
    const offset = Math.max(0, parseInt(q.offset, 10) || 0);

    // The expensive candidate scan is shared across filters and pagination.
    const cacheKey = 'education:window:' + JSON.stringify({ days, source });
    let feed = cacheGet(cacheKey);
    try {
      if (!feed) {
        feed = getEducationFeed(db, { days, source });
        cacheSet(cacheKey, feed);
      }
    } catch (err) {
      return sendError(res, 500, 'Education feed failed: ' + err.message);
    }
    const filtered = rawCategory === 'all' ? feed.allItems : feed.allItems.filter(item => item.category === rawCategory);
    sendJSON(res, 200, {
      status: 'ok', items: filtered.slice(offset, offset + limit), categories: feed.categories,
      stats: { ...feed.stats, total: filtered.length }, offset, limit,
    });
  };
}

module.exports = register;
