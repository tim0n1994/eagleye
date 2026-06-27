'use strict';

// Source profiles & entity momentum computation.
//
// Both tables (source_profiles, entity_momentum) exist since migration 009 but
// have never been populated. This module computes and upserts their values
// from existing signal_scores / entity_links data.
//
// Time-windowing reuses the digest_date lexicographic comparison convention
// (YYYYMMDD strings) established in topic-graph.js.

const { getDB } = require('../db/connection');

// ─── Helpers ────────────────────────────────────────────────────────────

/** Convert a Date to a YYYYMMDD digest-date string (UTC). */
function toDigest(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Return a YYYYMMDD digest-date string N days before `date`. */
function digestDaysAgo(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - days);
  return toDigest(d);
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

  console.log(`  📊 Updated entity_momentum: ${totalRows} rows across ${allEntities.size} entities (3 windows).`);
  return { entities: allEntities.size, rows: totalRows };
}

module.exports = { updateSourceProfiles, updateEntityMomentum };
