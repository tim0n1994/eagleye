// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const previousPath = process.env.EAGLEYE_DB_PATH;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'items-routes-'));
process.env.EAGLEYE_DB_PATH = path.join(directory, 'items_test.sqlite');

const { getDB, closeDB } = require('../../db/connection');
const registerItemsRoutes = require('../../routes/items');

let routes;
beforeAll(() => {
  const db = getDB();
  db.exec([
    'CREATE TABLE sources (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, label TEXT NOT NULL)',
    `CREATE TABLE information_items (
      id TEXT PRIMARY KEY,
      source_id TEXT REFERENCES sources(id),
      canonical_url TEXT NOT NULL,
      title TEXT NOT NULL,
      digest_date TEXT NOT NULL,
      source_payload TEXT NOT NULL DEFAULT '{}',
      normalized_payload TEXT NOT NULL DEFAULT '{}',
      popularity TEXT DEFAULT '{}',
      score REAL DEFAULT 0,
      published_at TEXT
    )`,
    'CREATE TABLE ai_summaries (item_id TEXT PRIMARY KEY, one_liner_zh TEXT)',
    'CREATE TABLE topics (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL)',
    'CREATE TABLE item_topics (item_id TEXT NOT NULL, topic_id TEXT NOT NULL, relevance REAL DEFAULT 0)',
    'CREATE TABLE tags (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL)',
    'CREATE TABLE item_tags (item_id TEXT NOT NULL, tag_id TEXT NOT NULL, confidence REAL DEFAULT 0)',
  ].join(';\n'));

  db.prepare("INSERT INTO sources (id, slug, label) VALUES ('src-1', 'test-source', 'Test Source')").run();
  db.prepare(`INSERT INTO information_items
    (id, source_id, canonical_url, title, digest_date, source_payload, normalized_payload, popularity, score, published_at)
    VALUES ('item-1', 'src-1', 'https://example.com/a', 'Item One', '2026-10-23', '{}', '{}', '{}', 1, '2026-10-23T00:00:00Z')`).run();
  db.prepare("INSERT INTO ai_summaries (item_id, one_liner_zh) VALUES ('item-1', '一句话摘要')").run();
  db.prepare("INSERT INTO topics (id, slug, name) VALUES ('t-1', 'ai', 'AI')").run();
  db.prepare("INSERT INTO item_topics (item_id, topic_id, relevance) VALUES ('item-1', 't-1', 0.9)").run();
  db.prepare("INSERT INTO tags (id, slug, name) VALUES ('g-1', 'llm', 'LLM')").run();
  db.prepare("INSERT INTO item_tags (item_id, tag_id, confidence) VALUES ('item-1', 'g-1', 0.8)").run();

  routes = {};
  registerItemsRoutes(routes);
});

afterAll(() => {
  closeDB();
  if (previousPath === undefined) delete process.env.EAGLEYE_DB_PATH;
  else process.env.EAGLEYE_DB_PATH = previousPath;
  fs.rmSync(directory, { recursive: true, force: true });
});

function call(handler, { params } = {}) {
  const req = { method: 'GET', url: '/api/items', headers: {} };
  let statusCode = 0;
  let rawResponse = '';
  const res = {
    writeHead(code) { statusCode = code; },
    end(body) { rawResponse = body; },
  };
  handler(req, res, { query: {} }, params);
  return { status: statusCode, body: JSON.parse(rawResponse) };
}

describe('items detail route', () => {
  it('GET /api/items/:id returns 200 with item payload and no deploy field', () => {
    const { status, body } = call(routes['/api/items/:id'], { params: { id: 'item-1' } });
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.item.id).toBe('item-1');
    expect(body.item.ai_summary.one_liner_zh).toBe('一句话摘要');
    expect(body.item.topics).toHaveLength(1);
    expect(body.item.tags).toHaveLength(1);
    expect(body).not.toHaveProperty('deploy');
  });

  it('GET /api/items/:id returns 404 for a missing item', () => {
    const { status, body } = call(routes['/api/items/:id'], { params: { id: 'missing' } });
    expect(status).toBe(404);
    expect(body.error).toBe('Item not found');
  });
});
