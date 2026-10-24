// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */
const Database = require('better-sqlite3');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

// This fixture mirrors the production restart envelope: 17 active sources,
// 16 durable fetch rows, three failed sources, and an x-following row that
// was never written by the pipeline because feed mode owns that source.
const ACTIVE_SOURCES = [
  'hacker-news',
  'github-trending',
  'product-hunt',
  'hugging-face',
  'techmeme',
  'solidot',
  'startup-archive',
  'app-store-rank',
  'app-store-trend',
  'physical-ai-arxiv',
  'physical-ai-humanoid',
  'physical-ai-cn-photonics',
  'physical-ai-sec-8k',
  'v2ex',
  'lobsters',
  'x-following',
  'reddit',
];

const CHECKPOINT_ERRORS = {
  reddit: 'AUTH_REQUIRED',
  solidot: 'Upstream 503',
  'physical-ai-cn-photonics': 'source exceeded 180000ms budget',
};

function checkpointRows() {
  const successful = ACTIVE_SOURCES.filter(slug => slug !== 'x-following' && !CHECKPOINT_ERRORS[slug]);
  expect(successful).toHaveLength(13);
  return successful.map((slug, index) => ({
    source: slug,
    items: index === 0 ? 3 : 0,
    inserted: index === 0 ? 3 : 0,
  })).concat(Object.entries(CHECKPOINT_ERRORS).map(([source, error]) => ({ source, error })));
}

describe('fetchAllSources restart checkpoint integration', () => {
  let db;
  let connectorCalls;
  let restoreConsole;

  function compileIndex() {
    const filename = path.resolve(__dirname, '../../connectors/index.js');
    const subject = new Module(filename, module);
    subject.filename = filename;
    // Registry construction is the only place where export names map to the
    // source slugs used by duplicate connector classes (RSS, Arxiv, AppStore).
    let rssCount = 0;
    let arxivCount = 0;
    let appStoreCount = 0;
    const connectorModule = new Proxy({}, {
      get: (_target, prop) => {
        if (prop === '__esModule') return false;
        const slugs = {
          HNConnector: 'hacker-news',
          GitHubConnector: 'github-trending',
          ProductHuntConnector: 'product-hunt',
          HuggingFaceConnector: 'hugging-face',
          StartupArchiveConnector: 'startup-archive',
          SEC8KConnector: 'physical-ai-sec-8k',
          HumanoidConnector: 'physical-ai-humanoid',
          CNPhotonicsConnector: 'physical-ai-cn-photonics',
          V2EXConnector: 'v2ex',
          LobstersConnector: 'lobsters',
          XFollowingConnector: 'x-following',
          RedditConnector: 'reddit',
          XiaoHongShuConnector: 'xiaohongshu',
        };
        let slug = slugs[prop];
        if (prop === 'RSSConnector') slug = ++rssCount === 1 ? 'techmeme' : 'solidot';
        if (prop === 'ArxivConnector') slug = ++arxivCount === 1 ? 'arxiv-ai' : 'physical-ai-arxiv';
        if (prop === 'AppStoreRankConnector') slug = 'app-store-rank';
        if (prop === 'AppStoreTrendConnector') slug = 'app-store-trend';
        return class ProbeConnector {
          static resolveMode() { return 'feed'; }
          constructor(registrySlug) { this.slug = registrySlug || slug; }
          async fetch(date) {
            connectorCalls.push({ slug: this.slug, date });
            if (CHECKPOINT_ERRORS[this.slug]) {
              const err = new Error(CHECKPOINT_ERRORS[this.slug]);
              if (this.slug === 'physical-ai-cn-photonics') err.name = 'TimeoutError';
              throw err;
            }
            return [];
          }
          saveItems() {
            return { items: [], inserted: 0, existing: 0, duplicates: 0, skipped: 0, failed: 0 };
          }
        };
      },
    });
    subject.require = id => {
      if (id === '../db/connection') return { getDB: () => db };
      if (id === './base') return require('../../connectors/base');
      if (id.startsWith('./')) return connectorModule;
      return require(id.startsWith('.') ? path.resolve(path.dirname(filename), id) : id);
    };
    subject._compile(fs.readFileSync(filename, 'utf8'), filename);
    return subject.exports;
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE sources (id INTEGER PRIMARY KEY, slug TEXT UNIQUE, is_active INTEGER NOT NULL)');
    const insert = db.prepare('INSERT INTO sources (slug, is_active) VALUES (?, 1)');
    for (const slug of ACTIVE_SOURCES) insert.run(slug);
    connectorCalls = [];
    restoreConsole = [];
    for (const method of ['log', 'warn', 'error']) {
      restoreConsole.push(vi.spyOn(console, method).mockImplementation(() => {}));
    }
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('retries only error rows, fills the missing feed-mode source, and reuses valid checkpoints', async () => {
    const { fetchAllSources } = compileIndex();
    const checkpoint = checkpointRows();
    expect(checkpoint).toHaveLength(16);

    const rows = await fetchAllSources('2026-10-23', { checkpoint });

    expect(rows).toHaveLength(17);
    const bySource = Object.fromEntries(rows.map(row => [row.source, row]));
    expect(Object.keys(bySource)).toEqual(expect.arrayContaining(ACTIVE_SOURCES));

    for (const row of checkpoint.filter(row => !row.error)) {
      expect(bySource[row.source]).toEqual({ ...row, checkpoint_reused: true });
    }
    for (const slug of Object.keys(CHECKPOINT_ERRORS)) {
      expect(bySource[slug]).toMatchObject({ source: slug, error: CHECKPOINT_ERRORS[slug] });
      expect(bySource[slug].checkpoint_reused).toBeUndefined();
    }
    expect(bySource['x-following']).toEqual({
      source: 'x-following',
      items: 0,
      skipped_by: 'incremental-mode',
    });

    // Exactly the 3 failed rows are retried. Feed mode owns x-following, and
    // all 13 successful/empty rows are durable checkpoints, so no connector
    // work is repeated.
    expect(connectorCalls.map(call => call.slug).sort()).toEqual([
      'physical-ai-cn-photonics',
      'reddit',
      'solidot',
    ]);
    expect(new Set(connectorCalls.map(call => call.date))).toEqual(new Set(['20261023']));
  });

  it('keeps a second recovery idempotent by retrying only the still-failed rows', async () => {
    const { fetchAllSources } = compileIndex();
    const checkpoint = checkpointRows();

    const first = await fetchAllSources('2026-10-23', { checkpoint });
    connectorCalls.length = 0;
    const second = await fetchAllSources('2026-10-23', { checkpoint: first });

    expect(connectorCalls.map(call => call.slug).sort()).toEqual([
      'physical-ai-cn-photonics',
      'reddit',
      'solidot',
    ]);
    expect(second.filter(row => row.checkpoint_reused)).toHaveLength(14);
    expect(second.filter(row => row.error)).toHaveLength(3);
  });
});
