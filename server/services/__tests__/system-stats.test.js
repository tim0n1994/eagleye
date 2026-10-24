/* global describe, it, expect, beforeEach, afterEach */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { getSystemStats, dateState } = require('../system-stats');
let db;
const now = new Date('2026-09-08T10:00:00Z');
const read = () => getSystemStats(db, { now, dbPath: ':memory:' });

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE information_items (id TEXT PRIMARY KEY, source_id TEXT, enrichment_attempts INTEGER, digest_date TEXT, fetched_at TEXT);
    CREATE TABLE ai_summaries (item_id TEXT, short_summary TEXT, short_summary_zh TEXT, one_liner TEXT, one_liner_zh TEXT, deep_summary TEXT, translation_status TEXT);
    CREATE TABLE sources (id TEXT, slug TEXT, label TEXT, is_active INTEGER, last_fetched_at TEXT);
    CREATE TABLE signal_scores (item_id TEXT, signal_type TEXT);
    CREATE TABLE research_reports (status TEXT);
    CREATE TABLE saved_items (id TEXT);
    CREATE TABLE seen_items (id TEXT);
    CREATE TABLE canonical_entities (id TEXT);
    CREATE TABLE dynamic_topics (id TEXT);
    CREATE TABLE item_features (item_id TEXT);
    CREATE TABLE item_vectors (item_id TEXT, vector_type TEXT, model_name TEXT);
    ALTER TABLE information_items ADD COLUMN duplicate_of TEXT; -- R3.0: 生产由新迁移提供
    CREATE TABLE background_jobs (id TEXT, job_type TEXT, status TEXT, result TEXT, created_at TEXT, completed_at TEXT, error TEXT);
    INSERT INTO sources VALUES ('s', 'source', 'Source', 1, '2026-09-08T09:00:00Z');
  `);
});
afterEach(() => db.close());

describe('system stats read model', () => {
  it('partitions 100 current items into 30 successful, 10 retryable, 60 exhausted', () => {
    const insert = db.prepare(`INSERT INTO information_items (id, source_id, enrichment_attempts, digest_date, fetched_at) VALUES (?, 's', ?, '2026-08-01', '2026-08-01 12:00:00')`);
    for (let i = 0; i < 100; i++) insert.run(String(i), i < 30 || i >= 40 ? 3 : null);
    const summary = db.prepare('INSERT INTO ai_summaries (item_id, short_summary, translation_status) VALUES (?, ?, ?)');
    for (let i = 0; i < 30; i++) summary.run(String(i), 'Useful summary', i < 20 ? 'translated' : null);
    summary.run('0', 'Duplicate', 'translated');
    summary.run('0', '', null);
    summary.run('30', ' \n\t ', null);
    summary.run(null, 'Orphan', null);
    summary.run('deleted', 'Deleted item', null);
    const stats = read();
    expect(stats).toMatchObject({ total_items: 100, summaries: 30, summary_rows: 35, enrichment_backlog: 10,
      poisoned_items: 60, enrichment_success: 30, enrichment_exhausted: 60, enrichment_coverage: 0.3, translation_backlog: 10,
      latest_digest_date: '2026-08-01', latest_item_fetched_at: '2026-08-01T12:00:00.000Z', server_date: '2026-09-08',
      data_freshness: { status: 'stale', age_days: 38 } });
    expect(stats.summaries + stats.enrichment_backlog + stats.poisoned_items).toBe(stats.total_items);
    expect(stats.connectors[0]).toMatchObject({ items_7d: 0, data_freshness: { status: 'stale', age_days: 38 } });
  });

  it('reports empty and unknown without inventing full coverage', () => {
    expect(read()).toMatchObject({ total_items: 0, summaries: 0, enrichment_backlog: 0, poisoned_items: 0,
      enrichment_coverage: null, data_freshness: { status: 'empty', age_days: null }, last_pipeline: null });
    expect(dateState('20260230', 1, now)).toEqual({ status: 'unknown', age_days: null });
    expect(dateState(null, 1, now)).toEqual({ status: 'unknown', age_days: null });
    expect(dateState('20260909', 1, now)).toEqual({ status: 'unknown', age_days: null });
    expect(dateState('20260908', 1, now)).toEqual({ status: 'current', age_days: 0 });
  });

  it('deduplicates KG items and exposes hash and semantic coverage separately', () => {
    db.exec(`INSERT INTO information_items (id, source_id, enrichment_attempts, digest_date, fetched_at) VALUES ('i', 's', 0, '20260908', '2026-09-08T09:00:00Z');
      INSERT INTO item_features VALUES ('i'), ('deleted');
      INSERT INTO item_vectors VALUES ('i', 'semantic-hash', 'eagleye-hash-v1'), ('i', 'semantic-fastembed', 'BAAI/bge-small-en-v1.5'), ('deleted', 'semantic', 'other');`);
    const stats = read();
    expect(stats.kg_features).toBe(1);
    expect(stats.vector_items).toBe(1);
    expect(stats.vector_models).toHaveLength(2);
    expect(stats.vector_models.map(v => v.kind).sort()).toEqual(['hash', 'semantic']);
    expect(stats.vector_models.every(v => v.items === 1 && v.coverage === 1)).toBe(true);
  });

  it('compares mixed timestamp representations as dates', () => {
    db.exec(`INSERT INTO information_items (id, source_id, enrichment_attempts, digest_date, fetched_at) VALUES ('early', 's', 0, '20260908', '2026-09-08T09:00:00Z'),
      ('late', 's', 0, '20260908', '2026-09-08 10:00:00');`);
    expect(read().latest_item_fetched_at).toBe('2026-09-08T10:00:00.000Z');
    expect(read().connectors[0].latest_item_fetched_at).toBe('2026-09-08T10:00:00.000Z');
  });

  it('exposes failed stages even on legacy completed pipeline rows', () => {
    db.prepare(`INSERT INTO background_jobs VALUES ('job', 'full-pipeline', 'completed', ?, '2026-09-08', NULL, NULL)`)
      .run(JSON.stringify({ stages: [{ key: 'kg', status: 'failed', error: 'Worker failed' }] }));
    expect(read().last_pipeline).toMatchObject({ status: 'failed', stored_status: 'completed',
      failed_stages: [{ key: 'kg', error: 'Worker failed' }], stages_known: true });
    db.exec(`UPDATE background_jobs SET result = 'legacy text'`);
    expect(read().last_pipeline.stages_known).toBe(false);
  });

  it('keeps read results identical with idempotent covering indexes', () => {
    db.exec(`INSERT INTO information_items (id, source_id, enrichment_attempts, digest_date, fetched_at) VALUES ('i', 's', 3, '20260908', '2026-09-08');
      INSERT INTO ai_summaries (item_id, short_summary) VALUES ('i', 'Useful summary'), ('i', '');`);
    const before = read();
    const migration = fs.readFileSync(path.join(__dirname, '../../migrations/029_system_stats_indexes.sql'), 'utf8');
    db.exec(migration);
    db.exec(migration);
    const queries = [];
    const instrumented = { prepare: sql => { queries.push(sql); return db.prepare(sql); } };
    expect(getSystemStats(instrumented, { now, dbPath: ':memory:' })).toEqual(before);
    const core = queries[0];
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + core).all().map(row => row.detail).join(' ');
    expect(plan).toContain('idx_summaries_valid_items');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_items_quality_metadata'").get()).toBeDefined();
  });
});
