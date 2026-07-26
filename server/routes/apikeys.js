/**
 * Eagleye — Service API keys (settings)
 *
 * Admin management of the `api_keys` table used by service-to-service
 * callers (e.g. Argus). Endpoints sit behind the admin gate and return the
 * full key value — same posture as services/auth.listApiKeys, which this
 * single-operator deployment already takes.
 */

const { createApiKey, listApiKeys, revokeApiKey } = require('../services/auth');
const { sendJSON, sendError, requireAdmin, readBody } = require('./_shared');

function register(routes) {

  // --- Service API keys: GET (list) / POST (create) ---
  routes['/api/settings/api-keys'] = async (req, res, _parsed) => {
    if (requireAdmin(req, res)) return;
    const method = req.method.toUpperCase();
    if (method === 'GET') {
      return sendJSON(res, 200, { status: 'ok', keys: listApiKeys(req.user.id) });
    }
    if (method === 'POST') {
      try {
        const body = await readBody(req);
        const name = String(body.name || '').trim() || 'service';
        const key = createApiKey(name.slice(0, 80), req.user.id);
        return sendJSON(res, 200, { status: 'ok', key, name });
      } catch (err) {
        return sendError(res, 400, err.message);
      }
    }
    sendError(res, 405, 'Method not allowed');
  };

  // --- Revoke: POST { key } — soft-disable (active=0), rows are kept for audit ---
  routes['/api/settings/api-keys/revoke'] = async (req, res, _parsed) => {
    if (req.method.toUpperCase() !== 'POST') return sendError(res, 405, 'Method not allowed');
    if (requireAdmin(req, res)) return;
    try {
      const body = await readBody(req);
      const key = String(body.key || '');
      if (!key.startsWith('eg_')) return sendError(res, 400, 'Invalid key');
      revokeApiKey(key);
      return sendJSON(res, 200, { status: 'ok' });
    } catch (err) {
      return sendError(res, 400, err.message);
    }
  };
}

module.exports = register;
