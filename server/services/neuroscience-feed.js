/** Bounded, source-backed neuroscience briefing. No network or model calls. */
const catalog = require('./specialist-sources');
const SOURCES = {
  'neuroscience-arxiv': { category: 'research', kind: 'preprint' },
  ...Object.fromEntries(Object.entries(catalog).filter(([slug]) => slug.startsWith('neuroscience-'))),
};
const CATEGORY_KEYS = ['research', 'bci', 'tools', 'community'];
const PER_SOURCE_CAP = 400;
const BCI = /brain[ -](?:computer|machine) interface|\b(?:BCI|EEG|MEG|electroencephalograph\w*|neuroprosthe\w*)\b|脑机接口|脑电|神经假体/i;

function getNeuroscienceFeed(db, days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const slugs = Object.keys(SOURCES);
  const sources = db.prepare(`SELECT slug, id, label, description, homepage_url,
    is_active, health_status, last_attempt_at, last_success_at, last_error_class, consecutive_empty
    FROM sources WHERE slug IN (${slugs.map(() => '?').join(',')}) ORDER BY label`).all(...slugs);
  const read = db.prepare(`SELECT id, title, title_zh, canonical_url AS url,
    original_summary, published_at, digest_date
    FROM information_items INDEXED BY idx_items_source_published
    WHERE source_id = ? AND published_at >= ? AND duplicate_of IS NULL
    ORDER BY published_at DESC LIMIT ?`);
  const items = [];
  let truncated = false;
  // Read all item lists in one SQLite snapshot.
  db.transaction(() => {
    for (const source of sources) {
      const meta = SOURCES[source.slug];
      const rows = read.all(source.id, cutoff, PER_SOURCE_CAP + 1);
      if (rows.length > PER_SOURCE_CAP) truncated = true;
      for (const row of rows.slice(0, PER_SOURCE_CAP)) {
        items.push({ ...row, source_slug: source.slug, source_label: source.label,
          evidence_kind: meta.kind,
          category: meta.category === 'research' && BCI.test(row.title) ? 'bci' : meta.category });
      }
    }
  })();
  items.sort((a, b) => b.published_at.localeCompare(a.published_at) || a.id.localeCompare(b.id));
  const seen = new Set();
  const allItems = items.filter(item => {
    const key = (item.url || item.id).replace(/\/$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { allItems, sources: sources.map(({ id, ...source }) => source),
    stats: { window_days: days, truncated, scanned: items.length },
    recommended_accounts: [{ label: 'Allen Institute', url: 'https://x.com/AllenInstitute',
      description: '神经科学与脑图谱研究动态', ingestion: 'link_only' }] };
}
module.exports = { getNeuroscienceFeed, CATEGORY_KEYS, SOURCES };
