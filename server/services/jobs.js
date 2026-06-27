/**
 * Eagleye — Background Job System
 *
 * Lightweight job queue backed by the background_jobs SQLite table.
 * Supports:
 * - Job creation and tracking
 * - Job execution with status updates
 * - Background enrichment pipeline (fetch → enrich → digest)
 */

const { getDB } = require('../db/connection');
const { enrichItems, generateDailyDigest } = require('./llm');
const { buildTopicGraph } = require('./topic-graph');

// Circular dependency: sync.js imported lazily inside executeJob()
const crypto = require('crypto');

function generateId() {
  return crypto.randomUUID();
}

// ─── Job Types ──────────────────────────────────────────────────────────

const JOB_TYPES = {
  FETCH_SOURCE: 'fetch-source',
  FETCH_ALL: 'fetch-all',
  ENRICH_ITEMS: 'enrich-items',
  BUILD_DIGEST: 'build-digest',
  BUILD_TOPIC_GRAPH: 'build-topic-graph',
  FULL_PIPELINE: 'full-pipeline',
  X_FOLLOWING_SYNC: 'x-following-sync',
  TRANSLATE_BACKFILL: 'translate-backfill',
  SCORE_SIGNALS: 'score-signals',
  BUILD_TAG_HIERARCHY: 'build-tag-hierarchy',
};

const DEFAULT_JOB_ENRICH_BATCH = Math.max(1, parseInt(process.env.JOB_ENRICH_BATCH_SIZE || '1600', 10));
const SINGLETON_JOB_TYPES = new Set([
  JOB_TYPES.FETCH_ALL,
  JOB_TYPES.FULL_PIPELINE,
  JOB_TYPES.TRANSLATE_BACKFILL,
  JOB_TYPES.X_FOLLOWING_SYNC,
]);

// ─── Job CRUD ───────────────────────────────────────────────────────────

function createJob(jobType, params = {}) {
  const db = getDB();
  if (!db) return null;

  if (!params.allowConcurrent && SINGLETON_JOB_TYPES.has(jobType)) {
    const existing = db.prepare(`
      SELECT id FROM background_jobs
      WHERE job_type = ? AND status IN ('queued', 'running')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(jobType);
    if (existing?.id) return existing.id;
  }

  const id = generateId();
  db.prepare(`
    INSERT INTO background_jobs (id, job_type, status, params)
    VALUES (?, ?, 'queued', ?)
  `).run(id, jobType, JSON.stringify(params));

  return id;
}

function getActiveSingletonJob(jobType) {
  const db = getDB();
  if (!db || !SINGLETON_JOB_TYPES.has(jobType)) return null;
  return db.prepare(`
    SELECT id FROM background_jobs
    WHERE job_type = ? AND status IN ('queued', 'running')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(jobType) || null;
}

function updateJobStatus(id, status, result = null, error = null) {
  const db = getDB();
  if (!db) return;

  const setClauses = [];
  const params = [];

  setClauses.push('status = ?');
  params.push(status);

  if (status === 'running') {
    setClauses.push("started_at = datetime('now')");
  }

  if (status === 'completed' || status === 'failed') {
    setClauses.push("completed_at = datetime('now')");
  }

  if (result) {
    setClauses.push('result = ?');
    params.push(typeof result === 'string' ? result : JSON.stringify(result));
  }

  if (error) {
    setClauses.push('error = ?');
    params.push(error);
  }

  params.push(id);
  db.prepare(`UPDATE background_jobs SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
}

function updateJobProgress(id, result) {
  const db = getDB();
  if (!db || !id) return;
  const row = db.prepare('SELECT job_type, result FROM background_jobs WHERE id = ? AND status = ?').get(id, 'running');
  if (row?.job_type === JOB_TYPES.FULL_PIPELINE) {
    db.prepare('UPDATE background_jobs SET result = ? WHERE id = ? AND status = ?')
      .run(JSON.stringify(mergePipelineProgress(row.result, result)), id, 'running');
    return;
  }
  db.prepare('UPDATE background_jobs SET result = ? WHERE id = ? AND status = ?')
    .run(typeof result === 'string' ? result : JSON.stringify(result), id, 'running');
}

const PIPELINE_STAGES = [
  ['fetch', '抓取信息源', 'Fetch sources'],
  ['enrich', 'AI 摘要与打标签', 'Enrich and tag'],
  ['source_profiles', '源质量画像', 'Source quality profiles'],
  ['translate', '中文卡片回填', 'Chinese card backfill'],
  ['topic_graph', '主题图谱', 'Topic graph'],
  ['kg_worker', 'KG Worker', 'KG worker'],
  ['entity_momentum', '实体动量', 'Entity momentum'],
  ['digest', '每日简报', 'Daily digest'],
  ['hierarchy', '概念图谱', 'Concept graph'],
];

function emptyPipelineProgress() {
  return {
    pipeline: true,
    phase: 'pipeline',
    current_stage: 'fetch',
    stages: PIPELINE_STAGES.map(([key, label_zh, label]) => ({
      key,
      label,
      label_zh,
      status: 'pending',
      detail: null,
      result: null,
      started_at: null,
      completed_at: null,
    })),
    updated_at: new Date().toISOString(),
  };
}

function parseProgress(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function inferPipelineStage(progress) {
  if (!progress || typeof progress !== 'object') return null;
  if (progress.stage) return progress.stage;
  if (progress.phase === 'fetching' || progress.phase === 'starting') return 'fetch';
  if (progress.phase === 'enriching' || progress.phase === 'scoring') return 'enrich';
  if (progress.phase === 'translating') return 'translate';
  if (progress.phase === 'embedding' || progress.phase === 'matching' || progress.phase === 'clustering') return 'topic_graph';
  return null;
}

function mergePipelineProgress(existingRaw, incoming) {
  const existing = parseProgress(existingRaw);
  const progress = existing?.pipeline ? existing : emptyPipelineProgress();
  const incomingObj = typeof incoming === 'string' ? { message: incoming } : (incoming || {});
  const stageKey = inferPipelineStage(incomingObj) || progress.current_stage || 'fetch';
  const now = new Date().toISOString();

  progress.current_stage = stageKey;
  progress.updated_at = now;
  progress.raw_phase = incomingObj.phase || progress.raw_phase || '';

  for (const stage of progress.stages) {
    if (stage.key === stageKey) {
      if (stage.status === 'pending') stage.started_at = now;
      stage.status = incomingObj.status || 'running';
      stage.detail = incomingObj;
    }
  }
  return progress;
}

function updatePipelineStage(jobId, stageKey, status, detail = null, result = null) {
  const db = getDB();
  if (!db || !jobId) return;
  const row = db.prepare('SELECT result FROM background_jobs WHERE id = ? AND status = ?').get(jobId, 'running');
  const progress = parseProgress(row?.result);
  const next = progress?.pipeline ? progress : emptyPipelineProgress();
  const now = new Date().toISOString();
  next.current_stage = stageKey;
  next.updated_at = now;
  for (const stage of next.stages) {
    if (stage.key === stageKey) {
      if (status === 'running' && !stage.started_at) stage.started_at = now;
      if (status === 'completed' || status === 'failed') stage.completed_at = now;
      stage.status = status;
      if (detail !== null) stage.detail = detail;
      if (result !== null) stage.result = result;
    }
  }
  db.prepare('UPDATE background_jobs SET result = ? WHERE id = ? AND status = ?')
    .run(JSON.stringify(next), jobId, 'running');
}

function getJob(id) {
  const db = getDB();
  if (!db) return null;
  return db.prepare('SELECT * FROM background_jobs WHERE id = ?').get(id);
}

function getRecentJobs(limit = 20) {
  const db = getDB();
  if (!db) return [];
  return db.prepare('SELECT * FROM background_jobs ORDER BY created_at DESC LIMIT ?').all(limit);
}

function markInterruptedJobs() {
  const db = getDB();
  if (!db) return 0;
  const info = db.prepare(`
    UPDATE background_jobs
    SET status = 'failed',
        completed_at = datetime('now'),
        error = 'Server restarted before this background job completed'
    WHERE status IN ('running', 'queued')
  `).run();
  return info.changes || 0;
}

/**
 * Mark a job as cancelled. Cooperative cancellation — the executor must
 * poll isJobCancelled() periodically. Returns true if cancellation succeeded.
 */
function cancelJob(id) {
  const db = getDB();
  if (!db) return false;
  const job = getJob(id);
  if (!job) return false;
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return false;
  }
  db.prepare(`
    UPDATE background_jobs
    SET status = 'cancelled', completed_at = datetime('now'),
        result = COALESCE(result, ?) || ' [cancelled by user]'
    WHERE id = ?
  `).run(JSON.stringify({ cancelled: true }), id);
  return true;
}

/**
 * Check whether a job has been cancelled. Long-running executors should
 * call this in their loops and abort cooperatively.
 */
function isJobCancelled(id) {
  const db = getDB();
  if (!db) return false;
  const row = db.prepare(`SELECT status FROM background_jobs WHERE id = ?`).get(id);
  return row && row.status === 'cancelled';
}

// ─── Job Executors ──────────────────────────────────────────────────────

/**
 * Execute a job by its ID. Runs the appropriate handler based on job type.
 */
async function executeJob(jobId) {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  updateJobStatus(jobId, 'running');

  try {
    let result;

    switch (job.job_type) {
      case JOB_TYPES.FETCH_ALL: {
        const { syncAllSources } = require('./sync');
        result = await syncAllSources({ jobId });
        break;
      }

      case JOB_TYPES.FETCH_SOURCE: {
        const params = JSON.parse(job.params || '{}');
        const { syncSource } = require('./sync');
        result = await syncSource(params.slug, params.date, { jobId });
        break;
      }

      case JOB_TYPES.ENRICH_ITEMS: {
        const params = JSON.parse(job.params || '{}');
        result = await enrichItems(params.batchSize || DEFAULT_JOB_ENRICH_BATCH, { jobId, ...params });
        break;
      }

      case JOB_TYPES.BUILD_DIGEST: {
        const params = JSON.parse(job.params || '{}');
        const date = params.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
        result = await generateDailyDigest(date, { jobId });
        break;
      }

      case JOB_TYPES.BUILD_TOPIC_GRAPH: {
        const params = JSON.parse(job.params || '{}');
        const date = params.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
        result = await buildTopicGraph(date, { jobId, deep: params.deep === true });
        break;
      }

      case JOB_TYPES.FULL_PIPELINE: {
        // Full pipeline: fetch all → enrich → translate backfill → build topic graph → KG worker → build digest → build tag hierarchy
        const { syncAllSources: syncAll } = require('./sync');
        const { runKGFullPipeline } = require('./kg-worker');
        const { translateItems } = require('./translate');
        const params = JSON.parse(job.params || '{}');
        const baseEnrichBatchSize = params.enrichBatchSize || DEFAULT_JOB_ENRICH_BATCH;
        updatePipelineStage(jobId, 'fetch', 'running', { message: 'Starting source fetch' });
        if (isJobCancelled(jobId)) throw new Error('Job cancelled by user');
        const fetchResult = await syncAll({ jobId, skipEnrich: true });
        updatePipelineStage(jobId, 'fetch', 'completed', null, fetchResult);
        if (isJobCancelled(jobId)) throw new Error('Job cancelled by user');
        const fetchedCount = (fetchResult?.fetch || []).reduce((sum, row) => sum + (Number(row?.items) || 0), 0);
        const enrichBatchSize = Math.max(baseEnrichBatchSize, fetchedCount);
        updatePipelineStage(jobId, 'enrich', 'running', { message: `Starting enrichment, batch size ${enrichBatchSize}` });
        const enrichResult = await enrichItems(enrichBatchSize, { jobId });
        updatePipelineStage(jobId, 'enrich', 'completed', null, enrichResult);
        if (isJobCancelled(jobId)) throw new Error('Job cancelled by user');
        // Source quality profiles (depends on signal_scores from enrich)
        try {
          updatePipelineStage(jobId, 'source_profiles', 'running', { message: 'Computing source quality profiles' });
          const { updateSourceProfiles } = require('./source-profiles');
          const profileResult = updateSourceProfiles();
          // Rescore today's items so source_quality_score reflects the fresh
          // profiles immediately (computeSourceScore reads source_profiles).
          let rescored = 0;
          try {
            const { scoreSignals } = require('./signals');
            const rescoreDb = getDB();
            const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const todayItems = rescoreDb.prepare(`
              SELECT i.*, s.label as source_label, s.slug as source_slug
              FROM information_items i JOIN sources s ON i.source_id = s.id
              WHERE i.digest_date = ?
            `).all(today);
            if (todayItems.length > 0) {
              const rescoreResult = await scoreSignals(todayItems, { jobId });
              rescored = rescoreResult?.scored || 0;
              console.log(`  📊 Auto-rescored ${rescored} items with fresh source profiles`);
            }
          } catch (rescoreErr) {
            console.warn(`  ⚠  Auto-rescore after source_profiles failed (non-fatal): ${rescoreErr.message}`);
          }
          updatePipelineStage(jobId, 'source_profiles', 'completed', null, { ...profileResult, rescored });
        } catch (err) {
          updatePipelineStage(jobId, 'source_profiles', 'failed', { error: err.message });
          console.warn(`  ⚠  Source profiles failed (non-fatal): ${err.message}`);
        }
        if (isJobCancelled(jobId)) throw new Error('Job cancelled by user');
        // Chinese translation backfill
        let translateResult = null;
        try {
          updatePipelineStage(jobId, 'translate', 'running', { message: 'Starting Chinese card backfill' });
          translateResult = await translateItems({ jobId });
          updatePipelineStage(jobId, 'translate', 'completed', null, translateResult);
          console.log(`  🌐 Translate backfill: translated=${translateResult.translated || 0}`);
        } catch (err) {
          updatePipelineStage(jobId, 'translate', 'failed', { error: err.message });
          console.warn(`  ⚠  Translate backfill failed (non-fatal): ${err.message}`);
        }
        if (isJobCancelled(jobId)) throw new Error('Job cancelled by user');
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        updatePipelineStage(jobId, 'topic_graph', 'running', { date: today });
        const topicGraphResult = await buildTopicGraph(today, { jobId });
        updatePipelineStage(jobId, 'topic_graph', 'completed', null, topicGraphResult);
        if (isJobCancelled(jobId)) throw new Error('Job cancelled by user');
        let kgResult = null;
        try {
          updatePipelineStage(jobId, 'kg_worker', 'running', { sources: 'x-following,hacker-news,github-trending,hugging-face,arxiv-ai,physical-ai-arxiv' });
          kgResult = await runKGFullPipeline('x-following,hacker-news,github-trending,hugging-face,arxiv-ai,physical-ai-arxiv');
          updatePipelineStage(jobId, 'kg_worker', 'completed', null, kgResult);
          console.log(`  🧠 KG Worker pipeline completed: extract=${kgResult.extract?.total || 0}, embed=${kgResult.embed?.vectors || 0}, topics=${kgResult.topics?.dynamic_topics || 0}`);
        } catch (err) {
          updatePipelineStage(jobId, 'kg_worker', 'failed', { error: err.message });
          console.warn(`  ⚠  KG Worker pipeline failed (non-fatal): ${err.message}`);
        }
        // Entity momentum (depends on canonical_entities/entity_links from kg_worker)
        try {
          updatePipelineStage(jobId, 'entity_momentum', 'running', { message: 'Computing entity momentum' });
          const { updateEntityMomentum } = require('./source-profiles');
          const momentumResult = updateEntityMomentum();
          updatePipelineStage(jobId, 'entity_momentum', 'completed', null, momentumResult);
        } catch (err) {
          updatePipelineStage(jobId, 'entity_momentum', 'failed', { error: err.message });
          console.warn(`  ⚠  Entity momentum failed (non-fatal): ${err.message}`);
        }
        updatePipelineStage(jobId, 'digest', 'running', { date: today });
        const digestResult = await generateDailyDigest(today, { jobId });
        updatePipelineStage(jobId, 'digest', 'completed', null, { generated: !!digestResult, id: digestResult?.id || null });
        // Build tag hierarchy
        let hierarchyResult = null;
        try {
          updatePipelineStage(jobId, 'hierarchy', 'running', { message: 'Building concept graph from tags' });
          const { buildTagHierarchy } = require('./tag-hierarchy');
          hierarchyResult = await buildTagHierarchy();
          updatePipelineStage(jobId, 'hierarchy', 'completed', null, hierarchyResult);
          console.log(`  🏷️  Tag hierarchy built: ${hierarchyResult.domains} domains → ${hierarchyResult.topics} topics → ${hierarchyResult.subTopics} sub-topics → ${hierarchyResult.tags} tags`);
        } catch (err) {
          updatePipelineStage(jobId, 'hierarchy', 'failed', { error: err.message });
          console.warn(`  ⚠  Tag hierarchy build failed (non-fatal): ${err.message}`);
        }
        const finalProgress = parseProgress(getJob(jobId)?.result);
        result = {
          pipeline: true,
          completed: true,
          current_stage: 'hierarchy',
          stages: finalProgress?.pipeline ? finalProgress.stages : [],
          summary: {
            fetch: fetchResult,
            enrich: enrichResult,
            translate: translateResult,
            topic_graph: topicGraphResult,
            kg_worker: kgResult,
            digest: !!digestResult,
            hierarchy: hierarchyResult,
          },
        };
        break;
      }

      case JOB_TYPES.X_FOLLOWING_SYNC: {
        const { syncXFollowing } = require('./x-following');
        const params = JSON.parse(job.params || '{}');
        result = await syncXFollowing({ jobId, ...params });
        break;
      }

      case JOB_TYPES.TRANSLATE_BACKFILL: {
        const { translateItems } = require('./translate');
        const params = JSON.parse(job.params || '{}');
        result = await translateItems({ ...params, jobId });
        break;
      }

      case JOB_TYPES.SCORE_SIGNALS: {
        const { scoreSignals } = require('./signals');
        const { getDB } = require('../db/connection');
        const params = JSON.parse(job.params || '{}');
        const db = getDB();
        const date = params.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const limit = params.limit || 200;
        const items = db.prepare(`
          SELECT i.*, s.label as source_label, s.slug as source_slug
          FROM information_items i
          JOIN sources s ON i.source_id = s.id
          WHERE i.digest_date = ?
          ORDER BY i.score DESC LIMIT ?
        `).all(date, limit);
        result = await scoreSignals(items, { jobId });
        break;
      }

      case JOB_TYPES.BUILD_TAG_HIERARCHY: {
        const { buildTagHierarchy } = require('./tag-hierarchy');
        result = await buildTagHierarchy();
        break;
      }

      default:
        throw new Error(`Unknown job type: ${job.job_type}`);
    }

    // If the job was cancelled mid-execution, the inner function may have thrown.
    // We still want to mark it as cancelled instead of completed.
    if (isJobCancelled(jobId)) {
      console.log(`  ⛔ Job ${jobId} (${job.job_type}) cancelled by user.`);
      return result;
    }

    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
    updateJobStatus(jobId, 'completed', resultStr);
    return result;
  } catch (err) {
    const cancelled = isJobCancelled(jobId);
    if (cancelled) {
      console.log(`  ⛔ Job ${jobId} (${job.job_type}) cancelled: ${err.message}`);
      return null;
    }
    console.error(`  ❌ Job ${jobId} (${job.job_type}) failed:`, err.message);
    updateJobStatus(jobId, 'failed', null, err.message);
    throw err;
  }
}

/**
 * Create and execute a job in the background.
 * Returns the job ID immediately — the caller can poll for status.
 */
async function runJob(jobType, params = {}) {
  if (!params.allowConcurrent) {
    const existing = getActiveSingletonJob(jobType);
    if (existing?.id) return existing.id;
  }

  const jobId = createJob(jobType, params);
  if (!jobId) return null;

  // Execute asynchronously — don't await
  executeJob(jobId).catch(err => {
    console.error(`Background job ${jobId} error:`, err.message);
  });

  return jobId;
}

module.exports = {
  JOB_TYPES,
  getJob,
  getRecentJobs,
  markInterruptedJobs,
  runJob,
  cancelJob,
  isJobCancelled,
  updateJobProgress,
};
