/**
 * Eagleye — X Following Service
 *
 * Wraps the X Following connector with cancellation support for jobs.
 */

const { XFollowingConnector } = require('../connectors/x-following');
const { isJobCancelled } = require('./jobs');

const connector = new XFollowingConnector();

async function syncXFollowing(opts = {}) {
  const { jobId } = opts;
  if (jobId && isJobCancelled(jobId)) {
    return { cancelled: true, posts: 0 };
  }
  const items = await connector.fetch();
  const saved = connector.saveItems(items);
  return { posts: items.length, saved: saved.length };
}

module.exports = { syncXFollowing };
