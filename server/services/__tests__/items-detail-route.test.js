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

describe('GET /api/items/:id', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/001_initial_schema.sql'), 'utf8'));
    db.prepare("INSERT INTO sources (id, slug, label) VALUES ('s1', 'hn', 'Hacker News')").run();
    db.prepare("INSERT INTO information_items (id, source_id, canonical_url, title, digest_date, score) VALUES ('i1', 's1', 'https://example.com/a', 'A story', '2026-10-23', 1)").run();
  });

  afterEach(() => { db?.close(); });

  it('returns item details without the removed deploy-eligibility field', () => {
    const routes = {};
    loadRoute('routes/items.js', {
      '../db/connection': { getDB: () => db },
      './_shared': require('../../routes/_shared'),
      '../services/date-contract': require('../date-contract'),
    })(routes);
    const res = makeRes();

    routes['/api/items/:id']({ method: 'GET', headers: {} }, res, { query: {} }, { id: 'i1' });

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.item.id).toBe('i1');
    expect(res.body.deploy).toBeUndefined();
  });
});
