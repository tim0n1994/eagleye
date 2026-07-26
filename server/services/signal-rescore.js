'use strict';

/**
 * Full-corpus signal rescoring.
 *
 * The daily FULL_PIPELINE only scores items fetched that day, so the backlog
 * of historical items never receives a signal_score — which leaves every
 * downstream consumer (entity momentum, source profiles, the /signals radar)
 * starved. This walks every digest_date (oldest first), re-runs scoreSignals
 * with the current taxonomy, and reports coverage.
 *
 * Multiple dates run concurrently to keep the LLM provider saturated (it
 * supports up to 64 parallel sockets), matching the worker-pool pattern used
 * by the legacy ad-hoc backfill scripts.
 *
 * Callers:
 *   - scripts/rescore-signals.js (standalone CLI)
 *   - the RESCORE_ALL background job (server/services/jobs.js)
 */

const { getDB } = require('../db/connection');

// How many digest_dates to score in parallel. The LLM provider saturates
// around 6; bump via RESCORE_CONCURRENCY for beefier endpoints.
const DEFAULT_CONCURRENCY = parseInt(process.env.RESCORE_CONCURRENCY || '6', 10);

async function rescoreAllSignals(opts = {}) {
  const { scoreSignals } = require('./signals');
  const db = getDB();
  if (!db) return { total_items: 0, scored: 0, dates_processed: 0 };

  const concurrency = Math.max(1, opts.concurrency || DEFAULT_CONCURRENCY);
  const jobId = opts.jobId || null;

  // Lazy require to avoid the circular jobs ↔ signal-rescore dependency
  // (jobs.js requires this module inside its RESCORE_ALL case). When invoked
  // standalone (no jobId) we no-op the progress/cancellation hooks.
  const jobsApi = jobId
    ? require('./jobs')
    : { isJobCancelled: () => false, updateJobProgress: () => {} };

  const dates = db.prepare(`
    SELECT digest_date, COUNT(*) as c
    FROM information_items
    GROUP BY digest_date
    ORDER BY digest_date ASC
  `).all();

  const total = dates.reduce((s, d) => s + d.c, 0);
  console.log(`[rescore] ${dates.length} dates, ${total} items total, concurrency=${concurrency}`);

  const startDist = db.prepare(`
    SELECT signal_type, COUNT(*) as c
    FROM signal_scores GROUP BY signal_type ORDER BY c DESC
  `).all();
  console.log('[rescore] before distribution:');
  for (const r of startDist) console.log(`  ${r.signal_type}: ${r.c}`);

  let processed = 0;
  let scored = 0;
  const startedAt = Date.now();

  async function processDate({ digest_date }) {
    if (jobsApi.isJobCancelled(jobId)) return 0;
    const items = db.prepare(`
      SELECT i.*, s.label as source_label, s.slug as source_slug
      FROM information_items i
      JOIN sources s ON i.source_id = s.id
      WHERE i.digest_date = ?
      ORDER BY i.score DESC
    `).all(digest_date);
    if (items.length === 0) return 0;
    const t0 = Date.now();
    // llmSkipRuleMatched: source-override and keyword-rule hits don't need an
    // LLM call — only items the rules left 'uncategorized' go to the classifier.
    const res = await scoreSignals(items, { jobId, llmSkipRuleMatched: true });
    const dt = Date.now() - t0;
    processed += items.length;
    scored += res.scored || 0;
    const pct = ((processed / total) * 100).toFixed(1);
    console.log(
      `[rescore] date=${digest_date} n=${items.length} scored=${res.scored} (${dt}ms) — total ${processed}/${total} (${pct}%)`
    );
    jobsApi.updateJobProgress(jobId, {
      progress_pct: Math.floor((processed / total) * 100),
      detail: `${processed}/${total} (date ${digest_date})`,
    });
    return items.length;
  }

  // Worker-pool over dates: N concurrent processDate() calls, each issuing its
  // own LLM batch. better-sqlite3 is synchronous, so DB writes (wrapped in a
  // transaction per scoreSignals call) interleave safely at await points.
  const queue = [...dates];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const next = queue.shift();
      if (!next || jobsApi.isJobCancelled(jobId)) return;
      try {
        await processDate(next);
      } catch (err) {
        console.error(`[rescore] date=${next.digest_date} FAILED:`, err.message);
      }
    }
  });
  await Promise.all(workers);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  const endDist = db.prepare(`
    SELECT signal_type, COUNT(*) as c
    FROM signal_scores GROUP BY signal_type ORDER BY c DESC
  `).all();
  console.log('[rescore] after distribution:');
  for (const r of endDist) console.log(`  ${r.signal_type}: ${r.c}`);

  const cov = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM information_items) as total,
      (SELECT COUNT(*) FROM signal_scores) as scored,
      (SELECT COUNT(*) FROM signal_scores WHERE signal_type='uncategorized') as unc
  `).get();
  const coveragePct = cov.total > 0 ? ((cov.scored / cov.total) * 100).toFixed(2) : '0.00';
  console.log(
    `[rescore] coverage: ${cov.scored}/${cov.total} (${coveragePct}%) | uncategorized=${cov.unc}`
  );
  console.log(`[rescore] DONE in ${elapsed}s — processed=${processed} scored=${scored}`);

  return {
    total_items: total,
    dates_processed: dates.length,
    scored,
    elapsed_sec: Number(elapsed),
    coverage: {
      scored: cov.scored,
      total: cov.total,
      pct: Number(coveragePct),
      uncategorized: cov.unc,
    },
  };
}

module.exports = { rescoreAllSignals, DEFAULT_CONCURRENCY };
