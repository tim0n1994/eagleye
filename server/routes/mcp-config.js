const { readBody, requireAdmin, sendJSON, sendError } = require('./_shared');

/**
 * @param {Record<string, Function>} routes
 * @returns {void}
 */
function register(routes) {
  const { getMcpServerConfig, saveMcpServerConfig } = require('../services/mcp-config');

  routes['/api/settings/mcp'] = async (req, res) => {
    if (requireAdmin(req, res)) return;
    if (req.method === 'GET') {
      return sendJSON(res, 200, { status: 'ok', config: getMcpServerConfig() });
    }
    if (req.method !== 'PUT') return sendError(res, 405, 'Method not allowed');
    try {
      const body = await readBody(req, 2048);
      if (typeof body.enabled !== 'boolean') {
        return sendError(res, 400, 'A boolean "enabled" field is required');
      }
      const config = saveMcpServerConfig({ enabled: body.enabled });
      return sendJSON(res, 200, { status: 'ok', config });
    } catch {
      return sendError(res, 400, 'Invalid request body. "enabled" must be a boolean.');
    }
  };
}

module.exports = register;
