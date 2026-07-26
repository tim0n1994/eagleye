/**
 * Eagleye — Jobs routes
 *
 * Pipeline control: sync, enrichment, translation, digest build and background job status.
 * Split out of api.js; handlers are unchanged.
 */

const { generateDailyDigest, enrichItems } = require('../services/llm');
const { getDB } = require('../db/connection');
const { getJob, getRecentJobs, runJob, cancelJob, JOB_TYPES } = require('../services/jobs');
const { runFullPipeline } = require('../services/sync');
const { translateItems } = require('../services/translate');
const { sendJSON, sendError } = require('./_shared');

function register(routes) {

  // --- Sync API ---
  routes['/api/sync'] = async (req, res, _parsed) => {
    const jobId = await runJob(JOB_TYPES.FETCH_ALL, {});
    sendJSON(res, 200, { status: 'queued', job_id: jobId, message: 'Sync queued' });
  };

  // --- Enrich API: Trigger AI summary enrichment ---
  routes['/api/enrich'] = async (req, res, parsed) => {
    const batchSize = parseInt(parsed.query.batch || process.env.JOB_ENRICH_BATCH_SIZE || '1600', 10);
    const background = parsed.query.background !== 'false';
    const priorityOnly = parsed.query.priority_only === 'true' || parsed.query.priority_only === '1';
    const resetAttempts = parsed.query.reset_attempts === 'true' || parsed.query.reset_attempts === '1';

    if (background) {
      const jobId = await runJob(JOB_TYPES.ENRICH_ITEMS, { batchSize, priorityOnly, resetAttempts });
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

  // --- Full Re-enrich: clear all existing enrichment + re-process ---
  routes['/api/enrich/reenrich'] = async (req, res, parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    const batchSize = parseInt(parsed.query.batch || '0', 10) || 5000;

    try {
      const clearedSummaries = db.prepare('DELETE FROM ai_summaries').run().changes;
      const clearedItemTags = db.prepare('DELETE FROM item_tags').run().changes;
      const clearedGraphEdges = db.prepare("DELETE FROM graph_edges WHERE edge_type IN ('item_has_tag','item_belongs_topic','item_mentions_entity')").run().changes;
      const clearedItemTopics = db.prepare("DELETE FROM item_topics WHERE assigned_by = 'keyword'").run().changes;

      const result = await enrichItems(batchSize, { priorityOnly: false });

      sendJSON(res, 200, {
        status: 'ok',
        cleared: { summaries: clearedSummaries, item_tags: clearedItemTags, graph_edges: clearedGraphEdges, item_topics: clearedItemTopics },
        enriched: result,
      });
    } catch (err) {
      sendError(res, 500, `Re-enrichment failed: ${err.message}`);
    }
  };

  // --- Digest API: Build or get digest for a date ---
  routes['/api/digest/build'] = async (req, res, parsed) => {
    const date = parsed.query.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
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
  routes['/api/pipeline'] = async (req, res, _parsed) => {
    try {
      const jobId = await runFullPipeline();
      sendJSON(res, 200, { status: 'ok', job_id: jobId, message: 'Full pipeline started' });
    } catch (err) {
      sendError(res, 500, `Pipeline failed: ${err.message}`);
    }
  };

  // --- Jobs API: List recent jobs ---
  routes['/api/jobs'] = (req, res, parsed) => {
    const jobs = getRecentJobs(parseInt(parsed.query.limit || '20', 10));
    sendJSON(res, 200, { status: 'ok', jobs });
  };

  // --- Single Job API ---
  routes['/api/jobs/:id'] = (req, res, parsed, params) => {
    const jobId = params?.id || parsed.query.id;
    if (!jobId) return sendError(res, 400, 'Job ID required');
    const job = getJob(jobId);
    if (!job) return sendError(res, 404, 'Job not found');
    sendJSON(res, 200, { status: 'ok', job });
  };

  // --- Cancel Job API: POST /api/jobs/:id/cancel ---
  routes['/api/jobs/:id/cancel'] = (req, res, parsed, params) => {
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
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const all = parsed.query.all === 'true' || parsed.query.all === '1';
    const batchSize = all
      ? Number.MAX_SAFE_INTEGER
      : Math.max(1, Math.min(parseInt(parsed.query.batch_size || '50', 10), 500));
    const force = parsed.query.force === 'true' || parsed.query.force === '1';
    const background = parsed.query.background !== 'false';
    const sourceSlug = String(parsed.query.source || '').trim();

    if (background) {
      // Use the job system so this is cancellable and visible in /api/jobs
      const jobId = await runJob(JOB_TYPES.TRANSLATE_BACKFILL, { batchSize, force, all, sourceSlug });
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

    const result = await translateItems({ batchSize, force, sourceSlug });

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
    const slug = parsed.query.slug || '';
    const date = parsed.query.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    if (!slug) return sendError(res, 400, 'Source slug required');

    try {
      const jobId = await runJob(JOB_TYPES.FETCH_SOURCE, { slug, date });
      sendJSON(res, 200, { status: 'ok', job_id: jobId, message: `Fetch queued for ${slug}` });
    } catch (err) {
      sendError(res, 500, `Failed to queue fetch: ${err.message}`);
    }
  };
}

module.exports = register;
