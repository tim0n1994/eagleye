'use strict';

// Eagleye — Source health evaluation (R0-09)
//
// Pure, timer-free helpers that grade source freshness from the health fields
// introduced by migration 037. is_active records user intent (the source is
// enabled); health_status records observed behavior. This module never
// schedules anything itself — the fetch scheduler is expected to call
// recomputeSourceHealth() after fetch passes; routes and the status page only
// read the stored fields.

const STALE_AFTER_HOURS = 48;    // success/content newer than this is fresh (floor)
const FAILING_AFTER_HOURS = 336; // 14 days without success/content -> failing
const FALLBACK_INTERVAL_HOURS = 48;

const HEALTH_STATUSES = ['healthy', 'stale', 'failing', 'unknown'];

function parseTime(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function latestOf(...values) {
  let best = null;
  for (const v of values) {
    const t = parseTime(v);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Estimate the expected interval between fetch passes from a 5-field cron.
// Deliberately conservative: anything it cannot confidently read falls back
// to 48h (e.g. weekly cron "30 8 * * 1" is under-read as 48h, which can only
// make health reporting more pessimistic, never silently healthier).
function expectedIntervalHoursFromCron(cron) {
  if (typeof cron !== 'string') return FALLBACK_INTERVAL_HOURS;
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return FALLBACK_INTERVAL_HOURS;
  const [, hour, dayOfMonth, month, dayOfWeek] = fields;
  const stepOf = (field) => {
    const m = /^\*\/(\d+)$/.exec(field);
    const n = m ? Number(m[1]) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const hourStep = stepOf(hour);
  if (hourStep) return Math.min(hourStep, 24);            // "0 */2 * * *" -> 2h
  if (hour === '*') return 1;                             // "15 * * * *" -> 1h
  const domStep = stepOf(dayOfMonth);
  if (domStep) return Math.min(domStep * 24, FAILING_AFTER_HOURS);
  const monthStep = stepOf(month);
  if (monthStep) return Math.min(monthStep * 24 * 30, FAILING_AFTER_HOURS);
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') return 24; // daily
  return FALLBACK_INTERVAL_HOURS;
}

// Grade one source from its recorded health fields.
//
// Semantics:
// - "success/content" = newer of last_success_at / last_new_content_at.
// - healthy   -> within healthyLimit = max(expectedInterval*1.5, 48h),
//                and no unresolved last_error_class
// - failing   -> beyond 14 days, OR attempted but never succeeded,
//                OR an error is recorded and the source is also overdue
// - stale     -> in between (overdue but < 14 days with no recorded error),
//                or fresh but the last round's error has not been cleared
// - unknown   -> nothing observed at all
function evaluateHealth(input = {}) {
  const {
    lastAttemptAt = null,
    lastSuccessAt = null,
    lastNewContentAt = null,
    lastErrorClass = null,
    expectedIntervalHours = FALLBACK_INTERVAL_HOURS,
    now = new Date(),
  } = input;

  const nowMs = now instanceof Date ? now.getTime() : (parseTime(now) ?? Date.now());
  const succeededAt = latestOf(lastSuccessAt, lastNewContentAt);

  if (succeededAt === null) {
    if (lastErrorClass) {
      return { status: 'failing', reason: 'never succeeded; last error ' + lastErrorClass };
    }
    if (lastAttemptAt) return { status: 'failing', reason: 'attempted but never succeeded' };
    return { status: 'unknown', reason: 'no attempt, success or content recorded yet' };
  }

  const interval = Number.isFinite(expectedIntervalHours) && expectedIntervalHours > 0
    ? Math.min(expectedIntervalHours, FAILING_AFTER_HOURS)
    : FALLBACK_INTERVAL_HOURS;
  const healthyLimit = Math.max(interval * 1.5, STALE_AFTER_HOURS);
  const ageHours = Math.max(0, (nowMs - succeededAt) / 3600000);

  if (ageHours <= healthyLimit) {
    // A recent success proves the transport can work, but a retained error
    // means the latest observed round did not end cleanly. Keep the severity
    // visible without escalating a fresh success to failing.
    if (lastErrorClass) {
      return { status: 'stale', reason: 'last success/content ' + round1(ageHours) +
        'h ago; unresolved last error ' + lastErrorClass };
    }
    return { status: 'healthy', reason: 'last success/content ' + round1(ageHours) + 'h ago' };
  }
  if (lastErrorClass) {
    return { status: 'failing', reason: round1(ageHours) + 'h since last success; last error ' + lastErrorClass };
  }
  if (ageHours <= FAILING_AFTER_HOURS) {
    return { status: 'stale', reason: 'last success/content ' + round1(ageHours) + 'h ago (overdue)' };
  }
  return { status: 'failing', reason: 'last success/content ' + round1(ageHours) + 'h ago' };
}

// Recompute health_status for every source from its stored fields. Called by
// the scheduler after fetch passes; cheap enough (one row per source) that
// callers needing fresher numbers may also run it right before reading.
function recomputeSourceHealth(db, { now = new Date() } = {}) {
  if (!db) return { total: 0, updated: 0, byStatus: {} };
  const rows = db.prepare(`
    SELECT id, refresh_cron, last_attempt_at, last_success_at,
           last_new_content_at, last_error_class
    FROM sources
  `).all();
  const update = db.prepare('UPDATE sources SET health_status = ? WHERE id = ?');
  const byStatus = {};
  db.transaction(() => {
    for (const row of rows) {
      const { status } = evaluateHealth({
        lastAttemptAt: row.last_attempt_at,
        lastSuccessAt: row.last_success_at,
        lastNewContentAt: row.last_new_content_at,
        lastErrorClass: row.last_error_class,
        expectedIntervalHours: expectedIntervalHoursFromCron(row.refresh_cron),
        now,
      });
      update.run(status, row.id);
      byStatus[status] = (byStatus[status] || 0) + 1;
    }
  })();
  return { total: rows.length, updated: rows.length, byStatus };
}

// Cross-tab of active x health for the degradation endpoint. Counts are read
// from the stored health_status column; unrecognized values count as 'unknown'.
function healthDistribution(db) {
  if (!db) return { total: 0, active: 0, by_status: {}, active_by_status: {} };
  const rows = db.prepare(`
    SELECT is_active, health_status, COUNT(*) AS count
    FROM sources
    GROUP BY is_active, health_status
  `).all();
  const byStatus = {};
  const activeByStatus = {};
  let total = 0;
  let active = 0;
  for (const r of rows) {
    const status = HEALTH_STATUSES.includes(r.health_status) ? r.health_status : 'unknown';
    byStatus[status] = (byStatus[status] || 0) + r.count;
    total += r.count;
    if (r.is_active) {
      activeByStatus[status] = (activeByStatus[status] || 0) + r.count;
      active += r.count;
    }
  }
  return { total, active, by_status: byStatus, active_by_status: activeByStatus };
}

// Read-only visibility hook for model-layer degradation. Aggregates the
// llm_request_events telemetry (migration 031, written by llm-pool.js); the
// LLM layer owns error_class semantics — this module only counts what is
// already recorded and never imports LLM internals.
function llmErrorClassSummary(db, { sinceHours = 24 } = {}) {
  if (!db) return { available: false, reason: 'database unavailable' };
  const hasTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'llm_request_events'"
  ).get();
  if (!hasTable) return { available: false, reason: 'llm_request_events table not present' };
  const hours = Number.isFinite(sinceHours) && sinceHours > 0 ? sinceHours : 24;
  const windowExpr = '-' + hours + ' hours';
  const total = db.prepare(`
    SELECT COUNT(*) AS count FROM llm_request_events
    WHERE created_at >= datetime('now', ?)
  `).get(windowExpr).count;
  const groups = db.prepare(`
    SELECT status, error_code, COUNT(*) AS count
    FROM llm_request_events
    WHERE created_at >= datetime('now', ?)
    GROUP BY status, error_code
    ORDER BY count DESC
  `).all(windowExpr);
  const failures = groups
    .filter((g) => g.error_code !== null && g.error_code !== undefined)
    .reduce((sum, g) => sum + g.count, 0);
  return {
    available: true,
    window_hours: hours,
    total,
    failures,
    by_status_error: groups.map((g) => ({ status: g.status, error_code: g.error_code, count: g.count })),
    note: 'read-only aggregation over llm_request_events; the LLM layer owns error_class semantics',
  };
}

module.exports = {
  HEALTH_STATUSES,
  STALE_AFTER_HOURS,
  FAILING_AFTER_HOURS,
  FALLBACK_INTERVAL_HOURS,
  expectedIntervalHoursFromCron,
  evaluateHealth,
  recomputeSourceHealth,
  healthDistribution,
  llmErrorClassSummary,
};
