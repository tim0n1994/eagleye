'use strict';

/**
 * Eagleye — Cross-source Story Clustering (PRD-3)
 *
 * The same event arrives from several sources (arXiv + HuggingFace, HN + X +
 * Reddit, …) as separate items, diluting velocity/cross_source and cluttering
 * the feed. This collapses near-duplicate coverage into "stories".
 *
 * Approach — light & robust (no embeddings required):
 *   1. Normalise each item's URL (strip query, fragment, trailing slash, www,
 *      lower-case host) so the same article seen via two feeds keys together.
 *   2. Title shingles (word bigrams) give a content fingerprint for items that
 *      describe the SAME event under DIFFERENT urls (a launch tweet vs the HN
 *      thread). Two items join a cluster when they share either the normalised
 *      URL OR ≥40% title-shingle overlap (Jaccard).
 *   3. Single-link union-find merges transitively, then clusters are ranked by
 *      size (multi-source stories first) then by best alpha.
 *
 * This runs at QUERY TIME over a date window (no new tables, no migration) so
 * it's safe to ship now. When real-embedding coverage rises (B5 roadmap item)
 * the shingle step is the seam to swap for cosine similarity.
 */

const { getDB } = require('../db/connection');
const { normalizeDigestDate, todayDigestDate } = require('./date-contract');

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'are',
  'with', 'via', 'this', 'that', 'it', 'as', 'by', 'at', 'be', 'from', 'you',
  'i', 'we', 'they', 'he', 'she', 'his', 'her', 'their', 'its', 'but', 'not',
  '的', '了', '在', '是', '和', '与', '为', '从', '让', '被', '把', '它', '他', '她',
]);

/**
 * Normalise a URL to a canonical key for dedup. Returns '' for unusable URLs.
 * Keeps the path (often distinguishes real articles) but strips tracking noise.
 */
function normaliseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const u = new URL(rawUrl);
    let host = u.hostname.toLowerCase().replace(/^www\./, '');
    // Collapse mobile/news prefixes that don't change identity.
    host = host.replace(/^(m|mobile|news)\./, '');
    let path = u.pathname.replace(/\/+$/, ''); // drop trailing slash
    // Drop version suffixes on arxiv (v1/v2 of the same paper = same story).
    path = path.replace(/(v\d+)$/, '');
    return `${host}${path}`;
  } catch {
    return '';
  }
}

/**
 * Build a set of word bigrams ("shingles") from a title, lower-cased and
 * stop-word-filtered. Used as a cheap content fingerprint for same-event /
 * different-URL items.
 */
function titleShingles(title) {
  if (!title) return new Set();
  // Split on non-alphanumeric (works for both Latin and CJK runs).
  const words = String(title).toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter(w => w && w.length > 1 && !STOPWORDS.has(w));
  if (words.length < 2) return new Set(words);
  const sh = new Set();
  for (let i = 0; i < words.length - 1; i++) sh.add(words[i] + ' ' + words[i + 1]);
  return sh;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  // Iterate the smaller set for speed.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Union-find over item indices for single-link clustering.
 */
function makeUnionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  return { find, union };
}

/**
 * Cluster items that describe the same story across sources.
 *
 * @param {object[]} items  rows with {id, canonical_url, title, source_id, source_slug, source_label, alpha_score, signal_type}
 * @returns {object[]} clusters, each {key, representative, items[], sources: string[], count, best_alpha, signal_type}
 */
function clusterItems(items) {
  if (!items?.length) return [];
  const n = items.length;
  const normUrls = items.map(it => normaliseUrl(it.canonical_url));
  const shingles = items.map(it => titleShingles(it.title));
  const uf = makeUnionFind(n);

  // O(n²) pairwise — fine for a day window (~hundreds of items). For wider
  // windows the call site should pre-filter by source/date to bound this.
  const SIM_THRESHOLD = 0.4;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Fast path: same normalised URL → same story.
      if (normUrls[i] && normUrls[i] === normUrls[j]) { uf.union(i, j); continue; }
      // Same source + same URL-ish is already handled. Skip same-source pairs
      // for the title path: two tweets from the same feed rarely mean "one
      // cross-source story", and it avoids collapsing a chatty account.
      if (items[i].source_id === items[j].source_id) continue;
      const sim = jaccard(shingles[i], shingles[j]);
      if (sim >= SIM_THRESHOLD) uf.union(i, j);
    }
  }

  // Group by root.
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(items[i]);
  }

  const clusters = [];
  for (const [, members] of groups) {
    const sources = [...new Set(members.map(m => m.source_slug || m.source_label || m.source_id).filter(Boolean))];
    const bestAlpha = members.reduce((b, m) => Math.max(b, m.alpha_score || 0), 0);
    // Representative = highest-alpha member.
    const rep = [...members].sort((a, b) => (b.alpha_score || 0) - (a.alpha_score || 0))[0];
    clusters.push({
      key: rep.id, // stable key = representative item id
      representative: rep,
      items: members,
      sources,
      count: members.length,
      cross_source: sources.length > 1,
      best_alpha: bestAlpha,
      signal_type: rep.signal_type || null,
    });
  }

  // Rank: cross-source stories first (the value is in de-duplicating coverage),
  // then by member count, then by best alpha.
  clusters.sort((a, b) => {
    if (a.cross_source !== b.cross_source) return a.cross_source ? -1 : 1;
    if (b.count !== a.count) return b.count - a.count;
    return b.best_alpha - a.best_alpha;
  });
  return clusters;
}

/**
 * Fetch items for a date window and return clustered stories.
 * Pure SELECT — no writes. Returns only clusters with count > 1 OR a
 * cross-source flag (singletons are dropped: they're just normal items).
 */
function getStories({ date = '', sinceDays = 7, limit = 100 } = {}) {
  const db = getDB();
  if (!db) return [];

  let dateFilter = '';
  const params = [];
  if (date) {
    const digestDate = normalizeDigestDate(date);
    if (!digestDate) return [];
    dateFilter = 'WHERE i.digest_date = ?';
    params.push(digestDate);
  } else if (sinceDays > 0) {
    const since = (() => {
      const d = new Date(); d.setDate(d.getDate() - sinceDays);
      return todayDigestDate(d);
    })();
    dateFilter = 'WHERE i.digest_date >= ?';
    params.push(since);
  }

  const items = db.prepare(`
    SELECT i.id, i.canonical_url, i.title, i.source_id, s.slug as source_slug, s.label as source_label,
           i.digest_date, i.published_at,
           ss.alpha_score, ss.signal_type
    FROM information_items i
    JOIN sources s ON i.source_id = s.id
    LEFT JOIN signal_scores ss ON ss.item_id = i.id
    ${dateFilter}
    ORDER BY i.digest_date DESC, COALESCE(ss.alpha_score, 0) DESC
  `).all(...params);

  const clusters = clusterItems(items);
  // Only return "stories" worth telling: multi-item clusters. Singletons are
  // identical to a plain feed row, so we omit them to keep the response focused.
  const stories = clusters.filter(c => c.count > 1).slice(0, limit);
  return stories;
}

/**
 * Build a itemId → cluster lookup for a date window, so item cards can show a
 * "+N sources" badge when they belong to a cross-source story (§16 dedup UX).
 * Returns a Map: itemId → { count, sources, member_ids }.
 * Cached per (window-key) for 2 minutes to avoid re-clustering on every page.
 */
let _clusterMapCache = null;
let _clusterMapKey = '';
const CLUSTER_MAP_TTL_MS = 2 * 60 * 1000;
let _clusterMapAt = 0;

function getItemClusterMap({ date = '', sinceDays = 1 } = {}) {
  const now = Date.now();
  const key = `${date || ''}:${sinceDays}`;
  if (_clusterMapCache && key === _clusterMapKey && (now - _clusterMapAt) < CLUSTER_MAP_TTL_MS) {
    return _clusterMapCache;
  }
  const stories = getStories({ date, sinceDays, limit: 500 });
  const map = new Map();
  for (const s of stories) {
    if (s.count < 2) continue;
    const memberIds = s.items.map(it => it.id);
    for (const it of s.items) {
      map.set(it.id, {
        count: s.count,
        cross_source: s.cross_source,
        sources: s.sources,
        member_ids: memberIds.filter(id => id !== it.id),
      });
    }
  }
  _clusterMapCache = map;
  _clusterMapKey = key;
  _clusterMapAt = now;
  return map;
}

module.exports = { getStories, getItemClusterMap, clusterItems, normaliseUrl, titleShingles, jaccard };
