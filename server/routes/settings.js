/**
 * Eagleye — Settings routes
 *
 * Server-level configuration — LLM provider, X-following crawler and the scheduler. Writes are admin-only.
 * Split out of api.js; handlers are unchanged.
 */

const { getDB } = require('../db/connection');
const { runJob, JOB_TYPES } = require('../services/jobs');
const { getLLMConfig, saveLLMConfig, clearLLMConfig, parsePastedLLMConfig, maskSecret, testLLMConfig } = require('../services/llm-provider');
const { getProviderInfo } = require('../services/llm-provider');
const { sendJSON, sendError, requireAdmin } = require('./_shared');

function register(routes) {

  // --- X Following Config: GET / PUT ---
  const { readXFollowingConfig, writeXFollowingConfig, getBlocklistArray, writeBlocklist, readBlocklist } = require('../services/x-following-config');

  routes['/api/settings/x-following'] = (req, res, _parsed) => {
    const method = req.method.toUpperCase();
    if (method !== 'GET' && requireAdmin(req, res)) return;
    if (method === 'GET') {
      const cfg = readXFollowingConfig();
      // Also report seed list from env if no file exists
      const envUsers = (process.env.X_FOLLOWING_USERS || '').split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);
      return sendJSON(res, 200, {
        status: 'ok',
        config: cfg,
        env_users: envUsers,
        blocklist: getBlocklistArray(),
      });
    }
    if (method === 'PUT') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 1048576) req.destroy(); });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const result = { status: 'ok' };
          if (Array.isArray(data.users)) {
            const saved = writeXFollowingConfig(data.users);
            result.saved = saved.users.length;
            result.path = saved.path;
          }
          if (Array.isArray(data.blocked_users)) {
            const savedBl = writeBlocklist(data.blocked_users);
            result.blocked_saved = savedBl.users.length;
            result.blocklist_path = savedBl.path;
          }
          sendJSON(res, 200, result);
        } catch (err) {
          sendError(res, 400, `Invalid JSON: ${err.message}`);
        }
      });
      return;
    }
    sendError(res, 405, 'Method not allowed');
  };

  // --- X Following Cleanup: POST /api/settings/x-following/cleanup ---
  // Removes signal_scores rows for items whose author is in the blocklist,
  // so blocked content disappears from /signals. information_items are kept
  // for audit/recovery. Returns the number of purged signal scores.
  routes['/api/settings/x-following/cleanup'] = (req, res, _parsed) => {
    if (req.method.toUpperCase() !== 'POST') return sendError(res, 405, 'Method not allowed');
    if (requireAdmin(req, res)) return;
    const blocklist = readBlocklist();
    if (blocklist.size === 0) {
      return sendJSON(res, 200, { status: 'ok', purged: 0, message: 'Blocklist is empty — nothing to clean.' });
    }
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    // Build LIKE patterns for blocked handles stored as '@handle' in author.
    const handles = [...blocklist];
    const purged = db.transaction((hs) => {
      let total = 0;
      for (const h of hs) {
        const likeAuthor = `@${h}%`;
        const r = db.prepare(`
          DELETE FROM signal_scores WHERE item_id IN (
            SELECT id FROM information_items WHERE author LIKE ?
          )
        `).run(likeAuthor);
        total += r.changes;
      }
      return total;
    })(handles);
    console.log(`  🧹 Cleaned ${purged} signal_scores for ${handles.length} blocked handles`);
    sendJSON(res, 200, { status: 'ok', purged, blocked_handles: handles.length });
  };

  // --- X Following Sync: POST /api/x-following/sync?background=true ---
  routes['/api/x-following/sync'] = async (req, res, parsed) => {
    const background = parsed.query.background !== 'false';
    if (background) {
      const jobId = await runJob(JOB_TYPES.X_FOLLOWING_SYNC, {});
      return sendJSON(res, 200, { status: 'ok', job_id: jobId, message: 'X following sync queued' });
    }
    try {
      const { syncXFollowing } = require('../services/x-following');
      const result = await syncXFollowing();
      sendJSON(res, 200, { status: 'ok', result });
    } catch (err) {
      sendError(res, 500, `X sync failed: ${err.message}`);
    }
  };

  // --- LLM Provider Info API ---
  routes['/api/llm'] = (req, res, _parsed) => {
    const info = getProviderInfo();
    sendJSON(res, 200, { status: 'ok', ...info });
  };

  // --- LLM Settings: GET current config / PUT new / DELETE reset ---
  // The current server dispatches by pathname only, so we branch on method.
  routes['/api/settings/llm'] = (req, res, _parsed) => {
    const method = req.method.toUpperCase();
    if (method !== 'GET' && requireAdmin(req, res)) return;

    if (method === 'GET') {
      try {
        const cfg = getLLMConfig() || {};
        const info = getProviderInfo();
        sendJSON(res, 200, {
          status: 'ok',
          config: {
            provider: cfg.provider || '',
            model: cfg.model || info.model || '',
            base_url: cfg.base_url || (info.base_url || ''),
            api_key: maskSecret(cfg.api_key),
            source: cfg.source || 'env',
            updated_at: cfg.updated_at || '',
          },
          active: {
            provider: info.provider,
            model: info.model,
            key_configured: info.key_configured,
            base_url: info.base_url || (cfg.provider === 'openai' ? (cfg.base_url || process.env.OPENAI_BASE_URL || '') : ''),
          },
        });
      } catch (err) {
        sendError(res, 500, `Failed to read LLM settings: ${err.message}`);
      }
      return;
    }

    if (method === 'PUT' || method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 1048576) req.destroy(); });
      req.on('end', () => {
        let payload;
        try {
          payload = body ? JSON.parse(body) : {};
        } catch {
          return sendError(res, 400, 'Invalid JSON body');
        }

        try {
          let next = null;
          if (typeof payload.pasted === 'string' && payload.pasted.trim()) {
            const parsed = parsePastedLLMConfig(payload.pasted);
            if (parsed.error) return sendError(res, 400, parsed.error);
            next = parsed;
          } else if (payload.config && typeof payload.config === 'object') {
            const { provider, api_key, base_url, model } = payload.config;
            if (!provider) return sendError(res, 400, 'provider required');
            if (!api_key) return sendError(res, 400, 'api_key required');
            if (!base_url) return sendError(res, 400, 'base_url required');
            if (!model) return sendError(res, 400, 'model required');
            next = { provider, api_key, base_url, model };
          } else {
            return sendError(res, 400, 'Provide either { pasted: "..." } or { config: { provider, api_key, base_url, model } }');
          }

          next.source = payload.config?.source || (payload.pasted ? 'user-pasted' : 'manual');
          saveLLMConfig(next);

          sendJSON(res, 200, {
            status: 'ok',
            message: 'LLM config saved. Provider reloaded.',
            config: {
              ...next,
              api_key: maskSecret(next.api_key),
            },
            active: getProviderInfo(),
          });
        } catch (err) {
          sendError(res, 500, `Failed to save LLM settings: ${err.message}`);
        }
      });
      return;
    }

    if (method === 'DELETE') {
      try {
        clearLLMConfig();
        sendJSON(res, 200, { status: 'ok', message: 'LLM config reset to .env defaults.', active: getProviderInfo() });
      } catch (err) {
        sendError(res, 500, `Failed to reset: ${err.message}`);
      }
      return;
    }

    sendError(res, 405, 'Method not allowed');
  };

  // --- LLM Settings: POST /api/settings/llm/test — ping the endpoint ---
  routes['/api/settings/llm/test'] = async (req, res, _parsed) => {
    try {
      const result = await testLLMConfig();
      sendJSON(res, 200, { status: 'ok', ...result });
    } catch (err) {
      sendError(res, 500, `LLM test failed: ${err.message}`);
    }
  };

  // --- LLM Settings: POST /api/settings/llm/parse — dry-run parse, no save ---
  routes['/api/settings/llm/parse'] = (req, res, _parsed) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1048576) req.destroy(); });
    req.on('end', () => {
      let payload;
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        return sendError(res, 400, 'Invalid JSON body');
      }
      const text = (payload.pasted || '').toString();
      if (!text.trim()) return sendError(res, 400, 'pasted text required');
      const result = parsePastedLLMConfig(text);
      if (result.error) {
        sendJSON(res, 200, { status: 'parse_error', error: result.error });
        return;
      }
      sendJSON(res, 200, {
        status: 'ok',
        ...result,
        masked: { ...result, api_key: maskSecret(result.api_key || '') },
      });
    });
  };

  // --- Scheduler: read/update the built-in daily pipeline schedule ---
  // GET  → current config ({enabled, time, task, lastRun})
  // PUT  → update {enabled?, time?, task?} (validated, persisted to user_data)
  // POST → same as PUT (some clients prefer POST for state changes)
  const handleScheduler = (req, res, _parsed, _params) => {
    const scheduler = require('../services/scheduler');
    if (req.method === 'GET') {
      return sendJSON(res, 200, { status: 'ok', config: scheduler.getConfig() });
    }
    if (requireAdmin(req, res)) return;
    // PUT / POST: parse body
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const patch = {};
        if (typeof data.enabled === 'boolean') patch.enabled = data.enabled;
        if (typeof data.time === 'string') {
          if (!/^\d{1,2}:\d{2}$/.test(data.time)) {
            return sendError(res, 400, 'Invalid time (use HH:MM)');
          }
          const [h, m] = data.time.split(':').map(Number);
          if (h < 0 || h > 23 || m < 0 || m > 59) {
            return sendError(res, 400, 'Invalid time (use HH:MM)');
          }
          patch.time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        }
        if (data.task === 'pipeline' || data.task === 'rescore') patch.task = data.task;
        const next = scheduler.saveConfig(patch);
        sendJSON(res, 200, { status: 'ok', config: next });
      } catch (err) {
        sendError(res, 400, 'Invalid JSON: ' + err.message);
      }
    });
  };
  routes['/api/scheduler'] = handleScheduler;
}

module.exports = register;
