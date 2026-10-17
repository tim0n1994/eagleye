/**
 * Eagleye — Server (Refactored)
 *
 * Modular Node.js HTTP server with:
 * - Static file serving
 * - API routes (modular)
 * - Database migrations
 * - RSS proxy
 *
 * Usage: node server.js [port]
 * Default port: 3019
 */

require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');

// --- Boot: Database & Migrations ---
const { getDB } = require('./server/db/connection');
const { runMigrations } = require('./server/db/migrate');
const { sendJSON, sendError, registerRoutes } = require('./server/routes/api');
const { DEFAULT_APP_PORT, parsePort } = require('./server/config');

// --- Configuration ---
const PORT = parsePort(process.argv[2] || process.env.PORT, DEFAULT_APP_PORT);
const ROOT = __dirname;

// --- MIME Types ---
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
};

function mimeType(ext) {
  return MIME[ext] || 'application/octet-stream';
}

// --- Static File Serving ---
// The repo root holds eagleye.db (password hashes, session tokens, API keys),
// .env, server-side source and *.log. Serving ROOT wholesale made all of it
// downloadable without auth, so static serving is restricted to the asset
// surface index.html actually references. Add a path here to make it public.
const PUBLIC_DIRS = ['/css/', '/js/', '/icons/'];
const PUBLIC_FILES = new Set(['/index.html', '/manifest.json', '/sw.js', '/favicon.ico']);

function isPublicAsset(p) {
  return PUBLIC_FILES.has(p) || PUBLIC_DIRS.some((dir) => p.startsWith(dir));
}

// Text assets are worth compressing; the image formats already are.
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.json', '.svg', '.xml']);

// Compressing ~3MB of assets on every request would cost more than it saves, so
// each (file, mtime, encoding) is compressed once and kept. Entries are keyed by
// mtime, so editing a file supersedes its entry rather than serving stale bytes.
const _assetCache = new Map();
const MAX_CACHED_ASSETS = 200;

function negotiateEncoding(accept) {
  const a = String(accept || '');
  if (/(^|,)\s*br\b/.test(a)) return 'br';
  if (/(^|,)\s*gzip\b/.test(a)) return 'gzip';
  return null;
}

function compressAsset(buf, encoding, cb) {
  if (encoding === 'br') {
    // Quality 5 rather than the default 11: ~10x faster to compress for a few
    // percent more bytes, and this runs on the request path the first time.
    zlib.brotliCompress(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }, cb);
  } else {
    zlib.gzip(buf, { level: 6 }, cb);
  }
}

/**
 * Cache policy by path. Module files are imported by bare specifier
 * (`import './pages.js'`) with no version query, so they have no cache-busting
 * mechanism and must be revalidated — `no-cache` means "store it, but check
 * before reuse", which still saves the body via a 304. Vendored libraries and
 * icons carry their version in the filename and change rarely, so they get a
 * bounded max-age instead of `immutable`: with no build step to rename them, a
 * year-long pin would make a bad deploy stick.
 */
function cacheControlFor(safePath) {
  if (safePath.startsWith('/js/lib/') || safePath.startsWith('/icons/')) {
    return 'public, max-age=604800';
  }
  return 'no-cache';
}

function serveStatic(res, reqPath, req) {
  const safePath = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/g, '');
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    return sendError(res, 403, 'Forbidden');
  }

  // 404 rather than 403 so a probe can't distinguish "exists but private".
  if (!isPublicAsset(safePath)) {
    return sendError(res, 404, 'Not Found');
  }

  fs.stat(filePath, (statErr, st) => {
    if (statErr || !st.isFile()) {
      return sendError(res, statErr && statErr.code !== 'ENOENT' ? 500 : 404,
        statErr && statErr.code !== 'ENOENT' ? 'Server Error' : 'Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const etag = `"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
    const base = {
      'Content-Type': mimeType(ext),
      'Cache-Control': cacheControlFor(safePath),
      ETag: etag,
    };

    // Unchanged since the client last fetched it: skip the body entirely.
    if (req && req.headers['if-none-match'] === etag) {
      res.writeHead(304, base);
      return res.end();
    }

    const encoding = COMPRESSIBLE.has(ext) ? negotiateEncoding(req && req.headers['accept-encoding']) : null;
    if (encoding) base.Vary = 'Accept-Encoding';

    const key = `${filePath}|${st.mtimeMs}|${encoding || 'raw'}`;
    const hit = _assetCache.get(key);
    if (hit) {
      if (encoding) base['Content-Encoding'] = encoding;
      res.writeHead(200, base);
      return res.end(hit);
    }

    fs.readFile(filePath, (err, data) => {
      if (err) return sendError(res, err.code === 'ENOENT' ? 404 : 500, err.code === 'ENOENT' ? 'Not Found' : 'Server Error');

      const store = (body) => {
        if (_assetCache.size >= MAX_CACHED_ASSETS) _assetCache.clear();
        _assetCache.set(key, body);
      };

      if (!encoding) {
        store(data);
        res.writeHead(200, base);
        return res.end(data);
      }

      compressAsset(data, encoding, (zErr, out) => {
        // Compression is an optimisation; if it fails, serve the original.
        if (zErr) {
          res.writeHead(200, base);
          return res.end(data);
        }
        store(out);
        base['Content-Encoding'] = encoding;
        res.writeHead(200, base);
        res.end(out);
      });
    });
  });
}

// --- RSS Proxy (kept from original) ---
async function proxyRSS(rssUrl) {
  const { fetchURL } = require('./server/services/utils');
  const xml = await fetchURL(rssUrl);

  const items = [];
  const titleMatch = xml.match(/<title>([^<]*)<\/title>/);
  const feedTitle = titleMatch ? titleMatch[1] : '';

  const itemRegex = /<(item|entry)>([\s\S]*?)<\/\1>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[2];

    const getField = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i'));
      if (m) return m[1];
      const m2 = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m2 ? m2[1].trim() : '';
    };

    let link = getField('link');
    if (!link) {
      const linkHrefMatch = block.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
      link = linkHrefMatch ? linkHrefMatch[1] : '';
    }

    const guidRaw = getField('guid') || getField('id');
    const pubDate = getField('pubDate') || getField('published') || getField('updated');
    const description = getField('description') || getField('content') || getField('summary') || '';

    const extractImg = (html) => {
      if (!html) return '';
      const m = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
      return m ? m[1] : '';
    };

    items.push({
      title: getField('title') || '[No Title]',
      link: link || guidRaw || '',
      pubDate: pubDate || '',
      description: description,
      image: extractImg(description),
    });
  }

  return {
    status: 'ok',
    feed: { title: feedTitle, url: rssUrl },
    items: items.slice(0, 35),
  };
}

// --- Feed Generators ---
// escapeXML lives in services/utils.js; api.js already imports it from there.
const { escapeXML } = require('./server/services/utils');

async function generateFeedXML() {
  const db = getDB();
  if (!db) return '<feed xmlns="http://www.w3.org/2005/Atom"><title>Eagleye</title></feed>';

  const items = db.prepare(`
    SELECT i.*, s.label as source_label, s.slug as source_slug
    FROM information_items i
    JOIN sources s ON i.source_id = s.id
    ORDER BY i.published_at DESC
    LIMIT 50
  `).all();

  const summaries = db.prepare('SELECT item_id, one_liner, short_summary FROM ai_summaries');
  const summaryMap = {};
  summaries.all().forEach(s => { summaryMap[s.item_id] = s; });

  const entries = items.map(item => {
    const summary = summaryMap[item.id] || {};
    const updated = item.published_at || item.created_at;
    return `
  <entry>
    <id>${escapeXML(item.canonical_url || item.id)}</id>
    <title>${escapeXML(item.title)}</title>
    <link href="${escapeXML(item.canonical_url || '')}"/>
    <published>${escapeXML(updated)}</published>
    <updated>${escapeXML(updated)}</updated>
    <author><name>${escapeXML(item.source_label || 'Eagleye')}</name></author>
    <summary type="html">${escapeXML(summary.short_summary || summary.one_liner || '')}</summary>
    <category term="${escapeXML(item.source_slug || '')}"/>
  </entry>`;
  }).join('');

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Eagleye — Technology Intelligence</title>
  <link href="/"/>
  <link rel="self" href="/feed.xml"/>
  <updated>${escapeXML(new Date().toISOString())}</updated>
  <author><name>Eagleye</name></author>
  <id>urn:eagleye:feed</id>
  <subtitle>AI-driven technology intelligence radar</subtitle>${entries}
</feed>`;
}

async function generateFeedJSON() {
  const db = getDB();
  if (!db) return { version: 'https://jsonfeed.org/version/1', title: 'Eagleye' };

  const items = db.prepare(`
    SELECT i.*, s.label as source_label
    FROM information_items i
    JOIN sources s ON i.source_id = s.id
    ORDER BY i.published_at DESC
    LIMIT 50
  `).all();

  const summaries = db.prepare('SELECT item_id, one_liner, short_summary FROM ai_summaries');
  const summaryMap = {};
  summaries.all().forEach(s => { summaryMap[s.item_id] = s; });

  return {
    version: 'https://jsonfeed.org/version/1',
    title: 'Eagleye — Technology Intelligence',
    home_page_url: '/',
    feed_url: '/feed.json',
    description: 'AI-driven technology intelligence radar',
    items: items.map(item => {
      const summary = summaryMap[item.id] || {};
      return {
        id: item.canonical_url || item.id,
        url: item.canonical_url || '',
        title: item.title,
        content_text: summary.short_summary || '',
        summary: summary.one_liner || '',
        date_published: item.published_at || item.created_at,
        authors: [{ name: item.source_label || 'Eagleye' }],
        tags: [item.source_label || ''].filter(Boolean),
      };
    }),
  };
}

// --- Request Handler ---
async function handleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  console.log(`[${new Date().toISOString()}] ${method} ${pathname.replace(/(\/api\/auth\/keys\/).+$/, '$1[REDACTED]')}`);

  try {
    // --- API Routes ---
    // Build the routes map once per request (cheap; avoids stale-handler bugs).
    const routeMap = {};
    registerRoutes(routeMap);

    // --- Clean feed URL aliases (§13): rewrite public feed paths to their
    // /api/ handlers so /topics/:slug/feed.xml etc. work as spec'd. Done before
    // the /api/ check so the alias is transparent to everything below.
    {
      const topicFeed = pathname.match(/^\/topics\/([^/]+)\/feed\.xml$/);
      const entityFeed = pathname.match(/^\/entities\/([^/]+)\/feed\.xml$/);
      const sourceFeed = pathname.match(/^\/feed\/([^/]+)$/);
      const watchlistFeed = pathname === '/watchlist/feed.xml';
      if (watchlistFeed) {
        const handler = routeMap['/api/watchlist/feed.xml'];
        if (handler) return handler(req, res, parsed);
      } else if (topicFeed) {
        const handler = routeMap['/api/topics/:slug/feed.xml'];
        if (handler) return handler(req, res, parsed, { slug: topicFeed[1] });
      } else if (entityFeed) {
        const handler = routeMap['/api/entities/:slug/feed.xml'];
        if (handler) return handler(req, res, parsed, { slug: entityFeed[1] });
      } else if (sourceFeed) {
        const handler = routeMap['/api/feed/:source'];
        if (handler) return handler(req, res, parsed, { source: sourceFeed[1] });
      }
    }

    if (pathname.startsWith('/api/')) {

      // ─── Auth gate: all /api/ routes require login except auth endpoints ───
      const AUTH_WHITELIST = new Set([
        '/api/auth/login', '/api/auth/register', '/api/auth/resend', '/api/auth/verify', '/api/auth/me', '/api/auth/logout',
      ]);
      if (!AUTH_WHITELIST.has(pathname)) {
        const auth = require('./server/services/auth');
        // Try session cookie first, then API key (Authorization: Bearer eg_xxx)
        let user = auth.getSessionUser(req);
        if (!user) {
          const authHeader = req.headers['authorization'] || '';
          const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
          if (bearer) user = auth.getApiKeyOwner(bearer);
        }
        if (!user) return sendError(res, 401, 'Authentication required');
        if (user.status !== 'active') return sendError(res, 403, 'Account disabled');
        req.user = user;
        // Admin-only endpoints
        if (pathname.startsWith('/api/admin/') && user.role !== 'admin') {
          return sendError(res, 403, 'Admin access required');
        }
      }
      // Clean up expired sessions periodically (cheap check)
      if (Math.random() < 0.01) {
        try { getDB().prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run(); } catch {}
      }

      // Match exact routes or parameterized routes
      const handler = routeMap[pathname];

      if (handler) {
        if (handler.constructor.name === 'AsyncFunction') {
          await handler(req, res, parsed);
        } else {
          handler(req, res, parsed);
        }
        return;
      }

      // Try param-based routes (ordered from most to least specific)
      const paramRoutes = [
        { pattern: /^\/api\/topics\/([^/]+)\/feed\.xml$/, handlerName: '/api/topics/:slug/feed.xml' },
        { pattern: /^\/api\/topics\/([^/]+)\/timeline$/, handlerName: '/api/topics/:slug/timeline' },
        { pattern: /^\/api\/topics\/([^/]+)\/graph$/, handlerName: '/api/topics/:slug/graph' },
        { pattern: /^\/api\/topics\/([^/]+)\/research$/, handlerName: '/api/topics/:slug/research' },
        { pattern: /^\/api\/topics\/(.+)$/, handlerName: '/api/topics/:slug' },
        { pattern: /^\/api\/items\/([^/]+)\/summary$/, handlerName: '/api/items/:id/summary' },
        { pattern: /^\/api\/items\/([^/]+)\/research\/chat$/, handlerName: '/api/items/:id/research/chat' },
        { pattern: /^\/api\/items\/([^/]+)\/research$/, handlerName: '/api/items/:id/research' },
        { pattern: /^\/api\/items\/([^/]+)\/deployment-plan$/, handlerName: '/api/items/:id/deployment-plan' },
        { pattern: /^\/api\/items\/([^/]+)\/save$/, handlerName: '/api/items/:id/save' },
        { pattern: /^\/api\/items\/([^/]+)\/seen$/, handlerName: '/api/items/:id/seen' },
        { pattern: /^\/api\/items\/(.+)$/, handlerName: '/api/items/:id' },
        { pattern: /^\/api\/research\/(.+)$/, handlerName: '/api/research/:id' },
        { pattern: /^\/api\/feed\/(.+)$/, handlerName: '/api/feed/:source' },
        { pattern: /^\/api\/skills\/(.+)$/, handlerName: '/api/skills/:id' },
        { pattern: /^\/api\/source\/(.+)$/, handlerName: '/api/source/:slug' },
        { pattern: /^\/api\/tags\/(.+)$/, handlerName: '/api/tags/:slug' },
        { pattern: /^\/api\/domains\/(.+)$/, handlerName: '/api/domains/:slug' },
        { pattern: /^\/api\/deployment-plans\/(.+)$/, handlerName: '/api/deployment-plans/:id' },
        { pattern: /^\/api\/year\/(\d{4})$/, handlerName: '/api/year/:year' },
        { pattern: /^\/api\/jobs\/([^/]+)\/cancel$/, handlerName: '/api/jobs/:id/cancel' },
        { pattern: /^\/api\/jobs\/(.+)$/, handlerName: '/api/jobs/:id' },
        { pattern: /^\/api\/compare\/(.+)$/, handlerName: '/api/compare/:competitor' },
        { pattern: /^\/api\/entities\/([^/]+)\/feed\.xml$/, handlerName: '/api/entities/:slug/feed.xml' },
        { pattern: /^\/api\/entities\/([^/]+)\/series$/, handlerName: '/api/entities/:slug/series' },
        { pattern: /^\/api\/entities\/(.+)$/, handlerName: '/api/entities/:slug' },
        { pattern: /^\/api\/signals\/([^/]+)$/, handlerName: '/api/signals/:id' },
        { pattern: /^\/api\/admin\/users\/([^/]+)\/role$/, handlerName: '/api/admin/users/:id/role' },
        { pattern: /^\/api\/admin\/users\/([^/]+)\/disable$/, handlerName: '/api/admin/users/:id/disable' },
        { pattern: /^\/api\/admin\/users\/([^/]+)\/enable$/, handlerName: '/api/admin/users/:id/enable' },
        { pattern: /^\/api\/auth\/keys\/(.+)$/, handlerName: '/api/auth/keys/:key' },
      ];

      for (const { pattern, handlerName } of paramRoutes) {
        const match = pathname.match(pattern);
        if (match && routeMap[handlerName]) {
          const decoded = decodeURIComponent(match[1]);
          const params = { slug: decoded, id: decoded, year: decoded, source: decoded, key: decoded };
          if (routeMap[handlerName].constructor.name === 'AsyncFunction') {
            await routeMap[handlerName](req, res, parsed, params);
          } else {
            routeMap[handlerName](req, res, parsed, params);
          }
          return;
        }
      }

      return sendError(res, 404, 'API endpoint not found');
    }

    // --- Feed XML ---
    if (pathname === '/feed.xml' || pathname === '/rss.xml') {
      try {
        const feed = await generateFeedXML();
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
        res.end(feed);
      } catch (err) {
        sendError(res, 500, `Feed error: ${err.message}`);
      }
      return;
    }

    // --- Feed JSON ---
    if (pathname === '/feed.json') {
      try {
        const feed = await generateFeedJSON();
        sendJSON(res, 200, feed);
      } catch (err) {
        sendError(res, 500, `Feed error: ${err.message}`);
      }
      return;
    }

    // --- RSS Proxy ---
    if (pathname === '/rss-proxy') {
      const rssUrl = parsed.query.url;
      if (!rssUrl) return sendError(res, 400, 'URL required');

      // Only feeds already registered in `sources` may be proxied. This route is
      // unauthenticated and the origin is published through a Cloudflare tunnel,
      // so an arbitrary `url` let anyone on the internet use the server to read
      // other services on this host and probe the LAN. The one real caller
      // (Sources page) always passes a known sources.feed_url.
      const known = getDB()?.prepare('SELECT 1 FROM sources WHERE feed_url = ?').get(rssUrl);
      if (!known) return sendError(res, 403, 'Feed not registered');

      try {
        const result = await proxyRSS(rssUrl);
        sendJSON(res, 200, result);
      } catch (err) {
        sendError(res, 502, `RSS proxy error: ${err.message}`);
      }
      return;
    }

    // --- OPML export: all source RSS feeds in OPML format for RSS readers ---
    if (pathname === '/opml.xml') {
      try {
        const db = getDB();
        const sources = db.prepare('SELECT label, slug, feed_url FROM sources WHERE is_active = 1 AND feed_url IS NOT NULL').all();
        let opml = '<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n<head><title>Eagleye Sources</title></head>\n<body>\n';
        for (const s of sources) {
          opml += `  <outline text="${s.label.replace(/"/g, '&quot;')}" title="${s.label.replace(/"/g, '&quot;')}" type="rss" xmlUrl="${s.feed_url}" htmlUrl="/sources/${s.slug}"/>\n`;
        }
        // Add watchlist + topic feeds
        opml += `  <outline text="Eagleye Watchlist" type="rss" xmlUrl="http://localhost:${PORT}/watchlist/feed.xml" htmlUrl="/watchlist"/>\n`;
        opml += `  <outline text="Eagleye Main Feed" type="rss" xmlUrl="http://localhost:${PORT}/feed.xml" htmlUrl="/"/>\n`;
        opml += '</body>\n</opml>';
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
        res.end(opml);
      } catch (err) {
        sendError(res, 500, `OPML error: ${err.message}`);
      }
      return;
    }

    // --- Weekly digest email HTML template: standalone email-ready HTML ---
    if (pathname === '/email/digest') {
      try {
        const db = getDB();
        const since7 = (() => {
          const d = new Date(); d.setDate(d.getDate() - 7);
          return d.toISOString().slice(0, 10).replace(/-/g, '');
        })();
        const signals = db.prepare(`
          SELECT ss.signal_type, ss.alpha_score, i.title, i.title_zh, i.canonical_url,
                 i.published_at, s.label as source_label,
                 a.one_liner_zh, a.short_summary_zh
          FROM signal_scores ss
          JOIN information_items i ON i.id = ss.item_id
          JOIN sources s ON i.source_id = s.id
          LEFT JOIN ai_summaries a ON a.item_id = i.id
          WHERE i.digest_date >= ? AND ss.signal_type != 'uncategorized'
          ORDER BY ss.alpha_score DESC LIMIT 15
        `).all(since7);

        let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eagleye Weekly Digest</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f5f5;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden}.header{background:#0e1c2c;color:#e5824e;padding:24px;text-align:center}.header h1{margin:0;font-size:24px}.header p{color:#999;margin:8px 0 0}.body{padding:24px}.item{border-bottom:1px solid #eee;padding:16px 0}.item:last-child{border-bottom:none}.item-title{font-size:15px;font-weight:600;color:#222;text-decoration:none}.item-meta{font-size:12px;color:#999;margin:4px 0}.item-summary{font-size:13px;color:#555;margin:8px 0;line-height:1.5}.badge{display:inline-block;padding:2px 8px;border-radius:3px;font-size:10px;font-weight:600;text-transform:uppercase;margin-right:4px}.footer{text-align:center;padding:20px;color:#999;font-size:11px}</style>
</head><body><div class="container">
<div class="header"><h1>🦅 Eagleye Weekly Digest</h1><p>Your top ${signals.length} signals this week</p></div>
<div class="body">`;
        for (const s of signals) {
          const typeColor = { origin_signal: '#e5824e', new_repo: '#4ec55e', new_paper: '#4e9de5', model_release: '#c54ee5', funding_signal: '#2ecc71', agent_signal: '#9b59b6' }[s.signal_type] || '#888';
          html += `<div class="item">
<a href="${s.canonical_url || '#'}" class="item-title">${(s.title_zh || s.title || '').replace(/</g, '&lt;')}</a>
<div class="item-meta"><span class="badge" style="background:${typeColor};color:#fff">${(s.signal_type || '').replace(/_/g, ' ')}</span> α${(s.alpha_score || 0).toFixed(2)} · ${(s.source_label || '')} · ${(s.published_at || '').slice(0,10)}</div>`;
          if (s.short_summary_zh || s.one_liner_zh) {
            html += `<p class="item-summary">${(s.short_summary_zh || s.one_liner_zh || '').replace(/</g, '&lt;')}</p>`;
          }
          html += `</div>`;
        }
        html += `</div><div class="footer">Generated by Eagleye · ${new Date().toISOString().slice(0,10)}<br/><a href="http://localhost:${PORT}/for-you" style="color:#e5824e">View full radar →</a></div>
</div></body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        sendError(res, 500, `Email template error: ${err.message}`);
      }
      return;
    }

    // --- robots.txt ---
    if (pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`User-agent: *\nAllow: /\nSitemap: http://localhost:${PORT}/sitemap.xml\n`);
      return;
    }

    // --- Sitemap.xml: list stable URLs for SEO (§3: every page has a shareable URL) ---
    if (pathname === '/sitemap.xml') {
      try {
        const db = getDB();
        const base = `http://localhost:${PORT}`;
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
        // Static pages
        const staticPages = ['/', '/for-you', '/papers', '/signals', '/digest', '/sources', '/tools', '/skills', '/kg3d', '/physical-ai', '/intelligence', '/industry-metrics', '/year', '/compare', '/search', '/help', '/saved', '/watchlist', '/stories', '/topics', '/tags'];
        for (const p of staticPages) xml += `  <url><loc>${base}${p}</loc></url>\n`;
        // Sources
        const sources = db.prepare('SELECT slug FROM sources WHERE is_active = 1').all();
        for (const s of sources) xml += `  <url><loc>${base}/sources/${s.slug}</loc></url>\n`;
        // Topics
        const topics = db.prepare('SELECT slug FROM topics').all();
        for (const t of topics) xml += `  <url><loc>${base}/topics/${t.slug}</loc></url>\n`;
        // Recent digest dates (last 30)
        const dates = db.prepare('SELECT DISTINCT digest_date FROM information_items ORDER BY digest_date DESC LIMIT 30').all();
        for (const d of dates) xml += `  <url><loc>${base}/digest/${d.digest_date}</loc></url>\n`;
        // Years
        const years = db.prepare('SELECT DISTINCT substr(digest_date,1,4) AS y FROM information_items').all();
        for (const y of years) xml += `  <url><loc>${base}/year/${y.y}</loc></url>\n`;
        xml += '</urlset>';
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
        res.end(xml);
      } catch (err) {
        sendError(res, 500, `Sitemap error: ${err.message}`);
      }
      return;
    }

    // --- Serve HTML pages for SPA routing ---
    if (pathname === '/' || !path.extname(pathname)) {
      serveStatic(res, '/index.html', req);
    } else {
      serveStatic(res, pathname, req);
    }
  } catch (err) {
    console.error('SERVER ERROR:', err);
    sendError(res, 500, err.message);
  }
}

// --- Start Server ---
const server = http.createServer(handleRequest);

// Graceful error handling: EADDRINUSE used to crash-loop the server (each
// restart hit the still-listening old process, producing the EADDRINUSE storm
// seen in server.log). Now we log clearly and exit so the supervisor can retry
// cleanly, instead of crash-looping into the same port.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ❌ Port ${PORT} is already in use. Another Eagleye instance may be running.`);
    console.error('     Kill it (lsof -ti tcp:' + PORT + ' | xargs kill) or use a different port.\n');
    process.exit(1);
  }
  console.error('Server error:', err.message);
});

// Catch unhandled rejections so a single failed async path doesn't crash the
// whole server (the pipeline has many fire-and-forget background jobs).
process.on('unhandledRejection', (reason) => {
  console.warn('  ⚠  Unhandled promise rejection (non-fatal):', reason?.message || reason);
});

server.listen(PORT, process.env.EAGLEYE_HOST || undefined, () => {
  const addr = `http://localhost:${PORT}`;
  console.log('');
  console.log('  🦅 Eagleye Bot (Orangebot Edition)');
  console.log('  ─────────────────────────────────');
  console.log(`  Server: ${addr}`);
  console.log('');

  // Run database migrations
  console.log('  Running migrations...');
  runMigrations();

  // Migrate legacy data from old items table
  const { run: migrateLegacy } = require('./server/migrations/002_migrate_legacy');
  migrateLegacy();

  const { backfillPublishedProvenance } = require('./server/services/date-contract');
  const publishedBackfill = backfillPublishedProvenance(getDB());
  if (publishedBackfill.scanned > 0) {
    console.log(`  🗓  Published-date contract: ${publishedBackfill.scanned} scanned, ${publishedBackfill.ok} parsed, ${publishedBackfill.unparseable} unparseable, ${publishedBackfill.missing} missing`);
  }

  // Apply static i18n translations (sources, topics)
  const { applyStaticTranslations } = require('./server/i18n/translations');
  const i18nResult = applyStaticTranslations(getDB());
  console.log(`  🌐 Static i18n: ${i18nResult.sources} sources + ${i18nResult.topics} topics translated`);

  const { markInterruptedJobs } = require('./server/services/jobs');
  const interruptedJobs = markInterruptedJobs();
  if (interruptedJobs > 0) {
    console.log(`  🧹 Marked ${interruptedJobs} interrupted background job(s) as failed`);
  }

  // Optional: initial sync (disabled by default — user starts manually or via API)
  console.log('  System ready. Start sync via /api/sync');

  // Start the built-in scheduler heartbeat (daily FULL_PIPELINE / RESCORE_ALL).
  // Config persisted in user_data[scheduler_config]; default disabled until
  // turned on via the Settings page or /api/scheduler.
  try {
    const scheduler = require('./server/services/scheduler');
    scheduler.start();
  } catch (err) {
    console.warn('  ⚠  Scheduler failed to start (non-fatal):', err.message);
  }
  console.log('');
});

// Handle graceful shutdown
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  require('./server/services/scheduler').stop();
  require('./server/services/kg-worker').stopKGWorkers();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    try {
      require('./server/services/jobs').markInterruptedJobs();
    } finally {
      require('./server/db/connection').closeDB();
      process.exit(0);
    }
  };
  const deadline = setTimeout(() => {
    server.closeAllConnections();
    finish();
  }, 10000);
  deadline.unref();
  const closed = new Promise(resolve => server.close(resolve));
  server.closeIdleConnections();
  await Promise.allSettled([closed, require('./server/services/llm-pool').shutdownPool()]);
  clearTimeout(deadline);
  finish();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
