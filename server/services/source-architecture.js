const fs = require('fs');
const path = require('path');
const { readXFollowingConfig, readBlocklist, dedupeHandles } = require('./x-following-config');
const referenceSlugs = ['hacker-news', 'github-trending', 'product-hunt', 'hugging-face', 'techmeme', 'solidot', 'app-store-rank'];
function groupFor(slug) {
  return slug === 'x-following' ? 'x' : /^(physical-ai-|education-)/.test(slug) ? 'specialist' : 'public';
}
function xNetworkSummary() {
  const config = readXFollowingConfig();
  const configured = new Set((config.users || []).map(s => s.toLowerCase()));
  const result = { mode: process.env.X_FOLLOWING_MODE || 'feed', configured: configured.size,
    blocked: readBlocklist().size, snapshot: null };
  // Local export is evidence of a past list, never a live following count.
  const file = process.env.X_FOLLOWING_SNAPSHOT_PATH || path.join(process.env.HOME || '', '.config/argus/x-following-set.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(data.screen_names)) {
      const exported = new Set(dedupeHandles(data.screen_names).map(s => s.toLowerCase()));
      result.snapshot = { count: exported.size, common: [...configured].filter(s => exported.has(s)).length,
        only_configured: [...configured].filter(s => !exported.has(s)).length,
        only_exported: [...exported].filter(s => !configured.has(s)).length };
    }
  } catch { /* Unknown export stays unknown. Never contact X from a page request. */ }
  return result;
}
module.exports = { groupFor, referenceSlugs, xNetworkSummary };
