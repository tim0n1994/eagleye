/**
 * Eagleye — Discovery routes
 *
 * Cross-cutting discovery: global search, competitor compare, story clusters and the watchlist.
 * Split out of api.js; handlers are unchanged.
 */

const { escapeXML } = require('../services/utils');
const { getDB } = require('../db/connection');
const { sendJSON, sendError, resolveFeedUser, cacheGet, cacheSet } = require('./_shared');

function register(routes) {

  // --- Stories: cross-source clusters of the same event (PRD-3) ---
  // GET /api/stories[?date=YYYYMMDD][&sinceDays=N][&limit=100]
  // Returns clusters of items that describe the same story across sources,
  // ranked cross-source-first. Pure query-time aggregation (no writes).
  routes['/api/stories'] = (req, res, parsed) => {
    const { getStories } = require('../services/story-clusters');
    const stories = getStories({
      date: parsed.query.date || '',
      sinceDays: parseInt(parsed.query.sinceDays || '7', 10),
      limit: Math.min(parseInt(parsed.query.limit || '100', 10), 500),
    });
    sendJSON(res, 200, {
      status: 'ok',
      stories,
      total: stories.length,
      cross_source_count: stories.filter(s => s.cross_source).length,
    });
  };

  // --- Watchlist (PRD-4): subscribe to entities / signal types ---
  // GET  /api/watchlist        → { subs }
  // GET  /api/watchlist/feed   → aggregated items matching any subscription
  // POST /api/watchlist        body {kind, value, label, add?} → toggle
  routes['/api/watchlist'] = (req, res, parsed) => {
    const wl = require('../services/watchlist');
    if (req.method === 'GET') {
      return sendJSON(res, 200, { status: 'ok', ...wl.getAll(req.user.id) });
    }
    // POST: parse body
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const add = data.add === true ? true : data.add === false ? false : undefined;
        const result = wl.toggle(data.kind, data.value, data.label, add, req.user.id);
        sendJSON(res, 200, { status: 'ok', subs: result.subs, added: result.added });
      } catch (err) {
        sendError(res, 400, err.message);
      }
    });
  };

  routes['/api/watchlist/feed'] = (req, res, parsed) => {
    const wl = require('../services/watchlist');
    const items = wl.getFeed({
      sinceDays: parseInt(parsed.query.sinceDays || '7', 10),
      limit: Math.min(parseInt(parsed.query.limit || '100', 10), 500),
      userId: req.user.id,
    });
    sendJSON(res, 200, { status: 'ok', items, total: items.length });
  };

  // --- Watchlist Atom feed: subscribe to all watched entities/types in one feed ---
  routes['/api/watchlist/feed.xml'] = (req, res, parsed) => {
    const wl = require('../services/watchlist');
    // A watchlist is personal data. Unlike the topic/entity/source feeds, which
    // publish already-public aggregate content, this one names what one account
    // chose to track, so it requires that account.
    const owner = resolveFeedUser(req, parsed);
    if (!owner) return sendError(res, 401, 'Authentication required (use ?key=<api key> for RSS readers)');
    const items = wl.getFeed({ sinceDays: 7, limit: 50, userId: owner.id });
    let atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Eagleye Watchlist</title>
  <link href="/watchlist"/>
  <link rel="self" href="/api/watchlist/feed.xml"/>
  <updated>${escapeXML(new Date().toISOString())}</updated>
  <id>urn:eagleye:watchlist</id>`;
    for (const item of items) {
      atom += `
  <entry>
    <id>${escapeXML(item.canonical_url || item.id)}</id>
    <title>${escapeXML(item.title)}</title>
    <link href="${escapeXML(item.canonical_url || '')}"/>
    <published>${escapeXML(item.published_at || '')}</published>
    <updated>${escapeXML(item.published_at || '')}</updated>
    <summary>${escapeXML((item.signal_type || '') + ' — ' + (item.source_label || ''))}</summary>
  </entry>`;
    }
    atom += '\n</feed>';
    res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
    res.end(atom);
  };

  // --- Compare (§7.9) ---
  // GET /api/compare           → feature matrix + persona matrix
  // GET /api/compare/:competitor → side-by-side comparison data
  routes['/api/compare'] = (_req, res) => {
    const cached = cacheGet('compare:matrix');
    if (cached) return sendJSON(res, 200, cached);
    // Static decision matrix — the competitive positioning doesn't come from
    // the DB; it's a curated product definition (§7.9 spec).
    const dimensions = [
      { key: 'sources', label: 'Source coverage', eagleye: '19 sources incl. Reddit/XiaoHongShu', hackertab: '~15', feedly: 'user RSS', techmeme: '~20 curated', dailydev: '~12 dev' },
      { key: 'ai_summary', label: 'AI summary per item', eagleye: '✓ Chinese knowledge card', hackertab: '—', feedly: '—', techmeme: 'editor summary', dailydev: '—' },
      { key: 'alpha_score', label: 'Multi-dim alpha scoring', eagleye: '✓ 6-dim + 3 audiences', hackertab: '—', feedly: '—', techmeme: '—', dailydev: '—' },
      { key: 'personalization', label: 'Personal filter + watchlist', eagleye: '✓ For-You + lens', hackertab: '—', feedly: '✓ ML', techmeme: '—', dailydev: '✓ basic' },
      { key: 'stories', label: 'Cross-source story clustering', eagleye: '✓', hackertab: '—', feedly: 'partial', techmeme: '✓ editorial', dailydev: '—' },
      { key: 'knowledge_graph', label: 'Live knowledge graph', eagleye: '✓ KG v2 + 3D', hackertab: '—', feedly: '—', techmeme: '—', dailydev: '—' },
      { key: 'deep_research', label: 'Deep research action', eagleye: '✓ per-item + topic', hackertab: '—', feedly: '—', techmeme: '—', dailydev: '—' },
      { key: 'deploy', label: '1-click deploy analysis', eagleye: '✓ GitHub repos', hackertab: '—', feedly: '—', techmeme: '—', dailydev: '—' },
      { key: 'language', label: 'Chinese-first', eagleye: '✓', hackertab: '—', feedly: '—', techmeme: '—', dailydev: '—' },
      { key: 'self_hosted', label: 'Self-hosted / local', eagleye: '✓', hackertab: '✓ ext', feedly: '—', techmeme: '—', dailydev: '—' },
      { key: 'signup', label: 'Sign-up friction', eagleye: 'none', hackertab: 'none', feedly: 'account', techmeme: 'none', dailydev: 'account' },
    ];
    const personas = [
      { key: 'solo_dev', label: 'Solo developer', best: 'eagleye', why: 'AI cards + deploy + deep research' },
      { key: 'ai_researcher', label: 'AI researcher', best: 'eagleye', why: 'arXiv + HF papers + topic graph + trajectories' },
      { key: 'indie_hacker', label: 'Indie hacker', best: 'eagleye', why: 'Product Hunt + funding signals + alpha radar' },
      { key: 'founder_vc', label: 'Founder / VC', best: 'eagleye', why: 'Investor lens + entity momentum + stories' },
      { key: 'casual', label: 'Casual reader', best: 'dailydev', why: 'Lowest friction, dev-community focus' },
      { key: 'enterprise', label: 'Enterprise team', best: 'feedly', why: 'Mature multi-user, MFA, integrations' },
    ];
    const data = { status: 'ok', dimensions, personas };
    cacheSet('compare:matrix', data, 60 * 60 * 1000); // 1h — fully static
    sendJSON(res, 200, data);
  };

  // --- Global Search (missing) ---
  // GET /api/search?q=...&limit=N
  // Searches item titles + AI summaries via FTS5 (trigram tokenizer, bilingual).
  // Ranked by BM25 relevance blended with alpha score.
  routes['/api/search'] = (req, res, parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    const q = (parsed.query.q || '').trim();
    if (q.length < 2) return sendJSON(res, 200, { status: 'ok', items: [], total: 0, q });
    const limit = Math.min(parseInt(parsed.query.limit || '50', 10), 200);

    // Sanitize for FTS5 MATCH: wrap in double-quotes to treat as a phrase,
    // escaping any embedded double-quotes. The trigram tokenizer handles
    // substring matching for both English and Chinese.
    const safeQ = q.replace(/"/g, '""');
    try {
      const items = db.prepare(`
        SELECT i.id, i.title, i.title_zh, i.canonical_url, i.digest_date, i.published_at,
               s.label AS source_label, s.slug AS source_slug,
               a.one_liner_zh, a.short_summary_zh,
               ss.alpha_score, ss.signal_type,
               rank AS fts_rank
        FROM items_fts f
        JOIN information_items i ON i.rowid = f.rowid
        JOIN sources s ON i.source_id = s.id
        LEFT JOIN ai_summaries a ON a.item_id = i.id
        LEFT JOIN signal_scores ss ON ss.item_id = i.id
        WHERE items_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `).all(`"${safeQ}"`, limit);

      sendJSON(res, 200, { status: 'ok', items, total: items.length, q, engine: 'fts5' });
    } catch (err) {
      // FTS5 table may not exist (pre-migration) — fall back to LIKE.
      const like = `%${q.replace(/[%_]/g, c => '\\' + c)}%`;
      const items = db.prepare(`
        SELECT i.id, i.title, i.title_zh, i.canonical_url, i.digest_date, i.published_at,
               s.label AS source_label, s.slug AS source_slug,
               a.one_liner_zh, a.short_summary_zh, ss.alpha_score, ss.signal_type, 0 AS fts_rank
        FROM information_items i
        JOIN sources s ON i.source_id = s.id
        LEFT JOIN ai_summaries a ON a.item_id = i.id
        LEFT JOIN signal_scores ss ON ss.item_id = i.id
        WHERE i.title LIKE ? ESCAPE '\\' OR i.title_zh LIKE ? ESCAPE '\\'
           OR a.one_liner_zh LIKE ? ESCAPE '\\' OR a.short_summary_zh LIKE ? ESCAPE '\\'
        ORDER BY COALESCE(ss.alpha_score, 0) DESC LIMIT ?
      `).all(like, like, like, like, limit);
      sendJSON(res, 200, { status: 'ok', items, total: items.length, q, engine: 'like-fallback' });
    }
  };
}

module.exports = register;
