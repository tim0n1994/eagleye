/**
 * Eagleye — Jobs routes
 *
 * Pipeline control: sync, enrichment, translation, digest build and background job status.
 * Split out of api.js; handlers are unchanged.
 */

const { generateDailyDigest, enrichItems } = require('../services/llm');
const { getDB } = require('../db/connection');
const { getJob, getRecentJobs, runJob, cancelJob, JOB_TYPES } = require('../services/jobs');
const { translateItems } = require('../services/translate');
const { sendJSON, sendError } = require('./_shared');
const { requireAdminPost: requireMutation, positiveInteger: boundedInteger } = require('./_validation');
const { normalizeDigestDate, todayDigestDate } = require('../services/date-contract');

function validDigestDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === value;
}

function register(routes) {

  // --- Sync API ---
  routes['/api/sync'] = async (req, res, _parsed) => {
    if (requireMutation(req, res)) return;
    const jobId = await runJob(JOB_TYPES.FETCH_ALL, {});
    sendJSON(res, 200, { status: 'queued', job_id: jobId, message: 'Sync queued' });
  };

  // --- Enrich API: Trigger AI summary enrichment ---
  routes['/api/enrich'] = async (req, res, parsed) => {
    if (requireMutation(req, res)) return;
    const configuredDefault = boundedInteger(process.env.JOB_ENRICH_BATCH_SIZE, 100, 1600) || 100;
    const batchSize = boundedInteger(parsed.query.batch, configuredDefault, 1600);
    if (batchSize === null) return sendError(res, 400, 'batch must be an integer between 1 and 1600');
    const background = parsed.query.background !== 'false';
    const priorityOnly = parsed.query.priority_only === 'true' || parsed.query.priority_only === '1';
    const resetAttempts = parsed.query.reset_attempts === 'true' || parsed.query.reset_attempts === '1';
    const requestId = parsed.query.request_id;
    if (requestId !== undefined && (!background || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))) {
      return sendError(res, 400, 'request_id must be a UUID v4 for a background job');
    }

    if (background) {
      const jobId = await runJob(JOB_TYPES.ENRICH_ITEMS, { batchSize, priorityOnly, resetAttempts, ...(requestId ? { requestId } : {}) });
      sendJSON(res, 200, {
        status: 'ok',
        job_id: jobId,
        message: `Priority enrichment queued (batch: ${batchSize}${priorityOnly ? ', priority sources only' : ''}${resetAttempts ? ', reset attempts' : ''})`,
      });
    } else {
      try {
        const result = await enrichItems(batchSize, { priorityOnly, resetAttempts });
        sendJSON(res, 200, { status: 'ok', result });
      } catch (err) {
        sendError(res, 500, `Enrichment failed: ${err.message}`);
      }
    }
  };

  routes['/api/enrich/reenrich'] = (req, res) => {
    if (requireMutation(req, res)) return;
    return sendError(res, 410, 'Full destructive re-enrichment has been removed. Use POST /api/enrich?batch=50&reset_attempts=true&background=true for bounded incremental recovery; valid summaries are preserved.');
  };

  // --- Digest API: Build or get digest for a date ---
  routes['/api/digest/build'] = async (req, res, parsed) => {
    if (requireMutation(req, res)) return;
    const date = normalizeDigestDate(parsed.query.date ?? todayDigestDate());
    if (!date || !validDigestDate(date)) return sendError(res, 400, 'Invalid date: expected YYYY-MM-DD or YYYYMMDD');
    const background = parsed.query.background !== 'false';

    if (background) {
      const jobId = await runJob(JOB_TYPES.BUILD_DIGEST, { date });
      sendJSON(res, 200, { status: 'ok', job_id: jobId, message: `Digest build queued for ${date}` });
    } else {
      try {
        const digest = await generateDailyDigest(date);
        sendJSON(res, 200, { status: 'ok', digest, date });
      } catch (err) {
        sendError(res, 500, `Digest build failed: ${err.message}`);
      }
    }
  };

  // --- Pipeline API: Run full fetch → enrich → digest pipeline ---
  routes['/api/pipeline'] = async (req, res, parsed) => {
    if (requireMutation(req, res)) return;
    const configuredDefault = boundedInteger(process.env.JOB_ENRICH_BATCH_SIZE, 100, 1600) || 100;
    const enrichBatchSize = boundedInteger(parsed.query.batch, configuredDefault, 1600);
    if (enrichBatchSize === null) return sendError(res, 400, 'batch must be an integer between 1 and 1600');
    try {
      const jobId = await runJob(JOB_TYPES.FULL_PIPELINE, { enrichBatchSize });
      sendJSON(res, 200, { status: 'ok', job_id: jobId, message: 'Full pipeline started' });
    } catch (err) {
      sendError(res, 500, `Pipeline failed: ${err.message}`);
    }
  };

  // --- Jobs API: List recent jobs ---
  routes['/api/jobs'] = (req, res, parsed) => {
    if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');
    const limit = boundedInteger(parsed.query.limit, 20, 100);
    if (limit === null) return sendError(res, 400, 'limit must be an integer between 1 and 100');
    const jobs = getRecentJobs(limit);
    sendJSON(res, 200, { status: 'ok', jobs });
  };

  // --- Single Job API ---
  routes['/api/jobs/:id'] = (req, res, parsed, params) => {
    if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');
    const jobId = params?.id || parsed.query.id;
    if (!jobId) return sendError(res, 400, 'Job ID required');
    const job = getJob(jobId);
    if (!job) return sendError(res, 404, 'Job not found');
    sendJSON(res, 200, { status: 'ok', job });
  };

  // --- Cancel Job API: POST /api/jobs/:id/cancel ---
  routes['/api/jobs/:id/cancel'] = (req, res, parsed, params) => {
    if (requireMutation(req, res)) return;
    const jobId = params?.id;
    if (!jobId) return sendError(res, 400, 'Job ID required');
    const ok = cancelJob(jobId);
    if (!ok) {
      const job = getJob(jobId);
      return sendError(res, 409, `Job is already ${job?.status || 'unknown'}`);
    }
    sendJSON(res, 200, { status: 'ok', job_id: jobId, cancelled: true });
  };

  // --- Translation Backfill API: POST /api/translate/backfill?batch_size=50&force=false&background=true ---
  routes['/api/translate/backfill'] = async (req, res, parsed) => {
    if (requireMutation(req, res)) return;
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const all = parsed.query.all === 'true' || parsed.query.all === '1';
    if (all) return sendError(res, 400, 'Unbounded backfill is disabled; use batch_size between 1 and 500 and repeat as needed');
    const batchSize = boundedInteger(parsed.query.batch_size, 50, 500);
    if (batchSize === null) return sendError(res, 400, 'batch_size must be an integer between 1 and 500');
    const force = parsed.query.force === 'true' || parsed.query.force === '1';
    const background = parsed.query.background !== 'false';
    const sourceSlug = String(parsed.query.source || '').trim();
    const retryBlocked = parsed.query.retry_blocked === 'true';
    const requestId = parsed.query.request_id;
    if (requestId !== undefined && (!background || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))) {
      return sendError(res, 400, 'request_id must be a UUID v4 for a background job');
    }

    if (background) {
      // Use the job system so this is cancellable and visible in /api/jobs
      const jobId = await runJob(JOB_TYPES.TRANSLATE_BACKFILL, { batchSize, force, all, sourceSlug, ...(requestId ? { requestId } : {}), ...(retryBlocked ? { retryBlocked } : {}) });
      const translatedRow = db.prepare(`
        SELECT COUNT(*) as c FROM information_items WHERE title_zh IS NOT NULL AND title_zh != ''
      `).get();
      return sendJSON(res, 200, {
        status: 'queued',
        job_id: jobId,
        message: `Backfill queued (${sourceSlug || 'all-sources'}, ${all ? 'all pending' : `batch: ${batchSize}`}, force: ${force}). Cancel via POST /api/jobs/${jobId}/cancel.`,
        total_translated: translatedRow.c,
        batch_size: all ? 'all' : batchSize,
        all,
        source: sourceSlug || null,
      });
    }

    const pendingRow = db.prepare(`
      SELECT COUNT(DISTINCT i.id) as c
      FROM information_items i
      JOIN sources src ON src.id = i.source_id
      LEFT JOIN ai_summaries s ON s.item_id = i.id
      WHERE (
        i.title_zh IS NULL OR i.title_zh = '' OR i.title_zh_status = 'pending'
        OR (
          s.item_id IS NOT NULL AND (
            s.ai_title_zh IS NULL OR s.ai_title_zh = ''
            OR s.one_liner_zh IS NULL OR s.one_liner_zh = ''
            OR s.short_summary_zh IS NULL OR s.short_summary_zh = ''
            OR s.translation_status = 'pending'
          )
        )
      )
      ${sourceSlug ? 'AND src.slug = ?' : ''}
    `).get(...(sourceSlug ? [sourceSlug] : []));
    const totalPending = pendingRow.c;
    const translatedRow = db.prepare(`
      SELECT COUNT(*) as c FROM information_items WHERE title_zh IS NOT NULL AND title_zh != ''
    `).get();
    const totalTranslated = translatedRow.c;

    if (totalPending === 0 && !force) {
      return sendJSON(res, 200, {
        status: 'complete',
        translated: 0,
        failed: 0,
        total_processed: 0,
        total_pending: 0,
        total_translated: totalTranslated,
        message: 'All items already translated.',
      });
    }

    const result = await translateItems({ batchSize, force, sourceSlug, ...(retryBlocked ? { retryBlocked } : {}) });

    const updatedTranslated = db.prepare(`
      SELECT COUNT(*) as c FROM information_items WHERE title_zh IS NOT NULL AND title_zh != ''
    `).get().c;

    sendJSON(res, 200, {
      status: 'ok',
      batch_size: batchSize,
      all,
      force,
      source: sourceSlug || null,
      ...result,
      total_translated: updatedTranslated,
    });
  };

  // --- Translation Status API: GET /api/translate/status ---
  routes['/api/translate/status'] = (req, res, _parsed) => {
    if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const itemsTotal = db.prepare('SELECT COUNT(*) as c FROM information_items').get().c;
    const itemsTranslated = db.prepare(`
      SELECT COUNT(*) as c FROM information_items WHERE title_zh IS NOT NULL AND title_zh != ''
    `).get().c;
    const itemsPending = itemsTotal - itemsTranslated;

    const summariesTotal = db.prepare('SELECT COUNT(*) as c FROM ai_summaries').get().c;
    const summariesTranslated = db.prepare(`
      SELECT COUNT(*) as c FROM ai_summaries
      WHERE ai_title_zh IS NOT NULL AND ai_title_zh != ''
        AND one_liner_zh IS NOT NULL AND one_liner_zh != ''
        AND short_summary_zh IS NOT NULL AND short_summary_zh != ''
    `).get().c;
    const summariesPending = summariesTotal - summariesTranslated;

    const sourcesTranslated = db.prepare(`
      SELECT COUNT(*) as c FROM sources WHERE label_zh IS NOT NULL AND label_zh != ''
    `).get().c;
    const sourcesTotal = db.prepare('SELECT COUNT(*) as c FROM sources').get().c;

    const topicsTranslated = db.prepare(`
      SELECT COUNT(*) as c FROM topics WHERE name_zh IS NOT NULL AND name_zh != ''
    `).get().c;
    const topicsTotal = db.prepare('SELECT COUNT(*) as c FROM topics').get().c;

    sendJSON(res, 200, {
      status: 'ok',
      items: { total: itemsTotal, translated: itemsTranslated, pending: itemsPending },
      summaries: { total: summariesTotal, translated: summariesTranslated, pending: summariesPending },
      sources: { translated: sourcesTranslated, total: sourcesTotal },
      topics: { translated: topicsTranslated, total: topicsTotal },
      progress: itemsTotal > 0 ? Math.round((itemsTranslated / itemsTotal) * 100) : 0,
    });
  };

  // --- Fetch Source Job API (§13: POST /api/jobs/fetch-source) ---
  routes['/api/jobs/fetch-source'] = async (req, res, parsed) => {
    if (requireMutation(req, res)) return;
    const limit = boundedInteger(parsed.query.limit, 5, 100);
    if (limit === null) return sendError(res, 400, 'limit must be an integer between 1 and 100');
    const slug = parsed.query.slug || '';
    const date = normalizeDigestDate(parsed.query.date ?? todayDigestDate());
    if (!date || !validDigestDate(date)) return sendError(res, 400, 'Invalid date: expected YYYY-MM-DD or YYYYMMDD');
    if (!slug) return sendError(res, 400, 'Source slug required');

    try {
      const jobId = await runJob(JOB_TYPES.FETCH_SOURCE, { slug, date: date.replace(/-/g, ''), limit });
      sendJSON(res, 200, { status: 'ok', job_id: jobId, message: `Fetch queued for ${slug}` });
    } catch (err) {
      sendError(res, 500, `Failed to queue fetch: ${err.message}`);
    }
  };
}

module.exports = register;
