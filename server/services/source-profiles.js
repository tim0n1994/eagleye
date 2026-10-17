'use strict';

// Source profiles & entity momentum computation.
//
// Both tables (source_profiles, entity_momentum) exist since migration 009 but
// have never been populated. This module computes and upserts their values
// from existing signal_scores / entity_links data.
//
// Time-windowing reuses the canonical digest_date (YYYY-MM-DD) comparison
// convention established in topic-graph.js.

const { getDB } = require('../db/connection');
const { burstScore } = require('./kleinberg');
const { normalizeDigestDate, todayDigestDate } = require('./date-contract');

// ─── Helpers ────────────────────────────────────────────────────────────

/** Return a canonical digest-date string N days before `date`. */
function digestDaysAgo(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() - days);
  return todayDigestDate(d);
}

/** Return a canonical digest-date string N days before `digestDate`. */
function digestMinus(digestDate, days) {
  const canonical = normalizeDigestDate(digestDate);
  const [y, m, d] = canonical.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Compute mean and population std-dev of an array of numbers.
 * Returns { mean, std } with std=0 if fewer than 2 values.
 */
function meanStd(values) {
  const n = values.length;
  if (n === 0) return { mean: 0, std: 0 };
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  if (n < 2) return { mean, std: 0 };
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, std: Math.sqrt(variance) };
}

/** Classify a source by its statistical profile into a heuristic type. */
function classifySourceType(noiseRate, earlyRate, originalityRate) {
  if (noiseRate > 0.5) return 'noisy';
  if (earlyRate > 0.3) return 'early_signal';
  if (originalityRate > 0.4) return 'originator';
  return 'amplifier';
}

// ─── source_profiles ────────────────────────────────────────────────────

/**
 * Recompute and upsert source_profiles for all sources that have scored items.
 *
 * Uses a trailing 30-day window of signal_scores to derive:
 *   noise_rate        — fraction of items scored 'uncategorized'
 *   early_signal_rate — fraction with high novelty + alpha (early signals)
 *   originality_rate  — fraction producing origin/repo/paper/model signals
 *   last_30d_alpha_hits — absolute count of high-alpha items
 *   source_type       — heuristic classification from the above rates
 *
 * Returns { sources: N, updated: N }.
 */
function updateSourceProfiles(date = new Date()) {
  const db = getDB();
  if (!db) return { sources: 0, updated: 0 };

  const since = digestDaysAgo(date, 30);
  const rows = db.prepare(`
    SELECT
      s.slug,
      COUNT(*) as total,
      SUM(CASE WHEN ss.signal_type = 'uncategorized' THEN 1 ELSE 0 END) as noise,
      SUM(CASE WHEN ss.alpha_score > 0.6 AND ss.novelty_score > 0.8 THEN 1 ELSE 0 END) as early,
      SUM(CASE WHEN ss.signal_type IN ('origin_signal','new_repo','new_paper','model_release') THEN 1 ELSE 0 END) as original,
      SUM(CASE WHEN ss.alpha_score > 0.65 THEN 1 ELSE 0 END) as alpha_hits
    FROM sources s
    JOIN information_items i ON i.source_id = s.id
    JOIN signal_scores ss ON ss.item_id = i.id
    WHERE i.digest_date >= ?
    GROUP BY s.slug
  `).all(since);

  if (rows.length === 0) {
    console.log('  📊 No scored items in the last 30 days; source_profiles unchanged.');
    return { sources: 0, updated: 0 };
  }

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO source_profiles
      (source_slug, source_type, early_signal_rate, noise_rate, originality_rate, last_30d_alpha_hits, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  let updated = 0;
  const tx = db.transaction((entries) => {
    for (const r of entries) {
      if (!r.total) continue;
      const noiseRate = r.noise / r.total;
      const earlyRate = r.early / r.total;
      const originalityRate = r.original / r.total;
      const sourceType = classifySourceType(noiseRate, earlyRate, originalityRate);
      upsert.run(r.slug, sourceType, earlyRate, noiseRate, originalityRate, r.alpha_hits);
      updated++;
    }
  });
  tx(rows);

  console.log(`  📊 Updated source_profiles for ${updated} sources (30d window since ${since}).`);
  return { sources: rows.length, updated };
}

// ─── entity_momentum ────────────────────────────────────────────────────

const MOMENTUM_WINDOWS = [
  { name: '24h', days: 1 },
  { name: '7d', days: 7 },
  { name: '30d', days: 30 },
];

/**
 * Recompute and upsert entity_momentum for all canonical entities with
 * recent mentions, across 24h / 7d / 30d windows.
 *
 * Data path: canonical_entities ← entity_links(entity_id)
 *            → entity_mentions(mention_id, item_id)
 *            → information_items(digest_date)
 *
 * velocity_zscore is computed per-window across all entities, so entities
 * with mention counts far above the cohort mean are flagged as "surging".
 *
 * Returns { entities: N, rows: N }.
 */
function updateEntityMomentum(date = new Date()) {
  const db = getDB();
  if (!db) return { entities: 0, rows: 0 };

  const aggregateForWindow = db.prepare(`
    SELECT
      el.entity_id,
      COUNT(*) as mention_count,
      COUNT(DISTINCT i.source_id) as unique_sources,
      SUM(CASE WHEN ss.alpha_score > 0.6 THEN 1 ELSE 0 END) as high_quality
    FROM entity_links el
    JOIN entity_mentions em ON em.id = el.mention_id
    JOIN information_items i ON i.id = em.item_id
    LEFT JOIN signal_scores ss ON ss.item_id = i.id
    WHERE i.digest_date >= ?
    GROUP BY el.entity_id
  `);

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO entity_momentum
      (entity_id, window, mention_count, unique_sources, high_quality_mentions, velocity_zscore, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  let totalRows = 0;
  const allEntities = new Set();

  for (const win of MOMENTUM_WINDOWS) {
    const since = digestDaysAgo(date, win.days);
    const rows = aggregateForWindow.all(since);
    if (rows.length === 0) continue;

    // Z-score across all entities within this window.
    const counts = rows.map(r => r.mention_count);
    const { mean, std } = meanStd(counts);

    const tx = db.transaction((entries) => {
      for (const r of entries) {
        allEntities.add(r.entity_id);
        const zscore = std > 0 ? (r.mention_count - mean) / std : 0;
        upsert.run(
          r.entity_id, win.name,
          r.mention_count, r.unique_sources, r.high_quality || 0,
          Math.round(zscore * 100) / 100
        );
        totalRows++;
      }
    });
    tx(rows);
  }

  console.log(`  📊 Updated entity_momentum (base): ${totalRows} rows across ${allEntities.size} entities (3 windows).`);

  // ─── Phase 1 enrichment: growth_rate, acceleration, burst_score ────────
  // All three derive from ONE daily-mention series per entity over 30 days,
  // so a single grouped query feeds them. Written with UPDATE after the base
  // rows exist, so the 7d/30d rows keep their mention_count/zscore intact.
  // (Anchored on the data's latest day, not `date` — see the function.)
  const phase1 = computeEntityPhase1Metrics(db);
  if (phase1.entities > 0) {
    console.log(`  📊 Updated entity_momentum (Phase 1): growth/accel/burst for ${phase1.entities} entities.`);
  }

  return { entities: allEntities.size, rows: totalRows, phase1 };
}

// ─── Phase 1 metric computation ─────────────────────────────────────────

/**
 * Compute growth_rate, acceleration, and burst_score per entity from its daily
 * mention series over the trailing 30 days, then UPDATE the 7d/30d rows.
 *
 *   growth_rate  (7d row)   = count(7d) / max(count(prev 7d), 1) - 1
 *   acceleration (7d row)   = (count(24h) - count(7d)/7) / max(count(7d)/7, 1)
 *   burst_score  (7d & 30d) = Kleinberg 2-state weight; 0 unless the most
 *                             recent day is in a burst state (see kleinberg.js)
 *
 * Note: anchoring is on the data's newest digest_date, not wall-clock time, so
 * this function takes no `date` argument. Returns { entities, updated }.
 */
function computeEntityPhase1Metrics(db) {
  // Anchor on the newest digest_date in the data, not wall-clock "now": when
  // ingestion lags a day or two (or during backfill), wall-clock comparison
  // would place both the 7d and prev-7d windows over sparse/empty ranges and
  // suppress every real spike. Relative-to-data anchoring keeps growth/accel/
  // burst meaningful regardless of freshness.
  const latestRow = db.prepare(`
    SELECT MAX(i.digest_date) as d
    FROM information_items i
    JOIN entity_mentions em ON em.item_id = i.id
    JOIN entity_links el ON el.mention_id = em.id
  `).get();
  if (!latestRow?.d) return { entities: 0, updated: 0 };
  const latest = latestRow.d;

  const since30 = digestMinus(latest, 30);

  // Daily mention counts per entity: entity_id → Map(digest_date → count)
  const seriesRows = db.prepare(`
    SELECT el.entity_id, i.digest_date, COUNT(*) as c
    FROM entity_links el
    JOIN entity_mentions em ON em.id = el.mention_id
    JOIN information_items i ON i.id = em.item_id
    WHERE i.digest_date >= ?
    GROUP BY el.entity_id, i.digest_date
  `).all(since30);

  if (seriesRows.length === 0) return { entities: 0, updated: 0 };

  // Build the zero-filled chronological date index for the 30d window (31 days),
  // anchored on the data's latest day so growth/accel/burst line up with the
  // densest stretch of data rather than wall-clock "now".
  const dateIndex = [];
  for (let d = 30; d >= 0; d--) dateIndex.push(digestMinus(latest, d));

  // Group rows by entity → count map.
  const byEntity = new Map();
  for (const r of seriesRows) {
    let m = byEntity.get(r.entity_id);
    if (!m) { m = new Map(); byEntity.set(r.entity_id, m); }
    m.set(r.digest_date, (m.get(r.digest_date) || 0) + r.c);
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round3 = (v) => Math.round(v * 1000) / 1000;

  const update7d = db.prepare(`
    UPDATE entity_momentum
    SET growth_rate = ?, acceleration = ?, burst_score = ?, prev_window_count = ?
    WHERE entity_id = ? AND window = '7d'
  `);
  const update30d = db.prepare(`
    UPDATE entity_momentum SET burst_score = ? WHERE entity_id = ? AND window = '30d'
  `);

  let updated = 0;
  const tx = db.transaction(() => {
    for (const [entityId, dayMap] of byEntity) {
      // Full 30d series (zero-filled) + slice the last 7 for the 7d window.
      const series30 = dateIndex.map(d => dayMap.get(d) || 0);
      const series7 = series30.slice(-7);

      const c24h = series7[series7.length - 1] || 0;
      const c7d = series7.reduce((a, b) => a + b, 0);
      const prev7 = dateIndex.slice(-14, -7).map(d => dayMap.get(d) || 0);
      const cPrev7d = prev7.reduce((a, b) => a + b, 0);

      const growthRate = c7d > 0 || cPrev7d > 0
        ? clamp(c7d / Math.max(cPrev7d, 1) - 1, -1, 10)
        : 0;
      const weekAvg = c7d / 7;
      const acceleration = weekAvg > 0
        ? clamp((c24h - weekAvg) / Math.max(weekAvg, 1), -5, 10)
        : (c24h > 0 ? 1 : 0);

      // adaptive:true relaxes the burst rate for sparse series so genuinely
      // accelerating niche entities (low absolute mention count) can register a
      // burst instead of silently falling back to day-volume velocity.
      const burst7d = round3(burstScore(series7, { adaptive: true }));
      const burst30d = round3(burstScore(series30, { adaptive: true }));

      update7d.run(round3(growthRate), round3(acceleration), burst7d, cPrev7d, entityId);
      update30d.run(burst30d, entityId);
      updated++;
    }
  });
  tx();

  return { entities: byEntity.size, updated };
}

module.exports = { updateSourceProfiles, updateEntityMomentum };
