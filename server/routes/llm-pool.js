const { readBody, requireAdmin, sendJSON, sendError } = require('./_shared');

/**
 * @param {Record<string, Function>} routes
 * @returns {void}
 */
function register(routes) {
  const pool = require('../services/llm-pool');

  routes['/api/settings/llm/pool'] = async (req, res) => {
    if (requireAdmin(req, res)) return;
    if (req.method === 'GET') {
      return sendJSON(res, 200, { status: 'ok', config: pool.getPoolConfig(), ...pool.getPoolStatus() });
    }
    if (req.method !== 'PUT') return sendError(res, 405, 'Method not allowed');
    try {
      const body = await readBody(req, 65536);
      const config = typeof body.pasted === 'string'
        ? { ...pool.parsePastedPoolConfig(body.pasted, { masked: false }), enabled: body.enabled === true }
        : body.config;
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return sendError(res, 400, 'Provide a pool config or pasted endpoint block');
      }
      const saved = pool.savePoolConfig(config);
      return sendJSON(res, 200, { status: 'ok', config: saved, ...pool.getPoolStatus() });
    } catch {
      return sendError(res, 400, 'Invalid endpoint pool configuration. Check endpoint IDs, full URLs, models, keys and limits.');
    }
  };

  routes['/api/settings/llm/pool/parse'] = async (req, res) => {
    if (requireAdmin(req, res)) return;
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    try {
      const { pasted } = await readBody(req, 65536);
      const config = pool.parsePastedPoolConfig(pasted);
      return sendJSON(res, 200, { status: 'ok', config });
    } catch {
      return sendError(res, 400, 'Could not parse endpoint configuration. Include a full Messages or Chat URL, API key and model for each endpoint.');
    }
  };

  routes['/api/settings/llm/pool/test'] = async (req, res) => {
    if (requireAdmin(req, res)) return;
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    try {
      const { endpoint_id: endpointId } = await readBody(req, 2048);
      if (typeof endpointId !== 'string' || !endpointId || endpointId.length > 128) {
        return sendError(res, 400, 'A saved endpoint_id is required');
      }
      const result = await pool.testPoolEndpoint(endpointId);
      return sendJSON(res, 200, { status: 'ok', ...result });
    } catch {
      return sendError(res, 400, 'Endpoint test unavailable. Check the saved endpoint ID and configuration.');
    }
  };

  routes['/api/settings/llm/pool/failures'] = async (req, res) => {
    if (requireAdmin(req, res)) return;
    if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');
    const days = Number(new URL(req.url, 'http://localhost').searchParams.get('days'));
    return sendJSON(res, 200, { status: 'ok', ...pool.getLlmFailureBreakdown(days > 0 ? { days } : {}) });
  };
}

module.exports = register;
