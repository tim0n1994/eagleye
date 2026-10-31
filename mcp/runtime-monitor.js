/**
 * Optional local monitor evidence. The operator chooses one file via environment;
 * MCP callers cannot choose a path. Only fixed issue codes and scalar metrics leave
 * this boundary: no source paths, exception messages, configuration or raw state.
 */
const fs = require('node:fs');

const MAX_BYTES = 65536;
const MAX_AGE_SECONDS = 90 * 60;
const COUNTERS = ['items_total', 'items_24h', 'valid_items_24h', 'summaries_total',
  'enrich_pending', 'enrich_exhausted_24h', 'outbox_pending', 'kg_pending',
  'active_jobs', 'jobs_stuck_6h', 'pipeline_failed_stages'];
const SIMPLE_ISSUES = new Set(['disk_free_below_10gib', 'pipeline_no_completion_36h',
  'pipeline_incomplete', 'pipeline_failed_without_successful_resume', 'no_new_items_48h',
  'outbox_undispatched_2h', 'jobs_stuck_6h', 'enrich_backlog_stalled_6h',
  'kg_backlog_stalled_6h', 'snapshot_not_masked', 'snapshot_timer_active',
  'snapshot_state_unknown', 'authenticated_health_failed', 'monitor_state_unreadable']);
const UNITS = {
  'argus-eagleye.service': 'app',
  'argus-eagleye-drain.timer': 'enrichment_timer',
  'argus-eagleye-outbox-drain.timer': 'outbox_timer',
  'argus-eagleye-kg-drain.timer': 'kg_timer',
};
const SOURCES = { reddit: 'reddit', 'x-following': 'x' };

function issueCode(value) {
  if (SIMPLE_ISSUES.has(value)) return value;
  const [kind, detail] = value.split(':');
  if (['inactive', 'unknown'].includes(kind) && Object.hasOwn(UNITS, detail)) {
    return UNITS[detail] + '_' + kind;
  }
  if (['source_missing', 'source_no_success_48h'].includes(kind)
      && Object.hasOwn(SOURCES, detail)) return SOURCES[detail] + '_' + kind;
  if (['monitor_check_failed', 'monitor_state_write_failed'].includes(kind)) return kind;
  return 'unrecognized_monitor_issue';
}

function timestamp(value) {
  if (typeof value !== 'string'
      || !/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)?$/.test(value)) return null;
  const zoned = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value.replace(' ', 'T') + 'Z';
  const milliseconds = Date.parse(zoned);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function readRuntimeMonitor({ file = process.env.EAGLEYE_MCP_MONITOR_PATH, now = Date.now() } = {}) {
  if (!file?.trim()) return { status: 'not_configured' };
  let fd;
  let state;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) return { status: 'unavailable', reason: 'invalid_file' };
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > MAX_BYTES) return { status: 'unavailable', reason: 'invalid_file' };
    state = JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
  } catch {
    return { status: 'unavailable', reason: 'unreadable_state' };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const checkedAt = timestamp(state?.checked_at);
  if (!checkedAt || !Array.isArray(state?.issues) || state.issues.length > 100
      || !state.issues.every(value => typeof value === 'string')
      || !state.metrics || typeof state.metrics !== 'object' || Array.isArray(state.metrics)) {
    return { status: 'unavailable', reason: 'invalid_state' };
  }
  const ageSeconds = Math.floor((now - Date.parse(checkedAt)) / 1000);
  if (ageSeconds < -300) return { status: 'unavailable', reason: 'future_timestamp' };
  const issues = [...new Set(state.issues.map(issueCode))].sort();
  const metrics = {};
  for (const key of COUNTERS) {
    const value = state.metrics[key];
    if (Number.isSafeInteger(value) && value >= 0) metrics[key] = value;
  }
  const free = state.metrics.free_gib;
  if (Number.isFinite(free) && free >= 0) metrics.free_gib = Math.round(free * 100) / 100;
  for (const key of ['pipeline_completed_at', 'pipeline_failed_at', 'latest_item', 'outbox_oldest']) {
    metrics[key] = timestamp(state.metrics[key]);
  }
  if (typeof state.metrics.pipeline_stages_complete === 'boolean') {
    metrics.pipeline_stages_complete = state.metrics.pipeline_stages_complete;
  }
  if (['free_gib', 'outbox_pending', 'kg_pending', 'enrich_pending'].some(key => metrics[key] === undefined)) {
    issues.push('monitor_metrics_incomplete');
  }
  const stale = ageSeconds > MAX_AGE_SECONDS;
  return {
    status: stale ? 'stale' : issues.length ? 'degraded' : 'ok',
    checked_at: checkedAt,
    age_seconds: Math.max(0, ageSeconds),
    max_age_seconds: MAX_AGE_SECONDS,
    issues,
    metrics,
  };
}

module.exports = { readRuntimeMonitor };
