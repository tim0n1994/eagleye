/**
 * Eagleye — X Following Service
 *
 * Wraps the X Following connector with cancellation support for jobs.
 */

const { XFollowingConnector } = require('../connectors/x-following');
const { recordFailedAttempt, recordFetchDuration } = require('../connectors/index');
const { isJobCancelled } = require('./jobs');
const { withSourceSlot, recordCollection } = require('./collection-control');
const { classifyFetchError } = require('../connectors/base');

const connector = new XFollowingConnector();

async function syncXFollowing(opts = {}) {
  const { jobId, signal } = opts;
  return withSourceSlot('x-following', signal, async () => {
    if (jobId && isJobCancelled(jobId)) {
      return { cancelled: true, posts: 0 };
    }
    const startedAt = Date.now();
    const stats = {};
    try {
      // Pass the job cancellation signal through so an aborted job also aborts
      // in-flight feed pages instead of only being checked once up front.
      const items = await connector.fetch(undefined, { signal, stats });
      if (stats.persisted) {
        const durationMs = Math.max(0, Date.now() - startedAt);
        recordFetchDuration('x-following', durationMs);
        let collectionError;
        if (stats.error) {
          const err = Object.assign(new Error(stats.error), { code: stats.error_code });
          if (err.code === 'RATE_LIMITED') err.status = 429;
          if (err.code === 'TIMEOUT') err.name = 'TimeoutError';
          recordFailedAttempt('x-following', err, durationMs);
          collectionError = classifyFetchError(err);
        }
        recordCollection('x-following', { ...stats, error: collectionError });
        return { ...stats, status: stats.error ? 'failed' : stats.failed ? 'partial' : 'completed',
          posts: items.length, saved: stats.inserted, duration_ms: durationMs };
      }
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
      if (stats.mode === 'roster') recordCollection('x-following', { ...stats, error: classifyFetchError(err) });
      throw err;
    }
  });
}

module.exports = { syncXFollowing };
