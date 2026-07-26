/**
 * Eagleye — Shared route helpers
 *
 * Response writers, body parsing, auth/admin guards and the read-cache used by
 * every route module. Extracted from api.js when the route layer was split by
 * domain; the implementations are unchanged.
 */

const auth = require('../services/auth');
const { checkAuthAttempt } = require('../services/rate-limit');

// The clean feed aliases in server.js (/watchlist/feed.xml etc.) are rewritten
// before the /api/ auth gate runs, so handlers they reach cannot assume req.user
// exists. Personal feeds resolve their owner here instead: session cookie for a
// browser, ?key=<api key> for an RSS reader, which cannot send cookies.
function resolveFeedUser(req, parsed) {
  if (req.user) return req.user;
  const viaSession = auth.getSessionUser(req);
  if (viaSession) return viaSession;
  const key = parsed?.query?.key || '';
  return key ? auth.getApiKeyOwner(key) : null;
}

// Admin guard for routes that live outside the /api/admin/ prefix (which
// server.js gates by path). Returns true when it has already answered.
function requireAdmin(req, res) {
  if (req.user?.role === 'admin') return false;
  sendError(res, 403, 'Admin access required');
  return true;
}

// Guard for the unauthenticated /api/auth/* endpoints. Returns true (and has
// already answered the request) when the caller is over budget.
function authThrottled(req, res) {
  const { limited, retryAfterSec } = checkAuthAttempt(req);
  if (!limited) return false;
  res.setHeader('Retry-After', String(retryAfterSec));
  sendError(res, 429, `Too many attempts. Try again in ${retryAfterSec}s.`);
  return true;
}

// Helper: read JSON body from a POST request (shared by auth routes)
function readBody(req, maxLen = 8192) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > maxLen) { req.destroy(); reject(new Error('Body too large')); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
}

// ─── Lightweight in-memory cache for read-heavy endpoints ──────────────
// Reduces DB load on repeated calls. Each entry has a TTL; mutation endpoints
// (POST/PUT/DELETE) should call cacheInvalidate() to bust relevant keys.
const _apiCache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 1 minute default

function cacheGet(key) {
  const entry = _apiCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { _apiCache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data, ttlMs = CACHE_TTL_MS) {
  _apiCache.set(key, { data, expires: Date.now() + ttlMs });
}

function cacheInvalidate(prefix) {
  if (!prefix) { _apiCache.clear(); return; }
  for (const key of _apiCache.keys()) { if (key.startsWith(prefix)) _apiCache.delete(key); }
}

/**
 * FTS5 fallback search (used when ES is unavailable).
 * Returns the same shape as esSearch but without aggregations.
 */
function ftsSearch(db, q, limit) {
  if (!db) return { hits: [], total: 0, aggs: null };
  if (q.length < 2) return { hits: [], total: 0, aggs: null };
  const safeQ = q.replace(/"/g, '""');
  try {
    const items = db.prepare(`
      SELECT i.id AS item_id, i.canonical_url AS url, i.title, i.title_zh,
             s.label AS source_label, s.slug AS source_slug,
             a.short_summary_zh, a.one_liner, a.ai_title,
             i.language, i.author, i.published_at, i.score,
             ss.alpha_score AS sig_alpha, ss.novelty_score AS sig_novelty,
             rank AS _score, NULL AS highlight
      FROM items_fts f
      JOIN information_items i ON i.rowid = f.rowid
      JOIN sources s ON i.source_id = s.id
      LEFT JOIN ai_summaries a ON a.item_id = i.id
      LEFT JOIN signal_scores ss ON ss.item_id = i.id
      WHERE items_fts MATCH ?
      ORDER BY rank ASC LIMIT ?
    `).all(`"${safeQ}"`, limit);
    return { hits: items, total: items.length, aggs: null };
  } catch {
    const like = `%${q.replace(/[%_]/g, c => '\\' + c)}%`;
    const items = db.prepare(`
      SELECT i.id AS item_id, i.canonical_url AS url, i.title, i.title_zh,
             s.label AS source_label, s.slug AS source_slug,
             a.short_summary_zh, a.one_liner, a.ai_title,
             i.language, i.author, i.published_at, i.score,
             ss.alpha_score AS sig_alpha, ss.novelty_score AS sig_novelty,
             0 AS _score, NULL AS highlight
      FROM information_items i
      JOIN sources s ON i.source_id = s.id
      LEFT JOIN ai_summaries a ON a.item_id = i.id
      LEFT JOIN signal_scores ss ON ss.item_id = i.id
      WHERE i.title LIKE ? ESCAPE '\\' OR i.title_zh LIKE ? ESCAPE '\\'
         OR a.one_liner LIKE ? ESCAPE '\\'
      ORDER BY COALESCE(ss.alpha_score, 0) DESC LIMIT ?
    `).all(like, like, like, limit);
    return { hits: items, total: items.length, aggs: null };
  }
}

module.exports = {
  sendJSON,
  sendError,
  readBody,
  requireAdmin,
  authThrottled,
  resolveFeedUser,
  cacheGet,
  cacheSet,
  cacheInvalidate,
  ftsSearch,
};
