'use strict';

/**
 * Eagleye — Built-in Scheduler
 *
 * There was no cron / no setInterval scheduler: daily ingestion relied on a
 * manual POST /api/sync, which is the single biggest ops gap. This module gives
 * the radar a heartbeat: a 60s tick evaluates the persisted schedule and fires
 * a FULL_PIPELINE (or RESCORE_ALL) job at the configured time, guarded by the
 * existing singleton lock so a slow pipeline never overlaps itself.
 *
 * Config (user_data[scheduler_config]):
 *   { enabled: bool,
 *     time:   "HH:MM"      // local time, daily (default "04:00")
 *     task:   "pipeline"|"rescore"   // what to run (default "pipeline")
 *     lastRun: "YYYY-MM-DD HH:MM" }  // set by the tick, for /api/scheduler
 *
 * The cron surface is deliberately tiny (one daily time). A full 5-field cron
 * parser is overkill for a single-user radar; HH:MM covers the real need
 * ("refresh overnight") and is trivially correct.
 */

const { getValue, setValue } = require('../db/user-data');
const CONFIG_KEY = 'scheduler_config';

const TICK_MS = 60 * 1000;
const DEFAULTS = { enabled: false, time: '04:00', task: 'pipeline' };

let _timer = null;

function getConfig() {
  const c = getValue(CONFIG_KEY) || {};
  return {
    enabled: c.enabled === true,
    time: /^\d{2}:\d{2}$/.test(c.time || '') ? c.time : DEFAULTS.time,
    task: c.task === 'rescore' ? 'rescore' : DEFAULTS.task,
    lastRun: c.lastRun || null,
  };
}

function saveConfig(patch) {
  const next = { ...getConfig(), ...patch };
  setValue(CONFIG_KEY, next);
  return next;
}

/**
 * Returns "YYYY-MM-DD HH:MM" in local time (matches lastRun format).
 */
function nowLocalStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Decide whether the schedule should fire right now.
 * Fires once per scheduled minute: when the wall clock has just reached the
 * configured time AND we haven't already run in that exact minute. Idempotent
 * across ticks because lastRun records the "YYYY-MM-DD HH:MM" that fired.
 */
function shouldFire(cfg) {
  if (!cfg.enabled) return false;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  if (hhmm !== cfg.time) return false;
  const stamp = nowLocalStamp();
  // Already fired this exact minute → don't double-fire within the 60s tick.
  return cfg.lastRun !== stamp;
}

function fire() {
  try {
    const { runJob, JOB_TYPES } = require('./jobs');
    const taskType = getConfig().task === 'rescore' ? JOB_TYPES.RESCORE_ALL : JOB_TYPES.FULL_PIPELINE;
    const id = runJob(taskType, {});
    const stamp = nowLocalStamp();
    saveConfig({ lastRun: stamp });
    console.log(`[scheduler] fired ${taskType} job ${id} at ${stamp}`);
    return id;
  } catch (err) {
    // Non-fatal: a missing DB or job error shouldn't kill the heartbeat.
    console.warn(`[scheduler] fire failed (non-fatal): ${err.message}`);
    return null;
  }
}

function tick() {
  try {
    const cfg = getConfig();
    if (shouldFire(cfg)) fire();
  } catch (err) {
    console.warn(`[scheduler] tick error (non-fatal): ${err.message}`);
  }
}

/**
 * Start the scheduler heartbeat. Safe to call multiple times (idempotent) —
 * a running timer is cleared first. Called from server.js on boot.
 */
function start() {
  if (_timer) clearInterval(_timer);
  _timer = setInterval(tick, TICK_MS);
  // Don't keep the event loop alive solely for the scheduler (allows clean
  // shutdown when the server closes).
  if (_timer.unref) _timer.unref();
  tick(); // evaluate once immediately in case we boot exactly on the minute
  console.log('[scheduler] heartbeat started (60s tick)');
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { start, stop, getConfig, saveConfig, nowLocalStamp, TICK_MS, DEFAULTS, CONFIG_KEY };
