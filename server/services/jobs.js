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
const { normalizeDigestDate, todayDigestDate } = require('./date-contract');

// buildTopicGraph is required lazily at its call sites (BUILD_TOPIC_GRAPH /
// the FULL_PIPELINE topic_graph stage) so jobs.js only pulls what the fired
// job actually needs.

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
  BUILD_TAG_HIERARCHY: 'build-tag-hierarchy',
  // R3 EAGLEYE_R3_DRAINER: 2h convergence drain entry (timer-fired via
  // scripts/kg-drain.js). Append-only job type per the R3 file boundary.
  KG_DRAIN: 'kg-drain',
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
  // The KG drain must be a true singleton — the enrich drainer's known gap
  // (ENRICH_ITEMS is NOT a singleton) must not be copied: a second 2h fire
  // while one drain runs reuses the in-flight job instead of doubling load.
  JOB_TYPES.KG_DRAIN,
]);

// D7 WAL governance: bulk-writing job types checkpoint the WAL when the run
// ends so the -wal file returns to baseline instead of growing unbounded
// (it reached 172MB in production). Gated to the daily pipeline and the
// enrich drain job (the 2h drainer's /api/enrich?background=true and manual
// background enrich both land in ENRICH_ITEMS).
const WAL_CHECKPOINT_JOB_TYPES = new Set([
  JOB_TYPES.FULL_PIPELINE,
  JOB_TYPES.ENRICH_ITEMS,
  // The KG drain is a bulk writer too (features / vectors / topic
  // assignments / edges); D7 exists precisely because failed drains used to
  // leave WAL frames accumulating for days.
  JOB_TYPES.KG_DRAIN,
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

/**
 * D7 WAL governance: TRUNCATE-checkpoint the shared connection once a
 * bulk-writing job (full pipeline / enrich drain) has finished — success,
 * failure or cancellation alike (failed enrich drains used to leave WAL
 * frames accumulating for days). Best-effort: a checkpoint failure never
 * fails the job itself.
 */
function checkpointWALAfterJob(jobId, jobType) {
  try {
    const db = getDB();
    if (!db) return;
    db.pragma('wal_checkpoint(TRUNCATE)');
    console.log(`  🧹 WAL checkpoint (TRUNCATE) after ${jobType} job ${jobId}`);
  } catch (err) {
    console.warn(`  ⚠  WAL checkpoint after ${jobType} job ${jobId} failed: ${err?.message || err}`);
  }
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
      if (['completed', 'failed', 'skipped', 'degraded'].includes(status)) stage.completed_at = now;
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

function findCompensationJob(jobId) {
  const db = getDB();
  if (!db || !jobId) return null;
  return db.prepare(`
    SELECT * FROM background_jobs
    WHERE job_type = ? AND json_extract(params, '$.resume_of') = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(JOB_TYPES.FULL_PIPELINE, jobId) || null;
}

function pipelineResult(jobId, outcome = null) {
  const progress = parseProgress(getJob(jobId)?.result) || emptyPipelineProgress();
  const stages = progress.stages || [];
  const failedStages = stages.filter(stage => stage.status === 'failed').map(stage => stage.key);
  const degradedStages = stages.filter(stage => stage.status === 'degraded').map(stage => stage.key);
  const cancelled = outcome === 'cancelled';
  return {
    ...progress,
    completed: !cancelled && failedStages.length === 0
      && stages.every(stage => ['completed', 'skipped', 'degraded'].includes(stage.status)),
    cancelled,
    outcome: outcome || (failedStages.length ? 'failed' : 'completed'),
    partial: stages.some(stage => stage.status === 'completed') && (cancelled || failedStages.length > 0),
    failed_stages: failedStages,
    degraded: degradedStages.length > 0,
    degraded_stages: degradedStages,
    summary: Object.fromEntries(stages.map(stage => [stage.key, stage.result])),
    updated_at: new Date().toISOString(),
  };
}

/**
 * EAGLEYE_R3_PARTIAL_FAIL — enrich partial-failure semantics (R3 stage 2).
 * Default ON; an explicitly falsy value ('0', 'false', …) restores the
 * legacy whole-batch judgment byte-identically. Since 10-19 the 2h enrich
 * drainer lost 2-34 items out of 1,200 per run (dead LLM batches + gate
 * skips) and this rule marked every such job failed even though the
 * ~1,196 successful items already flow downstream at the data layer
 * (downstream selectors never read background_jobs). Per-item retry /
 * poison-pill state lives on information_items.enrichment_attempts.
 */
function enrichPartialFailureEnabled() {
  const raw = String(process.env.EAGLEYE_R3_PARTIAL_FAIL ?? '').trim().toLowerCase();
  if (!raw) return true; // unset/empty → default ON
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function stageFailure(result, stageKey = null) {
  if (!result || typeof result !== 'object') return null;
  if (result.error || ['error', 'failed'].includes(result.status)) return result.error || result.message || 'Stage returned a failure';
  if (result.fallback_reason) return `Requested backend degraded: ${result.fallback_reason}`;
  // A fetch envelope signals per-source failures, not a failed stage. The
  // distinction between partial and total fetch failure belongs to the stage
  // runner, which has the whole source list. Check this before the generic
  // `failed` count clause, because syncAll returns `{ fetch, failed }`.
  if (stageKey === 'fetch' && Array.isArray(result.fetch)) return null;
  // Enrich-shaped batches (an `enriched` count) under the new semantics only
  // fail when the WHOLE batch died (enriched === 0); partial failures stay
  // visible in the stored result (failed count, successful_item_ids). Other
  // shapes — translate {translated, failed}, fetch rows, nested KG results —
  // keep today's judgment exactly.
  const wholeBatchFailure = !(typeof result.enriched === 'number' && result.enriched > 0 && enrichPartialFailureEnabled());
  const failedCount = Number(result.failed) || 0;
  const deferredCount = Number(result.deferred) || 0;
  if (failedCount > 0 && wholeBatchFailure) return `${failedCount} item(s) failed`;
  if (deferredCount > 0 && wholeBatchFailure) return `${deferredCount} item(s) deferred`;
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
    let failure = stageFailure(result, stageKey);
    let degraded = null;
    if (stageKey === 'fetch' && Array.isArray(result?.fetch)) {
      const failedSources = result.fetch.filter(row => row.error || row.status === 'failed');
      const availableSources = result.fetch.filter(row => !row.error && row.status !== 'failed');
      if (failedSources.length > 0 && availableSources.length === 0) {
        failure = failedSources.map(row => `${row.source || 'unknown'}: ${row.error || 'failed'}`).join('; ');
      } else if (failedSources.length > 0) {
        degraded = {
          warning: `${failedSources.length} source(s) failed; continuing downstream with ${availableSources.length} available source(s)`,
          failed_sources: failedSources.map(row => row.source || 'unknown'),
        };
      }
    }
    const status = failure ? 'failed' : degraded ? 'degraded' : result?.skipped ? 'skipped' : 'completed';
    updatePipelineStage(jobId, stageKey, status, failure ? { error: failure } : degraded || {}, result);
    // A fetch failure is a pipeline-level stop condition. Only the fetch stage
    // has the whole source set needed to distinguish a degraded round (some
    // sources succeeded) from a dead one. Other stages intentionally keep the
    // collect-and-continue semantics below, but continuing enrichment/digest
    // work after every source failed would publish an empty run as progress.
    if (failure && stageKey === 'fetch') throw new Error(failure);
    return result;
  } catch (err) {
    if (isJobCancelled(jobId)) throw err;
    updatePipelineStage(jobId, stageKey, 'failed', { error: err.message });
    console.warn(`  ⚠  Pipeline stage ${stageKey} failed: ${err.message}`);
    // The stage layer records the failure before rethrowing because the outer
    // executor owns terminalization. Swallowing a fetch exception here used to
    // let a fully dead fetch advance into enrich with no source rows.
    if (stageKey === 'fetch') throw err;
    return null;
  }
}

function getRecentJobs(limit = 20) {
  const db = getDB();
  if (!db) return [];
  return db.prepare('SELECT * FROM background_jobs ORDER BY created_at DESC LIMIT ?').all(limit);
}

// 重启恢复（scheduler-recovery）：只对 running 的 full-pipeline 尝试恢复，
// 依据是 job.result 里按阶段持久化的检查点（stage 状态与输出）。
// - fetch 已到终态（completed/failed/skipped）→ 抓取已完整落盘，创建补偿 job
//   从第一个未完成阶段续跑，复用已持久化的 stage 输出，不重抓不重复写入。
// - fetch 仍未终态（抓取中途被打断）→ 没有每源检查点，续跑等于盲目重放整条
//   pipeline，按策略明确拒绝恢复并失败。
// - 全部阶段已落盘（进程死在最终提交前）→ 就地按阶段终态收敛 job 终态。
// - queued job 从未开始、非 pipeline job 无阶段检查点 → 一律明确失败。
// 语义保持：补偿 job 走正常 runJob/claimJob（单例、lease、EAGLEYE_JOBS_PAUSED
// 回滚门全部复用）；默认 recover=false 维持旧行为（优雅停机路径不受影响）。
const SUCCESS_STAGE_STATUSES = new Set(['completed', 'skipped', 'degraded']);

function progressStages(progress) {
  if (!Array.isArray(progress?.stages)) return null;
  return new Map(progress.stages.map(stage => [stage?.key, stage]).filter(([key]) => key));
}

function pipelineDate(job, progress) {
  let params = {};
  try { params = JSON.parse(job?.params || '{}') || {}; } catch { /* legacy text params */ }
  const persisted = normalizeDigestDate(params.date);
  if (persisted) return persisted;
  const fetchStage = progressStages(progress)?.get('fetch');
  return normalizeDigestDate(fetchStage?.detail?.date) || normalizeDigestDate(fetchStage?.result?.date) || null;
}

// A stage list is a checkpoint, not a set of hints. The first stage that has
// not reached a successful terminal state is resumable even when its own
// status is running/failed/pending; completed prefixes are reused verbatim.
// For a fetch resume the persisted per-source rows are the checkpoint and the
// next attempt only fills the missing/error sources.
function planPipelineRecovery(job) {
  const progress = parseProgress(job.result);
  const stages = progressStages(progress);
  if (!stages) return { action: 'refuse', reason: 'no-stage-progress' };
  const firstUnfinished = PIPELINE_STAGES.findIndex(([key]) => {
    const stage = stages.get(key);
    return !stage || !SUCCESS_STAGE_STATUSES.has(stage.status);
  });
  if (firstUnfinished === -1) return { action: 'finalize', outcome: 'completed', progress };

  const resumeFromStage = PIPELINE_STAGES[firstUnfinished][0];
  const date = pipelineDate(job, progress);
  if (!date) return { action: 'refuse', reason: 'job-date-missing' };

  let fetchCheckpoint = null;
  if (resumeFromStage === 'fetch') {
    const fetchStage = stages.get('fetch');
    const rows = fetchStage?.detail?.results;
    if (fetchStage && !Array.isArray(rows)) {
      return { action: 'refuse', reason: 'fetch-checkpoint-missing' };
    }
    fetchCheckpoint = Array.isArray(rows) ? rows : [];
  }

  const rootResumeOf = progress.root_resume_of
    || progress.resume_of
    || job.id;
  return {
    action: 'resume',
    resumeFromStage,
    date,
    rootResumeOf,
    progress,
    fetchCheckpoint,
  };
}

// 把源 job 已到终态的阶段原样拷贝进补偿 job 的进度（含 stage 输出），使
// pipelineResult 能把补偿运行与原运行的已完成部分合并成一个完整视图。
function seedResumeProgress(jobId, originalProgress, resumeFromStage, resumeOf, rootResumeOf) {
  const db = getDB();
  if (!db) return;
  const stageOrder = PIPELINE_STAGES.map(([key]) => key);
  const resumeIndex = stageOrder.indexOf(resumeFromStage);
  const progress = emptyPipelineProgress();
  const originalStages = Array.isArray(originalProgress?.stages) ? originalProgress.stages : [];
  // 只拷贝 resume 点之前的前缀阶段：中断标注会把运行中/未开始的阶段改写为
  // failed/skipped，那些阶段必须由补偿 job 重新执行而不是原样带过来。
  if (resumeIndex > 0) {
    for (const stage of progress.stages) {
      if (stageOrder.indexOf(stage.key) >= resumeIndex) continue;
      const source = originalStages.find(row => row.key === stage.key);
      if (source && SUCCESS_STAGE_STATUSES.has(source.status)) {
        stage.status = source.status;
        stage.detail = source.detail;
        stage.result = source.result;
        stage.started_at = source.started_at;
        stage.completed_at = source.completed_at;
      }
    }
  }
  // Carry the resume stage's checkpoint (fetch rows, partial counts) without
  // copying its interrupted failure status. The stage runner advances it from
  // running to its real terminal state in this job.
  const resumeStage = progress.stages.find(stage => stage.key === resumeFromStage);
  const sourceStage = originalStages.find(row => row.key === resumeFromStage);
  if (resumeStage && sourceStage) {
    resumeStage.detail = sourceStage.detail ? { ...sourceStage.detail } : null;
    if (resumeStage.detail) delete resumeStage.detail.error;
    resumeStage.result = sourceStage.result ?? null;
  }
  progress.current_stage = resumeFromStage;
  progress.resume_of = resumeOf;
  progress.root_resume_of = rootResumeOf;
  progress.resumed_from_stage = resumeFromStage;
  progress.updated_at = new Date().toISOString();
  db.prepare('UPDATE background_jobs SET result = ? WHERE id = ? AND status = ?')
    .run(JSON.stringify(progress), jobId, 'running');
}

function reconcileInterruptedJobs({ recover = false } = {}) {
  const db = getDB();
  if (!db) return 0;
  const reason = 'Server restarted before this background job completed';
  const now = new Date().toISOString();
  const leaseClauses = hasLeaseColumns(db)
    ? ', lease_epoch = lease_epoch + 1, lease_owner = NULL, lease_expiry = NULL'
    : '';
  const resumePlans = [];
  const refusedPlans = [];
  const count = db.transaction(() => {
    const interrupted = db.prepare("SELECT * FROM background_jobs WHERE status IN ('running', 'queued')").all();
    // 终态参数化：恢复路径除了 failed，还可能就地收敛为 completed。
    const update = db.prepare(`UPDATE background_jobs SET status = ?, completed_at = ?, error = ?, result = ?${leaseClauses}
      WHERE id = ? AND status IN ('running', 'queued')`);
    for (const job of interrupted) {
      const previous = parseProgress(job.result);
      const plan = recover && job.status === 'running' && job.job_type === JOB_TYPES.FULL_PIPELINE
        ? planPipelineRecovery(job)
        : null;
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
      let terminalStatus = 'failed';
      let failureReason = reason;
      if (recover) {
        if (job.status === 'running' && job.job_type === JOB_TYPES.FULL_PIPELINE) {
          if (plan.action === 'resume') {
            result.recovery = { action: 'resume_scheduled', resume_of: job.id, root_resume_of: plan.rootResumeOf,
              resume_from_stage: plan.resumeFromStage, date: plan.date, planned_at: now };
            failureReason = `${reason}; recovery scheduled: remaining stages resume from '${plan.resumeFromStage}' in a follow-up job (persisted checkpoint reused)`;
            resumePlans.push({ resumeOf: job.id, rootResumeOf: plan.rootResumeOf,
              resumeFromStage: plan.resumeFromStage, date: plan.date, params: job.params,
              createdAt: job.created_at, previous });
            console.log(`  ♻️  Recovery: full-pipeline ${job.id} will resume from stage '${plan.resumeFromStage}'`);
          } else if (plan.action === 'finalize') {
            // 所有阶段已落盘：按阶段终态收敛，不重跑任何阶段。
            result.completed = plan.outcome === 'completed';
            result.outcome = plan.outcome;
            result.recovery = { action: 'finalized', planned_at: now };
            terminalStatus = plan.outcome;
            failureReason = `${reason}; recovery finalized: all stages were already persisted, outcome ${plan.outcome} committed without re-running`;
            console.log(`  ♻️  Recovery: full-pipeline ${job.id} finalized as ${plan.outcome} from persisted stages`);
          } else {
            result.recovery = { action: 'resume_refused', reason: plan.reason, planned_at: now };
            failureReason = `${reason}; recovery refused (${plan.reason}): no safe resume checkpoint, replaying would repeat the whole pipeline`;
            console.warn(`  ⚠  Recovery refused for full-pipeline ${job.id}: ${plan.reason}`);
            refusedPlans.push(job.id);
          }
        } else if (job.status === 'queued') {
          // queued 与 running 的分界：queued 从未开始，自动重放等于盲目重跑
          // 整个 job，明确失败并留下拒绝原因。
          result.recovery = { action: 'resume_refused', reason: 'job-never-started', planned_at: now };
          failureReason = `${reason}; recovery refused (job-never-started): queued job has no checkpoint to resume`;
          console.warn(`  ⚠  Recovery refused for queued job ${job.id} (${job.job_type}): never started`);
        } else {
          result.recovery = { action: 'resume_refused', reason: 'no-checkpoint-for-job-type', planned_at: now };
          failureReason = `${reason}; recovery refused (no-checkpoint-for-job-type): only full-pipeline persists resumable stage checkpoints`;
          console.warn(`  ⚠  Recovery refused for ${job.job_type} job ${job.id}: no stage checkpoint`);
        }
      }
      update.run(terminalStatus, now, terminalStatus === 'completed' ? null : failureReason, JSON.stringify(result), job.id);
    }
    return interrupted.length;
  })();

  return { count, resumePlans, refusedPlans };
}

async function enqueueRecoveryJobs(db, resumePlans) {
  // A single process has no queued-job pump. Resume the newest interrupted
  // full-pipeline and explicitly account for older roots instead of letting
  // the singleton intake silently hand back the wrong job ID.
  const ordered = [...resumePlans].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  if (ordered.length > 1) {
    for (const superseded of ordered.slice(1)) {
      const progress = parseProgress(getJob(superseded.resumeOf)?.result);
      if (progress?.recovery) {
        progress.recovery.action = 'resume_superseded';
        progress.recovery.superseded_by = ordered[0].resumeOf;
        db.prepare('UPDATE background_jobs SET result = ? WHERE id = ?').run(JSON.stringify(progress), superseded.resumeOf);
      }
    }
  }
  for (const plan of ordered.slice(0, 1)) {
    try {
      const originalParams = JSON.parse(plan.params || '{}');
      const existing = db.prepare(`
        SELECT id FROM background_jobs
        WHERE job_type = ? AND json_extract(params, '$.resume_of') = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(JOB_TYPES.FULL_PIPELINE, plan.resumeOf);
      const recoveryParams = {
        ...originalParams,
        date: plan.date,
        resume_of: plan.resumeOf,
        root_resume_of: plan.rootResumeOf,
        resume_from_stage: plan.resumeFromStage,
        allowConcurrent: true,
      };
      delete recoveryParams.allowConcurrent;
      const compensationId = existing?.id || await runJob(JOB_TYPES.FULL_PIPELINE, { ...recoveryParams, allowConcurrent: true });
      if (!compensationId) {
        console.warn(`  ⚠  Recovery of full-pipeline ${plan.resumeOf} not enqueued: job intake paused (EAGLEYE_JOBS_PAUSED)`);
        // 如实写回“未入队”，避免源 job 留下与事实不符的 resume_scheduled。
        const progress = parseProgress(getJob(plan.resumeOf)?.result);
        if (progress?.recovery) {
          progress.recovery.action = 'resume_blocked_jobs_paused';
          db.prepare('UPDATE background_jobs SET result = ? WHERE id = ?').run(JSON.stringify(progress), plan.resumeOf);
        }
      } else {
        const progress = parseProgress(getJob(plan.resumeOf)?.result);
        if (progress?.recovery) {
          progress.recovery.action = existing?.id ? 'resume_already_enqueued' : 'resume_scheduled';
          progress.recovery.compensation_job_id = compensationId;
          db.prepare('UPDATE background_jobs SET result = ? WHERE id = ?').run(JSON.stringify(progress), plan.resumeOf);
        }
        console.log(`  ♻️  Recovery job ${compensationId} enqueued for ${plan.resumeOf} (resume_from_stage='${plan.resumeFromStage}')`);
      }
    } catch (err) {
      console.warn(`  ⚠  Recovery of full-pipeline ${plan.resumeOf} failed to enqueue: ${err.message}`);
      const progress = parseProgress(getJob(plan.resumeOf)?.result);
      if (progress?.recovery) {
        progress.recovery.action = 'resume_enqueue_failed';
        progress.recovery.error = err.message;
        db.prepare('UPDATE background_jobs SET result = ? WHERE id = ?').run(JSON.stringify(progress), plan.resumeOf);
      }
    }
  }
}

let recoveryInFlight = null;

function markInterruptedJobs({ recover = false } = {}) {
  const reconciliation = reconcileInterruptedJobs({ recover });
  if (!recover || reconciliation.resumePlans.length === 0) return reconciliation.count;
  if (recoveryInFlight) return recoveryInFlight;
  recoveryInFlight = enqueueRecoveryJobs(getDB(), reconciliation.resumePlans)
    .then(() => reconciliation.count)
    .finally(() => { recoveryInFlight = null; });
  return recoveryInFlight;
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
        const { buildTopicGraph } = require('./topic-graph');
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
        // The digest date belongs to the job contract. Persisting it at
        // creation keeps a restart after midnight on the original day.
        const date = jobDate(params.date);
        const stage = (key, detail, work) => runPipelineStage(jobId, key, detail, work);
        const requestedBatch = Number(params.enrichBatchSize ?? DEFAULT_JOB_ENRICH_BATCH);
        const enrichBatchSize = Number.isInteger(requestedBatch) && requestedBatch > 0
          ? Math.min(1600, requestedBatch) : DEFAULT_JOB_ENRICH_BATCH;

        // 重启补偿：resume_from_stage 表示本 job 从持久化检查点续跑剩余阶段。
        // 已落盘阶段（含 stage 输出）从源 job 原样拷入进度，fetch 不重抓，
        // 避免重复写入；单例/lease/取消语义与本 job 自身的 claim 一致。
        const resumeFromStage = params.resume_from_stage;
        let startIndex = 0;
        let fetchCheckpoint = null;
        if (resumeFromStage) {
          const stageOrder = PIPELINE_STAGES.map(([key]) => key);
          startIndex = stageOrder.indexOf(resumeFromStage);
          if (startIndex < 0) throw new Error(`Invalid resume_from_stage: ${resumeFromStage}`);
          const originalProgress = parseProgress(getJob(params.resume_of || '')?.result);
          if (!originalProgress) throw new Error(`Cannot resume: source job ${params.resume_of || '(missing)'} has no checkpoint`);
          if (resumeFromStage === 'fetch') {
            const sourceFetch = originalProgress.stages?.find(stage => stage.key === 'fetch');
            if (!Array.isArray(sourceFetch?.detail?.results)) {
              throw new Error('Cannot resume fetch without a per-source checkpoint');
            }
            fetchCheckpoint = sourceFetch.detail.results;
          }
          seedResumeProgress(jobId, originalProgress,
            resumeFromStage, params.resume_of, params.root_resume_of || params.resume_of);
          console.log(`  ♻️  Job ${jobId} (${job.job_type}) resuming from stage '${resumeFromStage}' (recovered from ${params.resume_of})`);
        }

        // 阶段按声明顺序执行；恢复运行从 startIndex 起只跑剩余阶段。
        const stageRuns = [
          ['fetch', { message: 'Starting source fetch' },
            () => syncAll({ jobId, signal, skipEnrich: true, date, fetchCheckpoint })],
          ['enrich', { message: `Starting enrichment, batch size ${enrichBatchSize}` },
            () => enrichItems(enrichBatchSize, { jobId, signal })],
          ['translate', { message: 'Starting Chinese card backfill' },
            () => translateItems({ jobId, signal, batchSize: Math.min(200, enrichBatchSize) })],
          ['topic_graph', { date }, () => {
            const { buildTopicGraph } = require('./topic-graph');
            return buildTopicGraph(date, { jobId, signal });
          }],
          ['kg_worker', { sources: 'All active sources / 所有活跃信息源' },
            () => runKGFullPipeline(null)],
          ['entity_momentum', { message: 'Computing entity momentum' }, () => {
            const { updateEntityMomentum } = require('./source-profiles');
            return updateEntityMomentum();
          }],
          ['source_profiles', { message: 'Computing source profiles and rescoring with fresh evidence' }, async () => {
            const { updateSourceProfiles } = require('./source-profiles');
            const profileResult = updateSourceProfiles();
            const { scoreSignals } = require('./signals');
            const todayItems = getDB().prepare(`
              SELECT i.*, s.label as source_label, s.slug as source_slug
              FROM information_items i JOIN sources s ON i.source_id = s.id
              WHERE i.digest_date = ? LIMIT ?
            `).all(date, enrichBatchSize);
            let rescore = { scored: 0 };
            try {
              if (todayItems.length > 0) rescore = await scoreSignals(todayItems, { jobId, signal });
            } catch (err) {
              rescore = { error: err.message };
            }
            return { ...profileResult, rescored: rescore?.scored || 0, rescore };
          }],
          ['digest', { date }, async () => {
            const digest = await generateDailyDigest(date, { jobId, signal });
            if (digest?.id) return { generated: true, id: digest.id };
            if (digest?.__skipped) return { generated: false, skipped: true, reason: digest.reason };
            return { generated: false, error: 'Digest LLM call failed (empty/unparseable response or exception)' };
          }],
          ['hierarchy', { message: 'Building concept graph from tags' }, () => {
            const { buildTagHierarchy } = require('./tag-hierarchy');
            return buildTagHierarchy({ jobId, signal });
          }],
        ];
        for (const [key, detail, work] of stageRuns.slice(startIndex)) {
          await stage(key, detail, work);
        }
        result = pipelineResult(jobId);
        break;
      }

      case JOB_TYPES.KG_DRAIN: {
        // EAGLEYE_R3_DRAINER 2h convergence drain (timer-fired via
        // scripts/kg-drain.js). jobs.js stays switch-agnostic: runKGDrain
        // no-ops with { skipped: 'disabled' } when the switch is off, so a
        // manually fired job completes with the skip result instead of
        // hanging. Params (idleWindow) pass straight through.
        const params = JSON.parse(job.params || '{}');
        const { runKGDrain } = require('./kg-drainer');
        result = await runKGDrain({ jobId, signal, ...params });
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
    // D7: checkpoint once the run has fully ended, whatever the outcome.
    if (WAL_CHECKPOINT_JOB_TYPES.has(job.job_type)) checkpointWALAfterJob(jobId, job.job_type);
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
  // Persist the day this run belongs to before executeJob can cross midnight.
  // Recovery pins the same date explicitly; both paths use jobDate().
  if (jobType === JOB_TYPES.FULL_PIPELINE) params.date = jobDate(params.date);
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
  findCompensationJob,
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
