// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */
const Database = require('better-sqlite3');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const shared = require('../../routes/_shared');
const validation = require('../../routes/_validation');

describe('system mutation boundaries', () => {
  let db;
  let routes;
  let runJob;
  let cancelJob;
  let getDB;
  let effect;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE ai_summaries (id TEXT); INSERT INTO ai_summaries VALUES ('keep');
      CREATE TABLE information_items (id TEXT, title_zh TEXT);
      CREATE TABLE item_tags (id TEXT); INSERT INTO item_tags VALUES ('keep');
      CREATE TABLE graph_edges (id TEXT); INSERT INTO graph_edges VALUES ('keep');`);
    routes = {};
    runJob = vi.fn(async () => 'new-job');
    cancelJob = vi.fn(() => true);
    getDB = vi.fn(() => db);
    effect = vi.fn(async () => ({ id: 'report', topic: 'AI' }));
    const jobs = { runJob, cancelJob, getRecentJobs: () => [], getJob: () => ({ id: 'job', status: 'running' }),
      JOB_TYPES: new Proxy({}, { get: (_target, key) => key }) };
    const mocks = {
      './_shared': shared, './_validation': validation,
      '../db/connection': { getDB }, '../db/user-data': {}, '../services/jobs': jobs,
      '../services/llm': { enrichItems: effect, generateDailyDigest: effect },
      '../services/translate': { translateItems: effect },
      '../services/signals': {}, '../services/utils': { escapeXML: value => value },
      '../services/topic-graph': {},
      '../services/date-contract': require('../../services/date-contract'),
      '../services/elasticsearch': { esReindex: effect, esIncrementalSync: effect },
      '../services/es-rag': {}, '../services/es-ai-setup': { setupAI: effect },
    };
    for (const file of ['jobs.js', 'signals.js', 'taxonomy.js']) {
      const filename = path.resolve(__dirname, '../../routes', file);
      const subject = new Module(filename, module);
      subject.filename = filename;
      subject.require = id => {
        if (mocks[id]) return mocks[id];
        throw new Error(`Unmocked dependency: ${id}`);
      };
      subject._compile(fs.readFileSync(filename, 'utf8'), filename);
      subject.exports(routes);
    }
  });
  afterEach(() => db.close());

  async function call(route, method = 'POST', role = 'admin', query = {}, params = { id: 'job', slug: 'ai' }) {
    const response = { status: null, body: null,
      writeHead(status) { this.status = status; },
      end(body) { this.body = body ? JSON.parse(body) : null; } };
    await routes[route]({ method, user: { id: 'u', role } }, response, { query }, params);
    return response;
  }

  const mutations = ['/api/sync', '/api/enrich', '/api/enrich/reenrich', '/api/digest/build', '/api/pipeline',
    '/api/jobs/:id/cancel', '/api/translate/backfill', '/api/jobs/fetch-source', '/api/signals/rescore',
    '/api/tags/build-hierarchy', '/api/topics/build'];

  it.each(mutations)('rejects ordinary users and wrong methods before side effects: %s', async route => {
    expect((await call(route, 'POST', 'user')).status).toBe(403);
    for (const method of ['GET', 'PUT', 'DELETE']) expect((await call(route, method)).status).toBe(405);
    expect(runJob).not.toHaveBeenCalled();
    expect(cancelJob).not.toHaveBeenCalled();
    expect(getDB).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
  });

  it('returns 410 for old destructive re-enrichment and preserves every existing table', async () => {
    const response = await call('/api/enrich/reenrich');
    expect(response.status).toBe(410);
    expect(response.body.error).toContain('incremental recovery');
    for (const table of ['ai_summaries', 'item_tags', 'graph_edges']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n).toBe(1);
    expect(getDB).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '1.5', '5abc', '', 'Infinity', '1601', '9999999999999999999'])('rejects unsafe enrichment batch %s', async batch => {
    expect((await call('/api/enrich', 'POST', 'admin', { batch })).status).toBe(400);
    expect((await call('/api/pipeline', 'POST', 'admin', { batch })).status).toBe(400);
    expect(runJob).not.toHaveBeenCalled();
  });

  it('honors valid bounded recovery and pipeline parameters', async () => {
    expect((await call('/api/enrich', 'POST', 'admin', { batch: '50', reset_attempts: 'true' })).status).toBe(200);
    expect(runJob).toHaveBeenLastCalledWith('ENRICH_ITEMS', { batchSize: 50, priorityOnly: false, resetAttempts: true });
    expect((await call('/api/pipeline', 'POST', 'admin', { batch: '7' })).status).toBe(200);
    expect(runJob).toHaveBeenLastCalledWith('FULL_PIPELINE', { enrichBatchSize: 7 });
    expect((await call('/api/jobs/fetch-source', 'POST', 'admin', { slug: 'hacker-news', date: '20260909' })).status).toBe(200);
    expect(runJob).toHaveBeenLastCalledWith('FETCH_SOURCE', { slug: 'hacker-news', date: '20260909', limit: 5 });
    expect((await call('/api/jobs/fetch-source', 'POST', 'admin', { slug: 'hacker-news', date: '2026-09-09' })).status).toBe(200);
    expect(runJob).toHaveBeenLastCalledWith('FETCH_SOURCE', { slug: 'hacker-news', date: '20260909', limit: 5 });
  });

  it('rejects unbounded translation and respects explicit full-corpus rescore', async () => {
    expect((await call('/api/translate/backfill', 'POST', 'admin', { all: 'true' })).status).toBe(400);
    for (const batch_size of ['0', '-5', 'NaN', '501']) expect((await call('/api/translate/backfill', 'POST', 'admin', { batch_size })).status).toBe(400);
    expect((await call('/api/signals/rescore', 'POST', 'admin', { all: 'true', concurrency: '2' })).status).toBe(200);
    expect(runJob).toHaveBeenLastCalledWith('RESCORE_ALL', { concurrency: 2 });
    expect((await call('/api/signals/rescore', 'POST', 'admin', { concurrency: '9' })).status).toBe(400);
    expect((await call('/api/signals/rescore', 'POST', 'admin', { limit: '-1' })).status).toBe(400);
  });

  it.each(['20260230', '20261301', '2026099', '2026-13-01', ''])('validates calendar date before starting work: %s', async date => {
    for (const route of ['/api/digest/build', '/api/topics/build', '/api/jobs/fetch-source', '/api/signals/rescore']) {
      expect((await call(route, 'POST', 'admin', { date, slug: 'hacker-news' })).status).toBe(400);
    }
    expect(runJob).not.toHaveBeenCalled();
  });

  it('keeps job reads available with bounded limits and no mutation methods', async () => {
    expect((await call('/api/jobs', 'GET', 'user')).status).toBe(200);
    expect((await call('/api/jobs', 'GET', 'user', { limit: '-1' })).status).toBe(400);
    expect((await call('/api/jobs/:id', 'POST', 'admin')).status).toBe(405);
    expect((await call('/api/jobs/:id', 'GET', 'user')).status).toBe(200);
  });
});
