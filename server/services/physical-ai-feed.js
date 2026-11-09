/** Source-backed and evidence-classified Physical AI briefing. */
const { classifyPhysicalAi, relevantCandidate } = require('./physical-ai-classifier');

const engineeringSources = Object.keys(require('./specialist-sources')).filter(slug => slug.startsWith('physical-ai-'));
const CATEGORY_DEFS = [
  { key: 'engineering', source_slug: null, status_slugs: engineeringSources },
  { key: 'research', source_slug: 'physical-ai-arxiv', status_slugs: ['physical-ai-arxiv'] },
  { key: 'humanoid', source_slug: 'physical-ai-humanoid', status_slugs: ['physical-ai-humanoid'] },
  { key: 'open', source_slug: null, status_slugs: ['physical-ai-open-github', 'physical-ai-open-huggingface', 'github-trending'] },
  { key: 'applications', source_slug: null, status_slugs: ['physical-ai-humanoid', 'techmeme', 'x-following', 'hacker-news'] },
];
const CATEGORY_KEYS = CATEGORY_DEFS.map(def => def.key);
// Preserve access for old URLs and API clients; the retired sources remain in
// the source archive without being misrepresented as new topic categories.
const LEGACY_CATEGORY_SOURCES = {
  photonics: 'physical-ai-cn-photonics',
  filings: 'physical-ai-sec-8k',
};
const LEGACY_CATEGORY_KEYS = Object.keys(LEGACY_CATEGORY_SOURCES);
const DIRECT_SOURCES = [
  ...engineeringSources,
  'physical-ai-arxiv', 'physical-ai-humanoid', 'physical-ai-open-github',
  'physical-ai-open-huggingface', 'github-trending',
];
const SOURCE_SLUGS = [...new Set([...DIRECT_SOURCES, ...Object.values(LEGACY_CATEGORY_SOURCES)])];
const registeredDatabases = new WeakSet();

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function isValidDigestDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function timeScope(opts) {
  if (isValidDigestDate(opts.date)) {
    return { predicate: 'AND i.digest_date IN (?, ?)', params: [opts.date, opts.date.replace(/-/g, '')], index: 'idx_items_digest_date' };
  }
  const days = clampInt(opts.days, 1, 180, 30);
  return { predicate: 'AND i.published_at >= ?', params: [new Date(Date.now() - days * 86400000).toISOString()], index: 'idx_items_published_at' };
}

const NOT_PLACEHOLDER_SQL = "COALESCE(json_extract(CASE WHEN json_valid(i.source_payload) THEN i.source_payload ELSE '{}' END, '$.is_placeholder'), 0) NOT IN (1, 'true')";

function registerFunctions(db) {
  if (registeredDatabases.has(db)) return;
  db.function('physical_ai_candidate', { deterministic: true }, (title, titleZh, summary) => relevantCandidate(title, titleZh, summary) ? 1 : 0);
  db.function('physical_ai_category', { deterministic: true }, (sourceSlug, canonicalUrl, title, titleZh, summary, sourcePayload) => {
    const result = classifyPhysicalAi({ source_slug: sourceSlug, canonical_url: canonicalUrl, title, title_zh: titleZh, original_summary: summary, source_payload: sourcePayload });
    return result?.category || null;
  });
  registeredDatabases.add(db);
}

/**
 * A single item belongs to one category: licensed resource, proven
 * application, research, then robotics news. Rank identical original URLs
 * across sources before counts and pagination so the same story is not shown
 * twice; the strongest category evidence wins and ties are stable.
 */
function classifiedCte(scope) {
  const directParams = DIRECT_SOURCES.map(() => '?').join(', ');
  return `WITH classified AS MATERIALIZED (
    SELECT i.id, i.published_at, i.created_at,
      COALESCE(NULLIF(rtrim(i.canonical_url, '/'), ''), i.id) AS canonical_key,
      physical_ai_category(s.slug, i.canonical_url, i.title, i.title_zh, i.original_summary, i.source_payload) AS category
    FROM information_items i INDEXED BY ${scope.index}
    JOIN sources s ON s.id = i.source_id
    WHERE i.duplicate_of IS NULL ${scope.predicate}
      AND ${NOT_PLACEHOLDER_SQL}
      AND (s.slug IN (${directParams}) OR physical_ai_candidate(i.title, i.title_zh, i.original_summary) = 1)
  ), ranked AS MATERIALIZED (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY canonical_key
      ORDER BY CASE category WHEN 'open' THEN 0 WHEN 'applications' THEN 1 WHEN 'research' THEN 2 ELSE 3 END,
        published_at DESC, created_at DESC, id ASC
    ) AS duplicate_rank
    FROM classified WHERE category IS NOT NULL
  )`;
}

function getPhysicalAiSnapshot(db, opts = {}) {
  registerFunctions(db);
  const scope = timeScope(opts);
  const rows = db.prepare(`${classifiedCte(scope)}
    SELECT category, COUNT(*) AS count FROM ranked WHERE duplicate_rank = 1 GROUP BY category`)
    .all(...scope.params, ...DIRECT_SOURCES);
  const counts = new Map(rows.map(row => [row.category, row.count]));
  const statusSlugs = [...new Set(CATEGORY_DEFS.flatMap(def => def.status_slugs))];
  const statuses = db.prepare(`SELECT slug, is_active FROM sources WHERE slug IN (${statusSlugs.map(() => '?').join(',')})`).all(...statusSlugs);
  const activeMap = new Map(statuses.map(row => [row.slug, row.is_active === 1]));
  const categories = CATEGORY_DEFS.map(def => {
    const known = def.status_slugs.filter(slug => activeMap.has(slug));
    return {
      key: def.key, source_slug: def.source_slug, count: counts.get(def.key) || 0,
      is_active: known.length ? known.some(slug => activeMap.get(slug)) : null,
    };
  });
  return { categories, total: categories.reduce((sum, category) => sum + category.count, 0) };
}

function itemSelect() {
  return `SELECT i.id, i.title, i.title_zh, i.canonical_url, i.published_at, i.digest_date, i.original_summary, i.source_payload,
    s.slug AS source_slug, s.label AS source_label,
    a.ai_title, a.ai_title_zh, a.one_liner, a.one_liner_zh, a.short_summary, a.short_summary_zh`;
}

function itemJoins() {
  return `JOIN information_items i ON i.id = chosen.id
    JOIN sources s ON s.id = i.source_id
    LEFT JOIN ai_summaries a ON a.id = (
      SELECT latest.id FROM ai_summaries latest WHERE latest.item_id = i.id
      ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)`;
}

function formatItem(row) {
  const classification = classifyPhysicalAi(row) || {};
  return {
    id: row.id, category: row.category, source_slug: row.source_slug, source_label: row.source_label,
    title: row.title, title_zh: row.title_zh || '', canonical_url: row.canonical_url,
    published_at: row.published_at, digest_date: row.digest_date,
    ai_title: row.ai_title || '', ai_title_zh: row.ai_title_zh || '',
    one_liner: row.one_liner || '', one_liner_zh: row.one_liner_zh || '',
    short_summary: row.short_summary || '', short_summary_zh: row.short_summary_zh || '',
    original_summary: (row.original_summary || '').slice(0, 400),
    ...(classification.resource_url ? { resource_url: classification.resource_url } : {}),
    ...(classification.resource_license ? { resource_license: classification.resource_license } : {}),
    ...(classification.application_stage ? { application_stage: classification.application_stage } : {}),
  };
}

function getPhysicalAiItems(db, opts = {}) {
  registerFunctions(db);
  const scope = timeScope(opts);
  const limit = clampInt(opts.limit, 1, 120, 50);
  const offset = clampInt(opts.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  if (LEGACY_CATEGORY_SOURCES[opts.category]) return getLegacyItems(db, opts, scope, limit, offset);
  const category = CATEGORY_KEYS.includes(opts.category) ? opts.category : null;
  const rows = db.prepare(`${classifiedCte(scope)}, chosen AS MATERIALIZED (
    SELECT id, category, published_at, created_at FROM ranked
    WHERE duplicate_rank = 1 ${category ? 'AND category = ?' : ''}
    ORDER BY published_at DESC, created_at DESC, id ASC LIMIT ? OFFSET ?
  )
  ${itemSelect()}, chosen.category FROM chosen ${itemJoins()}
  ORDER BY chosen.published_at DESC, chosen.created_at DESC, chosen.id ASC`)
    .all(...scope.params, ...DIRECT_SOURCES, ...(category ? [category] : []), limit, offset);
  return rows.map(formatItem);
}

function getLegacyItems(db, opts, scope, limit, offset) {
  const source = LEGACY_CATEGORY_SOURCES[opts.category];
  const rows = db.prepare(`WITH chosen AS MATERIALIZED (
    SELECT i.id, i.published_at, i.created_at FROM information_items i INDEXED BY ${scope.index}
    JOIN sources s ON s.id = i.source_id
    WHERE i.duplicate_of IS NULL ${scope.predicate} AND s.slug = ? AND ${NOT_PLACEHOLDER_SQL}
    ORDER BY i.published_at DESC, i.created_at DESC, i.id ASC LIMIT ? OFFSET ?
  ) ${itemSelect()} FROM chosen ${itemJoins()}
  ORDER BY chosen.published_at DESC, chosen.created_at DESC, chosen.id ASC`)
    .all(...scope.params, source, limit, offset);
  return rows.map(row => formatItem({ ...row, category: opts.category }));
}

function getLegacySnapshot(db, opts = {}) {
  const source = LEGACY_CATEGORY_SOURCES[opts.category];
  if (!source) return null;
  const scope = timeScope(opts);
  const row = db.prepare(`SELECT COUNT(*) AS count FROM information_items i INDEXED BY ${scope.index}
    JOIN sources s ON s.id = i.source_id WHERE i.duplicate_of IS NULL ${scope.predicate}
      AND s.slug = ? AND ${NOT_PLACEHOLDER_SQL}`).get(...scope.params, source);
  const status = db.prepare('SELECT is_active FROM sources WHERE slug = ?').get(source);
  return { key: opts.category, source_slug: source, count: row.count, is_active: status ? status.is_active === 1 : null };
}

module.exports = { getPhysicalAiSnapshot, getPhysicalAiItems, getLegacySnapshot, CATEGORY_DEFS, CATEGORY_KEYS, LEGACY_CATEGORY_KEYS, SOURCE_SLUGS, isValidDigestDate, clampInt };
