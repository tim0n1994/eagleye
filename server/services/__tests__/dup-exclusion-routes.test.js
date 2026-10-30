// @vitest-environment node

import { beforeEach, afterEach, describe, expect, it } from 'vitest';

/**
 * R3.0 跨天重复治理 — RED 规格: digest / 搜索 / 计数默认排除 dup 行。
 *
 * 背景（2026-10-21, worktree round3-convergence @ 1b8bc3f）: 全库 65,916
 * 行中 32,446 行是（绝大多数跨天的）重复行 — UNIQUE(source_id,
 * canonical_url, digest_date) 允许同 URL 每天重插。方案 = information_items
 * 新增 duplicate_of TEXT NULL 软标记（回填后 dup 行指向组内首行 id），
 * 面向用户的读路径默认不再展示/统计重复行。物理清理放 R5 retention。
 *
 * 本文件钉的契约（默认排除 = 查询里加 duplicate_of IS NULL，不引入开关）:
 *
 *   1. GET /api/digest?date=...  （server/routes/digest.js）
 *      某日的 items 列表与 total 不含该日 dup 行。
 *   2. GET /api/digest/coverage  （server/routes/digest.js）
 *      逐日计数不含 dup 行。
 *   3. GET /api/search           （server/routes/discovery.js）
 *      FTS5 主路径与 LIKE 兜底路径都返回非 dup 行（两条路径都要 —
 *      生产 FTS 表缺失/报错时走兜底，排除语义不得只在一条路径成立）。
 *   4. getSystemStats            （server/services/system-stats.js）
 *      total_items 等计数口径切到非 dup 行; 既有不变量
 *      summaries + enrichment_backlog + poisoned_items === total_items
 *      在标记 dup 后仍成立（分区查询同口径排除）; kg_features /
 *      vector_items 不把 dup 行的 features/向量行计入覆盖。
 *
 * 不钉的: /api/items 主信息流、/api/year 归档等未在任务范围点名的面
 * （实现可顺手同口径，但本契约不强制）。
 *
 * fixture: 001_initial_schema.sql + 手建 signal_scores + ALTER 加
 * duplicate_of 列（生产由新迁移提供）。内存库，绝不触生产库。
 *
 * RED 门:
 *   export PATH=$HOME/.local/bin:$PATH &&
 *   npx vitest run server/services/__tests__/dup-exclusion-routes.test.js
 */

const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const MIGRATIONS = ['001_initial_schema.sql', '002_i18n_translations.sql'].map(name =>
  fs.readFileSync(path.resolve(__dirname, '../../migrations/', name), 'utf8'));
const { getSystemStats } = require('../system-stats');

function makeRes() {
  return {
    statusCode: null, headers: null, body: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(payload) { this.body = JSON.parse(payload); },
  };
}

function loadRoute(serverRelPath, mocks) {
  const filename = path.resolve(__dirname, '../../', serverRelPath);
  const subject = new Module(filename, module);
  subject.filename = filename;
  subject.require = id => {
    if (mocks[id]) return mocks[id];
    throw new Error('Unmocked route dependency: ' + id);
  };
  subject._compile(fs.readFileSync(filename, 'utf8'), filename);
  return subject.exports;
}

/** 001+002 migrations（搜索路径引用 i.title_zh / a.*_zh）+ duplicate_of 列 + signal_scores。 */
function buildRouteDb() {
  const db = new Database(':memory:');
  for (const sql of MIGRATIONS) db.exec(sql);
  db.exec(`
    ALTER TABLE information_items ADD COLUMN duplicate_of TEXT;
    CREATE TABLE signal_scores (item_id TEXT, signal_type TEXT, alpha_score REAL, novelty_score REAL);
  `);
  db.prepare("INSERT INTO sources (id, slug, label) VALUES ('s1', 'hn', 'Hacker News')").run();
  return db;
}

function insertItem(db, id, { date, title, duplicateOf = null }) {
  db.prepare(`INSERT INTO information_items
    (id, source_id, canonical_url, title, digest_date, score, duplicate_of)
    VALUES (?, 's1', ?, ?, ?, 50, ?)`)
    .run(id, `https://example.com/${id}`, title, date, duplicateOf);
}

function digestRoutes(db) {
  const routes = {};
  loadRoute('routes/digest.js', {
    '../db/connection': { getDB: () => db },
    './_shared': require('../../routes/_shared'),
    '../services/date-contract': require('../date-contract'),
  })(routes);
  return routes;
}

function searchRoutes(db) {
  const routes = {};
  loadRoute('routes/discovery.js', {
    '../services/utils': { escapeXML: v => String(v) },
    '../db/connection': { getDB: () => db },
    './_shared': require('../../routes/_shared'),
  })(routes);
  return routes;
}

describe('R3.0 — /api/digest excludes duplicate_of rows by default', () => {
  let db;
  beforeEach(() => {
    db = buildRouteDb();
    insertItem(db, 'n1', { date: '2026-10-19', title: 'Real story one' });
    insertItem(db, 'n2', { date: '2026-10-19', title: 'Real story two' });
    insertItem(db, 'n3', { date: '2026-10-19', title: 'Real story three' });
    insertItem(db, 'd1', { date: '2026-10-19', title: 'Real story one', duplicateOf: 'n1' });
    insertItem(db, 'd2', { date: '2026-10-19', title: 'Real story two', duplicateOf: 'n2' });
  });
  afterEach(() => db.close());

  it('the daily item list and total count only the 3 non-dup rows', () => {
    const res = makeRes();
    digestRoutes(db)['/api/digest']({ method: 'GET', headers: {} }, res, { query: { date: '2026-10-19' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(3);
    const shown = Object.values(res.body.by_source).flat().map(item => item.id).sort();
    expect(shown).toEqual(['n1', 'n2', 'n3']);
  });

  it('per-date coverage counts exclude duplicates', () => {
    insertItem(db, 'n4', { date: '2026-10-20', title: 'Real story four' });
    insertItem(db, 'd3', { date: '2026-10-20', title: 'Real story one', duplicateOf: 'n1' });
    const res = makeRes();
    digestRoutes(db)['/api/digest/coverage']({ method: 'GET', headers: {} }, res, { query: {} });
    expect(res.statusCode).toBe(200);
    expect(res.body.coverage).toEqual({ '2026-10-19': 3, '2026-10-20': 1 });
  });
});

describe('R3.0 — /api/search excludes duplicate_of rows on both engine paths', () => {
  it('fts5 path: only the 2 non-dup rows match', () => {
    const db = buildRouteDb();
    insertItem(db, 'n1', { date: '2026-10-19', title: 'quantum sensor breakthrough' });
    insertItem(db, 'n2', { date: '2026-10-19', title: 'quantum sensor rival paper' });
    insertItem(db, 'd1', { date: '2026-10-19', title: 'quantum sensor breakthrough', duplicateOf: 'n1' });
    insertItem(db, 'd2', { date: '2026-10-19', title: 'quantum sensor breakthrough', duplicateOf: 'n1' });
    // 022 迁移的影子表形态: rowid 对齐 information_items。
    db.exec('CREATE VIRTUAL TABLE items_fts USING fts5(title)');
    db.exec('INSERT INTO items_fts(rowid, title) SELECT rowid, title FROM information_items');
    const res = makeRes();
    searchRoutes(db)['/api/search']({ method: 'GET', headers: {} }, res, { query: { q: 'quantum' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.engine).toBe('fts5');
    expect(res.body.items.map(item => item.id).sort()).toEqual(['n1', 'n2']);
    expect(res.body.total).toBe(2);
    db.close();
  });

  it('LIKE fallback path (no items_fts table): only the 2 non-dup rows match', () => {
    const db = buildRouteDb();
    insertItem(db, 'n1', { date: '2026-10-19', title: 'quantum sensor breakthrough' });
    insertItem(db, 'n2', { date: '2026-10-19', title: 'quantum sensor rival paper' });
    insertItem(db, 'd1', { date: '2026-10-19', title: 'quantum sensor breakthrough', duplicateOf: 'n1' });
    const res = makeRes();
    searchRoutes(db)['/api/search']({ method: 'GET', headers: {} }, res, { query: { q: 'quantum' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.engine).toBe('like-fallback');
    expect(res.body.items.map(item => item.id).sort()).toEqual(['n1', 'n2']);
    expect(res.body.total).toBe(2);
    db.close();
  });
});

describe('R3.0 — getSystemStats counts non-dup rows only', () => {
  let db;
  let now;
  let read;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE information_items (id TEXT PRIMARY KEY, source_id TEXT, enrichment_attempts INTEGER,
        digest_date TEXT, fetched_at TEXT, duplicate_of TEXT);
      CREATE TABLE ai_summaries (item_id TEXT, short_summary TEXT, short_summary_zh TEXT,
        one_liner TEXT, one_liner_zh TEXT, deep_summary TEXT, translation_status TEXT);
      CREATE TABLE sources (id TEXT, slug TEXT, label TEXT, is_active INTEGER, last_fetched_at TEXT);
      CREATE TABLE signal_scores (item_id TEXT, signal_type TEXT);
      CREATE TABLE research_reports (status TEXT);
      CREATE TABLE saved_items (id TEXT);
      CREATE TABLE seen_items (id TEXT);
      CREATE TABLE canonical_entities (id TEXT);
      CREATE TABLE dynamic_topics (id TEXT);
      CREATE TABLE item_features (item_id TEXT);
      CREATE TABLE item_vectors (item_id TEXT, vector_type TEXT, model_name TEXT);
      CREATE TABLE background_jobs (id TEXT, job_type TEXT, status TEXT, result TEXT,
        created_at TEXT, completed_at TEXT, error TEXT);
      INSERT INTO sources VALUES ('s', 'source', 'Source', 1, '2026-09-08T09:00:00Z');
    `);
    now = new Date('2026-09-08T10:00:00Z');
    read = () => getSystemStats(db, { now, dbPath: ':memory:' });
  });
  afterEach(() => db.close());

  it('total_items, the enrichment partition and KG coverage all exclude dup rows', () => {
    const insert = db.prepare(`INSERT INTO information_items
      (id, source_id, enrichment_attempts, digest_date, fetched_at, duplicate_of)
      VALUES (?, 's', ?, '2026-08-01', '2026-08-01 12:00:00', ?)`);
    // 3 条非 dup: 1 条有摘要（attempts=3）, 2 条无摘要（attempts=NULL → backlog）。
    insert.run('n1', 3, null);
    insert.run('n2', null, null);
    insert.run('n3', null, null);
    // 2 条 dup: 全都“看起来健康”（有摘要、有 features、有向量）— 计数默认
    // 排除后它们一个都不能计入任何口径。
    insert.run('d1', 3, 'n1');
    insert.run('d2', 3, 'n1');
    const summary = db.prepare('INSERT INTO ai_summaries (item_id, short_summary, translation_status) VALUES (?, ?, ?)');
    summary.run('n1', 'Useful summary', 'translated');
    summary.run('d1', 'Duplicate summary', 'translated');
    summary.run('d2', 'Duplicate summary', 'translated');
    db.exec(`INSERT INTO item_features VALUES ('n1'), ('d1'), ('d2');
      INSERT INTO item_vectors VALUES ('n1', 'semantic-hash', 'eagleye-hash-v1'), ('d1', 'semantic-hash', 'eagleye-hash-v1');`);
    const stats = read();
    expect(stats.total_items).toBe(3);
    expect(stats.summaries).toBe(1);
    expect(stats.enrichment_backlog).toBe(2);
    expect(stats.summaries + stats.enrichment_backlog + stats.poisoned_items).toBe(stats.total_items);
    expect(stats.kg_features).toBe(1);
    expect(stats.vector_items).toBe(1);
  });
});
