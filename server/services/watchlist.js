'use strict';

/**
 * Eagleye — Subscription Hub / Watchlist (PRD-4)
 *
 * Phase 3.C added per-entity Atom feeds but no unified "watch this" surface —
 * a user couldn't track the entities/topics/types they care about in one place.
 * This service persists subscriptions in user_data[watchlist] and aggregates
 * a unified feed of items matching any subscription.
 *
 * Subscription shape: { kind: 'entity'|'type', value: <slug|signal_type> }
 *   - entity → all items mentioning canonical_entities[slug]
 *   - type   → all items with signal_scores[type]
 * (topic subscriptions are intentionally deferred: topic assignment is noisier
 *  than entity linking in this corpus; adding it later is a one-line extension.)
 *
 * Storage: user_data[watchlist] = { subs: [{kind,value,label,added_at}] }
 * The label is captured at add-time so the list renders even if the entity is
 * later pruned from canonical_entities.
 */

const { getValue, setValue } = require('../db/user-data');
const { getDB } = require('../db/connection');

const KEY = 'watchlist';
const MAX_SUBS = 200;

function getAll(userId) {
  const data = getValue(KEY, userId) || {};
  return { subs: Array.isArray(data.subs) ? data.subs : [] };
}

function save(subs, userId) {
  setValue(KEY, { subs }, userId);
  return subs;
}

function findSub(subs, kind, value) {
  return subs.findIndex(s => s.kind === kind && s.value === value);
}

/**
 * Toggle a subscription for one user. Returns { subs, added }.
 * add=true forces add; add=false forces remove; add=undefined toggles.
 */
function toggle(kind, value, label, add, userId) {
  if (!kind || !value) throw new Error('kind and value required');
  if (!['entity', 'type'].includes(kind)) throw new Error('invalid kind');
  const { subs } = getAll(userId);
  const idx = findSub(subs, kind, value);
  const exists = idx >= 0;
  let result = subs;
  let added;
  if (add === false || (add === undefined && exists)) {
    // Remove
    if (exists) { subs.splice(idx, 1); result = save(subs, userId); }
    added = false;
  } else {
    // Add
    if (!exists) {
      if (subs.length >= MAX_SUBS) throw new Error('watchlist full');
      subs.push({ kind, value, label: label || value, added_at: new Date().toISOString() });
      result = save(subs, userId);
    }
    added = true;
  }
  // A watchlist change alters the user interest profile — invalidate the
  // relevance cache so the For-You feed reflects the new subscription on the
  // next poll instead of up to 5min later. Lazy-require to avoid a load-time
  // cycle (relevance.js requires this module at top level).
  try { require('./relevance').invalidateProfile(userId); } catch { /* relevance absent */ }
  return { subs: result, added };
}

/**
 * Aggregate a unified feed of items matching ANY subscription.
 * Entity subs → items mentioning that canonical entity.
 * Type subs   → items with that signal_type.
 * Returns items de-duplicated by id, ranked by alpha desc, capped at limit.
 */
function getFeed({ sinceDays = 7, limit = 100, userId } = {}) {
  const db = getDB();
  if (!db) return [];
  const { subs } = getAll(userId);
  if (!subs.length) return [];

  const since = (() => {
    const d = new Date(); d.setDate(d.getDate() - sinceDays);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  })();

  const seen = new Set();
  const items = [];
  const cap = Math.min(Math.max(1, limit), 500);

  // Entity subscriptions: resolve slug → entity id → items.
  const entitySlugs = subs.filter(s => s.kind === 'entity').map(s => s.value);
  if (entitySlugs.length > 0) {
    const ph = entitySlugs.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT DISTINCT i.id, i.title, i.canonical_url, i.published_at, i.digest_date,
             s.label as source_label, s.slug as source_slug,
             ss.alpha_score, ss.signal_type
      FROM information_items i
      JOIN entity_mentions em ON em.item_id = i.id
      JOIN entity_links el ON el.mention_id = em.id
      JOIN canonical_entities ce ON ce.id = el.entity_id
      JOIN sources s ON i.source_id = s.id
      LEFT JOIN signal_scores ss ON ss.item_id = i.id
      WHERE ce.canonical_slug IN (${ph}) AND i.digest_date >= ?
      ORDER BY COALESCE(ss.alpha_score, 0) DESC
      LIMIT ?
    `).all(...entitySlugs, since, cap);
    for (const r of rows) {
      if (!seen.has(r.id)) { seen.add(r.id); items.push(r); }
    }
  }

  // Type subscriptions: items with that signal_type.
  const types = subs.filter(s => s.kind === 'type').map(s => s.value);
  if (types.length > 0) {
    const ph = types.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT i.id, i.title, i.canonical_url, i.published_at, i.digest_date,
             s.label as source_label, s.slug as source_slug,
             ss.alpha_score, ss.signal_type
      FROM information_items i
      JOIN signal_scores ss ON ss.item_id = i.id
      JOIN sources s ON i.source_id = s.id
      WHERE ss.signal_type IN (${ph}) AND i.digest_date >= ?
      ORDER BY ss.alpha_score DESC
      LIMIT ?
    `).all(...types, since, cap);
    for (const r of rows) {
      if (!seen.has(r.id)) { seen.add(r.id); items.push(r); }
    }
  }

  // Merge-sort by alpha and cap.
  items.sort((a, b) => (b.alpha_score || 0) - (a.alpha_score || 0));
  return items.slice(0, cap);
}

module.exports = { getAll, toggle, getFeed, KEY, MAX_SUBS };
