/**
 * Eagleye — Connector Registry
 *
 * Maps source slugs to their connector implementations.
 * Allows adding new connectors by registering them here.
 */

const { HNConnector } = require('./hn');
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
async function fetchSource(slug, date) {
  const connector = connectorRegistry[slug];
  if (!connector) {
    console.warn(`No connector registered for source: ${slug}`);
    return [];
  }

  const items = await connector.fetch(date);
  const saved = connector.saveItems(items);
  return saved;
}

/**
 * Race a promise against a deadline so one slow/dead source can't stall the
 * whole pipeline. Default budget is 3 min; override with SOURCE_TIMEOUT_MS.
 */
function withSourceTimeout(promise, slug) {
  const ms = parseInt(process.env.SOURCE_TIMEOUT_MS || '180000', 10);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`source ${slug} exceeded ${ms}ms budget`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Fetch all active sources for a given date.
 */
async function fetchAllSources(date, opts = {}) {
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
      const items = await withSourceTimeout(fetchSource(source.slug, date), source.slug);
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
