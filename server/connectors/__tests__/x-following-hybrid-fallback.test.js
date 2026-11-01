/**
 * R2.1 x-following hybrid lane（feed-first + 限频 per-user 降级）契约测试。
 *
 * Contract under test (server/connectors/x-following.js fetchHybrid)：
 *   X_FOLLOWING_MODE=hybrid（显式）时：
 *     - feed 优先：feed 成功 → 与 feed 模式完全一致（无 user-posts）。
 *     - feed 明确失败（非 FEED_COOLDOWN）→ 同一轮降级到旧 per-user 扫描，
 *       最多每 X_FOLLOWING_FULL_FALLBACK_COOLDOWN_MS（默认 24h）一次 ——
 *       2h timer 永远不会连续 tick 重复 442 账号全量扫。
 *     - FEED_COOLDOWN（被冷却抑制的 tick）→ 原样抛出，绝不降级扫描。
 *     - 降级运行后在同一 failure ledger（x_following_failure）记录
 *       last_full_fallback_at；后续 feed 失败重写账本时必须保留该字段。
 *     - 降级结果不推进 feed 游标（x_following_cursor 不被写入）。
 *
 * 与 x-following-feed-incremental.test.js 同形态：CLI 全 mock（agent-reach
 * stub）、user-data 读写 mock、EAGLEYE_DB_PATH 指向临时库（feed 分页真实走
 * BaseConnector.saveItems 持久化），零真实网络/进程调用。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const X_FOLLOWING_PATH = path.resolve(import.meta.dirname, '../../connectors/x-following.js');

const { getDB, closeDB } = require('../../db/connection');
const previousDbPath = process.env.EAGLEYE_DB_PATH;
let hermeticDbDir = null;

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

// 19 位 snowflake fixture（同 incremental 测试）。
const BASE = '1850000000000000';
const CURSOR_ID = `${BASE}200`;

function tw(suffix, handle, extra = {}) {
  const id = BASE + String(suffix).padStart(3, '0');
  return {
    id,
    text: extra.text ?? `fixture tweet ${suffix} from @${handle}`,
    createdAtISO: extra.at ?? '2026-10-20T08:00:00+08:00',
    metrics: { views: 1000, likes: 10, retweets: 1, replies: 1, bookmarks: 0 },
    author: { screenName: handle },
    lang: 'en',
    ...(extra.isRetweet ? { isRetweet: true } : {}),
  };
}

const idsOf = (items) => items.map((it) => it.external_id);

const oldRun = (start, handle, n = 8) => Array.from({ length: n }, (_, i) => tw(start - i, handle));

function buildHarness({ users, cursor, pages = [], feedError = null, userPosts = {}, failureState = null } = {}) {
  let feedCalls = 0;
  let failureLedger = failureState ? { ...failureState } : null;
  const runReach = vi.fn(async (cmd, args) => {
    if (cmd === 'twitter' && Array.isArray(args) && args[0] === 'feed') {
      feedCalls += 1;
      if (feedError && feedCalls === 1) {
        return { ok: false, code: feedError.code, message: feedError.message, stdout: '', stderr: '' };
      }
      const page = pages[feedCalls - 1];
      if (!page) return { ok: true, data: [], raw: { ok: true, data: [] }, stdout: '', stderr: '' };
      const envelope = { ok: true, schema_version: '1', data: page.tweets };
      if (page.cursor !== undefined) envelope.cursor = page.cursor;
      return {
        ok: true,
        data: page.tweets,
        raw: envelope,
        ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
        stdout: JSON.stringify(envelope),
        stderr: '',
      };
    }
    return { ok: false, code: 'EXIT_1', message: `unexpected command ${cmd} ${JSON.stringify(args)}`, stdout: '', stderr: '' };
  });

  const twitterUserPosts = vi.fn(async (username, count = 10) => ({
    ok: true,
    data: (userPosts[String(username).replace(/^@/, '')] || []).slice(0, count),
  }));

  const reach = { runReach, twitterUserPosts, isReachReady: vi.fn(async () => true) };
  const ud = {
    getValue: vi.fn((key) => {
      if (key === 'x_following_cursor') return cursor;
      if (key === 'x_following_failure') return failureLedger;
      return null;
    }),
    setValue: vi.fn((key, value) => {
      if (key === 'x_following_failure') failureLedger = { ...value };
    }),
    GLOBAL_SCOPE: '',
  };
  const cfg = {
    readXFollowingConfig: () => ({ users: [...users], path: 'fixture', exists: true }),
    readBlocklist: () => new Set(),
  };
  const utils = { fetchURL: vi.fn(async () => { throw new Error('network disabled in test'); }) };

  const { XFollowingConnector } = compileModule(X_FOLLOWING_PATH, {
    '../services/agent-reach': reach,
    '../services/utils': utils,
    '../services/x-following-config': cfg,
    '../db/user-data': ud,
    '../db/user-data.js': ud,
  });
  return { connector: new XFollowingConnector(), reach, ud, runReach, twitterUserPosts };
}

const feedCallCount = (runReach) =>
  runReach.mock.calls.filter(([cmd, args]) => cmd === 'twitter' && Array.isArray(args) && args[0] === 'feed').length;

describe('R2.1 hybrid lane：feed 优先、限频降级', () => {
  beforeAll(() => {
    hermeticDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-x-hybrid-'));
    process.env.EAGLEYE_DB_PATH = path.join(hermeticDbDir, 'hermetic.sqlite');
    const db = getDB();
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
    const db = getDB();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db.exec('DELETE FROM outbox; DELETE FROM information_items;');
    db.prepare('UPDATE sources SET item_count = 0, last_fetched_at = NULL WHERE slug = ?').run('x-following');
    process.env.X_FOLLOWING_MODE = 'hybrid';
    delete process.env.X_FOLLOWING_FAILURE_COOLDOWN_MS;
    delete process.env.X_FOLLOWING_FULL_FALLBACK_COOLDOWN_MS;
    delete process.env.X_FOLLOWING_INCLUDE_RT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    closeDB();
    if (previousDbPath === undefined) delete process.env.EAGLEYE_DB_PATH;
    else process.env.EAGLEYE_DB_PATH = previousDbPath;
    if (hermeticDbDir) fs.rmSync(hermeticDbDir, { recursive: true, force: true });
  });

  it('H1 hybrid + feed 成功：行为与 feed 模式一致（无 user-posts、写游标、无失败账本写入）', async () => {
    const h = buildHarness({
      users: ['alice'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      pages: [{ tweets: [tw(460, 'alice'), ...oldRun(150, 'alice')], cursor: 'page-2' }],
    });

    const items = await h.connector.fetch('20261020');

    expect(feedCallCount(h.runReach), 'feed 优先被使用').toBe(1);
    expect(h.twitterUserPosts.mock.calls.length, 'feed 成功时严禁逐账号扫描').toBe(0);
    expect(idsOf(items), '返回游标之后的新推').toEqual([`x:${BASE}460`]);
    const cursorWrite = h.ud.setValue.mock.calls.find(([key]) => key === 'x_following_cursor');
    expect(String(cursorWrite?.[1]?.cursor), 'feed 成功推进游标').toBe(`${BASE}460`);
    expect(
      h.ud.setValue.mock.calls.some(([key]) => key === 'x_following_failure'),
      '成功路径不写失败账本',
    ).toBe(false);
  });

  it('H2 hybrid + feed 明确失败（降级窗口开放）：同一轮降级 per-user，成功返回且不推进游标', async () => {
    const h = buildHarness({
      users: ['alice', 'bob'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      feedError: { code: 'EXIT_1', message: 'Clienttransaction error' },
      userPosts: { alice: [tw(301, 'alice')], bob: [tw(302, 'bob')] },
    });

    const items = await h.connector.fetch('20261020');

    expect(feedCallCount(h.runReach), 'feed 先被尝试').toBe(1);
    expect(h.twitterUserPosts.mock.calls.length, '降级必须逐账号扫描').toBeGreaterThan(0);
    expect(idsOf(items).sort(), '返回降级扫描的两账号推文').toEqual([`x:${BASE}301`, `x:${BASE}302`].sort());
    expect(
      h.ud.setValue.mock.calls.some(([key]) => key === 'x_following_cursor'),
      '降级结果不得推进 feed 游标（下一轮健康 feed 从旧 checkpoint 继续）',
    ).toBe(false);
    const failureWrites = h.ud.setValue.mock.calls.filter(([key]) => key === 'x_following_failure');
    const finalLedger = failureWrites.at(-1)?.[1];
    expect(finalLedger?.last_full_fallback_at, '降级运行必须记录 last_full_fallback_at').toBeDefined();
    expect(failureWrites[0]?.[1]?.count, 'feed 失败先入账（count=1）').toBe(1);
    expect(failureWrites[1]?.[1]?.last_failure_at, '降级戳写保留 feed 失败字段').toBeDefined();
  });

  it('H3 降级窗口未过期（<24h）+ feed 再失败：拒绝降级，原 feed 错误抛出，零账号扫描', async () => {
    process.env.X_FOLLOWING_FAILURE_COOLDOWN_MS = '0'; // 允许 feed 重试，聚焦降级限频
    const fallbackStamp = new Date(Date.now() - 3600e3).toISOString(); // 1h 前刚降级过
    const h = buildHarness({
      users: ['alice', 'bob'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      feedError: { code: 'EXIT_1', message: 'Clienttransaction error' },
      failureState: {
        last_full_fallback_at: fallbackStamp,
        count: 1,
      },
    });

    await expect(h.connector.fetch('20261020')).rejects.toThrow('EXIT_1');

    expect(feedCallCount(h.runReach), 'feed 冷却关闭时仍应重试').toBe(1);
    expect(h.twitterUserPosts.mock.calls.length, '24h 窗口内不得重复全量扫').toBe(0);
    const lastFailure = h.ud.setValue.mock.calls.filter(([key]) => key === 'x_following_failure').at(-1)?.[1];
    expect(lastFailure?.count, 'feed 失败计数累计（1→2）').toBe(2);
    expect(lastFailure?.last_full_fallback_at, '重写账本保留旧的降级戳').toBe(fallbackStamp);
  });

  it('H3b 降级窗口过期（>24h）：允许再次降级', async () => {
    process.env.X_FOLLOWING_FAILURE_COOLDOWN_MS = '0';
    const oldStamp = new Date(Date.now() - 25 * 3600e3).toISOString(); // 25h 前降级过
    const h = buildHarness({
      users: ['alice'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      feedError: { code: 'EXIT_1', message: 'Clienttransaction error' },
      userPosts: { alice: [tw(301, 'alice')] },
      failureState: {
        last_full_fallback_at: oldStamp,
        count: 3,
      },
    });

    const items = await h.connector.fetch('20261020');

    expect(h.twitterUserPosts.mock.calls.length, '窗口过期后允许再次降级扫描').toBeGreaterThan(0);
    expect(idsOf(items), '返回降级推文').toEqual([`x:${BASE}301`]);
    const failureWrites = h.ud.setValue.mock.calls.filter(([key]) => key === 'x_following_failure');
    expect(failureWrites.at(-1)?.[1]?.last_full_fallback_at, '新降级戳覆盖旧戳').not.toBe(oldStamp);
  });

  it('H4 FEED_COOLDOWN（被抑制的 tick）：原样抛出，绝不降级扫描', async () => {
    const h = buildHarness({
      users: ['alice', 'bob'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      failureState: {
        last_failure_at: new Date(Date.now() - 600e3).toISOString(),
        next_attempt_at: new Date(Date.now() + 29 * 60e3).toISOString(),
        reason: 'EXIT_1',
        count: 1,
      },
    });

    await expect(h.connector.fetch('20261020')).rejects.toMatchObject({
      name: 'UpstreamCooldownError',
      code: 'FEED_COOLDOWN',
    });

    expect(feedCallCount(h.runReach), '冷却窗口内不重试 feed').toBe(0);
    expect(h.twitterUserPosts.mock.calls.length, '被抑制 tick 不得降级扫描').toBe(0);
    expect(
      h.ud.setValue.mock.calls.some(([key]) => key === 'x_following_failure'),
      '被抑制 tick 不刷新账本',
    ).toBe(false);
  });

  it('H5 FULL_FALLBACK_COOLDOWN_MS=0 显式关闭限频：每次 feed 失败都降级（文档化逃生口）', async () => {
    process.env.X_FOLLOWING_FAILURE_COOLDOWN_MS = '0';
    process.env.X_FOLLOWING_FULL_FALLBACK_COOLDOWN_MS = '0';
    const h = buildHarness({
      users: ['alice'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      feedError: { code: 'EXIT_1', message: 'Clienttransaction error' },
      userPosts: { alice: [tw(301, 'alice')] },
      failureState: {
        last_full_fallback_at: new Date(Date.now() - 600e3).toISOString(), // 10 分钟前刚降级
        count: 1,
      },
    });

    const items = await h.connector.fetch('20261020');

    expect(h.twitterUserPosts.mock.calls.length, 'cooldown=0 关闭限频 → 立即降级').toBeGreaterThan(0);
    expect(idsOf(items)).toEqual([`x:${BASE}301`]);
  });
});
