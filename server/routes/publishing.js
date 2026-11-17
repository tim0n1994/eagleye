/**
 * Eagleye — Personal publishing routes.
 *
 * The /api gate authenticates; every persisted read/write is scoped by
 * req.user.id. All handlers are explicit async because server.js awaits only
 * AsyncFunction handlers.
 */

const { sendJSON, sendError } = require('./_shared');
const publishing = require('../services/publishing');

function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  sendError(res, 405, 'Method not allowed');
}

async function readJSON(req, maxLen) {
  try {
    // Decode after joining chunks so Chinese characters split across network
    // frames are not replaced with U+FFFD in a saved personal note.
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxLen * 4) throw new Error('Body too large');
      chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.length > maxLen) throw new Error('Body too large');
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw Object.assign(new Error(error && error.message ? error.message : 'Invalid JSON body'), { statusCode: 400 });
  }
}

function route(methods, handler) {
  return async function routeHandler(req, res, parsed, params) {
    res.setHeader('Cache-Control', 'no-store, private');
    if (!req.user?.id) return sendError(res, 401, 'Authentication required');
    if (!methods.includes(req.method)) return methodNotAllowed(res, methods);
    try {
      return await handler(req, res, parsed, params);
    } catch (error) {
      const status = Number.isInteger(error && error.statusCode) ? error.statusCode : 500;
      const message = status === 500 ? 'Publishing request failed' : ((error && error.message) || 'Publishing request failed');
      if (status === 500) console.error('Publishing request failed:', error);
      return sendError(res, status, message);
    }
  };
}

function queryIds(parsed) {
  const raw = String((parsed && parsed.query && parsed.query.ids) || '').trim();
  if (!raw) return [];
  return raw.split(',').map(id => id.trim()).filter(Boolean);
}

function registerPublishingRoutes(routes) {
  routes['/api/publishing/workspace'] = route(['GET', 'PUT'], async (req, res) => {
    if (req.method === 'GET') return sendJSON(res, 200, publishing.workspaceResponse(req.user.id));
    const body = await readJSON(req, 65536);
    const workspace = publishing.saveWorkspace(req.user.id, body);
    const response = publishing.workspaceResponse(req.user.id);
    return sendJSON(res, 200, Object.assign({ status: 'ok', workspace }, response, { workspace }));
  });

  routes['/api/publishing/notes'] = route(['GET'], async (req, res, parsed) => {
    return sendJSON(res, 200, { notes: publishing.listNotes(req.user.id, queryIds(parsed)) });
  });

  routes['/api/publishing/notes/:id'] = route(['PUT'], async (req, res, _parsed, params) => {
    const body = await readJSON(req, 20000);
    return sendJSON(res, 200, { note: publishing.saveNote(req.user.id, params.id, body) });
  });

  routes['/api/publishing/voice'] = route(['GET', 'PUT'], async (req, res) => {
    if (req.method === 'GET') return sendJSON(res, 200, { voice: publishing.getVoiceState(req.user.id) });
    const body = await readJSON(req, 40000);
    return sendJSON(res, 200, { voice: publishing.saveVoice(req.user.id, body) });
  });

  routes['/api/publishing/drafts'] = route(['GET', 'POST'], async (req, res) => {
    if (req.method === 'GET') return sendJSON(res, 200, { drafts: publishing.listDrafts(req.user.id) });
    const body = await readJSON(req, 65536);
    const created = publishing.createDraft(req.user.id, body);
    const draft = await publishing.generateDraft(req.user.id, created.id, {
      timeoutMs: publishing.GENERATION_TIMEOUT_MS,
    });
    return sendJSON(res, 201, { draft });
  });

  routes['/api/publishing/drafts/:id'] = route(['GET', 'PUT'], async (req, res, _parsed, params) => {
    if (req.method === 'GET') return sendJSON(res, 200, { draft: publishing.getDraft(req.user.id, params.id) });
    const body = await readJSON(req, 131072);
    return sendJSON(res, 200, { draft: publishing.updateDraft(req.user.id, params.id, body) });
  });

  routes['/api/publishing/drafts/:id/export'] = route(['GET'], async (req, res, parsed, params) => {
    const format = String(parsed.query?.format || '');
    const result = await publishing.exportDraft(req.user.id, params.id, format);
    res.writeHead(200, {
      'Content-Type': result.contentType || 'application/octet-stream',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(result.filename || 'draft').replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()),
      'Cache-Control': 'no-store, private',
      'Pragma': 'no-cache',
    });
    return res.end(result.body);
  });

  routes['/api/publishing/drafts/:id/cards/:index.png'] = route(['GET'], async (req, res, _parsed, params) => {
    const parsedIndex = Number(params.index);
    const index = Number.isSafeInteger(parsedIndex) ? parsedIndex : -1;
    const png = await publishing.renderCard(req.user.id, params.id, index);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'Cache-Control': 'no-store, private',
      'Pragma': 'no-cache',
    });
    return res.end(png);
  });
}

module.exports = registerPublishingRoutes;
