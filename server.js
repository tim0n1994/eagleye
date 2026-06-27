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
function serveStatic(res, reqPath) {
  const safePath = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/g, '');
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    return sendError(res, 403, 'Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        sendError(res, 404, 'Not Found');
      } else {
        sendError(res, 500, 'Server Error');
      }
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': mimeType(ext) };
    if (ext === '.js' || ext === '.css') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    }
    res.writeHead(200, headers);
    res.end(data);
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
function escapeXML(str) {
  return String(str || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')  // strip XML-invalid control chars
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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

  console.log(`[${new Date().toISOString()}] ${method} ${req.url}`);

  try {
    // --- API Routes ---
    if (pathname.startsWith('/api/')) {
      // Build routes map on first call
      const routeMap = {};
      registerRoutes(routeMap);

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
        { pattern: /^\/api\/topics\/(.+)$/, handlerName: '/api/topics/:slug' },
        { pattern: /^\/api\/items\/([^/]+)\/summary$/, handlerName: '/api/items/:id/summary' },
        { pattern: /^\/api\/items\/([^/]+)\/research\/chat$/, handlerName: '/api/items/:id/research/chat' },
        { pattern: /^\/api\/items\/([^/]+)\/research$/, handlerName: '/api/items/:id/research' },
        { pattern: /^\/api\/items\/([^/]+)\/deployment-plan$/, handlerName: '/api/items/:id/deployment-plan' },
        { pattern: /^\/api\/items\/([^/]+)\/save$/, handlerName: '/api/items/:id/save' },
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
      ];

      // More specific routes must come before less specific ones
      const specificRoutes = [
        '/api/topics/build',
        '/api/topics/:slug/feed.xml',
        '/api/jobs/fetch-source',
        '/api/jobs/build-year-archive',
        '/api/signals/rescore',
      ];
      for (const specific of specificRoutes) {
        if (pathname === specific && routeMap[specific]) {
          if (routeMap[specific].constructor.name === 'AsyncFunction') {
            await routeMap[specific](req, res, parsed);
          } else {
            routeMap[specific](req, res, parsed);
          }
          return;
        }
      }

      for (const { pattern, handlerName } of paramRoutes) {
        const match = pathname.match(pattern);
        if (match && routeMap[handlerName]) {
          const decoded = decodeURIComponent(match[1]);
          const params = { slug: decoded, id: decoded, year: decoded, source: decoded };
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

      try {
        const result = await proxyRSS(rssUrl);
        sendJSON(res, 200, result);
      } catch (err) {
        sendError(res, 502, `RSS proxy error: ${err.message}`);
      }
      return;
    }

    // --- Serve HTML pages for SPA routing ---
    if (pathname === '/' || !path.extname(pathname)) {
      serveStatic(res, '/index.html');
    } else {
      serveStatic(res, pathname);
    }
  } catch (err) {
    console.error('SERVER ERROR:', err);
    sendError(res, 500, err.message);
  }
}

// --- Start Server ---
const server = http.createServer(handleRequest);

server.listen(PORT, () => {
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
  console.log('');
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  const { closeDB } = require('./server/db/connection');
  closeDB();
  server.close(() => process.exit(0));
});
