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

function getConfig() {
  const c = normalizeConfig(getValue(CONFIG_KEY) || {});
  if (!_firing && c.last_outcome === 'enqueueing') {
    c.last_outcome = 'enqueue_unknown';
    c.last_error = 'Scheduler enqueue was interrupted. Inspect recent jobs before manually retrying.';
  }
  let lastJobStatus = null;
  if (c.last_job_id) {
    const { getJob } = require('./jobs');
    lastJobStatus = getJob(c.last_job_id)?.status || null;
  }
  return { ...c, last_job_status: lastJobStatus,
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
