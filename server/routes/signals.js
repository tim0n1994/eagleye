/**
 * Eagleye — Signals, entities and personalisation routes
 *
 * The alpha-radar surface: signal scoring and listing, entity momentum and
 * trajectories, the personal lens, audience re-ranking, seen-state and the
 * For-You feed. Everything personal here is scoped to req.user.
 */

const { getValue, setValue } = require('../db/user-data');
const {
  getSignals, getTodaySignals, getSignalById, getSignalTypes, getEntityMomentum,
  getRadarAudiences, getEntityItems, getEntitySeries, compareEntitySeries, getEntityCoOccurrence,
} = require('../services/signals');
const { runJob, JOB_TYPES } = require('../services/jobs');
const { escapeXML } = require('../services/utils');
const { sendJSON, sendError } = require('./_shared');

function register(routes) {
  // --- Signal Types API ---
  routes['/api/signal-types'] = (req, res, _parsed) => {
    const types = getSignalTypes();
    sendJSON(res, 200, { status: 'ok', types });
  };

  // --- Personal filter (Batch B6) ---
  // POST /api/items/:id/seen   → mark item seen (idempotent), invalidate profile
  // GET  /api/profile          → derived user interest profile
  // GET  /api/for-you          → personalised feed (alpha × relevance, unseen-first)
  routes['/api/items/:id/seen'] = (req, res, _parsed, params) => {
    const relevance = require('../services/relevance');
    const itemId = params?.id || '';
    if (!itemId) return sendError(res, 400, 'Item ID required');
    relevance.markSeen(itemId, req.user.id);
    sendJSON(res, 200, { status: 'ok', seen: true });
  };

  // POST /api/seen/batch — mark multiple items as seen ("mark all as read")
  routes['/api/seen/batch'] = (req, res) => {
    const relevance = require('../services/relevance');
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 32768) req.destroy(); });
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const ids = Array.isArray(data.item_ids) ? data.item_ids : [];
        const count = relevance.markManySeen(ids, req.user.id);
        sendJSON(res, 200, { status: 'ok', marked: count });
      } catch (err) {
        sendError(res, 400, 'Invalid JSON: ' + err.message);
      }
    });
  };

  routes['/api/profile'] = (req, res) => {
    const relevance = require('../services/relevance');
    const profile = relevance.getCachedProfile(req.user.id);
    // Project entities Set → array for JSON.
    sendJSON(res, 200, {
      status: 'ok',
      profile: {
        types: profile.types,
        entities: [...profile.entities],
        sources: profile.sources,
        has_signal: profile.has_signal,
      },
    });
  };

  routes['/api/for-you'] = (req, res, parsed) => {
    const relevance = require('../services/relevance');
    const result = relevance.getForYou({
      sinceDays: parseInt(parsed.query.sinceDays || '3', 10),
      limit: Math.min(parseInt(parsed.query.limit || '60', 10), 200),
      userId: req.user.id,
    });
    sendJSON(res, 200, { status: 'ok', ...result });
  };

  // --- Signals API ---
  // ?audience=developer|researcher|investor re-ranks by that lens (Phase 2):
  // the base alpha_score is preserved as alpha_score_base and a reweighted
  // alpha_score_audience is returned + used for ORDER BY.
  routes['/api/signals'] = (req, res, parsed) => {
    const signalType = parsed.query.type || 'all';
    const date = parsed.query.date || '';
    const sinceDays = parsed.query.sinceDays ? parseInt(parsed.query.sinceDays, 10) : null;
    const sortBy = parsed.query.sort || 'alpha_score';
    const audience = parsed.query.audience || '';
    const limit = parseInt(parsed.query.limit || '50', 10);
    const offset = parseInt(parsed.query.offset || '0', 10);
    // ?lens=mine (PRD-5): apply the user's saved personal lens to re-rank. The
    // lens takes precedence over any audience param — the user's explicit choice
    // wins over a preset. Invalid/empty lens degrades to the audience path.
    let lens = null;
    if (parsed.query.lens === 'mine') {
      lens = (getValue('personal_lens', req.user.id) || {}).types || null;
    }

    const signals = getSignals({ signalType, date, sinceDays, sortBy, audience, limit, offset, lens });
    sendJSON(res, 200, { status: 'ok', signals, audience: audience || null, lens_active: !!lens });
  };

  // --- Personal Alpha Lens (PRD-5): user-defined signal-type weighting ---
  // GET  /api/lens       → { lens: { types: {...} } | null }
  // POST /api/lens       body { types: {<signal_type>: <0.5-1.5>} } → save
  // DELETE /api/lens     → clear (revert to audience/preset ranking)
  const handleLens = (req, res) => {
    if (req.method === 'GET') {
      return sendJSON(res, 200, { status: 'ok', lens: getValue('personal_lens', req.user.id) || null });
    }
    if (req.method === 'DELETE') {
      setValue('personal_lens', null, req.user.id);
      return sendJSON(res, 200, { status: 'ok', cleared: true });
    }
    // POST: parse body
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 16384) req.destroy(); });
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const types = data.types || data;
        if (!types || typeof types !== 'object') {
          return sendError(res, 400, 'Expected { types: { signal_type: multiplier } }');
        }
        // Validate against the canonical signal type set + clamp multipliers.
        const validTypes = new Set(getSignalTypes().map(t => t.slug));
        const cleaned = {};
        for (const [k, v] of Object.entries(types)) {
          if (validTypes.has(k) && Number.isFinite(Number(v))) {
            cleaned[k] = Math.max(0.5, Math.min(1.5, Number(v)));
          }
        }
        setValue('personal_lens', { types: cleaned, updated_at: new Date().toISOString() }, req.user.id);
        sendJSON(res, 200, { status: 'ok', lens: { types: cleaned } });
      } catch (err) {
        sendError(res, 400, 'Invalid JSON: ' + err.message);
      }
    });
  };
  routes['/api/lens'] = handleLens;

  // --- Radar audiences: weight definitions for the /signals lens switcher ---
  routes['/api/radar/audiences'] = (req, res, _parsed) => {
    sendJSON(res, 200, { status: 'ok', audiences: getRadarAudiences() });
  };

  // --- Today's Top Signals ---
  routes['/api/signals/today'] = (req, res, parsed) => {
    const limit = parseInt(parsed.query.limit || '50', 10);
    const result = getTodaySignals(limit);
    sendJSON(res, 200, { status: 'ok', ...result });
  };

  // --- Rescore Signals: POST /api/signals/rescore[?all=true][&date=YYYYMMDD][&limit=500]
  //   ?all=true           → RESCORE_ALL: re-classify the FULL corpus (all
  //                         digest_dates), filling the backlog the daily
  //                         pipeline leaves behind. Long-running; singleton job.
  //   ?date=YYYYMMDD      → SCORE_SIGNALS: re-classify one date only (default today).
  //   ?limit=N            → cap per-date item count (single-date mode only).
  routes['/api/signals/rescore'] = async (req, res, parsed) => {
    const all = parsed.query.all === 'true' || parsed.query.all === '1';
    if (all) {
      const jobId = await runJob(JOB_TYPES.RESCORE_ALL, { concurrency: parseInt(parsed.query.concurrency || '0', 10) || undefined });
      return sendJSON(res, 200, {
        status: 'ok',
        job_id: jobId,
        mode: 'rescore-all',
        message: `Full-corpus rescore queued. Poll /api/jobs/${jobId}.`,
      });
    }
    const date = parsed.query.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const limit = parseInt(parsed.query.limit || '500', 10);
    const jobId = await runJob(JOB_TYPES.SCORE_SIGNALS, { date, limit });
    sendJSON(res, 200, {
      status: 'ok',
      job_id: jobId,
      mode: 'score-date',
      message: `Signal rescore queued for ${date} (up to ${limit} items). Poll /api/jobs/${jobId}.`,
    });
  };

  // --- Entity Momentum Leaderboard ---
  // ?sort=zscore|acceleration|growth|burst — Phase 1/2 ranking lens.
  routes['/api/entities/momentum'] = (req, res, parsed) => {
    const window = parsed.query.window || '7d';
    const sort = parsed.query.sort || 'zscore';
    const limit = Math.min(parseInt(parsed.query.limit || '20', 10), 100);
    const entities = getEntityMomentum(window, limit, sort);
    sendJSON(res, 200, { status: 'ok', window, sort, entities });
  };

  // --- Entity detail (Phase 3.C): JSON for an entity + its recent items ---
  routes['/api/entities/:slug'] = (req, res, parsed, params) => {
    const slug = params?.slug || '';
    const limit = Math.min(parseInt(parsed.query.limit || '20', 10), 100);
    const data = getEntityItems(slug, limit);
    if (!data) return sendError(res, 404, 'Entity not found');
    sendJSON(res, 200, { status: 'ok', ...data });
  };

  // --- Entity 30-day trajectory series (PRD-1): sparkline + burst highlight ---
  routes['/api/entities/:slug/series'] = (req, res, _parsed, params) => {
    const slug = params?.slug || '';
    const data = getEntitySeries(slug);
    if (!data) return sendError(res, 404, 'Entity not found');
    sendJSON(res, 200, { status: 'ok', ...data });
  };

  // --- Compare multiple entity trajectories (PRD-1 extension) ---
  // GET /api/entities/compare?slugs=slug1,slug2,slug3
  routes['/api/entities/compare'] = (req, res, parsed) => {
    const slugs = (parsed.query.slugs || '').split(',').map(s => s.trim()).filter(Boolean);
    if (slugs.length < 2) return sendError(res, 400, 'Provide at least 2 slugs (comma-separated)');
    const data = compareEntitySeries(slugs);
    sendJSON(res, 200, { status: 'ok', ...data });
  };

  // --- Entity co-occurrence matrix: which entities appear together ---
  routes['/api/entities/cooccurrence'] = (req, res, parsed) => {
    const limit = Math.min(parseInt(parsed.query.limit || '20', 10), 100);
    const pairs = getEntityCoOccurrence(limit);
    sendJSON(res, 200, { status: 'ok', pairs, total: pairs.length });
  };

  // --- Entity Atom feed (Phase 3.C): subscribe to a rising entity ---
  routes['/api/entities/:slug/feed.xml'] = (req, res, _parsed, params) => {
    const slug = params?.slug || '';
    const data = getEntityItems(slug, 20);
    if (!data) return sendError(res, 404, 'Entity not found');
    const { entity, items } = data;

    let atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXML(entity.canonical_name)} — Eagleye Entity</title>
  <link href="/entities/${escapeXML(slug)}"/>
  <link rel="self" href="/api/entities/${escapeXML(slug)}/feed.xml"/>
  <updated>${escapeXML(new Date().toISOString())}</updated>
  <id>urn:eagleye:entity:${escapeXML(slug)}</id>`;

    for (const item of items) {
      atom += `
  <entry>
    <id>${escapeXML(item.canonical_url || item.id)}</id>
    <title>${escapeXML(item.title)}</title>
    <link href="${escapeXML(item.canonical_url || '')}"/>
    <published>${escapeXML(item.published_at || '')}</published>
    <updated>${escapeXML(item.published_at || '')}</updated>
    <summary type="text">${escapeXML(item.one_liner || item.short_summary || '')}</summary>
    <category term="${escapeXML(entity.entity_type || '')}"/>
  </entry>`;
    }
    atom += '\n</feed>';

    res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
    res.end(atom);
  };

  // --- Single Signal Detail ---
  routes['/api/signals/:id'] = (req, res, _parsed, params) => {
    const itemId = params?.id || '';
    const signal = getSignalById(itemId);
    if (!signal) return sendError(res, 404, 'Signal not found');
    sendJSON(res, 200, { status: 'ok', signal });
  };
}

module.exports = register;
