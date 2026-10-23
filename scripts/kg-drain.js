#!/usr/bin/env node
/**
 * R3 convergence drainer — 2h fire script (EAGLEYE_R3_DRAINER).
 *
 * Repo-side half of the 3b98144 enrich-drainer three-piece pattern: this
 * script + a systemd user unit + a 2h timer (see
 * scripts/systemd/argus-eagleye-kg-drain.{service,timer}). The script is
 * the timer's entry point: it probes the convergence backlog read-only and
 * fires the kg-drain singleton job through the job system (runJob) — the
 * job never writes the DB from here directly.
 *
 * Thin and side-effect-free at import: real dependencies (backlog probe,
 * job fire) are lazy-wired inside main() and injectable for tests.
 *
 * Switch OFF → { skipped: 'disabled' }: the timer keeps running but nothing
 * is probed or fired — identical to today's no-drainer behavior. Every skip
 * path resolves (exit 0): a skipped drain cycle is not an error.
 */
'use strict';

// Fire floor copied from the enrich drainer (backlog < 200 → skip).
const FIRE_THRESHOLD = 200;

// Idle catch-up window, default 00:30–05:30 local: inside it the drain runs
// oldest-first with catch-up caps to chew the old backlog
// (旧积压空闲时段补齐). Override with EAGLEYE_KG_DRAIN_IDLE_WINDOW=HH:MM-HH:MM.
const DEFAULT_IDLE_WINDOW = '00:30-05:30';

function isDrainerEnabled() {
  const raw = String(process.env.EAGLEYE_R3_DRAINER ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function parseClock(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return fallback;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440 ? minutes : fallback;
}

function inIdleWindow(date, windowSpec = process.env.EAGLEYE_KG_DRAIN_IDLE_WINDOW || DEFAULT_IDLE_WINDOW) {
  const [startRaw, endRaw] = String(windowSpec).split('-');
  const start = parseClock(startRaw, 30); // 00:30
  const end = parseClock(endRaw, 330); // 05:30
  const minutes = date.getHours() * 60 + date.getMinutes();
  return minutes >= start && minutes < end;
}

/**
 * Read-only convergence backlog: non-duplicate items from an active source
 * that still miss KG features, the current semantic-hash vector, the current
 * semantic-lite vector, or a dynamic-topic assignment. This is the drainable
 * fair_items caliber: inactive-source rows can never be selected by a drain.
 * Semantic-hash also pins the live model; content-hash drift is not counted
 * here (production audit 2026-10-23 found 0 drifted rows). Opened strictly
 * read-only — the script never writes the production DB.
 *
 * R3.0 跨天重复治理: 口径 = 非 dup 行（BACKLOG_REAL caliber）— 排除
 * duplicate_of IS NOT NULL 的软标记重复行; dup 行不再虚抬 200 条火线。
 */
function defaultCountBacklog() {
  const Database = require('better-sqlite3'); // lazy: keeps import side-effect free
  const { getDBPath } = require('../server/config');
  const db = new Database(getDBPath(), { readonly: true });
  try {
    return db.prepare(`
      SELECT COUNT(*) AS backlog
      FROM information_items i JOIN sources s ON s.id = i.source_id
      WHERE s.is_active = 1 AND i.duplicate_of IS NULL
        AND (NOT EXISTS (SELECT 1 FROM item_features f WHERE f.item_id = i.id)
          OR NOT EXISTS (SELECT 1 FROM item_vectors v WHERE v.item_id = i.id
                         AND v.vector_type = 'semantic-hash'
                         AND v.model_name = 'eagleye-hash-v1')
          OR NOT EXISTS (SELECT 1 FROM item_vectors v WHERE v.item_id = i.id
                         AND v.vector_type = 'semantic-lite'
                         AND v.model_name = 'eagleye-hash-v1')
          OR NOT EXISTS (SELECT 1 FROM item_topic_assignments a WHERE a.item_id = i.id
                         AND a.topic_kind = 'dynamic'))
    `).get().backlog;
  } finally {
    db.close();
  }
}

/** Goes through the job system so the drain is visible, cancellable and
 *  singleton-protected like every other job. */
async function defaultFireDrainJob(params) {
  const { runJob, JOB_TYPES } = require('../server/services/jobs');
  const jobId = await runJob(JOB_TYPES.KG_DRAIN, params);
  if (!jobId) throw new Error('kg-drain job was not queued (job intake paused?)');
  return { job_id: jobId };
}

async function main(deps = {}) {
  if (!isDrainerEnabled()) return { skipped: 'disabled' };
  const {
    countBacklog = defaultCountBacklog,
    fireDrainJob = defaultFireDrainJob,
    now = () => new Date(),
  } = deps;
  const backlog = await countBacklog();
  if (!Number.isFinite(backlog) || backlog < FIRE_THRESHOLD) {
    return { skipped: 'backlog-below-threshold', backlog };
  }
  const idleWindow = inIdleWindow(now());
  const { job_id } = await fireDrainJob({ idleWindow });
  return { fired: true, job_id };
}

async function cli() {
  const result = await main();
  console.log(JSON.stringify(result));
}

if (require.main === module) {
  cli().catch(error => {
    console.error(`kg-drain failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = { main, isDrainerEnabled, inIdleWindow, FIRE_THRESHOLD };
