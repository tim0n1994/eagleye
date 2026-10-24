const fs = require('fs');
const { getDBPath } = require('../config');
const { normalizeDigestDate, todayDigestDate } = require('./date-contract');

function dateState(date, total, now) {
  if (!total) return { status: 'empty', age_days: null };
  const iso = normalizeDigestDate(typeof date === 'string' ? date : '');
  const timestamp = iso ? Date.parse(`${iso}T00:00:00Z`) : NaN;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== iso) return { status: 'unknown', age_days: null };
  const today = Date.parse(`${todayDigestDate(now)}T00:00:00Z`);
  const age = Math.round((today - timestamp) / 86400000);
  return { status: age < 0 ? 'unknown' : age > 0 ? 'stale' : 'current', age_days: age < 0 ? null : age };
}

function getSystemStats(db, { now = new Date(), dbPath = getDBPath() } = {}) {
  // Existence alone is insufficient: imports may leave empty or duplicate rows.
  // A current item succeeds if any attached row contains actual summary text.
  const stats = db.prepare(`
    WITH summary_items AS (
      SELECT item_id, MAX(CASE WHEN translation_status = 'translated' THEN 1 ELSE 0 END) AS translated
      FROM ai_summaries
      WHERE LENGTH(TRIM(COALESCE(short_summary, '') || COALESCE(short_summary_zh, '') ||
        COALESCE(one_liner, '') || COALESCE(one_liner_zh, '') || COALESCE(deep_summary, ''), char(9) || char(10) || char(13) || ' ')) > 0
      GROUP BY item_id
    )
    SELECT COUNT(*) AS total_items,
      COUNT(a.item_id) AS summaries,
      COALESCE(SUM(CASE WHEN a.item_id IS NULL AND COALESCE(i.enrichment_attempts, 0) < 3 THEN 1 ELSE 0 END), 0) AS enrichment_backlog,
      COALESCE(SUM(CASE WHEN a.item_id IS NULL AND COALESCE(i.enrichment_attempts, 0) >= 3 THEN 1 ELSE 0 END), 0) AS poisoned_items,
      COALESCE(SUM(CASE WHEN a.item_id IS NOT NULL AND a.translated = 0 THEN 1 ELSE 0 END), 0) AS translation_backlog,
      MAX(NULLIF(i.digest_date, '')) AS latest_digest_date,
      MAX(strftime('%Y-%m-%dT%H:%M:%fZ', i.fetched_at)) AS latest_item_fetched_at
    FROM information_items i LEFT JOIN summary_items a ON a.item_id = i.id
    WHERE i.duplicate_of IS NULL
  `).get();
  Object.assign(stats, db.prepare(`SELECT
    (SELECT COUNT(*) FROM ai_summaries) AS summary_rows,
    (SELECT COUNT(DISTINCT ss.item_id) FROM signal_scores ss JOIN information_items i ON i.id = ss.item_id WHERE i.duplicate_of IS NULL) AS scored,
    (SELECT COUNT(DISTINCT ss.item_id) FROM signal_scores ss JOIN information_items i ON i.id = ss.item_id WHERE i.duplicate_of IS NULL AND ss.signal_type = 'uncategorized') AS uncategorized,
    (SELECT COUNT(*) FROM research_reports WHERE status = 'completed') AS research_reports,
    (SELECT COUNT(*) FROM saved_items) AS saved_items,
    (SELECT COUNT(*) FROM seen_items) AS seen_items,
    (SELECT COUNT(*) FROM canonical_entities) AS entities,
    (SELECT COUNT(*) FROM dynamic_topics) AS dynamic_topics,
    (SELECT COUNT(DISTINCT f.item_id) FROM item_features f JOIN information_items i ON i.id = f.item_id WHERE i.duplicate_of IS NULL) AS kg_features,
    (SELECT COUNT(DISTINCT v.item_id) FROM item_vectors v JOIN information_items i ON i.id = v.item_id WHERE i.duplicate_of IS NULL) AS vector_items
  `).get());
  stats.enrichment_success = stats.summaries;
  stats.enrichment_exhausted = stats.poisoned_items;
  stats.enrichment_coverage = stats.total_items ? stats.summaries / stats.total_items : null;
  stats.kg_feature_coverage = stats.total_items ? stats.kg_features / stats.total_items : null;
  stats.vector_models = db.prepare(`SELECT v.vector_type, v.model_name, COUNT(DISTINCT v.item_id) AS items
    FROM item_vectors v JOIN information_items i ON i.id = v.item_id
    WHERE i.duplicate_of IS NULL
    GROUP BY v.vector_type, v.model_name ORDER BY items DESC, v.model_name`).all().map(row => ({
    ...row,
    kind: /hash/i.test(`${row.vector_type} ${row.model_name}`) ? 'hash' : ['semantic', 'semantic-fastembed'].includes(row.vector_type) ? 'semantic' : 'unknown',
    coverage: stats.total_items ? row.items / stats.total_items : null,
  }));
  stats.server_now = now.toISOString();
  stats.server_date = todayDigestDate(now);
  stats.data_freshness = dateState(stats.latest_digest_date, stats.total_items, now);
  try { stats.db_size_mb = Math.round(fs.statSync(dbPath).size / 1048576); }
  catch { stats.db_size_mb = null; }
  const since7Date = new Date(now);
  since7Date.setDate(since7Date.getDate() - 6);
  const since = todayDigestDate(since7Date);
  stats.connectors = db.prepare(`SELECT s.slug, s.label, s.last_fetched_at,
      COUNT(i.id) AS total_items,
      COALESCE(SUM(CASE WHEN i.digest_date BETWEEN ? AND ? THEN 1 ELSE 0 END), 0) AS items_7d,
      MAX(NULLIF(i.digest_date, '')) AS latest_digest_date,
      MAX(strftime('%Y-%m-%dT%H:%M:%fZ', i.fetched_at)) AS latest_item_fetched_at
    FROM sources s LEFT JOIN information_items i ON i.source_id = s.id AND i.duplicate_of IS NULL
    WHERE s.is_active = 1 GROUP BY s.id ORDER BY items_7d DESC, s.slug`).all(since, stats.server_date)
    .map(row => ({ ...row, data_freshness: dateState(row.latest_digest_date, row.total_items, now) }));
  const job = db.prepare(`SELECT id, status, created_at, completed_at, error, result FROM background_jobs
    WHERE job_type = 'full-pipeline' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get();
  stats.last_pipeline = null;
  if (job) {
    let result = null;
    try { result = JSON.parse(job.result); } catch { /* Legacy progress may be plain text. */ }
    const stages = Array.isArray(result?.stages) ? result.stages : [];
    const failed = stages.filter(stage => stage.status === 'failed');
    stats.last_pipeline = {
      id: job.id, stored_status: job.status,
      status: job.status === 'completed' && failed.length ? 'failed' : job.status,
      created_at: job.created_at, completed_at: job.completed_at, error: job.error,
      stages_known: Array.isArray(result?.stages),
      failed_stages: failed.map(stage => ({ key: stage.key, error: stage.error || stage.detail?.error || null })),
    };
  }
  return stats;
}

module.exports = { getSystemStats, dateState };
