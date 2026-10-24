'use strict';

const { getValue, setValue } = require('../db/user-data');
const { getSwitches } = require('../services/runtime-switches');
const CONFIG_KEY = 'scheduler_config';
const TICK_MS = 60 * 1000;
const DEFAULTS = { enabled: false, time: '04:00', task: 'pipeline' };
const ENQUEUE_RETRY_MS = 5 * 60 * 1000;
const MAX_ENQUEUE_ATTEMPTS = 3;
const TASK_REQUIRED_SWITCHES = {
  pipeline: ['collect', 'enrich', 'digest'],
  rescore: ['enrich'],
};

let _timer = null;
let _firing = false;
let _lastPauseKey = null;

function normalizeConfig(c = {}) {
  return {
    enabled: c.enabled === true,
    time: /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(c.time || '') ? c.time : DEFAULTS.time,
    task: c.task === 'rescore' ? 'rescore' : DEFAULTS.task,
    lastRun: c.lastRun || null,
    last_attempt: c.last_attempt || null,
    attempt_count: Number.isInteger(c.attempt_count) && c.attempt_count >= 0 ? c.attempt_count : 0,
    last_job_id: c.last_job_id || null,
    last_outcome: c.last_outcome || null,
    last_error: c.last_error || null,
  };
}

function nowLocalStamp(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function attemptIsToday(cfg, now) {
  return cfg.last_attempt && nowLocalStamp(new Date(cfg.last_attempt)).slice(0, 10) === nowLocalStamp(now).slice(0, 10);
}

function scheduledTime(cfg, now) {
  const due = new Date(now);
  const [hours, minutes] = cfg.time.split(':').map(Number);
  due.setHours(hours, minutes, 0, 0);
  return due;
}

function nextDue(cfg, now) {
  if (!cfg.enabled) return null;
  const due = scheduledTime(cfg, now);
  const firedToday = cfg.lastRun?.slice(0, 10) === nowLocalStamp(now).slice(0, 10);
  const exhaustedToday = attemptIsToday(cfg, now) && cfg.attempt_count >= MAX_ENQUEUE_ATTEMPTS;
  const uncertainToday = attemptIsToday(cfg, now) && ['enqueueing', 'enqueue_unknown'].includes(cfg.last_outcome);
  if (firedToday || exhaustedToday || uncertainToday) due.setDate(due.getDate() + 1);
  else if (attemptIsToday(cfg, now) && cfg.last_outcome === 'enqueue_failed') {
    return new Date(Math.max(due.getTime(), Date.parse(cfg.last_attempt) + ENQUEUE_RETRY_MS)).toISOString();
  }
  return due.toISOString();
}

// 调度结果对账表：底层 job 到达终态后，调度状态以 job 真实终态为准并持久化。
// 修复重启后 last_outcome 停留在 queued、与 background_jobs 终态分裂的问题
// （对外状态集合：queued / running / completed / failed / cancelled）。
const JOB_STATUS_OUTCOMES = { completed: 'completed', failed: 'failed', cancelled: 'cancelled' };

// Restart recovery creates a compensation job instead of replaying the
// interrupted run. The scheduler's `last_job_id` still names the original
// run, so follow the durable links to the newest job in the chain before
// reporting an outcome. A failed root must not mask a completed resume.
function finalJobInChain(initialId, getJob, findCompensationJob) {
  const seen = new Set();
  let job = getJob(initialId);
  const chain = [];
  while (job && !seen.has(job.id)) {
    seen.add(job.id);
    chain.push({ id: job.id, status: job.status });
    let recovery = null;
    try { recovery = JSON.parse(job.result || '{}')?.recovery || null; } catch { /* legacy result */ }
    const linkedId = recovery?.compensation_job_id;
    const child = linkedId
      ? getJob(linkedId)
      : (typeof findCompensationJob === 'function' ? findCompensationJob(job.id) : null);
    if (!child || seen.has(child.id)) break;
    job = child;
  }
  return { job, chain };
}

function getConfig() {
  const c = normalizeConfig(getValue(CONFIG_KEY) || {});
  if (!_firing && c.last_outcome === 'enqueueing') {
    c.last_outcome = 'enqueue_unknown';
    c.last_error = 'Scheduler enqueue was interrupted. Inspect recent jobs before manually retrying.';
  }
  let lastJobStatus = null;
  let effectiveJobId = null;
  let lastJobChain = [];
  if (c.last_job_id) {
    const { getJob, findCompensationJob } = require('./jobs');
    const resolved = finalJobInChain(c.last_job_id, getJob, findCompensationJob);
    const job = resolved.job;
    lastJobChain = resolved.chain;
    effectiveJobId = job?.id || null;
    lastJobStatus = job?.status || null;
    // 对账并写回：只有与底层 job 终态不一致时才持久化，避免仅展示层字段分裂。
    const terminalOutcome = JOB_STATUS_OUTCOMES[job?.status];
    if (terminalOutcome && c.last_outcome !== terminalOutcome) {
      c.last_outcome = terminalOutcome;
      if (job.status === 'failed') c.last_error = job.error || c.last_error || 'Underlying job failed';
      else if (job.status === 'cancelled') c.last_error = 'Underlying job was cancelled';
      else c.last_error = null;
      setValue(CONFIG_KEY, normalizeConfig(c));
    } else if (job?.status === 'running' && c.last_outcome === 'queued') {
      // queued → running 也持久化，保证对外状态与 job 执行态一致。
      c.last_outcome = 'running';
      setValue(CONFIG_KEY, normalizeConfig(c));
    }
  }
  return { ...c, last_job_status: lastJobStatus, effective_job_id: effectiveJobId,
    last_job_chain: lastJobChain,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    next_due: nextDue(c, new Date()) };
}

function saveConfig(patch) {
  const next = normalizeConfig({ ...(getValue(CONFIG_KEY) || {}), ...patch });
  setValue(CONFIG_KEY, next);
  return getConfig();
}

function shouldFire(cfg, now = new Date()) {
  if (!cfg.enabled || cfg.lastRun?.slice(0, 10) === nowLocalStamp(now).slice(0, 10)) return false;
  if (now < scheduledTime(cfg, now)) return false;
  if (attemptIsToday(cfg, now)) {
    if (['enqueueing', 'enqueue_unknown'].includes(cfg.last_outcome)) return false;
    if (cfg.attempt_count >= MAX_ENQUEUE_ATTEMPTS) return false;
    if (cfg.last_outcome === 'enqueue_failed' && now.getTime() - Date.parse(cfg.last_attempt) < ENQUEUE_RETRY_MS) return false;
  }
  return true;
}

async function fire(cfg) {
  const now = new Date();
  const attempt = {
    last_attempt: now.toISOString(),
    attempt_count: attemptIsToday(cfg, now) ? cfg.attempt_count + 1 : 1,
    last_error: null,
    last_job_id: null,
  };
  saveConfig({ ...attempt, last_outcome: 'enqueueing' });
  let id;
  try {
    const { runJob, JOB_TYPES } = require('./jobs');
    const taskType = cfg.task === 'rescore' ? JOB_TYPES.RESCORE_ALL : JOB_TYPES.FULL_PIPELINE;
    id = await runJob(taskType, {});
    if (typeof id !== 'string' || !id) throw new Error('Scheduler could not create a background job');
  } catch (err) {
    saveConfig({ ...attempt, last_outcome: 'enqueue_failed', last_error: err.message });
    console.warn(`[scheduler] enqueue failed: ${err.message}`);
    return null;
  }
  saveConfig({ ...attempt, lastRun: nowLocalStamp(now), last_job_id: id, last_outcome: 'queued' });
  return id;
}

async function tick() {
  if (_firing) return;
  try {
    const cfg = getConfig();
    if (!shouldFire(cfg)) return;
    const required = TASK_REQUIRED_SWITCHES[cfg.task] || [];
    const switches = getSwitches();
    const paused = required.filter(key => switches[key] === false);
    if (paused.length > 0) {
      const pauseKey = paused.join(',');
      if (_lastPauseKey !== pauseKey) {
        _lastPauseKey = pauseKey;
        console.warn(`[scheduler] ${cfg.task} skipped: runtime switch paused (${pauseKey})`);
      }
      if (cfg.last_outcome !== 'switch_paused') saveConfig({ last_outcome: 'switch_paused' });
      return;
    }
    _lastPauseKey = null;
    _firing = true;
    await fire(cfg);
  } catch (err) {
    console.warn(`[scheduler] tick error: ${err.message}`);
  } finally { _firing = false; }
}

function start() {
  if (_timer) clearInterval(_timer);
  _timer = setInterval(tick, TICK_MS);
  if (_timer.unref) _timer.unref();
  void tick();
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { start, stop, getConfig, saveConfig, nowLocalStamp, tick, shouldFire, TICK_MS, DEFAULTS, CONFIG_KEY };
