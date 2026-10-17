/**
 * Eagleye — Research routes
 *
 * Deep-research reports and the Claude Skills catalogue.
 * Split out of api.js; handlers are unchanged.
 */

const { getResearchReport, generateItemResearch } = require('../services/research');
const { getDB } = require('../db/connection');
const { getSkills, getSkillById, getSkillStats } = require('../services/skill-crawler');
const { sendJSON, sendError, readBody } = require('./_shared');

function register(routes) {

  // --- Research API ---
  routes['/api/research'] = async (req, res, parsed) => {
    if (!['GET', 'POST'].includes(req.method)) return sendError(res, 405, 'Use GET to read research or POST to generate');
    if (!req.user) return sendError(res, 401, 'Authentication required');
    let body = {};
    if (req.method === 'POST') {
      try { body = await readBody(req); }
      catch (err) { return sendError(res, 400, err.message); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'JSON object required');
    }
    const itemId = body.item_id || parsed.query?.item_id;
    const itemUrl = body.url || parsed.query?.url;
    if ((!itemId && !itemUrl) || (itemId && typeof itemId !== 'string') || (itemUrl && typeof itemUrl !== 'string')) {
      return sendError(res, 400, 'item_id or url string required');
    }
    const db = getDB();
    if (!db) return sendError(res, 503, 'Database not available');
    const item = itemId
      ? db.prepare('SELECT id FROM information_items WHERE id = ?').get(itemId)
      : db.prepare('SELECT id FROM information_items WHERE canonical_url = ? ORDER BY created_at DESC LIMIT 1').get(itemUrl);
    const cached = item && db.prepare(`SELECT * FROM research_reports
      WHERE item_id = ? AND status = 'completed' AND LENGTH(TRIM(COALESCE(report_markdown, ''), char(9) || char(10) || char(13) || ' ')) > 0
      ORDER BY created_at DESC LIMIT 1`).get(item.id);
    if (cached) {
      return sendJSON(res, 200, { status: 'ok', content: cached.report_markdown, id: cached.id, cached: true,
        model_name: cached.model_name, model_provider: cached.model_provider, llm_metadata: cached.llm_metadata });
    }
    if (req.method === 'GET') {
      if (itemUrl) {
        const legacy = db.prepare("SELECT content FROM research WHERE url = ? AND LENGTH(TRIM(COALESCE(content, ''), char(9) || char(10) || char(13) || ' ')) > 0").get(itemUrl);
        if (legacy) return sendJSON(res, 200, { status: 'ok', content: legacy.content, cached: true, provenance: 'legacy-unverified' });
      }
      return sendError(res, 404, 'No completed research found; POST to generate from an imported item');
    }
    if (!item) return sendError(res, 422, 'URL has not been imported; import the source content before generating research');
    try {
      const result = await generateItemResearch(item.id);
      if (result?.error || !result?.report?.trim()) return sendError(res, 502, result?.error || 'Research generation failed');
      const report = getResearchReport(result.id);
      return sendJSON(res, 200, { status: 'ok', content: result.report, id: result.id, cached: false,
        model_name: report?.model_name, model_provider: report?.model_provider, llm_metadata: report?.llm_metadata });
    } catch (err) {
      return sendError(res, 502, `Research generation failed: ${err.message}`);
    }
  };

  // --- Get Research Report API (§13: GET /api/research/:id) ---
  routes['/api/research/:id'] = (req, res, _parsed, params) => {
    if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');
    const reportId = params?.id || '';
    if (!reportId) return sendError(res, 400, 'Report ID required');

    const report = getResearchReport(reportId);
    if (!report) return sendError(res, 404, 'Report not found');

    sendJSON(res, 200, { status: 'ok', report });
  };

  // --- Research Reports list: GET /api/reports ---
  routes['/api/reports'] = (req, res, parsed) => {
    if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    const limit = Math.min(parseInt(parsed.query.limit || '50', 10), 200);
    const status = parsed.query.status || '';
    const statusFilter = status ? `WHERE status = ?` : '';
    const reports = db.prepare(`
      SELECT id, item_id, status, model_name, created_at, completed_at,
             substr(report_markdown, 1, 200) AS excerpt, error
      FROM research_reports
      ${statusFilter}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...(status ? [status] : []), limit);
    sendJSON(res, 200, { status: 'ok', reports, total: reports.length });
  };

  // --- Skills API (§13: GET /api/skills) ---
  routes['/api/skills'] = (req, res, parsed) => {
    const options = {
      category: parsed.query.category || '',
      search: parsed.query.search || '',
      sort: parsed.query.sort || 'installs',
      source: parsed.query.source || '',
      tag: parsed.query.tag || '',
      limit: parsed.query.limit || '50',
      offset: parsed.query.offset || '0',
    };

    const result = getSkills(options);
    const stats = getSkillStats();

    sendJSON(res, 200, { status: 'ok', ...result, stats });
  };

  // --- Single Skill API (§13: GET /api/skills/:id) ---
  routes['/api/skills/:id'] = (req, res, _parsed, params) => {
    const skillId = params?.id || '';
    const skill = getSkillById(skillId);
    if (!skill) return sendError(res, 404, 'Skill not found');
    sendJSON(res, 200, { status: 'ok', skill });
  };
}

module.exports = register;
