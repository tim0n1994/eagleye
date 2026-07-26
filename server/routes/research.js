/**
 * Eagleye — Research routes
 *
 * Deep-research reports and the Claude Skills catalogue.
 * Split out of api.js; handlers are unchanged.
 */

const { generateId } = require('../services/utils');
const { getResearchReport } = require('../services/research');
const { getDB } = require('../db/connection');
const { getProvider } = require('../services/llm-provider');
const { getSkills, getSkillById, getSkillStats } = require('../services/skill-crawler');
const { sendJSON, sendError } = require('./_shared');

function register(routes) {

  // --- Research API ---
  routes['/api/research'] = async (req, res, parsed) => {
    const itemId = parsed.query.item_id || parsed.query.url;
    const itemUrl = parsed.query.url;
    if (!itemId && !itemUrl) return sendError(res, 400, 'item_id or url required');

    const db = getDB();

    // Check cached research
    if (itemId) {
      const cached = db?.prepare('SELECT * FROM research_reports WHERE item_id = ? AND status = ?').get(itemId, 'completed');
      if (cached) {
        return sendJSON(res, 200, { status: 'ok', content: cached.report_markdown, id: cached.id });
      }
    }

    // Check legacy research table
    if (itemUrl) {
      const cached = db?.prepare('SELECT content FROM research WHERE url = ?').get(itemUrl);
      if (cached) {
        return sendJSON(res, 200, { status: 'ok', content: cached.content });
      }
    }

    // Generate new research
    const item = itemId ? db?.prepare(`
      SELECT i.*, s.label as source_label FROM information_items i 
      JOIN sources s ON i.source_id = s.id WHERE i.id = ?
    `).get(itemId) : null;

    // Get topics
    let topics = [];
    let relatedItems = [];
    if (item) {
      topics = db?.prepare(`
        SELECT t.name FROM item_topics it JOIN topics t ON it.topic_id = t.id WHERE it.item_id = ?
      `).all(item.id).map(r => r.name) || [];
      
      relatedItems = db?.prepare(`
        SELECT i.title FROM information_items i 
        WHERE i.id != ? AND i.source_id = ? 
        ORDER BY i.published_at DESC LIMIT 5
      `).all(item.id, item.source_id).map(r => r.title) || [];
    }

    const provider = getProvider();
    let report = null;
    if (provider) {
      try {
        const researchPrompt = `Generate a comprehensive research report about the following item.

Title: ${item?.title || itemUrl}
Source: ${item?.source_label || 'N/A'}
URL: ${item?.canonical_url || 'N/A'}
Topics: ${(topics || []).join(', ')}
Related: ${(relatedItems || []).slice(0, 3).join(', ')}

Write in Markdown: Executive Summary, Technical Analysis, Market Impact, Key Takeaways, Recommendations.`;
        report = await provider.call(researchPrompt, { temperature: 0.3, maxTokens: 4096 });
      } catch (err) {
        console.error('Research report failed:', err.message);
      }
    }
    const reportId = generateId();

    if (db && itemId) {
      db.prepare(`
        INSERT INTO research_reports (id, item_id, status, prompt, report_markdown, model_provider, model_name, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(reportId, itemId, 'completed', '', report || '', 'gemini', 'gemini-2.0-flash');
    }

    // Cache in legacy table too
    if (db && itemUrl) {
      db.prepare('INSERT OR REPLACE INTO research (url, content) VALUES (?, ?)').run(itemUrl, report || '');
    }

    sendJSON(res, 200, { status: 'ok', content: report || 'Research failed to generate.', id: reportId });
  };

  // --- Get Research Report API (§13: GET /api/research/:id) ---
  routes['/api/research/:id'] = (req, res, _parsed, params) => {
    const reportId = params?.id || '';
    if (!reportId) return sendError(res, 400, 'Report ID required');

    const report = getResearchReport(reportId);
    if (!report) return sendError(res, 404, 'Report not found');

    sendJSON(res, 200, { status: 'ok', report });
  };

  // --- Research Reports list: GET /api/reports ---
  routes['/api/reports'] = (req, res, parsed) => {
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
