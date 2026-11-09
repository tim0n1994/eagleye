// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const previousPath = process.env.EAGLEYE_DB_PATH;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'physical-ai-feed-'));
process.env.EAGLEYE_DB_PATH = path.join(directory, 'physical_ai_test.sqlite');

const { getDB, closeDB } = require('../../db/connection');
const registerPhysicalAiRoutes = require('../../routes/physical-ai');
const { getPhysicalAiSnapshot, getPhysicalAiItems } = require('../../services/physical-ai-feed');
const { todayDigestDate } = require('../../services/date-contract');

const hoursAgoIso = (hours) => (hours === null ? null : new Date(Date.now() - hours * 3600000).toISOString());
const today = todayDigestDate();

let db;
let routes;
// Exact insert-time ISO timestamps, so assertions cannot drift by the
// milliseconds between module load and request handling.
const publishedById = new Map();

beforeAll(() => {
  db = getDB();
  db.exec([
    'CREATE TABLE sources (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, label TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1)',
    'CREATE TABLE information_items (id TEXT PRIMARY KEY, source_id TEXT REFERENCES sources(id), canonical_url TEXT NOT NULL, title TEXT NOT NULL, title_zh TEXT, original_summary TEXT, digest_date TEXT NOT NULL, source_payload TEXT NOT NULL DEFAULT \'{}\', published_at TEXT, created_at TEXT, duplicate_of TEXT)',
    'CREATE INDEX idx_items_published_at ON information_items (published_at DESC)',
    'CREATE INDEX idx_items_digest_date ON information_items (digest_date)',
    'CREATE TABLE ai_summaries (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, created_at TEXT, ai_title TEXT, ai_title_zh TEXT, one_liner TEXT, one_liner_zh TEXT, short_summary TEXT, short_summary_zh TEXT)',
    'CREATE INDEX idx_summaries_item_id ON ai_summaries (item_id)',
  ].join(';\n'));

  const insertSource = db.prepare('INSERT INTO sources (id, slug, label, is_active) VALUES (?, ?, ?, ?)');
  insertSource.run('s-arxiv', 'physical-ai-arxiv', 'Physical AI — arXiv', 1);
  insertSource.run('s-humanoid', 'physical-ai-humanoid', 'Physical AI — Humanoid', 1);
  // Migration 046 reality: CN photonics is disabled but its history remains.
  insertSource.run('s-photonics', 'physical-ai-cn-photonics', 'Physical AI — CN Photonics', 0);
  insertSource.run('s-sec', 'physical-ai-sec-8k', 'Physical AI — SEC 8-K', 1);
  insertSource.run('s-noise', 'hacker-news', 'Hacker News', 1);

  const insertItem = db.prepare(
    'INSERT INTO information_items (id, source_id, canonical_url, title, title_zh, original_summary, digest_date, source_payload, published_at, created_at, duplicate_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  // [id, sourceId, hoursAgo (null = unknown published_at), digestDate, payload, duplicateOf, titleZh]
  const fixtures = [
    ['arx-1', 's-arxiv', 2, today, '{}', null, '具身智能综述'],
    ['arx-2', 's-arxiv', 40 * 24, '2026-09-30', '{}', null, null],
    ['arx-170', 's-arxiv', 170 * 24, '2026-05-01', '{}', null, null],
    ['arx-old', 's-arxiv', 200 * 24, '2026-04-01', '{}', null, null],
    ['arx-null', 's-arxiv', null, today, '{}', null, null],
    ['hum-1', 's-humanoid', 5, today, '{}', null, '人形机器人融资'],
    ['hum-2', 's-humanoid', 10, today, '{}', null, null],
    ['hum-dup', 's-humanoid', 1, today, '{}', 'hum-1', null],
    ['hum-ph-obj', 's-humanoid', 4, today, '{"is_placeholder": true}', null, null],
    ['hum-ph-str', 's-humanoid', 6, today, '{"is_placeholder": "true"}', null, null],
    ['hum-badjson', 's-humanoid', 3, today, '{not json', null, null],
    ['pho-1', 's-photonics', 20, today, '{}', null, null],
    ['pho-2', 's-photonics', 25, today, '{}', null, null],
    ['sec-1', 's-sec', 30, today, '{}', null, null],
    ['snap-canonical', 's-sec', 100 * 24, '2026-08-01', '{}', null, null],
    ['snap-compact', 's-humanoid', 101 * 24, '20260801', '{}', null, null],
    ['pho-snap', 's-photonics', 99 * 24, '2026-08-01', '{}', null, null],
  ];
  for (const [id, sourceId, hours, digestDate, payload, duplicateOf, titleZh] of fixtures) {
    const publishedAt = hoursAgoIso(hours);
    publishedById.set(id, publishedAt);
    insertItem.run(id, sourceId, 'https://example.com/' + id, 'Physical AI story: ' + id, titleZh,
      'Original summary for ' + id, digestDate, payload, publishedAt, publishedAt, duplicateOf);
  }

  const insertSummary = db.prepare(
    'INSERT INTO ai_summaries (id, item_id, created_at, ai_title, ai_title_zh, one_liner, one_liner_zh, short_summary, short_summary_zh) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  // Second-precision created_at mirrors the production datetime('now') default;
  // same-second rows must be broken deterministically by id DESC.
  insertSummary.run('sum-arx-1', 'arx-1', '2026-01-01 00:00:00', 'Embodied AI survey', '具身智能综述', 'A survey of embodied AI', '具身智能一线摘要',
    'Full short summary', '中文简短摘要');
  insertSummary.run('sum-hum-1', 'hum-1', '2026-01-01 00:00:00', null, null, 'Humanoid raises funding', '人形机器人融资摘要', null, null);
  insertSummary.run('sum-snap', 'snap-canonical', '2026-01-01 00:00:00', null, null, null, null, 'Filing summary', null);
  // Regeneration leftovers: the newer row must win over the stale one.
  insertSummary.run('sum-hum-2-old', 'hum-2', '2026-01-01 00:00:00', null, null, 'Older summary line', null, null, null);
  insertSummary.run('sum-hum-2-new', 'hum-2', '2026-01-02 00:00:00', null, null, 'Newer summary line', null, null, null);
  // Same-second tie: id DESC decides (sum-bbb over sum-aaa).
  insertSummary.run('sum-aaa', 'arx-170', '2026-01-01 00:00:00', null, null, 'Tie older id line', null, null, null);
  insertSummary.run('sum-bbb', 'arx-170', '2026-01-01 00:00:00', null, null, 'Tie newer id line', null, null, null);

  // A busy non-physical source must neither leak into items nor counts, at
  // volume that forces index-driven window scans instead of table walks.
  const insertNoise = db.prepare(
    'INSERT INTO information_items (id, source_id, canonical_url, title, digest_date, source_payload, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    for (let i = 0; i < 3000; i++) {
      insertNoise.run('noise-' + i, 's-noise', 'https://example.com/noise-' + i,
        'AI infrastructure update ' + i, today, '{}', hoursAgoIso(1), hoursAgoIso(1));
    }
  })();

  routes = {};
  registerPhysicalAiRoutes(routes);
});

afterAll(() => {
  closeDB();
  if (previousPath === undefined) delete process.env.EAGLEYE_DB_PATH;
  else process.env.EAGLEYE_DB_PATH = previousPath;
  fs.rmSync(directory, { recursive: true, force: true });
});

function call(query = {}, method = 'GET') {
  const req = { method, url: '/api/physical-ai', headers: {} };
  let statusCode = 0;
  let rawResponse = '';
  const res = {
    writeHead(code) { statusCode = code; },
    end(body) { rawResponse = body; },
  };
  routes['/api/physical-ai'](req, res, { query });
  return { status: statusCode, body: rawResponse ? JSON.parse(rawResponse) : null };
}

const cat = (body, key) => body.categories.find((entry) => entry.key === key);

describe('GET /api/physical-ai', () => {
  it('returns the 30-day window newest-first with full contract fields', () => {
    const { status, body } = call({ days: 30 });
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(50);
    expect(body.items.map((item) => item.id)).toEqual([
      'arx-1', 'hum-badjson', 'hum-1', 'hum-2',
    ]);
    const arx = body.items[0];
    expect(arx.category).toBe('research');
    expect(arx.source_slug).toBe('physical-ai-arxiv');
    expect(arx.source_label).toBe('Physical AI — arXiv');
    expect(arx.title).toContain('arx-1');
    expect(arx.title_zh).toBe('具身智能综述');
    expect(arx.canonical_url).toBe('https://example.com/arx-1');
    expect(arx.published_at).toBe(publishedById.get('arx-1'));
    expect(arx.digest_date).toBe(today);
    expect(arx.ai_title).toBe('Embodied AI survey');
    expect(arx.ai_title_zh).toBe('具身智能综述');
    expect(arx.one_liner).toBe('A survey of embodied AI');
    expect(arx.one_liner_zh).toBe('具身智能一线摘要');
    expect(arx.short_summary).toBe('Full short summary');
    expect(arx.short_summary_zh).toBe('中文简短摘要');
    expect(arx.original_summary).toBe('Original summary for arx-1');
    for (const item of body.items) {
      expect(['research', 'humanoid', 'open', 'applications']).toContain(item.category);
    }
  });

  it('counts every category scope-wide, regardless of category filter and pagination', () => {
    const full = call({ days: 30 }).body;
    expect(cat(full, 'research')).toEqual({ key: 'research', source_slug: 'physical-ai-arxiv', count: 1, is_active: true });
    expect(cat(full, 'humanoid')).toEqual({ key: 'humanoid', source_slug: 'physical-ai-humanoid', count: 3, is_active: true });
    expect(cat(full, 'open')).toEqual({ key: 'open', source_slug: null, count: 0, is_active: null });
    expect(cat(full, 'applications')).toEqual({ key: 'applications', source_slug: null, count: 0, is_active: true });
    expect(full.stats.total).toBe(4);

    const filtered = call({ days: 30, category: 'humanoid', limit: 1, offset: 1 }).body;
    expect(filtered.items.map((item) => item.id)).toEqual(['hum-1']);
    expect(filtered.stats.total).toBe(3);
    expect(filtered.categories).toEqual(full.categories);
  });

  it('windows items on published_at and clamps days into 1..180', () => {
    expect(call({ days: 90 }).body.stats.total).toBe(5);
    expect(call({ days: 90 }).body.items.map((item) => item.id)).toContain('arx-2');
    expect(call({ days: 200 }).body.items.map((item) => item.id)).toContain('arx-170');
    expect(call({ days: 200 }).body.items.map((item) => item.id)).not.toContain('arx-old');
    // The 180-day window also includes the earlier robotics snapshot.
    expect(call({ days: 200 }).body.stats.total).toBe(7);
    expect(call({ days: 'abc' }).body.stats.total).toBe(4);
  });

  it('snapshot by date wins over days and matches legacy compact digest_date', () => {
    const { body } = call({ date: '2026-08-01' });
    expect(body.items.map((item) => item.id)).toEqual(['snap-compact']);
    expect(body.items.find((item) => item.id === 'snap-compact').digest_date).toBe('20260801');
    expect(cat(body, 'research').count).toBe(0);
    expect(cat(body, 'humanoid').count).toBe(1);
    expect(cat(body, 'open').count).toBe(0);
    expect(cat(body, 'applications').count).toBe(0);
    expect(body.stats.total).toBe(1);
    expect(call({ date: '2026-08-01', days: 30 }).body.items.map((item) => item.id))
      .toEqual(body.items.map((item) => item.id));
  });

  it('snapshot includes unknown published_at rows and sorts them last', () => {
    const { body } = call({ date: today, days: 30 });
    const ids = body.items.map((item) => item.id);
    expect(ids[ids.length - 1]).toBe('arx-null');
    expect(ids).not.toContain('pho-1');
    expect(cat(body, 'research').count).toBe(2);
    expect(body.stats.total).toBe(5);
  });

  it('drops duplicate_of and placeholder rows, keeps corrupt JSON payloads', () => {
    const ids = call({ days: 30 }).body.items.map((item) => item.id);
    expect(ids).not.toContain('hum-dup');
    expect(ids).not.toContain('hum-ph-obj');
    expect(ids).not.toContain('hum-ph-str');
    expect(ids).toContain('hum-badjson');
  });

  it('joins one latest summary per item; repeated summaries cannot inflate pages', () => {
    const { body } = call({ days: 30 });
    const ids = body.items.map((item) => item.id);
    expect(ids).toEqual([...new Set(ids)]);
    expect(ids).toHaveLength(4);
    expect(body.stats.total).toBe(4);
    const hum2 = body.items.find((item) => item.id === 'hum-2');
    expect(hum2.one_liner).toBe('Newer summary line');
    const tie = call({ days: 200 }).body.items.find((item) => item.id === 'arx-170');
    expect(tie.one_liner).toBe('Tie newer id line');
    expect(call({ days: 200 }).body.items.filter((item) => item.id === 'arx-170')).toHaveLength(1);
  });

  it('keeps disabled-source history visible, marked is_active false', () => {
    const { body } = call({ days: 30, category: 'photonics' });
    expect(body.items.map((item) => item.id)).toEqual(['pho-1', 'pho-2']);
    expect(body.items[0].source_slug).toBe('physical-ai-cn-photonics');
    expect(body.items[0].source_label).toBe('Physical AI — CN Photonics');
    expect(body.stats.total).toBe(2);
    expect(cat(body, 'photonics').is_active).toBe(false);
  });

  it('paginates deterministically over the published_at order', () => {
    const all = call({ days: 30, limit: 120 }).body.items.map((item) => item.id);
    expect(call({ days: 30, limit: 2 }).body.items.map((item) => item.id)).toEqual(all.slice(0, 2));
    expect(call({ days: 30, limit: 2, offset: 5 }).body.items.map((item) => item.id)).toEqual(all.slice(5, 7));
    const beyond = call({ days: 30, limit: 2, offset: 99 }).body;
    expect(beyond.items).toEqual([]);
    expect(beyond.stats.total).toBe(4);
    expect(call({ days: 30, limit: '7', offset: 3 }).body.limit).toBe(7);
    expect(call({ days: 30, limit: 3, offset: 3 }).body.offset).toBe(3);
    const paged = [0, 3, 6].flatMap((offset) =>
      call({ days: 30, limit: 3, offset }).body.items.map((item) => item.id));
    expect(paged).toEqual(all);
  });

  it('rejects invalid input and honors GET/HEAD only', () => {
    expect(call({ category: 'bogus' }).status).toBe(400);
    expect(call({ category: 'bogus' }).body.error).toContain('research');
    expect(call({ date: '2026-13-01' }).status).toBe(400);
    expect(call({ date: '2026-02-30' }).status).toBe(400);
    expect(call({ date: 'not-a-date' }).status).toBe(400);
    expect(call({ date: '' }).status).toBe(200);
    expect(call({ date: '' }).body.stats.total).toBe(4);
    expect(call({}, 'POST').status).toBe(405);
    expect(call({}, 'HEAD').status).toBe(200);
  });

  it('registers on the aggregated /api router so the standard auth gate applies', () => {
    const api = require('../../routes/api');
    const aggregated = {};
    api.registerRoutes(aggregated);
    expect(typeof aggregated['/api/physical-ai']).toBe('function');
  });

  // Runs last: it mutates fixtures. A slug with no sources record must report
  // status unknown (null), never a false "disabled".
  it('reports missing source records as unknown status, not disabled', () => {
    db.prepare('DELETE FROM information_items WHERE source_id = ?').run('s-sec');
    db.prepare('DELETE FROM sources WHERE slug = ?').run('physical-ai-sec-8k');
    const snapshot = getPhysicalAiSnapshot(db, { days: 30 });
    expect(snapshot.categories.find((entry) => entry.key === 'open'))
      .toEqual({ key: 'open', source_slug: null, count: 0, is_active: null });
    expect(getPhysicalAiItems(db, { days: 30, category: 'filings', limit: 120 })).toEqual([]);
  });
});
