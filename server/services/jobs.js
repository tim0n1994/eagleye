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
const { normalizeDigestDate, todayDigestDate } = require('./date-contract');

// Circular dependency: sync.js imported lazily inside executeJob()
const crypto = require('crypto');
const jobControllers = new Map();
const jobLeases = new Map();
const leaseColumnCache = new WeakMap();
const WORKER_ID = `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

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
  RESCORE_ALL: 'rescore-all',
  ITEM_RESEARCH: 'item-research',
  BUILD_TAG_HIERARCHY: 'build-tag-hierarchy',
};

const configuredEnrichBatch = Number(process.env.JOB_ENRICH_BATCH_SIZE || 100);
const DEFAULT_JOB_ENRICH_BATCH = Number.isInteger(configuredEnrichBatch) && configuredEnrichBatch > 0
  ? Math.min(1600, configuredEnrichBatch) : 100;
const SINGLETON_JOB_TYPES = new Set([
  JOB_TYPES.FETCH_ALL,
  JOB_TYPES.FULL_PIPELINE,
  JOB_TYPES.TRANSLATE_BACKFILL,
  JOB_TYPES.X_FOLLOWING_SYNC,
  JOB_TYPES.RESCORE_ALL,
]);

function boundedJobCount(value, fallback, maximum) {
  const count = Number(value ?? fallback);
  if (!Number.isSafeInteger(count) || count <= 0 || count > maximum) {
    throw new Error(`Job batch must be an integer between 1 and ${maximum}`);
  }
  return count;
}

function jobDate(value, label = 'date') {
  if (value === undefined || value === null || value === '') return todayDigestDate();
  const canonical = normalizeDigestDate(value);
  if (!canonical) throw new Error(`Invalid ${label}: expected YYYY-MM-DD or YYYYMMDD`);
  return canonical;
}

// R0-06 rollback gate: with EAGLEYE_JOBS_PAUSED truthy the queue refuses new
// intake and new claims while in-flight jobs keep running and committing, so
// operators can drain work and roll the deployment back safely.
function isJobIntakePaused() {
  const raw = String(process.env.EAGLEYE_JOBS_PAUSED ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function leaseTtlMs() {
  const seconds = Number(process.env.EAGLEYE_JOB_LEASE_TTL_SECONDS ?? 900);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 900) * 1000;
}

function hasLeaseColumns(db) {
  if (!db) return false;
  if (!leaseColumnCache.has(db)) {
    const names = db.prepare("PRAGMA table_info('background_jobs')").all().map(column => column.name);
    leaseColumnCache.set(db, names.includes('lease_owner') && names.includes('lease_epoch'));
  }
  return leaseColumnCache.get(db);
}

function claimJob(jobId, workerId) {
  const db = getDB();
  if (!db) return { claimed: false, reason: 'no-database', epoch: null };
  if (isJobIntakePaused()) return { claimed: false, reason: 'paused', epoch: null };
  if (!hasLeaseColumns(db)) {
    const claimed = db.prepare(`
      UPDATE background_jobs SET status = 'running', started_at = datetime('now')
      WHERE id = ? AND status = 'queued'
    `).run(jobId).changes > 0;
    return { claimed, reason: claimed ? 'legacy' : 'not-queued', epoch: null };
  }
  return db.transaction(() => {
    const expiry = new Date(Date.now() + leaseTtlMs()).toISOString();
    const claimed = db.prepare(`
      UPDATE background_jobs
      SET status = 'running', started_at = datetime('now'),
          lease_owner = ?, lease_epoch = lease_epoch + 1, lease_expiry = ?,
          attempt = attempt + 1
      WHERE id = ? AND status = 'queued'
    `).run(workerId, expiry, jobId).changes > 0;
    const epoch = claimed
      ? Number(db.prepare('SELECT lease_epoch FROM background_jobs WHERE id = ?').get(jobId).lease_epoch)
      : null;
    return { claimed, reason: claimed ? 'lease-acquired' : 'not-queued', epoch };
  })();
}

function commitJobOutcome(jobId, expectedEpoch, apply) {
  const db = getDB();
  if (!db) return { committed: false, reason: 'no-database' };
  if (!hasLeaseColumns(db) || expectedEpoch === null) {
    apply();
    return { committed: true, reason: 'unverified' };
  }
  return db.transaction(() => {
    const row = db.prepare('SELECT lease_epoch FROM background_jobs WHERE id = ?').get(jobId);
    if (!row) return { committed: false, reason: 'job-missing' };
    if (Number(row.lease_epoch ?? 0) !== expectedEpoch) return { committed: false, reason: 'lease-stale' };
    apply();
    return { committed: true, reason: 'lease-current' };
  })();
}

function isStaleLeaseWriter(db, id) {
  if (!jobLeases.has(id) || !hasLeaseColumns(db)) return false;
  const row = db.prepare('SELECT lease_epoch FROM background_jobs WHERE id = ?').get(id);
  return !row || Number(row.lease_epoch ?? 0) !== jobLeases.get(id);
}

function staleLeaseResult(jobId, jobType, epoch, error) {
  console.warn(`  ⚠  Job ${jobId} (${jobType}) late commit rejected: lease epoch moved on from ${epoch}; newer results preserved`);
  return { stale: true, reason: 'lease-stale', jobId, jobType, ...(error ? { error } : {}) };
}

// ─── Job CRUD ───────────────────────────────────────────────────────────

function requestedJob(jobType, params) {
  if (!params.requestId) return null;
  if (![JOB_TYPES.ENRICH_ITEMS, JOB_TYPES.TRANSLATE_BACKFILL].includes(jobType)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.requestId)) {
    throw new Error('Invalid bounded-job request ID');
  }
  const existing = getJob(params.requestId);
  if (existing && (existing.job_type !== jobType
    || !require('node:util').isDeepStrictEqual(JSON.parse(existing.params), params))) {
    throw new Error('Request ID already used with different job parameters');
  }
  return existing;
}

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

  const id = params.requestId || generateId();
  const inserted = db.prepare(`
    INSERT ${params.requestId ? 'OR IGNORE' : ''} INTO background_jobs (id, job_type, status, params)
    VALUES (?, ?, 'queued', ?)
  `).run(id, jobType, JSON.stringify(params));
  if (!inserted.changes && params.requestId) return requestedJob(jobType, params)?.id || null;

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
  db.prepare(`UPDATE background_jobs SET ${setClauses.join(', ')} WHERE id = ? AND status != 'cancelled'`).run(...params);
}

function updateJobProgress(id, result) {
  const db = getDB();
  if (!db || !id) return;
  if (isStaleLeaseWriter(db, id)) return;
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
  ['translate', '中文卡片回填', 'Chinese card backfill'],
  ['topic_graph', '主题图谱', 'Topic graph'],
  ['kg_worker', 'KG Worker', 'KG worker'],
  ['entity_momentum', '实体动量', 'Entity momentum'],
  ['source_profiles', '源质量画像与重新评分', 'Source profiles and rescoring'],
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
  const stageKey = incomingObj.phase === 'scoring' && progress.current_stage === 'source_profiles'
    ? 'source_profiles'
    : inferPipelineStage(incomingObj) || progress.current_stage || 'fetch';
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
  if (isStaleLeaseWriter(db, jobId)) return;
  const row = db.prepare('SELECT result FROM background_jobs WHERE id = ? AND status = ?').get(jobId, 'running');
  const progress = parseProgress(row?.result);
  const next = progress?.pipeline ? progress : emptyPipelineProgress();
  const now = new Date().toISOString();
  next.current_stage = stageKey;
  next.updated_at = now;
  for (const stage of next.stages) {
    if (stage.key === stageKey) {
      if (status === 'running' && !stage.started_at) stage.started_at = now;
      if (['completed', 'failed', 'skipped'].includes(status)) stage.completed_at = now;
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

function pipelineResult(jobId, outcome = null) {
  const progress = parseProgress(getJob(jobId)?.result) || emptyPipelineProgress();
  const stages = progress.stages || [];
  const failedStages = stages.filter(stage => stage.status === 'failed').map(stage => stage.key);
  const cancelled = outcome === 'cancelled';
  return {
    ...progress,
    completed: !cancelled && failedStages.length === 0 && stages.every(stage => ['completed', 'skipped'].includes(stage.status)),
    cancelled,
    outcome: outcome || (failedStages.length ? 'failed' : 'completed'),
    partial: stages.some(stage => stage.status === 'completed') && (cancelled || failedStages.length > 0),
    failed_stages: failedStages,
    summary: Object.fromEntries(stages.map(stage => [stage.key, stage.result])),
    updated_at: new Date().toISOString(),
  };
}

function stageFailure(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.error || ['error', 'failed'].includes(result.status)) return result.error || result.message || 'Stage returned a failure';
  if (result.fallback_reason) return `Requested backend degraded: ${result.fallback_reason}`;
  if (Number(result.failed) > 0) return `${result.failed} item(s) failed`;
  const failedSources = (result.fetch || []).filter(row => row.error || row.status === 'failed');
  if (failedSources.length) return failedSources.map(row => `${row.source || 'unknown'}: ${row.error || 'failed'}`).join('; ');
  if (result.skipped && result.reason === 'no-llm-provider') return 'Enrichment unavailable: no LLM provider configured';
  for (const key of ['extract', 'embed', 'topics', 'rescore']) {
    const failure = stageFailure(result[key]);
    if (failure) return `${key}: ${failure}`;
  }
  return null;
}

async function runPipelineStage(jobId, stageKey, detail, work) {
  if (isJobCancelled(jobId)) throw new Error('Job cancelled by user');
  updatePipelineStage(jobId, stageKey, 'running', detail);
  try {
    const result = await work();
    if (isJobCancelled(jobId)) throw new Error('Job cancelled by user');
    const failure = stageFailure(result);
    updatePipelineStage(jobId, stageKey, failure ? 'failed' : result?.skipped ? 'skipped' : 'completed',
      failure ? { error: failure } : {}, result);
    return result;
  } catch (err) {
    if (isJobCancelled(jobId)) throw err;
    updatePipelineStage(jobId, stageKey, 'failed', { error: err.message });
    console.warn(`  ⚠  Pipeline stage ${stageKey} failed: ${err.message}`);
    return null;
  }
}

function getRecentJobs(limit = 20) {
  const db = getDB();
  if (!db) return [];
  return db.prepare('SELECT * FROM background_jobs ORDER BY created_at DESC LIMIT ?').all(limit);
}

function markInterruptedJobs() {
  const db = getDB();
  if (!db) return 0;
  const reason = 'Server restarted before this background job completed';
  const now = new Date().toISOString();
  const leaseClauses = hasLeaseColumns(db)
    ? ', lease_epoch = lease_epoch + 1, lease_owner = NULL, lease_expiry = NULL'
    : '';
  return db.transaction(() => {
    const interrupted = db.prepare("SELECT * FROM background_jobs WHERE status IN ('running', 'queued')").all();
    const update = db.prepare(`UPDATE background_jobs SET status = 'failed', completed_at = ?, error = ?, result = ?${leaseClauses}
      WHERE id = ? AND status IN ('running', 'queued')`);
    for (const job of interrupted) {
      const previous = parseProgress(job.result);
      const result = { ...(previous && typeof previous === 'object' ? previous : { previous_result: job.result }),
        completed: false, cancelled: false, interrupted: true, outcome: 'failed', updated_at: now };
      if (Array.isArray(result.stages)) {
        result.stages = result.stages.map(stage => ['running', 'pending'].includes(stage.status)
          ? { ...stage, status: stage.status === 'running' ? 'failed' : 'skipped', completed_at: now,
            detail: { ...stage.detail, reason, ...(stage.status === 'running' ? { error: reason } : {}) } }
          : stage);
        result.failed_stages = result.stages.filter(stage => stage.status === 'failed').map(stage => stage.key);
        result.partial = result.stages.some(stage => stage.status === 'completed');
      }
      update.run(now, reason, JSON.stringify(result), job.id);
    }
    return interrupted.length;
  })();
}

/**
 * Persist cancellation and abort in-flight operations that consume the job signal.
 */
function cancelJob(id) {
  const db = getDB();
  if (!db) return false;
  const job = getJob(id);
  if (!job) return false;
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return false;
  }
  const existing = parseProgress(job.result);
  const result = job.job_type === JOB_TYPES.FULL_PIPELINE
    ? pipelineResult(id, 'cancelled')
    : { ...(existing && typeof existing === 'object' ? existing : { previous_result: job.result }), completed: false, cancelled: true, outcome: 'cancelled' };
  result.cancel_reason = 'cancelled by user';
  for (const stage of result.stages || []) {
    if (stage.status === 'running' || stage.status === 'pending') {
      stage.status = stage.status === 'running' ? 'cancelled' : 'skipped';
      stage.completed_at = result.updated_at;
      stage.detail = { ...stage.detail, reason: result.cancel_reason };
    }
  }
  const updated = db.prepare(`
    UPDATE background_jobs
    SET status = 'cancelled', completed_at = datetime('now'),
        result = ?
    WHERE id = ? AND status IN ('queued', 'running')
  `).run(JSON.stringify(result), id);
  if (updated.changes > 0) jobControllers.get(id)?.abort(new Error('Job cancelled by user'));
  return updated.changes > 0;
}

function getJobSignal(id) {
  const signal = jobControllers.get(id)?.signal;
  if (signal) return signal;
  return isJobCancelled(id) ? AbortSignal.abort(new Error('Job cancelled by user')) : undefined;
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
  if (job.status !== 'queued') return parseProgress(job.result);

  const claim = claimJob(jobId, WORKER_ID);
  if (!claim.claimed) return parseProgress(job.result);
  jobLeases.set(jobId, claim.epoch);

  const controller = new AbortController();
  jobControllers.set(jobId, controller);
  const signal = controller.signal;
  try {
    let result;

    switch (job.job_type) {
      case JOB_TYPES.FETCH_ALL: {
        const { syncAllSources } = require('./sync');
        result = await syncAllSources({ jobId, signal });
        break;
      }

      case JOB_TYPES.FETCH_SOURCE: {
        const params = JSON.parse(job.params || '{}');
        const { syncSource } = require('./sync');
        result = await syncSource(params.slug, params.date, { jobId, signal, limit: params.limit || 5, skipEnrich: true });
        break;
      }

      case JOB_TYPES.ENRICH_ITEMS: {
        const params = JSON.parse(job.params || '{}');
        result = await enrichItems(params.batchSize || DEFAULT_JOB_ENRICH_BATCH, { ...params, jobId, signal });
        break;
      }

      case JOB_TYPES.BUILD_DIGEST: {
        const params = JSON.parse(job.params || '{}');
        const date = jobDate(params.date);
        result = await generateDailyDigest(date, { jobId, signal });
        if (!result) throw new Error('Digest generation returned no result');
        break;
      }

      case JOB_TYPES.BUILD_TOPIC_GRAPH: {
        const params = JSON.parse(job.params || '{}');
        const date = jobDate(params.date);
        result = await buildTopicGraph(date, { jobId, signal, deep: params.deep === true });
        break;
      }

      case JOB_TYPES.FULL_PIPELINE: {
        const { syncAllSources: syncAll } = require('./sync');
        const { runKGFullPipeline } = require('./kg-worker');
        const { translateItems } = require('./translate');
        const params = JSON.parse(job.params || '{}');
        const today = todayDigestDate();
        const stage = (key, detail, work) => runPipelineStage(jobId, key, detail, work);
        await stage('fetch', { message: 'Starting source fetch' },
          () => syncAll({ jobId, signal, skipEnrich: true }));
        const requestedBatch = Number(params.enrichBatchSize ?? DEFAULT_JOB_ENRICH_BATCH);
        const enrichBatchSize = Number.isInteger(requestedBatch) && requestedBatch > 0
          ? Math.min(1600, requestedBatch) : DEFAULT_JOB_ENRICH_BATCH;
        await stage('enrich', { message: `Starting enrichment, batch size ${enrichBatchSize}` },
          () => enrichItems(enrichBatchSize, { jobId, signal }));
        await stage('translate', { message: 'Starting Chinese card backfill' },
          () => translateItems({ jobId, signal, batchSize: Math.min(200, enrichBatchSize) }));
        await stage('topic_graph', { date: today }, () => buildTopicGraph(today, { jobId, signal }));
        await stage('kg_worker', { sources: 'All active sources / 所有活跃信息源' },
          () => runKGFullPipeline(null));
        await stage('entity_momentum', { message: 'Computing entity momentum' }, () => {
          const { updateEntityMomentum } = require('./source-profiles');
          return updateEntityMomentum();
        });
        await stage('source_profiles', { message: 'Computing source profiles and rescoring with fresh evidence' }, async () => {
          const { updateSourceProfiles } = require('./source-profiles');
          const profileResult = updateSourceProfiles();
          const { scoreSignals } = require('./signals');
          const todayItems = getDB().prepare(`
            SELECT i.*, s.label as source_label, s.slug as source_slug
            FROM information_items i JOIN sources s ON i.source_id = s.id
            WHERE i.digest_date = ? LIMIT ?
          `).all(today, enrichBatchSize);
          let rescore = { scored: 0 };
          try {
            if (todayItems.length > 0) rescore = await scoreSignals(todayItems, { jobId, signal, autoResearch: false });
          } catch (err) {
            rescore = { error: err.message };
          }
          return { ...profileResult, rescored: rescore?.scored || 0, rescore };
        });
        await stage('digest', { date: today }, async () => {
          const digest = await generateDailyDigest(today, { jobId, signal });
          if (digest?.id) return { generated: true, id: digest.id };
          if (digest?.__skipped) return { generated: false, skipped: true, reason: digest.reason };
          return { generated: false, error: 'Digest LLM call failed (empty/unparseable response or exception)' };
        });
        await stage('hierarchy', { message: 'Building concept graph from tags' }, () => {
          const { buildTagHierarchy } = require('./tag-hierarchy');
          return buildTagHierarchy({ jobId, signal });
        });
        result = pipelineResult(jobId);
        break;
      }

      case JOB_TYPES.X_FOLLOWING_SYNC: {
        const { syncXFollowing } = require('./x-following');
        const params = JSON.parse(job.params || '{}');
        result = await syncXFollowing({ ...params, jobId, signal });
        break;
      }

      case JOB_TYPES.TRANSLATE_BACKFILL: {
        const { translateItems } = require('./translate');
        const params = JSON.parse(job.params || '{}');
        result = await translateItems({ ...params, jobId, signal });
        break;
      }

      case JOB_TYPES.SCORE_SIGNALS: {
        const { scoreSignals } = require('./signals');
        const { getDB } = require('../db/connection');
        const params = JSON.parse(job.params || '{}');
        const db = getDB();
        const date = jobDate(params.date);
        const limit = params.limit || 200;
        const items = db.prepare(`
          SELECT i.*, s.label as source_label, s.slug as source_slug
          FROM information_items i
          JOIN sources s ON i.source_id = s.id
          WHERE i.digest_date = ?
          ORDER BY i.score DESC LIMIT ?
        `).all(date, limit);
        result = await scoreSignals(items, { jobId, signal, concurrency: params.concurrency });
        break;
      }

      case JOB_TYPES.RESCORE_ALL: {
        // Full-corpus rescore: walk every digest_date (oldest first) and
        // re-classify with the current taxonomy, filling the backlog that the
        // daily pipeline leaves behind. Singleton so a second trigger reuses
        // the in-flight run rather than doubling LLM load.
        const { rescoreAllSignals } = require('./signal-rescore');
        const params = JSON.parse(job.params || '{}');
        result = await rescoreAllSignals({ jobId, signal, concurrency: params.concurrency });
        break;
      }

      case JOB_TYPES.ITEM_RESEARCH: {
        // Auto-triggered deep research for high-alpha items (Phase 3.B).
        // Skips items that already have a completed report unless force=true.
        const { generateItemResearch } = require('./research');
        const params = JSON.parse(job.params || '{}');
        if (!params.itemId) throw new Error('item-research job requires itemId');
        const db = getDB();
        const existing = !params.force
          ? db?.prepare('SELECT id FROM research_reports WHERE item_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1').get(params.itemId, 'completed')
          : null;
        if (existing) {
          result = { itemId: params.itemId, skipped: true, reason: 'existing completed report', reportId: existing.id };
        } else {
          result = await generateItemResearch(params.itemId, { jobId, signal });
        }
        break;
      }

      case JOB_TYPES.BUILD_TAG_HIERARCHY: {
        const { buildTagHierarchy } = require('./tag-hierarchy');
        result = await buildTagHierarchy({ jobId, signal });
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

    const failure = stageFailure(result);
    const failed = result?.pipeline ? !result.completed : !!failure;
    const commit = commitJobOutcome(jobId, claim.epoch, () =>
      updateJobStatus(jobId, failed ? 'failed' : 'completed', result,
        failed ? (result?.pipeline ? `Pipeline stages failed: ${result.failed_stages.join(', ')}` : failure) : null));
    if (commit.reason === 'lease-stale') return staleLeaseResult(jobId, job.job_type, claim.epoch);
    return result;
  } catch (err) {
    const cancelled = isJobCancelled(jobId);
    if (cancelled) {
      console.log(`  ⛔ Job ${jobId} (${job.job_type}) cancelled: ${err.message}`);
      return null;
    }
    console.error(`  ❌ Job ${jobId} (${job.job_type}) failed:`, err.message);
    let failureResult = null;
    if (job.job_type === JOB_TYPES.FULL_PIPELINE) {
      const current = parseProgress(getJob(jobId)?.result)?.current_stage || 'fetch';
      updatePipelineStage(jobId, current, 'failed', { error: err.message });
      failureResult = pipelineResult(jobId, 'failed');
      for (const stage of failureResult.stages) {
        if (stage.status === 'pending') {
          stage.status = 'skipped';
          stage.detail = { reason: 'Pipeline aborted before this stage' };
          stage.completed_at = failureResult.updated_at;
        }
      }
    }
    const commit = commitJobOutcome(jobId, claim.epoch, () => updateJobStatus(jobId, 'failed', failureResult, err.message));
    if (commit.reason === 'lease-stale') return staleLeaseResult(jobId, job.job_type, claim.epoch, err.message);
    throw err;
  } finally {
    jobControllers.delete(jobId);
    jobLeases.delete(jobId);
  }
}

/**
 * Create and execute a job in the background.
 * Returns the job ID immediately — the caller can poll for status.
 */
async function runJob(jobType, params = {}) {
  params = { ...params };
  if (jobType === JOB_TYPES.ENRICH_ITEMS) params.batchSize = boundedJobCount(params.batchSize, DEFAULT_JOB_ENRICH_BATCH, 1600);
  if (jobType === JOB_TYPES.FULL_PIPELINE) params.enrichBatchSize = boundedJobCount(params.enrichBatchSize, DEFAULT_JOB_ENRICH_BATCH, 1600);
  if (jobType === JOB_TYPES.FETCH_SOURCE) params.limit = boundedJobCount(params.limit, 5, 100);
  if (jobType === JOB_TYPES.SCORE_SIGNALS) params.limit = boundedJobCount(params.limit, 200, 1600);
  if (jobType === JOB_TYPES.TRANSLATE_BACKFILL) {
    if (params.all) throw new Error('Unbounded translation backfill is disabled');
    params.batchSize = boundedJobCount(params.batchSize, 50, 500);
  }
  const requested = requestedJob(jobType, params);
  if (requested) return requested.id;
  if (!params.allowConcurrent) {
    const existing = getActiveSingletonJob(jobType);
    if (existing?.id && params.requestId) throw new Error('Another bounded job is already active');
    if (existing?.id) return existing.id;
  }

  if (isJobIntakePaused()) return null;

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
  executeJob,
  cancelJob,
  getJobSignal,
  isJobCancelled,
  isJobIntakePaused,
  updateJobProgress,
};
