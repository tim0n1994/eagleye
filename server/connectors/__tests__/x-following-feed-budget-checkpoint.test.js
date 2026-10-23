import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.TZ = 'Asia/Shanghai';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const X_FOLLOWING_PATH = path.resolve(import.meta.dirname, '../../connectors/x-following.js');

function compileModule(filename, stubs) {
  const subject = new Module(filename, module);
  subject.filename = filename;
  subject.require = (id) => {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
    return require(id.startsWith('.') ? path.resolve(path.dirname(filename), id) : id);
  };
  subject._compile(fs.readFileSync(filename, 'utf8'), filename);
  return subject.exports;
}

const BASE_ID = '1850000000000000';

function tweet(suffix, handle, extra = {}) {
  const id = BASE_ID + String(suffix).padStart(3, '0');
  return {
    id,
    text: extra.text ?? `fixture tweet ${suffix} from @${handle}`,
    createdAtISO: extra.at ?? '2026-10-23T08:00:00+08:00',
    metrics: { views: 100, likes: 10, retweets: 1, replies: 1, bookmarks: 0 },
    author: { screenName: handle },
    lang: 'en',
    ...(extra.isRetweet ? { isRetweet: true } : {}),
  };
}

function oldRun(start, handle, count = 8) {
  return Array.from({ length: count }, (_, index) => tweet(start - index, handle));
}

function pageEnvelope(page) {
  if (!page || page.failure) {
    return { ok: false, code: page?.code || 'UPSTREAM_FAILED', message: page?.message || 'controlled upstream failure' };
  }
  const envelope = { ok: true, schema_version: '1', data: page.tweets || [] };
  if (page.cursor !== undefined) envelope.cursor = page.cursor;
  return envelope;
}

function buildHarness({ users = ['alice'], initialCursor = null, pages = [], hangFeed = false } = {}) {
  const store = new Map();
  const setValueCalls = [];
  let feedCalls = 0;
  if (initialCursor) store.set('x_following_cursor', initialCursor);

  const getUserData = () => store;
  const setValue = vi.fn((key, value, scope) => {
    store.set(key, value);
    setValueCalls.push({ key, value, scope });
    if (key === 'x_following_cursor') {
      const db = require('../../db/connection').getDB();
      setValueCalls.at(-1).informationItems = db.prepare('SELECT COUNT(*) AS count FROM information_items').get().count;
      setValueCalls.at(-1).outbox = db.prepare('SELECT COUNT(*) AS count FROM outbox').get().count;
    }
  });
  const userData = {
    getValue: (key) => store.get(key) ?? null,
    setValue,
    GLOBAL_SCOPE: '',
  };

  const runReach = vi.fn(async (_command, args, options = {}) => {
    if (_command !== 'twitter' || args?.[0] !== 'feed') {
      return { ok: false, code: 'UNEXPECTED_COMMAND', message: `unexpected ${_command} ${args?.join(' ')}` };
    }
    feedCalls += 1;
    if (hangFeed) {
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    return pageEnvelope(pages[feedCalls - 1]);
  });
  const twitterUserPosts = vi.fn(async () => ({ ok: true, data: [] }));

  const reach = {
    runReach,
    twitterUserPosts,
    isReachReady: vi.fn(async () => true),
  };
  const config = {
    readXFollowingConfig: () => ({ users: [...users], path: 'fixture', exists: true }),
    readBlocklist: () => new Set(),
    isBlocked: () => false,
  };
  const utils = {
    fetchURL: vi.fn(async () => {
      throw new Error('network disabled');
    }),
  };

  const { XFollowingConnector } = compileModule(X_FOLLOWING_PATH, {
    '../services/agent-reach': reach,
    '../services/utils': utils,
    '../services/x-following-config': config,
    '../db/user-data': userData,
    '../db/user-data.js': userData,
  });

  return {
    connector: new XFollowingConnector(),
    feedCallCount: () => feedCalls,
    getUserData,
    runReach,
    setValueCalls,
    twitterUserPosts,
  };
}

function feedArgs(runReach) {
  return runReach.mock.calls
    .filter(([command, args]) => command === 'twitter' && args?.[0] === 'feed')
    .map(([, args]) => args);
}

function cursorValue(store) {
  return store.get('x_following_cursor') || null;
}

function failureValue(store) {
  return store.get('x_following_failure') || null;
}

// Node's production AbortSignal exposes listeners but no signal.abort(); only
// AbortController can cancel. Vitest's DOM environment can expose a different
// signal shape, so pin this test to the runtime shape that crashed production.
class ProductionShapedAbortController {
  constructor() {
    this.signal = {
      aborted: false,
      reason: undefined,
      _listeners: new Set(),
      addEventListener(type, listener) {
        if (type === 'abort') this._listeners.add(listener);
      },
      removeEventListener(type, listener) {
        if (type === 'abort') this._listeners.delete(listener);
      },
      throwIfAborted() {
        if (this.aborted) throw this.reason;
      },
    };
  }

  abort(reason) {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason;
    for (const listener of this.signal._listeners) listener({ type: 'abort' });
  }
}

describe('x-following strict feed budget and checkpoint behavior', () => {
  let dbDirectory;
  let db;
  let previousEnvironment;

  const setEnv = (key, value) => {
    previousEnvironment.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeAll(() => {
    previousEnvironment = new Map();
    dbDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-x-budget-'));
    process.env.EAGLEYE_DB_PATH = path.join(dbDirectory, 'connector.sqlite');
    const { getDB } = require('../../db/connection');
    db = getDB();
    db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        is_active INTEGER NOT NULL DEFAULT 1,
        item_count INTEGER DEFAULT 0,
        last_fetched_at TEXT
      );
      CREATE TABLE IF NOT EXISTS information_items (
        id TEXT PRIMARY KEY,
        source_id TEXT REFERENCES sources(id),
        canonical_url TEXT NOT NULL,
        external_id TEXT,
        title TEXT NOT NULL,
        original_summary TEXT,
        content_text TEXT,
        language TEXT DEFAULT 'en',
        author TEXT,
        published_at TEXT,
        published_raw TEXT,
        published_precision TEXT,
        published_parse_status TEXT,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
        digest_date TEXT NOT NULL,
        source_payload TEXT NOT NULL DEFAULT '{}',
        normalized_payload TEXT NOT NULL DEFAULT '{}',
        score REAL DEFAULT 0,
        popularity TEXT DEFAULT '{}',
        content_hash TEXT,
        duplicate_group_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(source_id, canonical_url, digest_date)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        unique_key TEXT UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        dispatched_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
    `);
    db.prepare(`
      INSERT INTO sources (id, slug, label)
      VALUES ('source-x-following', 'x-following', 'X following')
      ON CONFLICT(slug) DO NOTHING
    `).run();
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db.exec('DELETE FROM outbox; DELETE FROM information_items;');
    db.prepare('UPDATE sources SET item_count = 0, last_fetched_at = NULL WHERE slug = ?').run('x-following');
    for (const key of [
      'X_FOLLOWING_MODE',
      'X_FOLLOWING_USERS',
      'X_FOLLOWING_DB_BATCH_SIZE',
      'X_FOLLOWING_FEED_PAGE_SIZE',
      'X_FOLLOWING_FEED_MAX_PAGES',
      'X_FOLLOWING_FEED_PAGE_TIMEOUT_MS',
      'X_FOLLOWING_FEED_TOTAL_TIMEOUT_MS',
      'X_FOLLOWING_FAILURE_COOLDOWN_MS',
      'X_FOLLOWING_CURSOR_CONFIRM_RUN',
      'X_FOLLOWING_INCLUDE_RT',
    ]) setEnv(key, undefined);
  });

  afterEach(() => {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previousEnvironment.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    const { closeDB } = require('../../db/connection');
    closeDB();
    if (dbDirectory) fs.rmSync(dbDirectory, { recursive: true, force: true });
    delete process.env.EAGLEYE_DB_PATH;
  });

  it('defaults to feed and never falls back to per-user after a feed failure', async () => {
    setEnv('X_FOLLOWING_FAILURE_COOLDOWN_MS', '0');
    const harness = buildHarness({
      pages: [{ failure: true, code: 'FEED_DOWN' }],
    });

    const result = await harness.connector.fetch('20261023');

    expect(result).toEqual([]);
    expect(feedArgs(harness.runReach)).toHaveLength(1);
    expect(feedArgs(harness.runReach)[0]).toEqual(expect.arrayContaining(['-t', 'following', '--json']));
    expect(harness.twitterUserPosts).not.toHaveBeenCalled();
    expect(harness.getUserData().has('x_following_cursor')).toBe(false);
    expect(failureValue(harness.getUserData())?.reason).toContain('FEED_DOWN');
  });

  it('keeps explicit per-user as legacy while feed remains the default route', async () => {
    setEnv('X_FOLLOWING_MODE', 'per-user');
    setEnv('X_FOLLOWING_TWEETS_PER_USER', '1');
    const harness = buildHarness({ users: ['alice'] });
    harness.twitterUserPosts.mockImplementation(async (username) => ({
      ok: true,
      data: [tweet(901, username)],
    }));

    const result = await harness.connector.fetch('20261023');

    expect(harness.feedCallCount()).toBe(0);
    expect(harness.twitterUserPosts).toHaveBeenCalledWith('alice', 1, { signal: undefined });
    expect(result).toHaveLength(1);
    expect(result[0].external_id).toBe(`x:${BASE_ID}901`);
  });

  it('persists page batches incrementally and advances the cursor only after each save', async () => {
    setEnv('X_FOLLOWING_DB_BATCH_SIZE', '1');
    const harness = buildHarness({
      pages: [{ tweets: [tweet(301, 'alice'), tweet(300, 'alice'), tweet(299, 'alice')] }],
    });

    const result = await harness.connector.fetchViaFeed(['alice']);

    expect(result).toHaveLength(3);
    expect(db.prepare('SELECT COUNT(*) AS count FROM information_items').get().count).toBe(3);
    expect(db.prepare('SELECT COUNT(*) AS count FROM outbox').get().count).toBe(3);
    const cursorWrites = harness.setValueCalls.filter((call) => call.key === 'x_following_cursor');
    // A following feed is newest-first. Batch checkpoints for lower ids must
    // never move the global watermark backwards after the first batch.
    expect(cursorWrites.map((call) => call.value.cursor)).toEqual([`${BASE_ID}301`]);
    expect(cursorWrites.map((call) => call.informationItems)).toEqual([1]);
    expect(cursorWrites.at(-1).outbox).toBe(1);
  });

  it('preserves an earlier batch and checkpoint when a later batch fails to persist', async () => {
    setEnv('X_FOLLOWING_DB_BATCH_SIZE', '1');
    const harness = buildHarness({
      pages: [{ tweets: [tweet(401, 'alice'), tweet(400, 'alice', { text: 'trigger persist-failure here' })] }],
    });
    db.exec(`
      CREATE TRIGGER force_x_persistence_failure
      BEFORE INSERT ON information_items
      WHEN NEW.title LIKE '%persist-failure%'
      BEGIN
        SELECT RAISE(ABORT, 'forced persistence failure');
      END;
    `);

    try {
      const result = await harness.connector.fetchViaFeed(['alice']);
      expect(result).toHaveLength(1);
      expect(db.prepare('SELECT COUNT(*) AS count FROM information_items').get().count).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS count FROM outbox').get().count).toBe(1);
      expect(cursorValue(harness.getUserData())?.cursor).toBe(`${BASE_ID}401`);
      expect(failureValue(harness.getUserData())?.reason).toContain('forced persistence failure');
    } finally {
      db.exec('DROP TRIGGER force_x_persistence_failure');
    }
  });

  it('resumes from the preserved checkpoint without repeating old feed data', async () => {
    setEnv('X_FOLLOWING_FAILURE_COOLDOWN_MS', '0');
    const harness = buildHarness({
      pages: [
        { tweets: [tweet(501, 'alice')], cursor: 'page-2' },
        { failure: true },
        { tweets: [tweet(501, 'alice'), tweet(502, 'alice'), ...oldRun(500, 'alice')] },
      ],
    });

    const firstResult = await harness.connector.fetchViaFeed(['alice']);
    expect(firstResult).toHaveLength(1);
    expect(cursorValue(harness.getUserData())?.cursor).toBe(`${BASE_ID}501`);

    harness.getUserData().set('x_following_failure', {
      last_failure_at: new Date(Date.now() - 3600_000).toISOString(),
      next_attempt_at: new Date(Date.now() - 1800_000).toISOString(),
      reason: 'expired',
      count: 1,
    });
    const secondResult = await harness.connector.fetchViaFeed(['alice']);

    expect(secondResult).toHaveLength(1);
    expect(secondResult[0].external_id).toBe(`x:${BASE_ID}502`);
    expect(harness.feedCallCount()).toBe(3);
    const rows = db.prepare('SELECT external_id FROM information_items ORDER BY external_id').all();
    expect(rows.map((row) => row.external_id)).toEqual([`x:${BASE_ID}501`, `x:${BASE_ID}502`]);
    expect(cursorValue(harness.getUserData())?.cursor).toBe(`${BASE_ID}502`);
  });

  it('uses failure cooldown before retrying and retries only after it expires', async () => {
    setEnv('X_FOLLOWING_FAILURE_COOLDOWN_MS', String(30 * 60 * 1000));
    const harness = buildHarness({
      pages: [
        { failure: true },
        { tweets: [tweet(601, 'alice')] },
      ],
    });

    await expect(harness.connector.fetchViaFeed(['alice'])).resolves.toEqual([]);
    expect(harness.feedCallCount()).toBe(1);
    expect(cursorValue(harness.getUserData())).toBeNull();
    const cooldown = failureValue(harness.getUserData());
    expect(Date.parse(cooldown.next_attempt_at) - Date.parse(cooldown.last_failure_at)).toBe(30 * 60 * 1000);

    await expect(harness.connector.fetchViaFeed(['alice'])).resolves.toEqual([]);
    expect(harness.feedCallCount()).toBe(1);

    cooldown.next_attempt_at = new Date(Date.now() - 1000).toISOString();
    harness.getUserData().set('x_following_failure', cooldown);
    const recovered = await harness.connector.fetchViaFeed(['alice']);
    expect(harness.feedCallCount()).toBe(2);
    expect(recovered).toHaveLength(1);
    expect(cursorValue(harness.getUserData())?.cursor).toBe(`${BASE_ID}601`);
  });

  it('aborts a hung feed page before the pipeline budget and ignores its late result', async () => {
    vi.useFakeTimers();
    setEnv('X_FOLLOWING_FEED_TOTAL_TIMEOUT_MS', '5000');
    setEnv('X_FOLLOWING_FEED_PAGE_TIMEOUT_MS', '4000');
    setEnv('X_FOLLOWING_FAILURE_COOLDOWN_MS', '0');
    const harness = buildHarness({ hangFeed: true });

    const originalAbortController = globalThis.AbortController;
    globalThis.AbortController = ProductionShapedAbortController;
    let result;
    try {
      const run = harness.connector.fetchViaFeed(['alice']);
      await vi.advanceTimersByTimeAsync(4001);
      result = await run;
    } finally {
      globalThis.AbortController = originalAbortController;
    }

    expect(result).toEqual([]);
    expect(feedArgs(harness.runReach)[0]).toEqual(expect.arrayContaining(['-t', 'following', '-n', '200']));
    const upstreamSignal = harness.runReach.mock.calls[0][2]?.signal;
    expect(typeof upstreamSignal?.abort).toBe('undefined');
    expect(upstreamSignal?.aborted).toBe(true);
    expect(upstreamSignal?.reason?.name).toBe('TimeoutError');
    expect(cursorValue(harness.getUserData())).toBeNull();

    let lateUpstreamSettled = false;
    harness.runReach.mock.results.at(0).value.then(() => {
      lateUpstreamSettled = true;
    }, () => {
      lateUpstreamSettled = true;
    });
    await Promise.resolve();
    expect(lateUpstreamSettled).toBe(true);
    expect(cursorValue(harness.getUserData())).toBeNull();
  });

  it('propagates an external abort promptly instead of treating it as feed cooldown', async () => {
    setEnv('X_FOLLOWING_FEED_TOTAL_TIMEOUT_MS', '5000');
    setEnv('X_FOLLOWING_FEED_PAGE_TIMEOUT_MS', '5000');
    const harness = buildHarness({ hangFeed: true });
    const controller = new AbortController();
    const started = Date.now();

    const run = harness.connector.fetchViaFeed(['alice'], { signal: controller.signal });
    await vi.waitFor(() => expect(harness.feedCallCount()).toBe(1));
    controller.abort(new Error('caller deadline reached'));

    await expect(run).rejects.toThrow('caller deadline reached');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(cursorValue(harness.getUserData())).toBeNull();
    expect(failureValue(harness.getUserData())).toBeNull();
  });
});
