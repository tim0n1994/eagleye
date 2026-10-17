/**
 * Eagleye — Connector Registry
 *
 * Maps source slugs to their connector implementations.
 * Allows adding new connectors by registering them here.
 */

const { compactDigestDate } = require('../services/date-contract');
const { HNConnector } = require('./hn');
const { parseItemLimit } = require('./base');
const { GitHubConnector } = require('./github');
const { RSSConnector } = require('./rss');
const { HuggingFaceConnector } = require('./huggingface');
const { ArxivConnector } = require('./arxiv');
const { V2EXConnector } = require('./v2ex');
const { LobstersConnector } = require('./lobsters');
const { ProductHuntConnector } = require('./producthunt');
const { StartupArchiveConnector } = require('./startup-archive');
const { AppStoreRankConnector, AppStoreTrendConnector } = require('./appstore');
const { SEC8KConnector } = require('./sec-8k');
const { HumanoidConnector } = require('./humanoid');
const { CNPhotonicsConnector } = require('./cn-photonics');
const { XFollowingConnector } = require('./x-following');
const { RedditConnector } = require('./reddit');
const { XiaoHongShuConnector } = require('./xiaohongshu');

const connectorRegistry = {
  'hacker-news': new HNConnector(),
  'github-trending': new GitHubConnector(),
  'product-hunt': new ProductHuntConnector(),
  'techmeme': new RSSConnector('techmeme'),
  'solidot': new RSSConnector('solidot'),
  'hugging-face': new HuggingFaceConnector(),
  'arxiv-ai': new ArxivConnector('arxiv-ai'),
  'startup-archive': new StartupArchiveConnector(),
  'app-store-rank': new AppStoreRankConnector(),
  'app-store-trend': new AppStoreTrendConnector(),
  'physical-ai-arxiv': new ArxivConnector('physical-ai-arxiv'),
  'physical-ai-sec-8k': new SEC8KConnector(),
  'physical-ai-humanoid': new HumanoidConnector(),
  'physical-ai-cn-photonics': new CNPhotonicsConnector(),
  'v2ex': new V2EXConnector(),
  'lobsters': new LobstersConnector(),
  'x-following': new XFollowingConnector(),
  'reddit': new RedditConnector(),
  'xiaohongshu': new XiaoHongShuConnector(),
};

/**
 * Fetch items from a specific source for a given date.
 */
async function fetchSource(slug, date, opts = {}) {
  opts.signal?.throwIfAborted();
  const limit = parseItemLimit(opts.limit);
  const returnDetails = opts.returnDetails === true || limit !== undefined;
  const connector = connectorRegistry[slug];
  if (!connector) {
    if (returnDetails) throw new Error(`No connector registered for source: ${slug}`);
    console.warn(`No connector registered for source: ${slug}`);
    return [];
  }

  const stats = { requested: 0, failed: 0, skipped: 0 };
  // Connectors filter on compact yyyymmdd day strings (see base.js fetch
  // contract); callers pass the canonical digest date, so normalize here
  // once instead of per-connector.
  const timeoutKey = `SOURCE_TIMEOUT_${slug.toUpperCase().replace(/-/g, '_')}_MS`;
  const configuredMs = Number(process.env[timeoutKey] || process.env.SOURCE_TIMEOUT_MS || 180000);
  const ms = Number.isFinite(configuredMs) && configuredMs > 0 ? configuredMs : 180000;
  const controller = new AbortController();
  const { signal } = controller;
  const abort = () => controller.abort(opts.signal.reason);
  opts.signal?.addEventListener('abort', abort, { once: true });
  const deadline = Date.now() + ms;
  const timeoutError = new Error(`source ${slug} exceeded ${ms}ms budget`);
  timeoutError.name = 'TimeoutError';
  const timer = setTimeout(() => controller.abort(timeoutError), ms);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const items = await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return connector.fetch(compactDigestDate(date) || date, { limit, stats, signal });
      }),
      aborted,
    ]);
    // Check wall time too: a synchronous connector can delay the deadline timer.
    if (Date.now() >= deadline) controller.abort(timeoutError);
    signal.throwIfAborted();
    if (!Array.isArray(items)) throw new Error(`Invalid item response from source: ${slug}`);
    const selected = limit === undefined ? items : items.slice(0, limit);
    if (opts.isCancelled?.()) {
      return returnDetails ? { source: slug, date, limit: limit ?? null, cancelled: true,
        items: [], inserted: 0, existing: 0, failed: stats.failed,
        requested: stats.requested || items.length, fetched: items.length,
        skipped: stats.skipped + items.length } : [];
    }
    if (!returnDetails) return connector.saveItems(selected);
    const saved = connector.saveItems(selected, { returnDetails: true });
    return {
      ...saved,
      source: slug,
      date,
      limit: limit ?? null,
      requested: stats.requested || items.length,
      fetched: items.length,
      skipped: saved.skipped + stats.skipped + (items.length - selected.length),
      failed: saved.failed + stats.failed,
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    opts.signal?.removeEventListener('abort', abort);
  }
}

/**
 * Fetch all active sources for a given date.
 */
async function fetchAllSources(date, opts = {}) {
  opts.signal?.throwIfAborted();
  const { onProgress } = opts;
  const { getDB } = require('../db/connection');
  const db = getDB();
  if (!db) return [];

  const sources = db.prepare(`
    SELECT slug FROM sources WHERE is_active = 1
    ORDER BY CASE slug
      WHEN 'x-following' THEN 0
      WHEN 'hacker-news' THEN 1
      WHEN 'github-trending' THEN 2
      WHEN 'hugging-face' THEN 3
      WHEN 'product-hunt' THEN 4
      WHEN 'reddit' THEN 90
      WHEN 'xiaohongshu' THEN 91
      ELSE 99
    END, slug
  `).all();
  const results = [];
  let completed = 0;
  let heartbeat = 0;
  let lastSource = '';
  const emitProgress = (extra = {}) => {
    if (!onProgress) return;
    onProgress({
      phase: 'fetching',
      current_source: lastSource,
      current_index: completed,
      total_sources: sources.length,
      completed_sources: completed,
      heartbeat,
      results,
      ...extra,
    });
  };

  emitProgress({ message: 'fetch started' });
  const heartbeatTimer = onProgress ? setInterval(() => {
    heartbeat++;
    emitProgress({ message: 'fetch heartbeat' });
  }, 5000) : null;

  const settled = await Promise.allSettled(sources.map(async (source) => {
    try {
      const items = await fetchSource(source.slug, date, { signal: opts.signal, isCancelled: opts.isCancelled });
      const result = { source: source.slug, items: items.length };
      results.push(result);
      completed++;
      lastSource = source.slug;
      emitProgress({ current_source: source.slug });
      return result;
    } catch (err) {
      console.error(`Error fetching ${source.slug}:`, err.message);
      const result = { source: source.slug, error: err.message };
      results.push(result);
      completed++;
      lastSource = source.slug;
      emitProgress({ current_source: source.slug });
      return result;
    }
  }));
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  opts.signal?.throwIfAborted();

  const finalResults = results.length ? results : [];
  for (let i = 0; i < settled.length && finalResults.length < settled.length; i++) {
    const entry = settled[i];
    const result = entry.status === 'fulfilled' ? entry.value : { source: sources[i].slug, error: entry.reason?.message || 'unknown' };
    finalResults.push(result);
  }
  emitProgress({ current_index: finalResults.length, completed_sources: finalResults.length, results: finalResults, message: 'fetch complete' });

  // Summary: distinguish fetch errors from genuine-empty so the pipeline log
  // surfaces degraded sources (was: all empty results looked identical to
  // errors, making diagnosis impossible).
  const errors = finalResults.filter(r => r.error);
  const empty = finalResults.filter(r => !r.error && (r.items || 0) === 0);
  const withData = finalResults.filter(r => (r.items || 0) > 0);
  if (errors.length > 0) {
    console.log(`  ⚠  Fetch summary: ${withData.length} sources with data, ${empty.length} empty, ${errors.length} ERRORED:`);
    for (const e of errors) console.log(`    ✗ ${e.source}: ${e.error}`);
  } else {
    console.log(`  ✅ Fetch summary: ${withData.length} sources with data, ${empty.length} empty (no errors)`);
  }

  return finalResults;
}

module.exports = { fetchSource, fetchAllSources };
