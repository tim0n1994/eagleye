/**
 * Eagleye — X Following Service
 *
 * Wraps the X Following connector with cancellation support for jobs.
 */

const { XFollowingConnector } = require('../connectors/x-following');
const { recordFailedAttempt, recordFetchDuration } = require('../connectors/index');
const { isJobCancelled } = require('./jobs');

const connector = new XFollowingConnector();

async function syncXFollowing(opts = {}) {
  const { jobId } = opts;
  if (jobId && isJobCancelled(jobId)) {
    return { cancelled: true, posts: 0 };
  }
  const startedAt = Date.now();
  try {
    const items = await connector.fetch();
    const saved = connector.saveItems(items);
    recordFetchDuration('x-following', Math.max(0, Date.now() - startedAt));
    return { posts: items.length, saved: saved.length };
  } catch (err) {
    const durationMs = Math.max(0, Date.now() - startedAt);
    if (err && typeof err === 'object') err.duration_ms ??= durationMs;
    // The dedicated feed job does not pass through fetchSource(), so mirror
    // its pre-save failure bookkeeping here. Otherwise a failed X tick is
    // visible in background_jobs but the source health row remains stale.
    recordFailedAttempt('x-following', err, durationMs);
    throw err;
  }
}

module.exports = { syncXFollowing };
