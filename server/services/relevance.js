'use strict';

/**
 * Eagleye — Personal Relevance Engine (Batch B6)
 *
 * The system collected user behaviour (saved items, watchlist subscriptions)
 * but never fed it back into ranking — every user saw the same alpha ordering.
 * This module closes that loop for a *personal* information filter:
 *
 *   1. deriveProfile()  — build a user interest profile from explicit signals
 *                         (watchlist subs + saved items): type affinities and
 *                         the set of watched entities.
 *   2. getForYou()      — rank a candidate pool by alpha × personal relevance,
 *                         with an unseen boost so the feed surfaces fresh items.
 *
 * Graceful degradation is the core design constraint: saved_items may be empty
 * and entity_links only covers ~6% of items, so the profile must lean on the
 * broadly-available signal (signal_type) and degrade to plain alpha ranking
 * when there is no behaviour to learn from. A new user still gets a useful feed
 * (alpha-ranked, unseen-first); a engaged user gets one tuned to their tastes.
 */

const { getDB } = require('../db/connection');
const { getAll: getWatchlist } = require('./watchlist');
const { todayDigestDate } = require('./date-contract');

// 5-minute TTL on the derived profile — cheap to recompute, but avoids
// re-scanning saved_items + watchlist on every /api/for-you poll. Keyed by
// user: a single shared entry would have leaked one account's interest profile
// into another account's For-You ranking.
const _profileCache = new Map(); // userId -> { profile, at }
const PROFILE_TTL_MS = 5 * 60 * 1000;

/**
 * Derive the user interest profile from explicit behaviour.
 * Returns { types: {slug: weight}, entities: Set<slug>, sources: {slug: weight},
 *           has_signal: boolean }.
 *
 *   - Watchlist entity subs → explicit entity affinities (high precision).
 *   - Watchlist type subs   → explicit type affinities.
 *   - Saved items           → implicit: their signal_types and their linked
 *                             entities feed the same affinity maps, weighted by
 *                             recency (recent saves count more).
 * Affinity weights are normalised to [0,1] via softmax-ish cap so a single
 * heavy type can't dominate; combined with alpha in getForYou they act as a
 * gentle re-ranker (same envelope philosophy as the audience/personal lenses).
 */
function deriveProfile(userId) {
  const db = getDB();
  if (!db) return { types: {}, entities: new Set(), sources: {}, has_signal: false };

  const types = {};   // slug → raw affinity score
  const entities = new Set();
  const sources = {};

  // 1. Explicit watchlist subscriptions.
  const { subs } = getWatchlist(userId);
  for (const s of subs) {
    if (s.kind === 'entity' && s.value) {
      entities.add(s.value);
    } else if (s.kind === 'type' && s.value) {
      types[s.value] = (types[s.value] || 0) + 1.0; // explicit type sub = strong
    }
  }

  // 2. Implicit signal from saved items (recency-weighted).
  // A save is a stronger relevance signal than a watchlist type-sub (it's an
  // act on a specific item), so weight it higher, but decay older saves.
  const saves = db.prepare(`
    SELECT sv.item_id, sv.created_at, ss.signal_type, i.source_id
    FROM saved_items sv
    JOIN information_items i ON i.id = sv.item_id
    LEFT JOIN signal_scores ss ON ss.item_id = sv.item_id
    WHERE sv.user_id = ?
    ORDER BY sv.created_at DESC
    LIMIT 200
  `).all(userId);

  const now = Date.now();
  for (const sv of saves) {
    // Half-life ~30d: a save 30 days ago counts half as much as today's.
    const ageDays = (now - new Date(sv.created_at || now).getTime()) / 86400000;
    const w = 1.5 * Math.pow(0.5, Math.max(0, ageDays) / 30);
    if (sv.signal_type) types[sv.signal_type] = (types[sv.signal_type] || 0) + w;
    if (sv.source_id) sources[sv.source_id] = (sources[sv.source_id] || 0) + w;

    // Pull entities linked to this saved item into the affinity set.
    try {
      const ents = db.prepare(`
        SELECT DISTINCT ce.canonical_slug
        FROM entity_mentions em
        JOIN entity_links el ON el.mention_id = em.id
        JOIN canonical_entities ce ON ce.id = el.entity_id
        WHERE em.item_id = ?
      `).all(sv.item_id);
      for (const e of ents) if (e.canonical_slug) entities.add(e.canonical_slug);
    } catch { /* entity tables absent → skip */ }
  }

  // Normalise type affinities to [0,1] (cap at a soft max so no single type
  // overwhelms). maxObserved → 1.0; everything scales proportionally.
  const maxType = Math.max(1, ...Object.values(types));
  const typesNorm = {};
  for (const [k, v] of Object.entries(types)) typesNorm[k] = Math.min(1, v / maxType);

  const maxSrc = Math.max(1, ...Object.values(sources));
  const sourcesNorm = {};
  for (const [k, v] of Object.entries(sources)) sourcesNorm[k] = Math.min(1, v / maxSrc);

  return {
    types: typesNorm,
    entities,
    sources: sourcesNorm,
    has_signal: subs.length > 0 || saves.length > 0,
  };
}

function getCachedProfile(userId) {
  const now = Date.now();
  const hit = _profileCache.get(userId);
  if (hit && (now - hit.at) < PROFILE_TTL_MS) return hit.profile;
  const profile = deriveProfile(userId);
  _profileCache.set(userId, { profile, at: now });
  return profile;
}

/** Invalidate one user's cached profile (call when their saves/watchlist change). */
function invalidateProfile(userId) {
  if (userId === undefined) _profileCache.clear();
  else _profileCache.delete(userId);
}

/**
 * Mark an item as seen (idempotent). Called when the user opens a card/detail.
 */
function markSeen(itemId, userId) {
  const db = getDB();
  if (!db || !itemId) return false;
  db.prepare(`INSERT OR IGNORE INTO seen_items (user_id, item_id) VALUES (?, ?)`)
    .run(userId, itemId);
  return true;
}

/**
 * Mark multiple items as seen at once (batch "mark all as read").
 * @param {string[]} itemIds
 * @returns {number} count marked
 */
function markManySeen(itemIds, userId) {
  const db = getDB();
  if (!db || !Array.isArray(itemIds) || itemIds.length === 0) return 0;
  const stmt = db.prepare(`INSERT OR IGNORE INTO seen_items (user_id, item_id) VALUES (?, ?)`);
  const tx = db.transaction(() => {
    for (const id of itemIds) stmt.run(userId, id);
  });
  tx();
  return itemIds.length;
}

/**
 * The For-You feed: a candidate pool ranked by alpha × personal relevance,
 * unseen-first.
 *
 * Ranking combines (computed in SQL where possible, final blend in JS):
 *   - alpha_score (base quality — always present)
 *   - type_affinity boost:  +profile.types[type] * 0.20  (up to +0.20)
 *   - entity_affinity boost: +0.25 if the item mentions a watched entity
 *   - seen damping:          seen items multiplied by 0.55 (pushed down, not
 *                            hidden — the user may want to revisit)
 *
 * Candidate pool = trailing N days, capped. Returns { items, total, profile }.
 */
function getForYou({ sinceDays = 3, limit = 60, userId } = {}) {
  const db = getDB();
  if (!db) return { items: [], total: 0, profile: { has_signal: false } };

  const profile = getCachedProfile(userId);
  const since = (() => {
    const d = new Date(); d.setDate(d.getDate() - sinceDays);
    return todayDigestDate(d);
  })();

  // Pull a candidate pool wider than the return limit so personalisation has
  // room to re-rank before the cap.
  const poolSize = Math.min(400, Math.max(limit * 4, 120));

  // Entity-affinity boost is only worth the JOIN when the user actually watches
  // entities; otherwise skip it (keeps the query cheap for new users).
  const entitySlugs = [...profile.entities];
  const entityMatchExpr = entitySlugs.length > 0
    ? `EXISTS(SELECT 1 FROM entity_mentions em2 JOIN entity_links el2 ON el2.mention_id=em2.id
              JOIN canonical_entities ce2 ON ce2.id=el2.entity_id
              WHERE em2.item_id=i.id AND ce2.canonical_slug IN (${entitySlugs.map(() => '?').join(',')}))`
    : '0';

  const params = entitySlugs.length > 0 ? [...entitySlugs, since, poolSize] : [since, poolSize];

  const rows = db.prepare(`
    SELECT i.id, i.title, i.canonical_url, i.published_at, i.digest_date,
           s.label as source_label, s.slug as source_slug,
           ss.alpha_score, ss.signal_type,
           COALESCE(seen.item_id IS NOT NULL, 0) AS seen,
           ${entityMatchExpr} AS entity_hit
    FROM information_items i
    JOIN sources s ON i.source_id = s.id
    LEFT JOIN signal_scores ss ON ss.item_id = i.id
    LEFT JOIN seen_items seen ON seen.user_id = ? AND seen.item_id = i.id
    WHERE i.digest_date >= ? AND ss.alpha_score IS NOT NULL
    ORDER BY ss.alpha_score DESC
    LIMIT ?
  `).all(userId, ...params);

  // Final personal blend in JS (small pool → cheap).
  const scored = rows.map(r => {
    const typeBoost = (profile.types[r.signal_type] || 0) * 0.20;
    // Entity boost is the strongest personal signal — an item mentioning a
    // watched entity is highly relevant. But a flat +0.25 can over-boost a
    // low-alpha item. Tier it: +0.25 for entity match on items with alpha≥0.5,
    // +0.15 for entity match on low-alpha items (still surfaces but doesn't
    // dominate). This prevents a junk tweet mentioning a watched entity from
    // outranking a genuinely strong signal.
    let entityBoost = 0;
    if (r.entity_hit) {
      entityBoost = (r.alpha_score || 0) >= 0.5 ? 0.25 : 0.15;
    }
    // Source affinity: a mild boost for sources the user saves from (their
    // preferred feeds). Capped at +0.10 so it never overrides content quality.
    const sourceBoost = Math.min(0.10, (profile.sources[r.source_slug] || 0) * 0.10);
    const seenFactor = r.seen ? 0.55 : 1.0;
    const relevance = (r.alpha_score + typeBoost + entityBoost + sourceBoost) * seenFactor;
    return { ...r, relevance, type_boost: typeBoost, entity_boost: entityBoost, source_boost: sourceBoost };
  });
  scored.sort((a, b) => b.relevance - a.relevance);

  const items = scored.slice(0, limit).map(r => ({
    id: r.id, title: r.title, canonical_url: r.canonical_url,
    published_at: r.published_at, digest_date: r.digest_date,
    source_label: r.source_label, source_slug: r.source_slug,
    alpha_score: r.alpha_score, signal_type: r.signal_type,
    relevance: Math.round(r.relevance * 1000) / 1000,
    seen: !!r.seen,
    personal_boost: Math.round(((r.type_boost + r.entity_boost) - (r.seen ? r.alpha_score * 0.45 : 0)) * 1000) / 1000,
  }));

  return { items, total: items.length, profile: { has_signal: profile.has_signal, type_count: Object.keys(profile.types).length, entity_count: profile.entities.size } };
}

module.exports = { deriveProfile, getCachedProfile, invalidateProfile, markSeen, markManySeen, getForYou };
