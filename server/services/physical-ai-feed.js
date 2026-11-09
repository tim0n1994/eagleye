/**
 * Eagleye — Physical AI feed
 *
 * Read-only backing for GET /api/physical-ai: a de-duplicated, placeholder-free
 * briefing over the four Physical AI sources (arXiv research, humanoid news,
 * CN photonics, SEC 8-K filings). Two mutually exclusive scopes:
 *   - days window (default 30, clamped 1..180) on the indexed published_at;
 *   - date=YYYY-MM-DD snapshot on digest_date, matching canonical and legacy
 *     compact forms; date wins when both are given.
 *
 * Disabled sources keep their historical items visible and counted —
 * is_active reflects the current collection status only. A slug with no
 * sources record reports is_active null (unknown), never a false "disabled".
 *
 * Efficiency: counts come from one GROUP BY over the window (independent of
 * category and pagination, so callers can cache it per scope), and items use
 * an index-ordered LIMIT/OFFSET walk — the full window is never materialized.
 * Real corpora hold several ai_summaries rows per item, so each item joins
 * exactly its latest summary via a correlated subquery on idx_summaries_item_id;
 * without that, duplicated summaries inflate pages and break count/pagination
 * consistency. INDEXED BY hints keep the planner on the date indexes instead
 * of the low-selectivity duplicate_of index (same rationale as education-feed.js).
 */

const CATEGORY_DEFS = [
  { key: 'research', source_slug: 'physical-ai-arxiv' },
  { key: 'humanoid', source_slug: 'physical-ai-humanoid' },
  { key: 'photonics', source_slug: 'physical-ai-cn-photonics' },
  { key: 'filings', source_slug: 'physical-ai-sec-8k' },
];
const CATEGORY_KEYS = CATEGORY_DEFS.map((def) => def.key);
const SOURCE_SLUGS = CATEGORY_DEFS.map((def) => def.source_slug);

const CANONICAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Strict YYYY-MM-DD calendar validation: rejects 2026-13-01 and 2026-02-30.
function isValidDigestDate(value) {
  if (typeof value !== 'string' || !CANONICAL_DATE_RE.test(value)) return false;
  const ts = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(ts) && new Date(ts).toISOString().slice(0, 10) === value;
}

function compactDigestDate(value) {
  return value.replace(/-/g, '');
}

// Some collectors wrote company watchlist placeholders as items, and corrupt
// payloads exist in the wild. Same JSON-safe predicate as routes/items.js:
// invalid JSON parses as '{}' (row kept), 1/'true' placeholders are dropped.
const NOT_PLACEHOLDER_SQL =
  "COALESCE(json_extract(CASE WHEN json_valid(i.source_payload) THEN i.source_payload ELSE '{}' END, '$.is_placeholder'), 0) NOT IN (1, 'true')";

function timeScope(opts) {
  if (isValidDigestDate(opts.date)) {
    return {
      predicate: 'AND i.digest_date IN (?, ?)',
      params: [opts.date, compactDigestDate(opts.date)],
      index: 'idx_items_digest_date',
    };
  }
  const days = clampInt(opts.days, 1, 180, 30);
  return {
    predicate: 'AND i.published_at >= ?',
    params: [new Date(Date.now() - days * 86400000).toISOString()],
    index: 'idx_items_published_at',
  };
}

/**
 * Per-category counts and totals for one scope. Counts cover ALL categories
 * and are unaffected by the category filter and pagination. Disabled sources
 * keep their real historical counts; is_active only reports current status.
 */
function getPhysicalAiSnapshot(db, opts = {}) {
  const scope = timeScope(opts);
  const slugParams = SOURCE_SLUGS.map(() => '?').join(', ');
  const counts = db.prepare([
    'SELECT s.slug, COUNT(*) AS count',
    '  FROM information_items i INDEXED BY ' + scope.index,
    '  JOIN sources s ON s.id = i.source_id',
    ' WHERE i.duplicate_of IS NULL',
    '   AND s.slug IN (' + slugParams + ')',
    '   ' + scope.predicate,
    '   AND ' + NOT_PLACEHOLDER_SQL,
    ' GROUP BY s.slug',
  ].join('\n')).all(...SOURCE_SLUGS, ...scope.params);
  const activeRows = db.prepare('SELECT slug, is_active FROM sources WHERE slug IN (' + slugParams + ')')
    .all(...SOURCE_SLUGS);
  const activeMap = new Map(activeRows.map((row) => [row.slug, row.is_active === 1]));
  const countBySlug = new Map(counts.map((row) => [row.slug, row.count]));
  const categories = CATEGORY_DEFS.map((def) => {
    const hasRecord = activeMap.has(def.source_slug);
    return {
      key: def.key,
      source_slug: def.source_slug,
      count: countBySlug.get(def.source_slug) || 0,
      // null = no sources record: collection status unknown, never "disabled".
      is_active: hasRecord ? activeMap.get(def.source_slug) : null,
    };
  });
  return { categories, total: categories.reduce((sum, category) => sum + category.count, 0) };
}

/**
 * One page of items for a scope, newest published_at first (NULL dates last —
 * SQLite sorts them after every value in DESC order), with stable created_at
 * and id tie-breakers so pagination cannot reshuffle rows. Items with several
 * ai_summaries rows appear exactly once, carrying the latest summary
 * (created_at DESC, id DESC — created_at has second precision, so id breaks
 * same-second ties).
 */
function getPhysicalAiItems(db, opts = {}) {
  const scope = timeScope(opts);
  const limit = clampInt(opts.limit, 1, 120, 50);
  const offset = clampInt(opts.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const categoryDef = CATEGORY_DEFS.find((def) => def.key === opts.category);
  const slugParams = SOURCE_SLUGS.map(() => '?').join(', ');
  const rows = db.prepare([
    'SELECT i.id, i.title, i.title_zh, i.canonical_url, i.published_at, i.digest_date, i.original_summary,',
    '       s.slug AS source_slug, s.label AS source_label,',
    '       a.ai_title, a.ai_title_zh, a.one_liner, a.one_liner_zh, a.short_summary, a.short_summary_zh',
    '  FROM information_items i INDEXED BY ' + scope.index,
    '  JOIN sources s ON s.id = i.source_id',
    '  LEFT JOIN ai_summaries a ON a.id = (',
    '    SELECT latest.id FROM ai_summaries latest',
    '     WHERE latest.item_id = i.id',
    '     ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)',
    ' WHERE i.duplicate_of IS NULL',
    '   AND s.slug IN (' + slugParams + ')',
    '   ' + scope.predicate,
    '   AND ' + NOT_PLACEHOLDER_SQL,
    categoryDef ? '   AND s.slug = ?' : '',
    ' ORDER BY i.published_at DESC, i.created_at DESC, i.id ASC',
    ' LIMIT ? OFFSET ?',
  ].filter(Boolean).join('\n')).all(...SOURCE_SLUGS, ...scope.params,
    ...(categoryDef ? [categoryDef.source_slug] : []), limit, offset);
  const categoryBySlug = new Map(CATEGORY_DEFS.map((def) => [def.source_slug, def.key]));
  return rows.map((row) => ({
    id: row.id,
    category: categoryBySlug.get(row.source_slug),
    source_slug: row.source_slug,
    source_label: row.source_label,
    title: row.title,
    title_zh: row.title_zh || '',
    canonical_url: row.canonical_url,
    published_at: row.published_at,
    digest_date: row.digest_date,
    ai_title: row.ai_title || '',
    ai_title_zh: row.ai_title_zh || '',
    one_liner: row.one_liner || '',
    one_liner_zh: row.one_liner_zh || '',
    short_summary: row.short_summary || '',
    short_summary_zh: row.short_summary_zh || '',
    original_summary: (row.original_summary || '').slice(0, 400),
  }));
}

module.exports = {
  getPhysicalAiSnapshot,
  getPhysicalAiItems,
  CATEGORY_DEFS,
  CATEGORY_KEYS,
  SOURCE_SLUGS,
  isValidDigestDate,
  clampInt,
};
