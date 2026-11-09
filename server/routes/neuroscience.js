const { getDB } = require('../db/connection');
const { sendJSON, sendError, cacheGet, cacheSet } = require('./_shared');
const { getNeuroscienceFeed, CATEGORY_KEYS, SOURCES } = require('../services/neuroscience-feed');

module.exports = function register(routes) {
  routes['/api/neuroscience'] = (req, res, parsed) => {
    if (!['GET', 'HEAD'].includes(req.method)) return sendError(res, 405, 'Method not allowed');
    const q = parsed?.query || {};
    const category = q.category || 'all';
    const source = q.source || 'all';
    if (category !== 'all' && !CATEGORY_KEYS.includes(category)) return sendError(res, 400, 'Invalid category');
    if (source !== 'all' && !Object.hasOwn(SOURCES, source)) return sendError(res, 400, 'Invalid source');
    const days = [30, 90, 180].includes(Number(q.days)) ? Number(q.days) : 30;
    const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 24));
    const offset = Math.min(10000, Math.max(0, parseInt(q.offset, 10) || 0));
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    try {
      // Only three possible cache entries; filters and pagination share them.
      const key = `neuroscience:${days}`;
      let feed = cacheGet(key);
      if (!feed) { feed = getNeuroscienceFeed(db, days); cacheSet(key, feed); }
      const scoped = feed.allItems.filter(item => source === 'all' || item.source_slug === source);
      const filtered = scoped.filter(item => category === 'all' || item.category === category);
      res.setHeader('Cache-Control', 'private, no-store');
      sendJSON(res, 200, { status: 'ok', items: filtered.slice(offset, offset + limit),
        categories: CATEGORY_KEYS.map(key => ({ key, count: scoped.filter(item => item.category === key).length })),
        sources: feed.sources, recommended_accounts: feed.recommended_accounts,
        stats: { ...feed.stats, total: filtered.length }, offset, limit });
    } catch (err) {
      console.error('[neuroscience]', err.message);
      sendError(res, 500, 'Neuroscience feed temporarily unavailable');
    }
  };
};
