/**
 * R3 convergence drainer — EAGLEYE_R3_DRAINER (Round 3 stage 2).
 *
 * The KG convergence stages (extract / embed / topics) move from the nightly
 * one-shot pipeline (caps 200/500/1000, one run per pipeline — the exact
 * bottleneck the stage-1 diagnosis found: every stage was pinned at its cap
 * with skipped=0 while intake ran ~4.4k items/day) to a 2h continuous
 * drainer, copying the 3b98144 enrich drainer operating model.
 *
 * R3.1 (CTO ruling A on Q1/Q2): catch-up is triggered by the backlog itself
 * — backlog_features > 500 while load1 < 2.5 (read from /proc/loadavg) —
 * instead of the 00:30–05:30 clock window the 2h script used to flag; two
 * consecutive samples with load1 ≥ 3.0 downgrade the run to the slow lane
 * and record a { type: 'load-downgrade' } event — "consecutive" spans
 * fires: each fire is a fresh oneshot process, so the previous sample is
 * read back from the persisted kg-drain job result. /proc/loadavg is the
 * only load criterion and its path is injectable, so the decision is
 * deterministic under test.
 *
 * Pure decision module: the stage runners, the heavy.lock holder, the
 * Salon9 probe and the backlog count are lazy-wired inside runKGDrain, so
 * requiring this module has no side effects and every dependency is
 * injectable for tests.
 *
 * Switch OFF (EAGLEYE_R3_DRAINER unset/falsy) must leave today's behavior
 * untouched: runKGDrain returns { skipped: 'disabled' } before probing
 * anything, and the nightly pipeline keeps its one-shot 200/500/1000 shape
 * (pinned by kg-worker-drain-args.test.js).
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_LOADAVG_PATH = '/proc/loadavg';

/**
 * R3.1 trigger thresholds (ruling A). The comparisons are strict exactly as
 * ruled: catch-up needs either backlog count above 500 AND load1 < 2.5, so a
 * backlog of 500 or a load1 of 2.5 stays steady; a sample with load1 ≥ 3.0 is HIGH
 * (3.0 itself is high, 2.99 is not) and the SECOND consecutive high sample
 * downgrades the run to slow.
 */
const DRAIN_TRIGGER = Object.freeze({
  backlogFeatures: 500,
  load1Catchup: 2.5,
  load1High: 3.0,
  highLoadSamples: 2,
});

/**
 * Consecutive high-load samples (load1 ≥ DRAIN_TRIGGER.load1High). One
 * sample = one runKGDrain cycle (one 2h fire). In production EVERY fire is
 * a fresh oneshot process (scripts/systemd/argus-eagleye-kg-drain.service
 * Type=oneshot → scripts/kg-drain.js → jobs.js runJob executes the job in
 * the caller's own process; there is no queued-job poller), so this counter
 * alone would never pass 1. Cross-fire continuity therefore comes from the
 * previous fire's persisted kg-drain job result: every sampled cycle —
 * including a lock-busy skip — writes load1 into background_jobs.result,
 * and a fire whose own sample is high reads the previous sample back
 * (readPreviousLoad1, read-only) to rebuild the streak. The in-process
 * counter still accumulates for repeated calls inside one process (tests,
 * an in-service re-fire). Any sample below the bound — or an unreadable
 * one — resets the streak: downgrading needs two confirmed readings.
 */
let highLoadStreak = 0;

/** Same truthy spellings as isJobIntakePaused (jobs.js), read at call time. */
function isDrainerEnabled() {
  const raw = String(process.env.EAGLEYE_R3_DRAINER ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

/**
 * CTO rule: Salon9 room occupied (asr-agent log count > 0) → drain in the
 * slow lane; a log that cannot be read (null) counts as occupied — safe
 * default. Only an exact count of 0 means the room is free.
 */
function salon9Occupied(count) {
  if (count === null || count === undefined) return true;
  return Number(count) > 0;
}

/**
 * load1 = first whitespace-separated field of a /proc/loadavg-shaped file
 * ("0.38 0.58 1.12 1/936 2952339"). Pure and synchronous; never throws:
 * unreadable or unparseable → null, and the caller then neither catches up
 * nor downgrades (same safe default as the unreadable Salon9 probe).
 */
function readLoad1(loadavgPath = DEFAULT_LOADAVG_PATH) {
  let text;
  try {
    text = fs.readFileSync(loadavgPath, 'utf8');
  } catch {
    return null;
  }
  const first = String(text).trim().split(/\s+/)[0];
  if (!/^\d+(?:\.\d+)?$/.test(first)) return null;
  const load1 = Number(first);
  return Number.isFinite(load1) ? load1 : null;
}

/**
 * Per-run caps from the stage-1 measurements. Catch-up is a backlog + load
 * criterion, not a clock (R3.1 ruling A): a run is 'catchup' when the room
 * is free, backlog_features > 500 and load1 < 2.5 (/proc/loadavg), so any of
 * the 24 two-hour fires in 48h may be a catch-up run. The 00:30–05:30 clock
 * trigger this replaces allowed only ~3 of them a night, which is why the
 * per-run arithmetic below never held under it (erratum, fixed R3.1).
 *  - catchup extract 1000: clearing the 12,712 features backlog + 2×4,400
 *    intake over 24 runs in 48h needs ≥897/run; 1000 leaves headroom (cold
 *    ~14 it/s ⇒ ~72s). The 48h SLO counts only when BOTH backlogs — features
 *    (extract) and embed — are drained to zero.
 *  - steady extract 500 keeps ahead of ~370 items/2h intake with headroom.
 *  - topics stays 1000: its write phase is a single BEGIN IMMEDIATE
 *    transaction that contends with the live service.
 *  - slow = today's pipeline caps while Salon9 is occupied, or after two
 *    consecutive samples with load1 ≥ 3.0 (load-downgrade event).
 *  - order: newest-first keeps 入库→出向量 p95 < 6h in steady/slow;
 *    oldest-first chews the old backlog in catch-up runs (旧积压补齐).
 */
const DRAIN_CAPS = {
  steady: Object.freeze({ extract: 500, embed: 1000, topics: 1000, order: 'newest-first' }),
  catchup: Object.freeze({ extract: 1000, embed: 1000, topics: 1000, order: 'oldest-first' }),
  slow: Object.freeze({ extract: 200, embed: 500, topics: 1000, order: 'newest-first' }),
};

function drainCaps(mode) {
  return DRAIN_CAPS[mode] || DRAIN_CAPS.steady;
}

// ── Real (lazy-wired) defaults ──────────────────────────────────────────

/**
 * Salon9 occupancy probe: count recent salon9-asr-agent-1 journal lines —
 * any log activity in the window means the room is in use. Unreadable
 * (journalctl missing/erroring/timing out) resolves null, which
 * salon9Occupied treats as occupied.
 */
function defaultSalon9Count() {
  const unit = process.env.EAGLEYE_SALON9_UNIT || 'salon9-asr-agent-1';
  const window = process.env.EAGLEYE_SALON9_WINDOW || '-30 min';
  return new Promise(resolve => {
    execFile('journalctl', ['--user', '-u', unit, '--since', window, '--no-pager', '-q'],
      { timeout: 5000 }, (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(String(stdout || '').split('\n').filter(Boolean).length);
      });
  });
}

/**
 * backlog_features: non-duplicate items from an active source that still miss
 * KG features, counted READ-ONLY on a
 * strictly readonly handle (the same discipline as scripts/kg-drain.js —
 * the drainer never writes the DB from here). Throws when the DB cannot be
 * opened; runKGDrain maps that to "unknown", which never triggers catch-up.
 *
 * R3.0 跨天重复治理: 口径 = 非 dup 行（BACKLOG_REAL caliber）— 排除
 * duplicate_of IS NOT NULL 的软标记重复行。与 fair_items 一样只统计
 * active 来源; inactive 行不会被 drain 选取。真实积压 > 500 依然触发。
 */
function defaultReadBacklogFeatures() {
  const Database = require('better-sqlite3'); // lazy: keeps this module side-effect free
  const { getDBPath } = require('../config');
  const db = new Database(getDBPath(), { readonly: true });
  try {
    return db.prepare(`
      SELECT COUNT(*) AS backlog
      FROM information_items i JOIN sources s ON s.id = i.source_id
      WHERE s.is_active = 1
        AND i.duplicate_of IS NULL
        AND NOT EXISTS (SELECT 1 FROM item_features f WHERE f.item_id = i.id)
    `).get().backlog;
  } finally {
    db.close();
  }
}

/**
 * backlog_topics: items that cannot be treated as KG-consumable yet because
 * they lack either the current semantic-lite vector or a dynamic-topic
 * assignment. This mirrors kg-worker's TOPICS_LITE_PENDING and fair_items:
 * non-duplicate rows from active sources only. The topics lane is the current
 * dominant backlog, so it must participate in catch-up separately from
 * features.
 */
function defaultReadBacklogTopics() {
  const Database = require('better-sqlite3');
  const { getDBPath } = require('../config');
  const db = new Database(getDBPath(), { readonly: true });
  try {
    return db.prepare(`
      SELECT COUNT(*) AS backlog
      FROM information_items i JOIN sources s ON s.id = i.source_id
      WHERE s.is_active = 1 AND i.duplicate_of IS NULL
        AND (NOT EXISTS (
               SELECT 1 FROM item_vectors v
               WHERE v.item_id = i.id AND v.vector_type = 'semantic-lite'
                 AND v.model_name = 'eagleye-hash-v1')
          OR NOT EXISTS (
               SELECT 1 FROM item_topic_assignments a
               WHERE a.item_id = i.id AND a.topic_kind = 'dynamic'))
    `).get().backlog;
  } finally {
    db.close();
  }
}

/**
 * load1 of the most recent kg-drain fire that actually sampled, read back
 * from the persisted job result — same source and order as
 * scripts/slo-baseline.py latest_drain_gear (completed kg-drain jobs,
 * newest first, first parseable row wins). Rows without a numeric load1
 * (e.g. { skipped: 'disabled' } from a manual fire while the switch was
 * off) are not samples and are skipped; nothing usable → null. READ-ONLY
 * handle; throws when the DB cannot be opened — runKGDrain maps that to
 * "no previous sample".
 */
function defaultReadPreviousLoad1() {
  const Database = require('better-sqlite3'); // lazy: keeps this module side-effect free
  const { getDBPath } = require('../config');
  const jobType = require('./jobs').JOB_TYPES?.KG_DRAIN ?? 'kg-drain';
  const db = new Database(getDBPath(), { readonly: true });
  try {
    const rows = db.prepare(`
      SELECT result FROM background_jobs
      WHERE job_type = ? AND status = 'completed' AND result IS NOT NULL
      ORDER BY created_at DESC, rowid DESC
      LIMIT 16
    `).all(jobType);
    for (const { result } of rows) {
      let parsed;
      try {
        parsed = JSON.parse(result);
      } catch {
        continue; // unparseable row → not a sample
      }
      const load1 = parsed?.load1;
      if (typeof load1 === 'number' && Number.isFinite(load1)) return load1;
    }
    return null;
  } finally {
    db.close();
  }
}

/**
 * heavy.lock coordination (checklist discipline: bulk work holds the lock
 * and yields on timeout). The lock is held by a `flock … sh -c 'echo
 * locked; timeout H cat'` child chain with stdin piped: release() ends
 * stdin, cat sees EOF and exits, the whole chain exits, the lock FD closes
 * and heavy.lock is free IMMEDIATELY. (Killing the flock parent alone would
 * NOT release the lock: the FD-inheriting sh/sleep child keeps holding it
 * until its sleep expires — review blocker, fixed 2026-10-21.) If this Node
 * process dies, the pipe closes and the same EOF path releases the lock
 * without any release() call; `timeout H` bounds the holder even if stdin
 * never closes. Returns null when the lock cannot be taken within the wait
 * budget (busy → the caller skips this drain cycle).
 */
function defaultAcquireLock() {
  const lockPath = process.env.EAGLEYE_HEAVY_LOCK || path.join(REPO_ROOT, 'heavy.lock');
  const waitSeconds = Number(process.env.EAGLEYE_DRAIN_LOCK_WAIT_SECONDS ?? 30);
  const holdSeconds = Number(process.env.EAGLEYE_DRAIN_LOCK_HOLD_SECONDS ?? 1800);
  const wait = Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds : 30;
  const hold = Number.isFinite(holdSeconds) && holdSeconds > 0 ? holdSeconds : 1800;
  return new Promise(resolve => {
    let proc;
    try {
      // "locked" on stdout is the only signal that the lock is actually
      // held (spawn fires before flock finishes waiting).
      proc = spawn('flock', ['-w', String(wait), lockPath, 'sh', '-c', `echo locked; timeout ${hold} cat`],
        { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const settle = value => { if (!settled) { settled = true; resolve(value); } };
    const release = () => {
      try { proc.stdin.end(); } catch { /* stdin already destroyed */ }
    };
    proc.stdin.on('error', () => {}); // EPIPE after the holder exited is fine
    proc.stdout.on('data', () => settle(release));
    proc.on('error', () => settle(null));
    proc.on('close', () => settle(null));
  });
}

/**
 * One drain cycle. Order of operations is the contract:
 *   1. switch off → { skipped: 'disabled' }, nothing else touched;
 *   2. probe Salon9 (unreadable/throwing reader → occupied → slow mode),
 *      count backlog_features read-only (unreadable → unknown) and sample
 *      load1 from loadavgPath (unreadable → null). Exactly one load sample
 *      per cycle, taken before the lock, so a lock-busy cycle still counts
 *      toward the high-load streak (its skip result keeps load1, see 3).
 *      Every fire is a fresh oneshot process, so when this process's sample
 *      is its first high one the streak is rebuilt from the previous fire's
 *      persisted load1 (readPreviousLoad1, read-only; unreadable → no
 *      previous sample). Mode:
 *        occupied, or 2nd consecutive sample with load1 ≥ 3.0 → 'slow'
 *          (the downgrade adds { type: 'load-downgrade', load1 } to events)
 *        backlog_features > 500 && load1 < 2.5                → 'catchup'
 *        otherwise                                             → 'steady'
 *      idleWindow (still sent by scripts/kg-drain.js) is accepted and
 *      ignored: R3.1 ruling A replaced the clock trigger with this one;
 *   3. acquire heavy.lock FIRST; a null release yields the cycle
 *      ({ skipped: 'lock-busy', load1 } — the sample is kept so the next
 *      fire can still read it back) and no stage runs;
 *   4. extract → embed → topics, once each, with the mode's caps; topics
 *      carries the converging --pending predicate (the 60k dynamic-topic
 *      backlog cannot drain without it) and every stage carries --order;
 *   5. release() exactly once on the finally path; a stage error still
 *      propagates and the remaining stages are not started.
 * A non-skipped run resolves { mode, caps, load1, backlogFeatures, events,
 * extract, embed, topics } — load1/backlogFeatures are the sampled inputs
 * (null = unreadable) so the stored job result explains its own mode and
 * the next fire can rebuild the load streak from it.
 */
async function runKGDrain(options = {}) {
  if (!isDrainerEnabled()) return { skipped: 'disabled' };

  const kg = require('./kg-worker'); // lazy: keeps this module side-effect free
  const {
    readSalon9Count = defaultSalon9Count,
    readBacklogFeatures = defaultReadBacklogFeatures,
    readBacklogTopics = defaultReadBacklogTopics,
    readPreviousLoad1 = defaultReadPreviousLoad1,
    loadavgPath = DEFAULT_LOADAVG_PATH,
    acquireLock = defaultAcquireLock,
    runExtract = (sources, limit, opts) => kg.runKGExtract(sources, limit, opts),
    runEmbed = (sources, limit, opts) => kg.runKGEmbed(sources, limit, 64, opts),
    runTopics = (sources, limit, minItems, opts) => kg.runKGTopics(sources, limit, minItems, opts),
  } = options;

  let occupied;
  try {
    occupied = salon9Occupied(await readSalon9Count());
  } catch {
    occupied = true; // unreadable probe → treat as occupied
  }

  let backlogFeatures = null;
  try {
    const count = await readBacklogFeatures();
    if (typeof count === 'number' && Number.isFinite(count)) backlogFeatures = count;
  } catch {
    /* unreadable backlog → unknown → never catch-up */
  }

  let backlogTopics = null;
  try {
    const count = await readBacklogTopics();
    if (typeof count === 'number' && Number.isFinite(count)) backlogTopics = count;
  } catch {
    /* unreadable topic backlog → unknown; feature backlog can still trigger */
  }

  const load1 = readLoad1(loadavgPath);
  if (load1 !== null && load1 >= DRAIN_TRIGGER.load1High) {
    highLoadStreak += 1;
    if (highLoadStreak === 1) {
      // First high sample seen by THIS process: every fire is a fresh
      // process, so the streak must be rebuilt from the previous fire's
      // persisted sample (only consulted when it can matter).
      let previousLoad1 = null;
      try {
        previousLoad1 = await readPreviousLoad1();
      } catch {
        /* unreadable history → no previous sample */
      }
      if (Number.isFinite(previousLoad1) && previousLoad1 >= DRAIN_TRIGGER.load1High) highLoadStreak += 1;
    }
  } else {
    highLoadStreak = 0;
  }
  const loadDowngrade = highLoadStreak >= DRAIN_TRIGGER.highLoadSamples;
  const events = [];
  if (loadDowngrade) events.push({ type: 'load-downgrade', load1, streak: highLoadStreak });

  let mode = 'steady';
  if (occupied || loadDowngrade) {
    mode = 'slow';
  } else if (((backlogFeatures !== null && backlogFeatures > DRAIN_TRIGGER.backlogFeatures)
      || (backlogTopics !== null && backlogTopics > DRAIN_TRIGGER.backlogFeatures))
      && load1 !== null && load1 < DRAIN_TRIGGER.load1Catchup) {
    mode = 'catchup';
  }
  const caps = drainCaps(mode);

  const release = await acquireLock();
  if (!release) return { skipped: 'lock-busy', load1 };

  try {
    const extract = await runExtract(null, caps.extract, { order: caps.order });
    const embed = await runEmbed(null, caps.embed, { order: caps.order });
    const topics = await runTopics(null, caps.topics, 5, { order: caps.order, pending: true });
    return { mode, caps, load1, backlogFeatures, backlogTopics, events, extract, embed, topics };
  } finally {
    release();
  }
}

module.exports = { isDrainerEnabled, salon9Occupied, drainCaps, readLoad1, runKGDrain, DRAIN_TRIGGER };
