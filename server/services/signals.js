/**
 * Alpha Radar — Signal Scoring Engine
 *
 * Computes multi-dimensional signal scores for information items and
 * classifies them into investment/research signal types.
 */

const { getDB } = require('../db/connection');
const { getProvider, getLLMConfig } = require('./llm-provider');

// Whether a usable LLM provider is configured (env or runtime override). Avoids
// burning a full provider.call() round-trip just to detect absence — used to
// gate the second-pass retry so an offline endpoint degrades gracefully.
const { SIGNAL_TYPES } = require('./signals-classify');
const { scoreSignals } = require('./signals-score');

const AUDIENCE_DEFS = [
  {
    key: 'developer',
    label: 'Developer',
    label_zh: '开发者',
    description: 'New repos, model releases, agents, launches — what to build with.',
    description_zh: '新仓库、模型发布、智能体、产品发布 —— 值得上手做的。',
    weights: {
      new_repo: 1.30, model_release: 1.20, agent_signal: 1.25,
      origin_signal: 1.15, velocity_spike: 1.10, new_paper: 1.05,
      funding_signal: 0.85, hiring_signal: 0.85, supply_chain: 0.85,
    },
  },
  {
    key: 'researcher',
    label: 'Researcher',
    label_zh: '研究者',
    description: 'Papers, benchmarks, architecture shifts, contradictions — the frontier.',
    description_zh: '论文、基准、架构迁移、矛盾信号 —— 前沿进展。',
    weights: {
      new_paper: 1.30, benchmark_claim: 1.25, architecture_shift: 1.20,
      contradiction: 1.20, model_release: 1.10, novel_combination: 1.10,
      funding_signal: 0.85, hiring_signal: 0.85, supply_chain: 0.85,
      velocity_spike: 0.90,
    },
  },
  {
    key: 'investor',
    label: 'Investor',
    label_zh: '投资人',
    description: 'Funding, hiring, supply chain, narrative shifts — alpha & momentum.',
    description_zh: '融资、招聘、供应链、叙事迁移 —— alpha 与动量。',
    weights: {
      funding_signal: 1.30, hiring_signal: 1.20, supply_chain: 1.20,
      narrative_shift: 1.15, contradiction: 1.15, origin_signal: 1.10,
      new_repo: 0.85, new_paper: 0.90, benchmark_claim: 0.90,
      velocity_spike: 0.90,
    },
  },
];

const AUDIENCE_WEIGHTS = Object.fromEntries(
  AUDIENCE_DEFS.map(a => [a.key, a.weights])
);

function getRadarAudiences() {
  // Destructure to drop the internal `weights` map from the public payload.
  return AUDIENCE_DEFS.map(({ weights: _weights, ...meta }) => meta);
}

/**
 * Build a SQL CASE expression multiplying alpha_score by the audience's
 * per-type weight, or null when no audience is selected (use raw alpha_score).
 * SQLite MIN(a,b) is the scalar 2-arg form here, not the aggregate.
 */
function audienceReweightSQL(audience) {
  const weights = AUDIENCE_WEIGHTS[audience];
  if (!weights) return null;
  const cases = Object.entries(weights)
    .map(([type, w]) => `WHEN '${type}' THEN ${w}`)
    .join(' ');
  return `MIN(1.0, ss.alpha_score * (CASE ss.signal_type ${cases} ELSE 1.0 END))`;
}

/**
 * Build a reweight SQL fragment from a user's personal lens (PRD-5).
 * A lens is { types: { <signal_type>: <multiplier 0.5..1.5> } }. Multipliers are
 * clamped to [0.5, 1.5] (gentle, same envelope as the audience lenses) and the
 * signal_type values are validated against the canonical SIGNAL_TYPES set so a
 * crafted lens can't inject SQL. Returns null for an empty/invalid lens.
 */
function personalLensSQL(lens) {
  if (!lens || typeof lens !== 'object') return null;
  const types = lens.types || lens;
  if (!types || typeof types !== 'object') return null;
  const valid = new Set(SIGNAL_TYPES);
  const entries = Object.entries(types)
    .filter(([t, w]) => valid.has(t) && Number.isFinite(Number(w)))
    .map(([t, w]) => [t, Math.max(0.5, Math.min(1.5, Number(w)))]);
  if (entries.length === 0) return null;
  const cases = entries.map(([t, w]) => `WHEN '${t}' THEN ${w}`).join(' ');
  return `MIN(1.0, ss.alpha_score * (CASE ss.signal_type ${cases} ELSE 1.0 END))`;
}

function getSignals(opts = {}) {
  const db = getDB();
  if (!db) return [];

  const { signalType, date, sortBy = 'alpha_score', limit = 50, offset = 0, sinceDays, audience, lens, excludeUncategorized } = opts;

  // When an audience OR personal lens is active, compute a reweighted score and
  // rank by it; the base alpha_score is preserved on the row as alpha_score_base.
  // The personal lens (PRD-5) takes precedence over the preset audience lenses
  // when both are supplied — the user's explicit choice should win.
  const reweight = personalLensSQL(lens) || audienceReweightSQL(audience);
  const audienceCol = reweight
    ? `, ${reweight} as alpha_score_audience`
    : '';
  // Determine the ORDER BY column: audience/lens reweight wins over an explicit
  // alpha sort; novelty/velocity sorts are dimension-specific and left intact.
  let orderCol = 'ss.alpha_score';
  if (reweight && (sortBy === 'alpha_score' || sortBy === 'alpha')) {
    orderCol = 'alpha_score_audience';
  } else if (sortBy === 'novelty') {
    orderCol = 'ss.novelty_score';
  } else if (sortBy === 'velocity') {
    orderCol = 'ss.velocity_score';
  }

  let sql = `
    SELECT ss.*, i.title, i.canonical_url, i.published_at, i.score,
           s.label as source_label, s.slug as source_slug,
           a.one_liner, a.short_summary, a.ai_title,
           sp.source_type, sp.noise_rate, sp.early_signal_rate${audienceCol}
    FROM signal_scores ss
    JOIN information_items i ON ss.item_id = i.id
    JOIN sources s ON i.source_id = s.id
    LEFT JOIN ai_summaries a ON a.item_id = i.id
    LEFT JOIN source_profiles sp ON sp.source_slug = s.slug
    WHERE 1=1
  `;
  const params = [];

  if (signalType && signalType !== 'all') {
    sql += ' AND ss.signal_type = ?';
    params.push(signalType);
  }

  if (excludeUncategorized) {
    sql += " AND ss.signal_type != 'uncategorized' AND ss.signal_type != 'non_tech'";
  }

  if (date) {
    sql += ' AND i.digest_date = ?';
    params.push(date);
  } else if (sinceDays && Number(sinceDays) > 0) {
    // ISO yyyymmdd → lexicographic compare works because the column is stored
    // as a zero-padded 8-char string.
    const cutoff = new Date(Date.now() - Number(sinceDays) * 86400000)
      .toISOString().slice(0, 10).replace(/-/g, '');
    sql += ' AND i.digest_date >= ?';
    params.push(cutoff);
  }

  sql += ` ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

function getTodaySignals(limit = 100) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  // Try today first; if empty for 7+ days, show from the most recent scored date
  let signals = getSignals({ date: today, limit, sortBy: 'alpha_score', excludeUncategorized: true });
  if (signals.length > 0) return { signals, date: today, total: signals.length, fallback: false };

  // No signals today — find the most recent date with scored signals
  const db = getDB();
  if (db) {
    const recent = db.prepare(`
      SELECT i.digest_date FROM signal_scores ss
      JOIN information_items i ON ss.item_id = i.id
      WHERE ss.signal_type != 'uncategorized'
      ORDER BY i.digest_date DESC LIMIT 1
    `).get();
    if (recent && recent.digest_date) {
      signals = getSignals({ date: recent.digest_date, limit, sortBy: 'alpha_score', excludeUncategorized: true });
      return { signals, date: recent.digest_date, total: signals.length, fallback: true };
    }
  }
  return { signals: [], date: today, total: 0, fallback: false };
}

function getSignalById(itemId) {
  const db = getDB();
  if (!db) return null;

  const signal = db.prepare(`
    SELECT ss.*, i.title, i.canonical_url, i.published_at, i.score,
           i.original_summary, i.content_text,
           s.label as source_label, s.slug as source_slug,
           a.one_liner, a.short_summary, a.key_points, a.why_it_matters,
           a.ai_title, a.ai_title_zh,
           sp.source_type, sp.noise_rate, sp.early_signal_rate
    FROM signal_scores ss
    JOIN information_items i ON ss.item_id = i.id
    JOIN sources s ON i.source_id = s.id
    LEFT JOIN ai_summaries a ON a.item_id = i.id
    LEFT JOIN source_profiles sp ON sp.source_slug = s.slug
    WHERE ss.item_id = ?
  `).get(itemId);

  if (signal) {
    signal.topics = db.prepare(`
      SELECT t.slug, t.name FROM item_topics it
      JOIN topics t ON it.topic_id = t.id WHERE it.item_id = ?
    `).all(itemId);
    // Entities via KG v2 (canonical_entities), with 7d momentum if available.
    signal.entities = db.prepare(`
      SELECT ce.canonical_name as name, ce.canonical_slug as slug, ce.entity_type as type,
             em2.velocity_zscore as zscore, em2.mention_count,
             em2.growth_rate, em2.acceleration, em2.burst_score
      FROM entity_mentions ement
      JOIN entity_links el ON el.mention_id = ement.id
      JOIN canonical_entities ce ON ce.id = el.entity_id
      LEFT JOIN entity_momentum em2 ON em2.entity_id = ce.id AND em2.window = '7d'
      WHERE ement.item_id = ?
      GROUP BY ce.id
      ORDER BY (em2.velocity_zscore IS NOT NULL) DESC, COALESCE(em2.velocity_zscore, 0) DESC
      LIMIT 10
    `).all(itemId);
  }

  return signal;
}

function getSignalTypes() {
  const db = getDB();
  if (!db) return [];

  const types = db.prepare('SELECT * FROM signal_types ORDER BY sort_order').all();
  const counts = db.prepare(`
    SELECT signal_type, COUNT(*) as cnt FROM signal_scores
    WHERE datetime(scored_at) > datetime('now', '-24 hours')
    GROUP BY signal_type
  `).all();
  const countMap = {};
  for (const c of counts) countMap[c.signal_type] = c.cnt;

  return types.map(t => ({ ...t, today_count: countMap[t.slug] || 0 }));
}

/**
 * Trending entities ranked by a chosen metric for a given time window.
 * Used by the intelligence/momentum leaderboard and the /signals "Rising
 * Entities" panel.
 *
 * sort options:
 *   'zscore' (default) — cross-entity velocity z-score (most-mentioned cohort)
 *   'acceleration'     — today vs week-average (who is spiking right now)
 *   'growth'           — week-over-week growth rate
 *   'burst'            — Kleinberg burst weight (0 unless currently bursting)
 *
 * Phase 1 enrichment: growth_rate/acceleration/burst_score columns come from
 * updateEntityMomentum's Phase 1 pass.
 */
function getEntityMomentum(window = '7d', limit = 20, sort = 'zscore') {
  const db = getDB();
  if (!db) return [];

  const sortCol = {
    acceleration: 'em.acceleration',
    growth: 'em.growth_rate',
    burst: 'em.burst_score',
    zscore: 'em.velocity_zscore',
  }[sort] || 'em.velocity_zscore';

  return db.prepare(`
    SELECT ce.canonical_name as name, ce.canonical_slug as slug, ce.entity_type as type,
           em.mention_count, em.unique_sources, em.high_quality_mentions,
           em.velocity_zscore as zscore,
           em.growth_rate, em.acceleration, em.burst_score, em.prev_window_count
    FROM entity_momentum em
    JOIN canonical_entities ce ON ce.id = em.entity_id
    WHERE em.window = ? AND em.mention_count >= 2
    ORDER BY ${sortCol} DESC, em.mention_count DESC
    LIMIT ?
  `).all(window, limit);
}

/**
 * Resolve a canonical entity by slug and return its recent items + momentum,
 * for the entity detail view and the per-entity Atom feed (Phase 3.C).
 *
 * Item path: canonical_entities ← entity_links → entity_mentions → information_items,
 * the inverse of getSignalById's entity query. Returns { entity, items } or null.
 */
function getEntityItems(slug, limit = 20) {
  const db = getDB();
  if (!db) return null;

  const entity = db.prepare(`
    SELECT id, canonical_name, canonical_slug, entity_type, description, homepage_url
    FROM canonical_entities WHERE canonical_slug = ?
  `).get(slug);
  if (!entity) return null;

  const items = db.prepare(`
    SELECT i.id, i.title, i.canonical_url, i.published_at, i.digest_date,
           s.label as source_label, s.slug as source_slug,
           a.one_liner, a.short_summary, a.ai_title,
           ss.alpha_score, ss.signal_type
    FROM entity_links el
    JOIN entity_mentions em ON em.id = el.mention_id
    JOIN information_items i ON i.id = em.item_id
    JOIN sources s ON i.source_id = s.id
    LEFT JOIN ai_summaries a ON a.item_id = i.id
    LEFT JOIN signal_scores ss ON ss.item_id = i.id
    WHERE el.entity_id = ?
    ORDER BY i.published_at DESC
    LIMIT ?
  `).all(entity.id, limit);

  // Momentum across windows, if computed.
  const momentum = db.prepare(`
    SELECT window, mention_count, velocity_zscore, growth_rate, acceleration, burst_score
    FROM entity_momentum WHERE entity_id = ?
  `).all(entity.id);

  return { entity, items, momentum };
}

/**
 * 30-day daily mention series for an entity, for the Trend Trajectory view
 * (PRD-1). Re-derives the zero-filled series at query time (same windowing the
 * Phase-1 metrics use) and annotates which days fall inside the Kleinberg
 * burst segment so the frontend sparkline can highlight the spike region.
 *
 * Returns { entity, series: [{date, count, burst}], stats } or null.
 */
function getEntitySeries(slug) {
  const db = getDB();
  if (!db) return null;

  const entity = db.prepare(`
    SELECT id, canonical_name, canonical_slug, entity_type
    FROM canonical_entities WHERE canonical_slug = ?
  `).get(slug);
  if (!entity) return null;

  // Anchor on the data's latest digest_date (NOT wall-clock now) so backfilled
  // data still lines up — identical reasoning to computeEntityPhase1Metrics.
  const latestRow = db.prepare(`SELECT MAX(digest_date) AS latest FROM information_items`).get();
  const latest = latestRow?.latest;
  if (!latest) return { entity, series: [], stats: {} };

  const since30 = (() => {
    const y = Number(latest.slice(0, 4));
    const m = Number(latest.slice(4, 6)) - 1;
    const d = Number(latest.slice(6, 8));
    const dt = new Date(Date.UTC(y, m, d));
    dt.setUTCDate(dt.getUTCDate() - 30);
    return dt.toISOString().slice(0, 10).replace(/-/g, '');
  })();

  const rows = db.prepare(`
    SELECT i.digest_date, COUNT(*) AS c
    FROM entity_links el
    JOIN entity_mentions em ON em.id = el.mention_id
    JOIN information_items i ON i.id = em.item_id
    WHERE el.entity_id = ? AND i.digest_date >= ?
    GROUP BY i.digest_date
  `).all(entity.id, since30);

  const dayMap = new Map(rows.map(r => [r.digest_date, r.c]));
  const dateIndex = [];
  for (let d = 30; d >= 0; d--) {
    const y = Number(latest.slice(0, 4));
    const m = Number(latest.slice(4, 6)) - 1;
    const dd = Number(latest.slice(6, 8));
    const dt = new Date(Date.UTC(y, m, dd));
    dt.setUTCDate(dt.getUTCDate() - d);
    dateIndex.push(dt.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  const series30 = dateIndex.map(d => dayMap.get(d) || 0);

  // Find burst days: run viterbi over the series and mark the contiguous final
  // burst run (adaptive so sparse entities still register).
  let burstMask = series30.map(() => false);
  try {
    const { viterbiPath } = require('./kleinberg');
    const total = series30.reduce((a, b) => a + b, 0);
    const mean = total / series30.length;
    const maxC = series30.length ? Math.max(...series30) : 0;
    const opts = { adaptive: true };
    if (mean > 0 && maxC > mean) {
      const ratio = maxC / mean;
      opts.s = Math.min(2.0, Math.max(1.3, ratio - 0.05));
    }
    if (mean > 0) opts.entryCost = Math.max(0.5, 2.0 * Math.min(1, total / 30));
    const path = viterbiPath(series30, opts);
    burstMask = path.map(p => p === 1);
  } catch { /* kleinberg unavailable → no burst highlight */ }

  const series = dateIndex.map((date, i) => ({
    date,
    count: series30[i],
    burst: burstMask[i],
  }));

  // Trend stats over the 7d window for the headline chips.
  const last7 = series30.slice(-7);
  const prev7 = series30.slice(-14, -7);
  const c7 = last7.reduce((a, b) => a + b, 0);
  const cPrev7 = prev7.reduce((a, b) => a + b, 0);
  const stats = {
    total_30d: series30.reduce((a, b) => a + b, 0),
    count_7d: c7,
    growth_rate: c7 > 0 || cPrev7 > 0 ? Number((c7 / Math.max(cPrev7, 1) - 1).toFixed(3)) : 0,
    peak_day: series30.indexOf(Math.max(...series30)) >= 0 ? dateIndex[series30.indexOf(Math.max(...series30))] : null,
    burst_days: burstMask.filter(Boolean).length,
  };

  return { entity, series, stats };
}

/**
 * Entity co-occurrence matrix: find entity pairs that frequently appear in the
 * same items. Returns top pairs with co-occurrence counts for the intelligence
 * page's relationship visualization.
 */
function getEntityCoOccurrence(limit = 20) {
  const db = getDB();
  if (!db) return [];
  // Find pairs of entities that co-occur in the same item, ranked by frequency.
  try {
    return db.prepare(`
      SELECT
        ce1.canonical_name AS name_a, ce1.canonical_slug AS slug_a, ce1.entity_type AS type_a,
        ce2.canonical_name AS name_b, ce2.canonical_slug AS slug_b, ce2.entity_type AS type_b,
        COUNT(DISTINCT em1.item_id) AS co_count
      FROM entity_links el1
      JOIN entity_mentions em1 ON em1.id = el1.mention_id
      JOIN canonical_entities ce1 ON ce1.id = el1.entity_id
      JOIN entity_mentions em2 ON em2.item_id = em1.item_id AND em2.id > em1.id
      JOIN entity_links el2 ON el2.mention_id = em2.id
      JOIN canonical_entities ce2 ON ce2.id = el2.entity_id
      WHERE ce1.id < ce2.id
      GROUP BY ce1.id, ce2.id
      ORDER BY co_count DESC
      LIMIT ?
    `).all(limit);
  } catch {
    return [];
  }
}

/**
 * Compare multiple entities' 30-day trajectories on one chart.
 * Returns { entities: [{slug, name, type, series, stats}], dates } for overlay.
 * Each series is normalized to 0-100 relative to that entity's own peak so
 * entities of different scales (100 mentions vs 5) are comparable.
 */
function compareEntitySeries(slugs) {
  const db = getDB();
  if (!db || !Array.isArray(slugs) || slugs.length === 0) return { entities: [], dates: [] };

  const entities = [];
  let sharedDates = null;

  for (const slug of slugs.slice(0, 5)) { // cap at 5 for readability
    const data = getEntitySeries(slug);
    if (!data || !data.entity) continue;
    // Normalize counts to 0-100 relative to peak (so small entities are visible).
    const maxCount = Math.max(1, ...data.series.map(p => p.count || 0));
    const normSeries = data.series.map(p => ({
      date: p.date,
      count: p.count,
      norm: Math.round((p.count / maxCount) * 100),
      burst: p.burst,
    }));
    entities.push({
      slug,
      name: data.entity.canonical_name || slug,
      type: data.entity.entity_type || '',
      series: normSeries,
      stats: data.stats,
    });
    if (!sharedDates) sharedDates = data.series.map(p => p.date);
  }

  return { entities, dates: sharedDates || [] };
}

module.exports = {
  scoreSignals,
  getSignals,
  getTodaySignals,
  getSignalById,
  getSignalTypes,
  getEntityMomentum,
  getEntityItems,
  getEntitySeries,
  compareEntitySeries,
  getEntityCoOccurrence,
  getRadarAudiences,
  personalLensSQL,
  SIGNAL_TYPES,
};
