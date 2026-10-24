// @vitest-environment node
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');
const utils = require('../utils');
const { describe, it, expect, beforeEach, afterEach } = globalThis;

function harness(db, options = {}) {
  const cache = new Map();
  const requests = [];
  const enrichCalls = [];
  let cancelled = false;
  const serverRoot = path.resolve(__dirname, '../..');
  const fixedDate = '20260909';
  // D2 window contract: story timestamps must be relative to the real clock
  // and inside the 36h fetch window — day filtering is now
  // isWithinFetchWindow-based (date-contract.js), not digest-day ==
  // item-UTC-day equality.
  const stories = options.stories || Array.from({ length: 40 }, (_, index) => ({
    id: index + 1, title: `Story ${index + 1}`, url: `https://example.com/story-${index + 1}`,
    by: 'author', score: 20, descendants: 3, time: Math.floor(Date.now() / 1000) - 7 * 3600,
  }));
  const fetchURL = async (url) => {
    requests.push(url);
    if (options.fetchError) throw options.fetchError;
    if (url.endsWith('topstories.json')) return JSON.stringify(stories.map((_, index) => index + 1));
    const id = Number(url.match(/item\/(\d+)\.json/)[1]);
    if (options.cancelDuringFetch) cancelled = true;
    const story = stories[id - 1];
    if (story instanceof Error) throw story;
    return JSON.stringify(story);
  };
  function load(relativePath) {
    const filename = path.join(serverRoot, relativePath);
    if (cache.has(filename)) return cache.get(filename);
    const module = { exports: {} };
    const context = {
      module, console: { log() {}, warn() {}, error() {} }, URL, setTimeout, clearTimeout, setInterval, clearInterval,
      AbortController: globalThis.AbortController,
      process: { env: { SYNC_ENRICH_BATCH_SIZE: '1600' } },
      require(name) {
        if (name === '../db/connection') return { getDB: () => db };
        if (name === '../services/utils') return { ...utils, fetchURL };
        if (name === '../services/date-contract') return require('../date-contract');
        if (name === '../services/x-following-config') return { readBlocklist: () => new Set(), isBlocked: () => false };
        if (name === './llm') return { enrichItems: async (...args) => { enrichCalls.push(args); return { enriched: 1 }; } };
        if (name === './jobs') return { isJobCancelled: () => cancelled };
        if (name === './date-contract') return require('../date-contract');
        if (name === '../connectors/index') return load('connectors/index.js');
        if (name === '../services/outbox') return require('../outbox');
        if (name === './base') return load('connectors/base.js');
        if (name === './hn') return load('connectors/hn.js');
        if (options.realDescriptionConnectors && name === './github') return load('connectors/github.js');
        if (options.realDescriptionConnectors && name === './huggingface') return load('connectors/huggingface.js');
        if (relativePath === 'connectors/index.js') {
          class OtherConnector extends load('connectors/base.js').BaseConnector {
            constructor() { super('github-trending'); }
            async fetch() {
              return stories.slice(0, 8).map(raw => ({ ...this.normalize(raw), digest_date: fixedDate }));
            }
          }
          return new Proxy({}, { get: () => OtherConnector });
        }
        throw new Error(`Unexpected require ${name} from ${relativePath}`);
      },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    cache.set(filename, module.exports);
    return module.exports;
  }
  return { sync: load('services/sync.js'), registry: load('connectors/index.js'),
    BaseConnector: load('connectors/base.js').BaseConnector, requests, enrichCalls };
}

describe('bounded single-source sync', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/001_initial_schema.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/033_item_time_contract.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/040_outbox.sql'), 'utf8'));
  });
  afterEach(() => db.close());

  it('caps HN fanout before requests, persists normally, and never auto-enriches a bounded sync', async () => {
    const h = harness(db);
    const result = await h.sync.syncSource('hacker-news', '20260909', { limit: 5 });
    expect(h.requests).toHaveLength(6);
    expect(result).toMatchObject({ source: 'hacker-news', date: '20260909', limit: 5,
      requested: 5, fetched: 5, inserted: 5, existing: 0, failed: 0, skipped: 0, enrichment_skipped: true });
    expect(result.items).toHaveLength(5);
    expect(h.enrichCalls).toEqual([]);
    const row = db.prepare('SELECT * FROM information_items ORDER BY external_id LIMIT 1').get();
    expect(row.digest_date).toBe('2026-09-09');
    expect(JSON.parse(row.source_payload).hnId).toBe(1);
    expect(row.content_hash).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) count FROM information_items').get().count).toBe(5);
    const repeat = await h.sync.syncSource('hacker-news', '20260909', { limit: 5, skipEnrich: true });
    expect(repeat).toMatchObject({ inserted: 0, existing: 5, failed: 0 });
    expect(repeat.items).toEqual([]);
    expect(h.enrichCalls).toEqual([]);
  });

  it('preserves the legacy unbounded call contract and automatic enrichment', async () => {
    const h = harness(db);
    const result = await h.sync.syncSource('hacker-news', '20260909');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(30);
    expect(h.requests).toHaveLength(31);
    expect(h.enrichCalls).toHaveLength(1);
    expect(h.enrichCalls[0][0]).toBe(1600);
    expect(h.enrichCalls[0][1].signal).toBeUndefined();
  });

  it('separates failed requests from deleted or out-of-date stories', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const h = harness(db, { stories: [new Error('request failed'), { deleted: true },
      { id: 3, title: 'Old', time: nowSec - 40 * 3600 }, null,
      { id: 5, title: 'Today', time: nowSec - 7 * 3600 }] });
    const result = await h.sync.syncSource('hacker-news', '20260909', { limit: 5, skipEnrich: true });
    expect(result).toMatchObject({ requested: 5, inserted: 1, existing: 0, skipped: 2, failed: 2 });
    expect(h.enrichCalls).toEqual([]);
  });

  it('rejects invalid limits before any network request', async () => {
    const h = harness(db);
    for (const limit of [0, -1, 101, 1.5, NaN, Infinity, true, null, '5oops']) {
      await expect(h.sync.syncSource('hacker-news', '20260909', { limit })).rejects.toThrow('limit');
    }
    expect(h.requests).toEqual([]);
  });

  it('caps persistence even when another connector ignores the requested limit', async () => {
    const h = harness(db);
    const result = await h.registry.fetchSource('github-trending', '20260909', { limit: 2 });
    expect(result).toMatchObject({ inserted: 2, fetched: 8, skipped: 6, failed: 0 });
    expect(db.prepare('SELECT COUNT(*) count FROM information_items').get().count).toBe(2);
  });

  it.each(['github-trending', 'hugging-face'])('propagates bounded %s network failures while preserving legacy empty results', async (slug) => {
    const h = harness(db, { realDescriptionConnectors: true, fetchError: new Error('upstream TLS failed') });
    await expect(h.sync.syncSource(slug, '20260909', { limit: 5, skipEnrich: true })).rejects.toThrow('upstream TLS failed');
    expect(h.requests).toHaveLength(1);
    expect(h.enrichCalls).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) count FROM information_items').get().count).toBe(0);
    await expect(h.registry.fetchSource(slug, '20260909')).resolves.toEqual([]);
    expect(h.requests).toHaveLength(2);
  });

  it('reports a rolled-back batch as failed with no phantom saved items', () => {
    const h = harness(db);
    const connector = new h.BaseConnector('hacker-news');
    const good = connector.normalize({ title: 'Good', url: 'https://example.com/good' });
    const bad = connector.normalize({ title: 'Bad', url: 'https://example.com/bad' });
    bad.source_id = 'missing-source';
    const result = connector.saveItems([good, bad], { returnDetails: true });
    expect(result).toMatchObject({ inserted: 0, existing: 0, failed: 2, items: [] });
    expect(result.error).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) count FROM information_items').get().count).toBe(0);
  });

  it('does not persist or enrich if cancelled while fetching', async () => {
    const h = harness(db, { cancelDuringFetch: true });
    const result = await h.sync.syncSource('hacker-news', '20260909', { limit: 5, skipEnrich: true, jobId: 'job' });
    expect(result).toMatchObject({ cancelled: true, inserted: 0, existing: 0, enrichment_skipped: true });
    expect(db.prepare('SELECT COUNT(*) count FROM information_items').get().count).toBe(0);
    expect(h.enrichCalls).toEqual([]);
  });
});
