/**
 * Eagleye — Sync Engine
 *
 * Orchestrates fetching, enrichment (LLM summaries), and digest building.
 * Supports both full sync and per-source sync.
 */

const { fetchAllSources, fetchSource } = require('../connectors/index');
const { enrichItems } = require('./llm');
const { isJobCancelled } = require('./jobs');
const { normalizeDigestDate, todayDigestDate } = require('./date-contract');

// Circular dependency: runJob/JOB_TYPES imported lazily inside runFullPipeline()

const DEFAULT_SYNC_ENRICH_BATCH = Math.max(1, parseInt(process.env.SYNC_ENRICH_BATCH_SIZE || '4000', 10));

/**
 * Sync all sources for the current date, then enrich new items.
 */
async function syncAllSources(opts = {}) {
  opts.signal?.throwIfAborted();
  const { jobId, enrichBatchSize = DEFAULT_SYNC_ENRICH_BATCH, skipEnrich = false } = opts;
  const requestedDate = normalizeDigestDate(opts.date);
  if (opts.date != null && opts.date !== '' && !requestedDate) {
    throw new Error(`Invalid sync date: expected YYYY-MM-DD or YYYYMMDD, got ${opts.date}`);
  }
  const checkpoint = Array.isArray(opts.fetchCheckpoint) ? opts.fetchCheckpoint : [];
  const updateProgress = (progress) => {
    if (!jobId) return;
    const { updateJobProgress } = require('./jobs');
    updateJobProgress(jobId, progress);
  };

  console.log('📡 Starting full sync...');
  const date = requestedDate || todayDigestDate();
  updateProgress({
    phase: 'starting', date, current_index: checkpoint.length,
    total_sources: 0, results: checkpoint, checkpoint_rows: checkpoint.length,
  });

  if (jobId && isJobCancelled(jobId)) {
    console.log('  ⛔ syncAllSources cancelled before start');
    return { cancelled: true };
  }

  const results = await fetchAllSources(date, {
    signal: opts.signal,
    checkpoint,
    isCancelled: () => !!jobId && isJobCancelled(jobId),
    onProgress: (progress) => updateProgress({ date, ...progress }),
  });
  console.log(`📡 Sync results:`, results);
  opts.signal?.throwIfAborted();

  if (jobId && isJobCancelled(jobId)) {
    console.log('  ⛔ syncAllSources cancelled after fetch, skipping enrich');
    return { fetch: results, cancelled: true };
  }

  if (skipEnrich) {
    return { fetch: results };
  }

  // Automatically enrich new/high-score items after fetch so the UI receives
  // Chinese card text and graph assignments without a separate translation job.
  const fetchedCount = results.reduce((sum, row) => sum + (Number(row?.items) || 0), 0);
  const targetBatchSize = Math.max(enrichBatchSize, fetchedCount);

  console.log(`📡 Auto-enriching new items... target batch ${targetBatchSize}`);
  updateProgress({ phase: 'enriching', date, results });
  const enrichResult = await enrichItems(targetBatchSize, { jobId, signal: opts.signal });
  console.log(`📡 Enriched: ${enrichResult.enriched}/${enrichResult.total}`);

  return { fetch: results, enrich: enrichResult };
}

/**
 * Sync a single source by slug for a given date, then enrich.
 */
async function syncSource(slug, date, opts = {}) {
  opts.signal?.throwIfAborted();
  const { jobId, enrichBatchSize = DEFAULT_SYNC_ENRICH_BATCH, limit, skipEnrich = limit !== undefined } = opts;
  const returnDetails = skipEnrich || limit !== undefined || opts.returnDetails === true;
  const dateStr = date || todayDigestDate();
  console.log(`📡 Syncing source: ${slug} for ${dateStr}`);

  if (jobId && isJobCancelled(jobId)) {
    return { cancelled: true, source: slug, date: dateStr, limit: limit ?? null, items: [], inserted: 0, existing: 0, failed: 0, skipped: 0 };
  }

  const fetched = await fetchSource(slug, dateStr, { limit, returnDetails, signal: opts.signal,
    isCancelled: () => !!jobId && isJobCancelled(jobId) });
  const items = returnDetails ? fetched.items : fetched;
  opts.signal?.throwIfAborted();
  console.log(`📡 ${slug}: ${items.length} new items`);

  // Enrich any items that don't have summaries yet
  const cancelled = jobId && isJobCancelled(jobId);
  if (!skipEnrich && !cancelled && items.length > 0) {
    await enrichItems(Math.max(enrichBatchSize, items.length), { jobId, signal: opts.signal });
  }

  return returnDetails ? { ...fetched, enrichment_skipped: skipEnrich || !!cancelled, ...(cancelled ? { cancelled: true } : {}) } : items;
}

/**
 * Run the full pipeline as a background job: fetch → enrich → digest.
 */
async function runFullPipeline() {
  const { runJob, JOB_TYPES } = require('./jobs');
  const jobId = await runJob(JOB_TYPES.FULL_PIPELINE);
  return jobId;
}

module.exports = { syncAllSources, syncSource, runFullPipeline };
