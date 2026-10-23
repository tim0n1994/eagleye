// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach */
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

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

describe('REST API score-scale declarations (plan OBS-08 / T03)', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/001_initial_schema.sql'), 'utf8'));
    db.prepare("INSERT INTO sources (id, slug, label) VALUES ('s1', 'hn', 'Hacker News')").run();
    db.prepare("INSERT INTO information_items (id, source_id, canonical_url, title, digest_date, score) VALUES ('i1', 's1', 'https://example.com/a', 'A story', '2026-09-09', 887517.313)").run();
  });

  afterEach(() => { db.close(); });

  it('/api/items declares the legacy unbounded score scale', () => {
    const mocks = {
      '../db/connection': { getDB: () => db },
      './_shared': require('../../routes/_shared'),
      '../services/date-contract': require('../date-contract'),
    };
    const routes = {};
    loadRoute('routes/items.js', mocks)(routes);
    const res = makeRes();
    routes['/api/items']({ method: 'GET', headers: {} }, res, { query: {} });
    expect(res.statusCode).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.score_scale).toEqual({ score: 'unbounded-legacy' });
  });

  it('/api/signals declares alpha scores on the 0-1 scale', () => {
    const mocks = {
      '../db/user-data': { getValue: () => null, setValue: () => {} },
      '../services/signals': { getSignals: () => [], getTodaySignals: () => [], getSignalById: () => null, getSignalTypes: () => [], getEntityMomentum: () => [], getRadarAudiences: () => [], getEntityItems: () => [], getEntitySeries: () => [], compareEntitySeries: () => null, getEntityCoOccurrence: () => [] },
      '../services/jobs': { runJob: async () => ({}), JOB_TYPES: {} },
      '../services/utils': { escapeXML: v => String(v) },
      './_validation': { requireAdminPost: () => false, positiveInteger: (value, fallback) => fallback },
      './_shared': require('../../routes/_shared'),
      '../services/date-contract': require('../date-contract'),
    };
    const routes = {};
    loadRoute('routes/signals.js', mocks)(routes);
    const res = makeRes();
    routes['/api/signals']({ method: 'GET', headers: {} }, res, { query: {} });
    expect(res.statusCode).toBe(200);
    expect(res.body.score_scale).toEqual({ alpha_score: '0-1', alpha_score_audience: '0-1' });
  });
});
