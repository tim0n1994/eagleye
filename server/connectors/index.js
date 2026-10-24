/**
 * Eagleye — Connector Registry
 *
 * Maps source slugs to their connector implementations.
 * Allows adding new connectors by registering them here.
 */

const { compactDigestDate } = require('../services/date-contract');
const sharedUtils = require('../services/utils');
// Round 2 · CTO 03:40: propagate the per-source { stats, signal } to every
// fetchURL a connector makes (none of the call sites forward stats), so the
// network-retry counter can surface in the envelope. Tolerates utils stubs
// that only provide fetchURL (several test harnesses) by running fn directly.
const runWithFetchContext = typeof sharedUtils.runWithFetchContext === 'function'
  ? sharedUtils.runWithFetchContext
  : (_store, fn) => fn();
const { HNConnector } = require('./hn');
const { parseItemLimit, classifyFetchError } = require('./base');
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

// Round 2 ⑤: a fetch invocation whose synchronous span reaches this bound
// counts as a synchronously-crawling connector (its whole round ran inside
// the call). Real network connectors reach their first await — and with it
// the honest settle-span measurement — far below this bound.
const SYNC_CRAWL_SPAN_MS = 100;

/**
 * Round 2 ⑤: stamp sources.last_fetch_duration_ms (043 column) with the
 * latest fetch round's wall time in milliseconds. Called for every COMPLETED
 * round — successful, empty, and cancelled alike ("耗时含成功与失败轮";
 * failed rounds go through recordFailedAttempt below, same column). The
 * value overwrites on every round: it is the LATEST round's duration, never
 * an accumulation. Column probing plus a blanket try/catch keep this a
 * no-op on databases that predate 043, mirroring the D4 invariant that
 * bookkeeping must never break ingestion (base.js saveItems contract).
 */
function recordFetchDuration(slug, durationMs) {
  const ms = Math.max(0, Math.round(Number(durationMs)));
  if (!Number.isFinite(ms)) return;
  try {
    const { getDB } = require('../db/connection');
    const db = getDB();
    if (!db) return;
    const row = db.prepare('SELECT id FROM sources WHERE slug = ?').get(slug);
    if (!row) return;
    const columns = new Set(db.pragma('table_info(sources)').map(c => c.name));
    if (!columns.has('last_fetch_duration_ms')) return;
    db.prepare('UPDATE sources SET last_fetch_duration_ms = ? WHERE id = ?').run(ms, row.id);
  } catch { /* best-effort bookkeeping */ }
}

/**
 * Round 1 D4 (main-script arbitration takeover): a fetch that fails before
 * saveItems runs is still an attempt — saveItems bookkeeping never sees it.
 * Round 1.1 定案4: an error round is NOT an empty round. Record
 * sources.last_error_class (037 column, bucketed from err.name/err.code via
 * classifyFetchError) and set health_status='failing'; leave
 * consecutive_empty untouched — the pre-R1.1 +1 here conflated ruling 4 with
 * ruling 3 (a genuine zero-item round). Then let the caller's error
 * propagate unchanged. Column probing plus a blanket try/catch keep this a
 * no-op on partial-schema databases and ensure bookkeeping can never mask
 * or replace the original fetch error.
 * Round 2 ⑤ (merge rehearsal r2-merge-trial): a failed round still burned
 * crawl time — the measured duration (when known) is stamped on the same
 * path so the sources column reflects failure rounds too. Semantic merge of
 * R1.1 (slug, err) × R2 (slug, durationMs) → (slug, err, durationMs).
 */
function recordFailedAttempt(slug, err, durationMs) {
  try {
    const { getDB } = require('../db/connection');
    const db = getDB();
    if (!db) return;
    const row = db.prepare('SELECT id FROM sources WHERE slug = ?').get(slug);
    if (!row) return;
    const columns = new Set(db.pragma('table_info(sources)').map(c => c.name));
    if (columns.has('last_attempt_at')) {
      db.prepare("UPDATE sources SET last_attempt_at = datetime('now') WHERE id = ?").run(row.id);
    }
    if (columns.has('last_error_class')) {
      db.prepare('UPDATE sources SET last_error_class = ? WHERE id = ?').run(classifyFetchError(err), row.id);
    }
    if (columns.has('health_status')) {
      db.prepare("UPDATE sources SET health_status = 'failing' WHERE id = ?").run(row.id);
    }
    if (columns.has('last_fetch_duration_ms') && Number.isFinite(Number(durationMs))) {
      db.prepare('UPDATE sources SET last_fetch_duration_ms = ? WHERE id = ?')
        .run(Math.max(0, Math.round(Number(durationMs))), row.id);
    }
  } catch { /* best-effort bookkeeping */ }
}

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

  // Round 2 · CTO 03:40: `retries` is the network-retry counter accumulated by
  // utils.fetchURL (explicitly via opts.stats or via the ambient fetch
  // context); initialised here so the envelope field is always a number.
  // R2 观测性 B: `notModified` rides the same convention — incremented by
  // rss.js when a feed answers 304, always a number in the envelope.
  const stats = { requested: 0, failed: 0, skipped: 0, retries: 0, notModified: 0 };
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
  // Round 2 ⑤: per-source fetch duration. The clock starts immediately
  // before the fetch is invoked; two spans are captured:
  //  - sync span — across the invocation itself. A connector whose whole
  //    body runs before its first await (synchronous crawl logic; every
  //    deterministic test double) completes inside this span, which is also
  //    immune to sibling rounds advancing the clock concurrently
  //    (fetchAllSources runs rounds in parallel).
  //  - settle span — stamped the moment the fetch promise settles
  //    (fulfilled OR rejected): the honest duration for real network
  //    crawlers, whose bodies reach an await within microseconds.
  // A sync span >= SYNC_CRAWL_SPAN_MS means real synchronous crawl work ran
  // inside the call; below that it is setup noise before the first await and
  // using it would underreport async crawls. Success, empty, and failed
  // rounds all carry the measurement. Date.now() is deliberate: injectable
  // in tests, consistent with the deadline check below.
  const startedAt = Date.now();
  let fetchSettledAt = null;
  const stampSettle = () => { fetchSettledAt = Date.now(); };
  let fetchPromise;
  try {
    signal.throwIfAborted();
    // Invoked synchronously (was: deferred through Promise.resolve().then) so
    // the sync span brackets the call exactly; an async connector still
    // yields at its first await, keeping the abort race below effective, and
    // a sync-throwing connector still rejects the race (async fn semantics /
    // explicit Promise.reject). runWithFetchContext is synchronous too (ALS
    // run) — it returns fetch()'s promise untouched.
    // 案1 (2026-10-22 morning): the per-source budget epoch (`deadline`,
    // computed above) rides the same ambient store so withFetchRetry inside
    // every connector's fetchURL/native-fetch transport refuses to start a
    // retry the remaining budget can no longer cover (backoff + one request)
    // — the source then ends on its last network error instead of the
    // "exceeded <budget>ms budget" abort that the old 30s/120s backoffs
    // caused. Zero connector changes required.
    fetchPromise = runWithFetchContext({ stats, signal, deadline }, () =>
      connector.fetch(compactDigestDate(date) || date, { limit, stats, signal }));
  } catch (err) {
    fetchPromise = Promise.reject(err);
  }
  const syncSpanMs = Math.max(0, Math.round(Date.now() - startedAt));
  Promise.resolve(fetchPromise).then(stampSettle, stampSettle);
  const settleSpanMs = () => Math.max(0, Math.round((fetchSettledAt ?? Date.now()) - startedAt));
  const elapsedMs = () => (syncSpanMs >= SYNC_CRAWL_SPAN_MS ? syncSpanMs : settleSpanMs());
  const retryCount = () => (Number.isFinite(stats.retries) ? stats.retries : 0);
  // R2 观测性 B: 304 counter — same always-a-number contract as retries.
  const notModifiedCount = () => (Number.isFinite(stats.notModified) ? stats.notModified : 0);
  try {
    try {
      const items = await Promise.race([fetchPromise, aborted]);
      // Check wall time too: a synchronous connector can delay the deadline timer.
      if (Date.now() >= deadline) controller.abort(timeoutError);
      signal.throwIfAborted();
      if (!Array.isArray(items)) throw new Error(`Invalid item response from source: ${slug}`);
      const selected = limit === undefined ? items : items.slice(0, limit);
      if (opts.isCancelled?.()) {
        const durationMs = elapsedMs();
        recordFetchDuration(slug, durationMs);
        return returnDetails ? { source: slug, date, limit: limit ?? null, cancelled: true,
          items: [], inserted: 0, existing: 0, failed: stats.failed,
          requested: stats.requested || items.length, fetched: items.length,
          skipped: stats.skipped + items.length, duration_ms: durationMs, retries: retryCount(),
          notModified: notModifiedCount() } : [];
      }
      if (!returnDetails) {
        const outcome = connector.saveItems(selected);
        recordFetchDuration(slug, elapsedMs());
        return outcome;
      }
      // saveItems normally returns a details envelope; legacy/stub connectors
      // may ignore returnDetails and return a bare saved array — normalize
      // both so every returnDetails caller gets an envelope with an items
      // array (spreading a bare array would drop the items key entirely).
      const saved = connector.saveItems(selected, { returnDetails: true });
      const durationMs = elapsedMs();
      recordFetchDuration(slug, durationMs);
      const savedIsArray = Array.isArray(saved);
      const savedItems = savedIsArray ? saved : (saved.items || []);
      const savedCounts = savedIsArray
        ? { inserted: savedItems.length, existing: 0, duplicates: 0, skipped: 0, failed: 0 }
        : saved;
      return {
        ...savedCounts,
        items: savedItems,
        source: slug,
        date,
        limit: limit ?? null,
        requested: stats.requested || items.length,
        fetched: items.length,
        skipped: (savedCounts.skipped || 0) + stats.skipped + (items.length - selected.length),
        failed: (savedCounts.failed || 0) + stats.failed,
        duration_ms: durationMs,
        retries: retryCount(),
        notModified: notModifiedCount(),
      };
    } catch (err) {
      // Round 1 D4: the round died before saveItems could record it —
      // stamp the attempt (R1.1 定案4: + last_error_class + failing,
      // streak untouched), then rethrow the original error untouched.
      // Round 2 ⑤: the burned time is still a measurable round — stamp the
      // duration column on this same path and attach it to the error so the
      // fetch summary's error rows can surface it.
      // Round 2 · CTO 03:40: the network-retry count rides along the same way
      // (err.retries beside err.duration_ms) so error rows show how hard the
      // round tried before giving up.
      const durationMs = elapsedMs();
      if (typeof err === 'object' && err !== null) {
        // A parent cancellation is deliberate caller state; keep it distinct
        // from a source's timeout budget so bookkeeping can classify it as
        // cancelled instead of timeout.
        if (opts.signal?.aborted && err.name !== 'TimeoutError') err.name = 'CancelledError';
        if (err.duration_ms === undefined) err.duration_ms = durationMs;
        if (err.retries === undefined) err.retries = retryCount();
      }
      recordFailedAttempt(slug, err, durationMs);
      throw err;
    }
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
  // A resumed fetch carries the previous job's per-source rows. Rows that
  // reached a successful terminal state (including a genuine empty round or
  // the feed-mode ownership skip) are already a durable checkpoint: do not
  // touch their upstream again. Error rows are retried, and a source that has
  // no row at all is fetched normally.
  const checkpoint = Array.isArray(opts.checkpoint) ? opts.checkpoint : [];
  const activeSources = new Set(sources.map(source => source.slug));
  const reused = new Map();
  for (const row of checkpoint) {
    if (!row?.source || !activeSources.has(row.source) || reused.has(row.source)) continue;
    if (row.error || row.status === 'failed') continue;
    reused.set(row.source, { ...row, checkpoint_reused: true });
  }
  const results = [...reused.values()];
  const pendingSources = sources.filter(source => !reused.has(source.slug));
  let completed = results.length;
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

  emitProgress({ message: 'fetch started', checkpoint_reused: reused.size });
  const heartbeatTimer = onProgress ? setInterval(() => {
    heartbeat++;
    emitProgress({ message: 'fetch heartbeat' });
  }, 5000) : null;

  const settled = await Promise.allSettled(pendingSources.map(async (source) => {
    // Round 2 ①: in feed mode the x-following source is owned by its own 2h
    // incremental schedule (deploy/thinkpad/argus-eagleye-x-following.timer →
    // POST /api/x-following/sync), so the 01:00 pipeline stage must make ZERO
    // twitter-cli calls for it. The skip comes from the mode switch, not from
    // deactivating the source — X_FOLLOWING_MODE=per-user restores the legacy
    // in-pipeline behavior immediately. Resolved via the static mode helper
    // (not an instance protocol) so registry stubs/proxies in other tests
    // (source-cancellation, fetch-duration harnesses) stay unaffected.
    if (source.slug === 'x-following'
      && typeof XFollowingConnector.resolveMode === 'function'
      && XFollowingConnector.resolveMode() === 'feed') {
      console.log(`  ⏭ ${source.slug}: excluded from pipeline fetch (handled by its own incremental schedule)`);
      const result = { source: source.slug, items: 0, skipped_by: 'incremental-mode' };
      results.push(result);
      completed++;
      lastSource = source.slug;
      emitProgress({ current_source: source.slug });
      return result;
    }
    try {
      // Round 1 D3: request the details envelope so the summary can surface
      // cross-day duplicate counts alongside item counts. The result may be a
      // details envelope OR — for legacy/stub connectors that ignore
      // returnDetails — a bare saved array; handle both shapes.
      const r = await fetchSource(source.slug, date, { signal: opts.signal, isCancelled: opts.isCancelled, returnDetails: true });
      // Round 2 ⑤: every summary row — success AND error — carries the
      // round's duration_ms so slow/failed sources are visible in the log.
      // Bare-array outcomes (legacy connectors) have no envelope: null.
      // CTO 03:40: `retries` rides beside duration_ms on both row kinds.
      // R2 观测性 B: `notModified` rides the same seat — a 304 round now
      // leaves an explicit fingerprint (envelope value, null for bare arrays).
      const result = Array.isArray(r)
        ? { source: source.slug, items: r.length, duration_ms: null, retries: null, notModified: null }
        : { source: source.slug, items: (r.items || []).length, duplicates: r.duplicates || 0,
          duration_ms: r.duration_ms ?? null, retries: r.retries ?? null, notModified: r.notModified ?? 0 };
      results.push(result);
      completed++;
      lastSource = source.slug;
      emitProgress({ current_source: source.slug });
      return result;
    } catch (err) {
      console.error(`Error fetching ${source.slug}:`, err.message);
      // Round 2 ⑤: fetchSource attaches the burned wall time to the error —
      // surface it on the error row too (failed rounds count as rounds).
      // CTO 03:40: same for the retry count.
      const result = { source: source.slug, error: err.message,
        duration_ms: err?.duration_ms ?? null, retries: err?.retries ?? null };
      results.push(result);
      completed++;
      lastSource = source.slug;
      emitProgress({ current_source: source.slug });
      return result;
    }
  }));
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  opts.signal?.throwIfAborted();

  const finalResults = [...results];
  const present = new Set(finalResults.map(row => row.source));
  for (let i = 0; i < settled.length; i++) {
    const entry = settled[i];
    const slug = pendingSources[i].slug;
    if (entry.status === 'fulfilled' || present.has(slug)) continue;
    finalResults.push({ source: slug, error: entry.reason?.message || 'unknown' });
  }
  emitProgress({ current_index: finalResults.length, completed_sources: finalResults.length, results: finalResults, message: 'fetch complete' });
  // The round is now terminal: reconcile stored health once after every
  // source outcome (including reused checkpoints, errors, and empty rounds).
  // Best-effort keeps partial-schema test fixtures and legacy databases on
  // the same ingestion path as migrated production databases.
  try {
    // Resolved lazily: older test harnesses compile this file in controlled
    // module sandboxes and deliberately reject unrelated service imports.
    // A failed resolution must only skip reconciliation, never fail fetching.
    const { recomputeSourceHealth } = require('../services/source-health');
    recomputeSourceHealth(db);
  } catch { /* health columns are unavailable in partial schemas */ }

  // Summary: distinguish fetch errors from genuine-empty so the pipeline log
  // surfaces degraded sources (was: all empty results looked identical to
  // errors, making diagnosis impossible).
  const errors = finalResults.filter(r => r.error);
  const empty = finalResults.filter(r => !r.error && (r.items || 0) === 0);
  const withData = finalResults.filter(r => (r.items || 0) > 0);
  // Round 1 D3: duplicates are fetched-but-not-new items (skipped cross-day
  // re-appearances); surfacing them keeps an all-duplicate source from being
  // indistinguishable from a genuinely empty one in the pipeline log.
  const duplicates = finalResults.reduce((sum, r) => sum + (r.duplicates || 0), 0);
  if (errors.length > 0) {
    console.log(`  ⚠  Fetch summary: ${withData.length} sources with data, ${empty.length} empty, ${errors.length} ERRORED, ${duplicates} duplicate(s):`);
    for (const e of errors) console.log(`    ✗ ${e.source}: ${e.error}`);
  } else {
    console.log(`  ✅ Fetch summary: ${withData.length} sources with data, ${empty.length} empty, ${duplicates} duplicate(s) (no errors)`);
  }

  return finalResults;
}

module.exports = { fetchSource, fetchAllSources, recordFailedAttempt };
