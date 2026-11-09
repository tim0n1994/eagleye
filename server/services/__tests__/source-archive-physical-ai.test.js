// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Physical AI 源存档契约 — GET /api/source/:slug 仅在 slug 以 physical-ai-
 * 开头时生效:
 *   1. 按 published_at DESC 排序（date 分支同样生效，不再按 score DESC）。
 *   2. 排除 duplicate_of 非空行与 source_payload.is_placeholder 占位行
 *      （占位真值口径与 /api/items exclude_placeholders 一致: true/1/'true'）。
 *   3. 损坏 JSON 保守保留该行，不因解析失败丢历史。
 * 其他源两条分支行为完全不变（date 分支 score DESC，重复/占位行照常返回）。
 * fixture: 001+002 迁移 + duplicate_of 列 + signal_scores 表。内存库，
 * 绝不触生产库。
 */

const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const MIGRATIONS = ['001_initial_schema.sql', '002_i18n_translations.sql'].map(name =>
  fs.readFileSync(path.resolve(__dirname, '../../migrations/', name), 'utf8'));

function makeRes() {
  return {
    statusCode: null, headers: null, body: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(payload) { this.body = JSON.parse(payload); },
  };
}

function sourceRoutes(db) {
  const filename = path.resolve(__dirname, '../../routes/sources.js');
  const subject = new Module(filename, module);
  subject.filename = filename;
  subject.require = id => {
    if (id === '../db/connection') return { getDB: () => db };
    if (id === './_shared') return require('../../routes/_shared');
    if (id === '../services/date-contract') return require('../date-contract');
    if (id === '../services/scheduler') return { getConfig: () => ({}), expectedIntervalHours: () => null };
    if (id === '../services/source-health') return { expectedIntervalForSource: () => ({ hours: null, basis: 'unknown' }) };
    if (id === '../services/utils') return require('../../services/utils');
    throw new Error('Unmocked route dependency: ' + id);
  };
  subject._compile(fs.readFileSync(filename, 'utf8'), filename);
  const routes = {};
  subject.exports(routes);
  return routes;
}

function buildDb() {
  const db = new Database(':memory:');
  for (const sql of MIGRATIONS) db.exec(sql);
  db.exec('DELETE FROM sources;'); // migrations seed demo rows; this fixture owns its sources
  db.exec(`
    ALTER TABLE information_items ADD COLUMN duplicate_of TEXT;
    CREATE TABLE signal_scores (item_id TEXT, signal_type TEXT, alpha_score REAL, novelty_score REAL);
  `);
  db.prepare(`INSERT INTO sources (id, slug, label) VALUES ('s-pa', 'physical-ai-arxiv', 'Physical AI — arXiv')`).run();
  db.prepare(`INSERT INTO sources (id, slug, label) VALUES ('s-hn', 'hacker-news', 'Hacker News')`).run();
  return db;
}

function insertItem(db, sourceId, id, opts = {}) {
  const o = { digestDate: '2026-11-03', publishedAt: '2026-11-03T00:00:00Z', score: 50, duplicateOf: null, payload: '{}', ...opts };
  db.prepare(`
    INSERT INTO information_items
      (id, source_id, canonical_url, title, digest_date, published_at, score, duplicate_of, source_payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, sourceId, 'https://example.com/' + id, 'Item ' + id, o.digestDate, o.publishedAt, o.score, o.duplicateOf, o.payload);
}

function fetchSource(db, slug, query = {}) {
  const res = makeRes();
  sourceRoutes(db)['/api/source/:slug']({ method: 'GET', headers: {} }, res, { query }, { slug });
  return res;
}

describe('Physical AI 源存档 — 无 date 分支', () => {
  let db;
  beforeEach(() => {
    db = buildDb();
    insertItem(db, 's-pa', 'corrupt1', { digestDate: '2026-11-07', publishedAt: '2026-11-07T12:00:00Z', payload: '{broken-json' });
    insertItem(db, 's-pa', 'd1', { digestDate: '2026-11-06', publishedAt: '2026-11-06T12:00:00Z', duplicateOf: 'p2' });
    insertItem(db, 's-pa', 'p2', { digestDate: '2026-11-05', publishedAt: '2026-11-05T12:00:00Z' });
    insertItem(db, 's-pa', 'ph1', { digestDate: '2026-11-04', publishedAt: '2026-11-04T12:00:00Z', payload: '{"is_placeholder":true}' });
    insertItem(db, 's-pa', 'p1', { digestDate: '2026-11-03', publishedAt: '2026-11-03T08:00:00Z' });
    insertItem(db, 's-pa', 'ph2', { digestDate: '2026-11-02', publishedAt: '2026-11-02T12:00:00Z', payload: '{"is_placeholder":1}' });
    insertItem(db, 's-pa', 'ph3', { digestDate: '2026-11-01', publishedAt: '2026-11-01T12:00:00Z', payload: '{"is_placeholder":"true"}' });
  });
  afterEach(() => db.close());

  it('newest first; dedup and placeholder rows excluded; corrupt JSON row kept', () => {
    const res = fetchSource(db, 'physical-ai-arxiv');
    expect(res.statusCode).toBe(200);
    expect(res.body.exists).toBe(true);
    expect(res.body.items.map(item => item.id)).toEqual(['corrupt1', 'p2', 'p1']);
    expect(res.body.total).toBe(3);
  });

  it('filters placeholders before the archive limit', () => {
    db.transaction(() => {
      for (let i = 0; i < 100; i++) insertItem(db, 's-pa', `placeholder-${i}`, { publishedAt: '2026-11-08T12:00:00Z', payload: '{"is_placeholder":true}' });
    })();
    const res = fetchSource(db, 'physical-ai-arxiv');
    expect(res.body.items.map(item => item.id)).toEqual(['corrupt1', 'p2', 'p1']);
  });
});

describe('Physical AI 源存档 — date 分支', () => {
  let db;
  beforeEach(() => {
    db = buildDb();
    insertItem(db, 's-pa', 'p3', { publishedAt: '2026-11-03T10:00:00Z', score: 10 });
    insertItem(db, 's-pa', 'p4', { publishedAt: '2026-11-03T09:00:00Z', score: 99 });
    insertItem(db, 's-pa', 'p1', { publishedAt: '2026-11-03T08:00:00Z', score: 50 });
  });
  afterEach(() => db.close());

  it('orders by published_at DESC instead of score DESC', () => {
    const res = fetchSource(db, 'physical-ai-arxiv', { date: '2026-11-03' });
    expect(res.statusCode).toBe(200);
    expect(res.body.items.map(item => item.id)).toEqual(['p3', 'p4', 'p1']);
  });
});

describe('其他源 — 行为保持不变', () => {
  let db;
  beforeEach(() => {
    db = buildDb();
    insertItem(db, 's-hn', 'hc1', { publishedAt: '2026-11-03T08:00:00Z', score: 100 });
    insertItem(db, 's-hn', 'hcd', { publishedAt: '2026-11-03T10:00:00Z', score: 99, duplicateOf: 'hc1' });
    insertItem(db, 's-hn', 'hcph', { publishedAt: '2026-11-03T07:00:00Z', score: 95, payload: '{"is_placeholder":true}' });
    insertItem(db, 's-hn', 'hc2', { publishedAt: '2026-11-03T09:00:00Z', score: 90 });
  });
  afterEach(() => db.close());

  it('no date: duplicate and placeholder rows still come back, published_at DESC', () => {
    const res = fetchSource(db, 'hacker-news');
    expect(res.statusCode).toBe(200);
    expect(res.body.items.map(item => item.id)).toEqual(['hcd', 'hc2', 'hc1', 'hcph']);
    expect(res.body.total).toBe(4);
  });

  it('date branch: score DESC kept, duplicate and placeholder rows still come back', () => {
    const res = fetchSource(db, 'hacker-news', { date: '2026-11-03' });
    expect(res.statusCode).toBe(200);
    expect(res.body.items.map(item => item.id)).toEqual(['hc1', 'hcd', 'hcph', 'hc2']);
  });
});
