/**
 * Eagleye — Sync Engine
 *
 * Orchestrates fetching, enrichment (LLM summaries), and digest building.
 * Supports both full sync and per-source sync.
 */

const { fetchAllSources, fetchSource } = require('../connectors/index');
const { enrichItems } = require('./llm');
const { isJobCancelled } = require('./jobs');

// Circular dependency: runJob/JOB_TYPES imported lazily inside runFullPipeline()

const DEFAULT_SYNC_ENRICH_BATCH = Math.max(1, parseInt(process.env.SYNC_ENRICH_BATCH_SIZE || '4000', 10));

/**
 * Sync all sources for the current date, then enrich new items.
 */
async function syncAllSources(opts = {}) {
  const { jobId, enrichBatchSize = DEFAULT_SYNC_ENRICH_BATCH, skipEnrich = false } = opts;
  const updateProgress = (progress) => {
    if (!jobId) return;
    const { updateJobProgress } = require('./jobs');
    updateJobProgress(jobId, progress);
  };

  console.log('📡 Starting full sync...');
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  updateProgress({ phase: 'starting', date, current_index: 0, total_sources: 0, results: [] });

  if (jobId && isJobCancelled(jobId)) {
    console.log('  ⛔ syncAllSources cancelled before start');
    return { cancelled: true };
  }

  const results = await fetchAllSources(date, {
    onProgress: (progress) => updateProgress({ date, ...progress }),
  });
  console.log(`📡 Sync results:`, results);

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
  const enrichResult = await enrichItems(targetBatchSize, { jobId });
  console.log(`📡 Enriched: ${enrichResult.enriched}/${enrichResult.total}`);

  return { fetch: results, enrich: enrichResult };
}

/**
 * Sync a single source by slug for a given date, then enrich.
 */
async function syncSource(slug, date, opts = {}) {
  const { jobId, enrichBatchSize = DEFAULT_SYNC_ENRICH_BATCH } = opts;
  const dateStr = date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  console.log(`📡 Syncing source: ${slug} for ${dateStr}`);

  if (jobId && isJobCancelled(jobId)) {
    return { cancelled: true, items: [] };
  }

  const items = await fetchSource(slug, dateStr);
  console.log(`📡 ${slug}: ${items.length} new items`);

  // Enrich any items that don't have summaries yet
  if (items.length > 0) {
    await enrichItems(Math.max(enrichBatchSize, items.length), { jobId });
  }

  return items;
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
