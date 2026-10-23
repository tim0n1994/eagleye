/**
 * Research module sunset — endpoint contract (CTO option C, 2026-10-21).
 *
 * The research backend was removed by 58650a7 (routes/research.js, the
 * items.js and taxonomy.js research handlers, services/research.js). The
 * sunset decision pins the HTTP surface instead of letting these paths decay
 * into ambiguous 404s: every original research endpoint must answer
 * 410 Gone — the standard "deliberately and permanently removed" semantic —
 * via a small stub route, for any caller that still holds an old URL.
 *
 * Endpoints (per the sunset checklist):
 *   GET  /api/research                    (old list / cached read)
 *   POST /api/research                    (old generate-by-URL)
 *   GET  /api/research/:id                (old single report read)
 *   GET  /api/reports                     (old research_reports listing)
 *   POST /api/items/:id/research          (old sync trigger, ?force=true variant)
 *   POST /api/items/:id/research/chat     (old research chat)
 *   POST /api/topics/:slug/research       (old topic trigger)
 *
 * How this is tested: the REAL route table is built through
 * server/routes/api.js registerRoutes(), and the REAL dispatch table (the
 * paramRoutes list inside server.js handleRequest) is parsed from the
 * server.js source, so these tests exercise the same exact-match-then-ordered-
 * param-match resolution production uses — including the ordering constraint
 * that e.g. /api/items/:id/research must be matched before the /api/items/:id
 * catch-all. Handlers are invoked directly, which is what handleRequest does
 * for an authenticated request (the /api/ auth gate runs before dispatch and
 * is not part of this contract).
 *
 * RED against the pre-sunset HEAD: no research route is registered at all, so
 * exact paths resolve to nothing and param paths fall into catch-alls.
 */

// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const nodeUrl = require('node:url');

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..', '..');

// Route modules must be required with a throwaway DB so nothing in the real
// worktree is touched; the 410 stubs themselves never query anything.
const previousDbPath = process.env.EAGLEYE_DB_PATH;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-sunset-routes-'));
process.env.EAGLEYE_DB_PATH = path.join(directory, 'routes.sqlite');

const { registerRoutes } = require('../../routes/api');
const routeMap = {};
registerRoutes(routeMap);

// Parse the paramRoutes dispatch list out of server.js. Entries look like:
//   { pattern: /^\/api\/items\/([^/]+)\/research$/, handlerName: '/api/items/:id/research' },
// The regex bodies contain escaped slashes and raw '/' inside character
// classes, so capture the literal text between the outer slashes and rebuild
// it with new RegExp() rather than pattern-matching the body structure.
const serverSource = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');
const paramRoutes = [];
{
  const entry = /\{\s*pattern:\s*(\/.+?\/)\s*,\s*handlerName:\s*'([^']+)'\s*\}/g;
  let match;
  while ((match = entry.exec(serverSource)) !== null) {
    const parts = match[1].match(/^\/(.*)\/([a-z]*)$/s);
    paramRoutes.push({ pattern: new RegExp(parts[1], parts[2]), handlerName: match[2] });
  }
}

// Mirror of server.js handleRequest resolution: exact key first, then the
// ordered paramRoutes list; first pattern whose handler is registered wins.
function resolveRoute(pathname) {
  if (routeMap[pathname]) return { key: pathname, handler: routeMap[pathname], params: undefined };
  for (const { pattern, handlerName } of paramRoutes) {
    const match = pathname.match(pattern);
    if (match && routeMap[handlerName]) {
      const decoded = decodeURIComponent(match[1]);
      // Same params shape server.js hands to param handlers.
      const params = { slug: decoded, id: decoded, year: decoded, source: decoded, key: decoded };
      return { key: handlerName, handler: routeMap[handlerName], params };
    }
  }
  return null;
}

async function call(method, requestUrl, body, expectedKey) {
  const parsed = nodeUrl.parse(requestUrl, true);
  const resolved = resolveRoute(parsed.pathname);
  expect(resolved, `no registered route dispatches ${method} ${requestUrl}`).toBeTruthy();
  // Assert the dispatch target BEFORE invoking, so a mis-dispatched URL (e.g.
  // swallowed by the /api/items/:id catch-all) fails loudly here instead of
  // running an unrelated live handler against the fixture DB.
  expect(resolved.key, `dispatch target for ${method} ${requestUrl}`).toBe(expectedKey);

  const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
  Object.assign(req, {
    method,
    url: requestUrl,
    headers: {},
    user: { id: 'research-sunset-check', role: 'admin', status: 'active' },
  });
  let status = 0;
  let headers = {};
  let raw = '';
  const res = {
    writeHead(code, hdrs) { status = code; headers = hdrs || {}; },
    end(payload) { raw = payload ?? ''; },
  };
  await resolved.handler(req, res, parsed, resolved.params);
  await new Promise(resolve => setImmediate(resolve));
  return { status, headers, body: raw ? JSON.parse(raw) : null };
}

// The body must say the resource is gone — permanent removal, not a generic
// failure and not a bare 404 "never existed".
const GONE_HINT = /gone|removed|retired|sunset|deprecat|no longer/i;

afterAll(() => {
  if (previousDbPath === undefined) delete process.env.EAGLEYE_DB_PATH;
  else process.env.EAGLEYE_DB_PATH = previousDbPath;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('dispatch table sanity', () => {
  it('parsed the real paramRoutes list out of server.js', () => {
    // If server.js is ever reformatted so this parser silently matches
    // nothing, these bounds fail instead of the sunset tests vacuously
    // passing on an empty dispatch table.
    expect(paramRoutes.length).toBeGreaterThanOrEqual(20);
    expect(paramRoutes.some(entry => entry.handlerName === '/api/items/:id')).toBe(true);
    expect(paramRoutes.some(entry => entry.handlerName === '/api/topics/:slug')).toBe(true);
  });
});

describe('retired research endpoints answer 410 Gone', () => {
  it.each([
    ['GET', '/api/research', undefined, '/api/research', 'old list / cached read'],
    ['POST', '/api/research', { url: 'https://example.com/article' }, '/api/research', 'old generate by URL'],
    ['GET', '/api/research/rep-1', undefined, '/api/research/:id', 'old single report read'],
    ['GET', '/api/reports', undefined, '/api/reports', 'old research_reports listing'],
    ['POST', '/api/items/item-1/research', undefined, '/api/items/:id/research', 'old sync item trigger'],
    ['POST', '/api/items/item-1/research?force=true', undefined, '/api/items/:id/research', 'old forced item trigger'],
    ['POST', '/api/items/item-1/research/chat', { message: 'hi', history: [] }, '/api/items/:id/research/chat', 'old research chat'],
    ['POST', '/api/topics/topic-1/research', undefined, '/api/topics/:slug/research', 'old topic trigger'],
  ])('%s %s → 410 (%s)', async (method, requestUrl, body, expectedKey) => {
    const response = await call(method, requestUrl, body, expectedKey);
    expect(response.status, `status for ${method} ${requestUrl}`).toBe(410);
    expect(String(response.body?.error), `Gone message for ${method} ${requestUrl}`).toMatch(GONE_HINT);
    expect(String(response.headers['Content-Type']), `content-type for ${method} ${requestUrl}`).toContain('application/json');
  });
});
