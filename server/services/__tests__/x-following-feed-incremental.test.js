/**
 * Round 2 ① x-following 增量 feed 模式（connector 契约测试）。
 *
 * Contract under test (CTO Round 2 方案 ①，文件边界 server/connectors/x-following.js
 * + X 增量触发的新文件；触发/调度机制不在本文件范围):
 *
 *   X_FOLLOWING_MODE=feed|per-user（CTO 裁决 2026-10-23：未设置默认 feed；
 *   精确显式 per-user 才进入旧逐账号路径）。feed 模式经 agent-reach
 *   runReach('twitter', ['feed','-t','following','-n','200','--json', …]) 分页
 *   拉取关注时间线；遇到已存游标（user_data 全局域键 x_following_cursor，
 *   即上次最大推文 ID）即停止分页；只保留关注列表作者；转推默认过滤、
 *   X_FOLLOWING_INCLUDE_RT=1 时保留；翻页触底、页数/预算耗尽或 feed 失败
 *   都是本轮 terminal/degraded 终态，严禁回退 twitter user-posts 或 442
 *   账号扫描。已持久化批次和已写游标保留，下一次 tick 从 checkpoint 继续。
 *
 * RED（在未实现代码上）: 现有 connector 只有 per-user 路径，从不调用
 *   runReach('twitter', ['feed', …])，也不读写 x_following_cursor —— 下列
 *   feed 断言全部以 expect 断言失败（非环境错误）的形式变红；per-user 的
 *   GUARD 用例在旧代码上保持绿，钉住旧路径不被破坏。
 *
 * 实现者注（测试固化的口径）:
 *   - 游标 = 上次最大推文 ID，字符串（snowflake，19 位，超出
 *     Number.MAX_SAFE_INTEGER —— 必须按字符串/BigInt 比较，不能用 Number）。
 *   - 停止条件（评审后修订）: following feed 非严格降序（现场实测置顶/注入
 *     古老条目位于 200 条页的第 25..174 位），孤条 id<=游标 视为注入噪声
 *     跳过继续扫；仅连续 X_FOLLOWING_CURSOR_CONFIRM_RUN（默认 8）条
 *     id<=游标 才确认水位停页，该 run 亦即最小页地板。run 跨页累计。
 *     恰等（id==游标）计入 run 且不入库。
 *   - 游标读写走 server/db/user-data.js getValue/setValue，全局域 user_id=''
 *     （键 x_following_cursor，值 {cursor, updated_at, …} 结构化 JSON，照
 *     scheduler_config 惯例）。
 *   - feed 每页参数钉死为实测部署参数 -n 200（来自 CTO 方案实测：每 2h
 *     增量一次、每次 -n 200、覆盖率 100%）。可加额外分页参数（如 cursor
 *     token / since-id），但 -t following、-n 200、--json 必须在。
 *   - feed 失败账本是 x_following_failure；它与数据游标分离。旧
 *     x_following_fallback / user-posts 回退契约已删除。
 *   - 转推识别: fixture 同时给 text 前缀 "RT @" 与 isRetweet:true，实现
 *     任选其一识别即可。
 *   - CLI 全部 mock（agent-reach stub），零真实网络/进程调用；时间为固定
 *     ISO 固件，TZ=Asia/Shanghai（B1 冷却用例的 last_full_fallback_at
 *     相对 Date.now() 动态生成，避免时间耦合）。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.TZ = 'Asia/Shanghai';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const X_FOLLOWING_PATH = path.resolve(import.meta.dirname, '../../connectors/x-following.js');

// ─── Hermetic DB（镜像 x-following-per-user-default.test.js:20-32 的做法）───
// connector 真链路里 ./base → getSourceId() → getDB() 打开 EAGLEYE_DB_PATH；
// 指向临时库并建最小 sources 表，绝不触碰 worktree/生产的 eagleye.db。
const { getDB, closeDB } = require('../../db/connection');
const previousDbPath = process.env.EAGLEYE_DB_PATH;
let hermeticDbDir = null;

/** Compile a connector file with selected requires replaced by stubs. */
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

// ─── Fixtures ──────────────────────────────────────────────────────────────
// 19 位 snowflake：BASE+3 位后缀。全部大于 Number.MAX_SAFE_INTEGER，
// 用 Number/parseInt 比较会全部塌缩成同一个数 —— 游标逻辑必须字符串/BigInt。
const BASE = '1850000000000000';
const CURSOR_ID = `${BASE}200`; // 上次最大推文 ID（已入库水位）

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

// n 条连续 id<=游标 的老推（从 start 递减），凑满水位确认 run
// （X_FOLLOWING_CURSOR_CONFIRM_RUN 默认 8；评审后口径见文件头注释）。
const oldRun = (start, handle, n = 8) => Array.from({ length: n }, (_, i) => tw(start - i, handle));

/**
 * Build a freshly-compiled XFollowingConnector with every external seam stubbed:
 * agent-reach（CLI 全 mock）、user-data（游标读写 mock）、x-following-config、
 * utils.fetchURL（禁真实网络）。'./base' 走真实现（临时库）。
 */
function buildHarness({ users, cursor, pages = [], feedError = null, userPosts = {}, failureState = null } = {}) {
  let feedCalls = 0;
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
      if (key === 'x_following_failure') return failureState;
      return null;
    }),
    setValue: vi.fn(),
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

const userPostsAccounts = (twitterUserPosts) =>
  [...new Set(twitterUserPosts.mock.calls.map((c) => String(c[0]).replace(/^@/, '')))];

describe('Round 2 ① x-following feed 增量模式', () => {
  beforeAll(() => {
    hermeticDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-x-feed-'));
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
    // CTO 裁决后默认 feed：大多数用例保持生产默认态；T4b 显式切 legacy。
    delete process.env.X_FOLLOWING_MODE;
    delete process.env.X_FOLLOWING_INCLUDE_RT;
    delete process.env.X_FOLLOWING_USERS;
    delete process.env.X_FOLLOWING_TWEETS_PER_USER;
    delete process.env.X_FOLLOWING_CONCURRENCY;
    delete process.env.X_FOLLOWING_BATCH_DELAY_MS;
    delete process.env.X_FOLLOWING_CURSOR_CONFIRM_RUN;
    delete process.env.X_FOLLOWING_FAILURE_COOLDOWN_MS;
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

  it('T1 分页拉取遇到游标即停：只取 > 游标的推文，不再翻下一页，游标前移到新最大 ID', async () => {
    const h = buildHarness({
      users: ['alice', 'bob'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      pages: [
        { tweets: [tw(460, 'alice'), tw(450, 'bob')], cursor: 'page-2' },
        { tweets: [tw(210, 'alice'), ...oldRun(150, 'alice')], cursor: 'page-3' }, // 150..143 连续 8 老 → 确认水位 → 停
        { tweets: [tw(100, 'bob')], cursor: undefined }, // 第 3 页不允许被请求
      ],
    });

    const items = await h.connector.fetch('20261020');

    // feed 路径被使用，且分页在第 2 页后停止
    expect(feedCallCount(h.runReach), 'feed 模式必须经 runReach 调 twitter feed').toBeGreaterThanOrEqual(1);
    expect(feedCallCount(h.runReach), '遇到游标后不得继续翻页（第 3 页不该被请求）').toBe(2);

    // feed 调用参数：实测部署参数 -t following / -n 200 / --json
    const firstFeedArgs = h.runReach.mock.calls.find(([cmd, a]) => cmd === 'twitter' && a?.[0] === 'feed')?.[1] || [];
    expect(firstFeedArgs.join(' '), 'feed 参数须含 -t following').toContain('-t following');
    expect(firstFeedArgs.join(' '), 'feed 参数须含 --json').toContain('--json');
    const nIdx = firstFeedArgs.indexOf('-n');
    expect(nIdx, 'feed 参数须含 -n').toBeGreaterThanOrEqual(0);
    expect(firstFeedArgs[nIdx + 1], '-n 钉死为实测参数 200').toBe('200');

    // 只保留 > 游标的推文；游标与更早的不返回
    expect(idsOf(items).sort(), '返回的应为 210/450/460（460>450>210>游标200），150/100 被游标拦下').toEqual(
      [`x:${BASE}210`, `x:${BASE}450`, `x:${BASE}460`].sort(),
    );

    // 不触发 user-posts 回退（已正常到达游标）
    expect(h.twitterUserPosts.mock.calls.length, '游标正常命中时不得回退 user-posts').toBe(0);

    // 游标写入：全局域 user_data 键 x_following_cursor，cursor=新最大推文 ID
    const write = h.ud.setValue.mock.calls.find(([key]) => key === 'x_following_cursor');
    expect(write, 'fetch 后必须写回 x_following_cursor').toBeDefined();
    const [, value, scope] = write;
    expect(String(value?.cursor), '游标应前移到本次最大推文 ID').toBe(`${BASE}460`);
    expect(value?.updated_at, '游标值应为 {cursor, updated_at, …} 结构').toBeDefined();
    expect(scope ?? '', '游标必须存全局域（user_id 空串），不得漏传属主写入个人行').toBe('');
  });

  it('T2 只保留关注列表作者：非关注作者的推文被过滤，且不回退 user-posts', async () => {
    const h = buildHarness({
      users: ['alice', 'bob'], // 关注列表
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      pages: [
        {
          tweets: [
            tw(460, 'alice'),
            tw(450, 'stranger'),  // 非关注作者（时间线里混入的推荐/转发旁路内容）
            tw(445, 'bob'),
            tw(440, 'stranger2'), // 非关注作者
            ...oldRun(150, 'alice'), // 150..143 连续 8 老 → 确认水位 → 停
          ],
          cursor: 'page-2',
        },
      ],
    });

    const items = await h.connector.fetch('20261020');

    expect(feedCallCount(h.runReach), 'feed 路径必须被使用').toBeGreaterThanOrEqual(1);
    expect(idsOf(items).sort(), '只保留关注作者 alice/bob 的 460/445，stranger 的 450/440 被过滤').toEqual(
      [`x:${BASE}445`, `x:${BASE}460`].sort(),
    );
    const authors = new Set(items.map((it) => it.author));
    for (const a of authors) {
      expect(['@alice', '@bob'], `作者 ${a} 不在关注列表`).toContain(a);
    }
    expect(h.twitterUserPosts.mock.calls.length, '游标正常命中时不得回退 user-posts').toBe(0);
  });

  it('T3a 转推默认过滤：X_FOLLOWING_INCLUDE_RT 未设时不返回 RT 推文', async () => {
    const h = buildHarness({
      users: ['alice'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      pages: [
        {
          tweets: [
            tw(460, 'alice'),
            tw(450, 'alice', { text: 'RT @bob: quoted original text', isRetweet: true }),
            ...oldRun(150, 'alice'), // 连续 8 老 → 确认水位 → 停
          ],
          cursor: 'page-2',
        },
      ],
    });

    const items = await h.connector.fetch('20261020');

    expect(feedCallCount(h.runReach), 'feed 路径必须被使用').toBeGreaterThanOrEqual(1);
    expect(idsOf(items), '原始推文 460 必须保留').toContain(`x:${BASE}460`);
    expect(idsOf(items), '默认（INCLUDE_RT 未设）转推 450 必须被过滤').not.toContain(`x:${BASE}450`);
  });

  it('T3b X_FOLLOWING_INCLUDE_RT=1 时保留转推', async () => {
    process.env.X_FOLLOWING_INCLUDE_RT = '1';
    const h = buildHarness({
      users: ['alice'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      pages: [
        {
          tweets: [
            tw(460, 'alice'),
            tw(450, 'alice', { text: 'RT @bob: quoted original text', isRetweet: true }),
            ...oldRun(150, 'alice'),
          ],
          cursor: 'page-2',
        },
      ],
    });

    const items = await h.connector.fetch('20261020');

    expect(feedCallCount(h.runReach), 'feed 路径必须被使用').toBeGreaterThanOrEqual(1);
    expect(idsOf(items), 'INCLUDE_RT=1 时转推 450 必须保留').toContain(`x:${BASE}450`);
    expect(idsOf(items), '原始推文 460 也必须保留').toContain(`x:${BASE}460`);
  });

  it('T4a CTO 裁决后默认 feed：未设 MODE 时读游标、调 feed、不调 user-posts', async () => {
    delete process.env.X_FOLLOWING_MODE; // 生产默认态：env 未设
    const h = buildHarness({
      users: ['alice', 'bob'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      pages: [{ tweets: [tw(460, 'alice'), ...oldRun(150, 'alice')], cursor: 'page-2' }],
    });

    const items = await h.connector.fetch('20261020');

    expect(feedCallCount(h.runReach), '默认（未设 MODE）必须调用 twitter feed').toBe(1);
    expect(
      h.ud.getValue.mock.calls.some(([key]) => key === 'x_following_cursor'),
      'feed 路径必须先读 checkpoint',
    ).toBe(true);
    expect(h.twitterUserPosts.mock.calls.length, 'feed 默认路径严禁逐账号扫描').toBe(0);
    expect(idsOf(items), '返回游标之后的 460').toEqual([`x:${BASE}460`]);
  });

  it('T4a-2 显式 X_FOLLOWING_MODE=feed：行为与默认一致，读旧游标、不碰 user-posts', async () => {
    process.env.X_FOLLOWING_MODE = 'feed';
    const h = buildHarness({
      users: ['alice'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      pages: [{ tweets: [tw(460, 'alice'), ...oldRun(150, 'alice')], cursor: 'page-2' }],
    });

    const items = await h.connector.fetch('20261020');

    expect(feedCallCount(h.runReach), '显式 feed 必须走 feed 路径').toBeGreaterThanOrEqual(1);
    expect(
      h.ud.getValue.mock.calls.some(([key]) => key === 'x_following_cursor'),
      'feed 模式必须先读 x_following_cursor 游标',
    ).toBe(true);
    expect(h.twitterUserPosts.mock.calls.length, 'feed 增量下不得逐账号 user-posts').toBe(0);
    expect(idsOf(items), '返回游标之后的 460').toEqual([`x:${BASE}460`]);
  });

  it('T4b/T5 GUARD X_FOLLOWING_MODE=per-user：旧路径完整可用（逐账号 user-posts，不调 feed）', async () => {
    process.env.X_FOLLOWING_MODE = 'per-user';
    const h = buildHarness({
      users: ['alice', 'bob'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      pages: [{ tweets: [tw(460, 'alice'), tw(150, 'alice')], cursor: 'page-2' }],
      userPosts: {
        alice: [tw(301, 'alice')],
        bob: [tw(302, 'bob')],
      },
    });

    const items = await h.connector.fetch('20261020');

    expect(feedCallCount(h.runReach), 'per-user 模式不得调用 twitter feed').toBe(0);
    const accounts = userPostsAccounts(h.twitterUserPosts);
    expect(accounts, 'per-user 模式必须逐账号调用 user-posts（alice、bob）').toEqual(
      expect.arrayContaining(['alice', 'bob']),
    );
    expect(idsOf(items).sort(), 'per-user 返回两账号的推文').toEqual([`x:${BASE}301`, `x:${BASE}302`].sort());
    expect(items.map((it) => it.author).sort(), 'per-user 条目作者正确').toEqual(['@alice', '@bob']);
  });

  it('T6 翻页触底未达游标：保留 feed 已入库结果，严禁回退 user-posts', async () => {
    const h = buildHarness({
      users: ['alice', 'bob'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      pages: [
        { tweets: [tw(460, 'alice'), tw(450, 'bob')], cursor: 'page-2' },
        { tweets: [tw(430, 'alice'), tw(420, 'bob')], cursor: undefined }, // 触底，始终未遇到 <= 游标
      ],
    });

    const items = await h.connector.fetch('20261020');

    expect(feedCallCount(h.runReach), 'feed 路径必须被使用').toBe(2);
    expect(h.twitterUserPosts.mock.calls.length, '触底未确认水位也严禁回退 user-posts').toBe(0);
    expect(idsOf(items).sort(), '只保留 feed 已抓到的四条新推').toEqual(
      [`x:${BASE}420`, `x:${BASE}430`, `x:${BASE}450`, `x:${BASE}460`].sort(),
    );
    const write = h.ud.setValue.mock.calls.find(([key]) => key === 'x_following_cursor');
    expect(String(write?.[1]?.cursor), '游标推进到 feed 已确认保存的最大 id').toBe(`${BASE}460`);
  });

  it('T7 feed 失败：本轮 terminal，保留游标并写 failure ledger，严禁 user-posts', async () => {
    const h = buildHarness({
      users: ['alice', 'bob'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      feedError: { code: 'EXIT_1', message: 'Clienttransaction error' },
    });

    const items = await h.connector.fetch('20261020');

    expect(feedCallCount(h.runReach), 'feed 必须被尝试过').toBe(1);
    expect(h.twitterUserPosts.mock.calls.length, 'feed 失败严禁触发 442 账号扫描').toBe(0);
    expect(items).toEqual([]);
    expect(
      h.ud.setValue.mock.calls.some(([key]) => key === 'x_following_cursor'),
      '首轮失败不得写入新游标',
    ).toBe(false);
    const failure = h.ud.setValue.mock.calls.find(([key]) => key === 'x_following_failure');
    expect(failure, 'feed 失败必须写独立 failure ledger').toBeDefined();
    expect(failure[1]?.reason).toContain('EXIT_1');
    expect(failure[1]?.count).toBe(1);
    expect(failure[2] ?? '', 'failure ledger 存全局域').toBe('');
  });

  it('T9 评审①回归：注入的孤条古老推文不提前停页——其后的新推不丢失，连续 8 条老推才确认水位', async () => {
    const h = buildHarness({
      users: ['alice', 'bob'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      pages: [
        // 180 = 注入的 >7 天置顶/古推（实测位次 25..174 形态），其后仍有新推 450/440
        { tweets: [tw(460, 'alice'), tw(180, 'alice'), tw(450, 'bob'), tw(440, 'alice')], cursor: 'page-2' },
        { tweets: [tw(430, 'bob'), ...oldRun(150, 'bob')], cursor: 'page-3' }, // 150..143 连续 8 老 → 确认 → 停
        { tweets: [tw(100, 'bob')], cursor: undefined }, // 第 3 页不允许被请求
      ],
    });

    const items = await h.connector.fetch('20261020');

    expect(feedCallCount(h.runReach), '孤老条目不停页：两页后由确认 run 停').toBe(2);
    expect(idsOf(items).sort(), '注入古推 180 之后的 450/440/430 不得丢失（旧实现会静默永久丢失）').toEqual(
      [`x:${BASE}430`, `x:${BASE}440`, `x:${BASE}450`, `x:${BASE}460`].sort(),
    );
    expect(idsOf(items), '注入的古老条目不入库').not.toContain(`x:${BASE}180`);
    expect(h.twitterUserPosts.mock.calls.length, '水位确认后不回退').toBe(0);
    const write = h.ud.setValue.mock.calls.find(([key]) => key === 'x_following_cursor');
    expect(String(write?.[1]?.cursor), '游标前移到本次最大新推').toBe(`${BASE}460`);
  });

  it('T9b 注入古推 + 翻页触底：保留 feed 已入库数据，严禁涉及账号回填', async () => {
    const h = buildHarness({
      users: ['alice', 'bob'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      pages: [
        { tweets: [tw(460, 'alice'), tw(175, 'alice'), tw(450, 'bob')], cursor: 'page-2' }, // 175 注入
        { tweets: [tw(430, 'bob'), tw(420, 'alice')], cursor: undefined }, // 触底，水位从未确认
      ],
    });

    const items = await h.connector.fetch('20261020');

    expect(feedCallCount(h.runReach), '孤老不停页，两页翻完（触底）').toBe(2);
    expect(h.twitterUserPosts.mock.calls.length, '触底未确认水位也严禁回填').toBe(0);
    expect(idsOf(items), 'feed 新推保留').toContain(`x:${BASE}460`);
    expect(idsOf(items), '注入古推后的新推不丢失').toContain(`x:${BASE}450`);
    expect(idsOf(items).sort(), '只保留 feed 中四条新推').toEqual(
      [`x:${BASE}420`, `x:${BASE}430`, `x:${BASE}450`, `x:${BASE}460`].sort(),
    );
    expect(idsOf(items), '注入的 175 不入库').not.toContain(`x:${BASE}175`);
  });

  it('T10 游标缺失（首轮生产路径）：翻到 token 耗尽后保留 feed 结果并首次写游标，严禁回填', async () => {
    const h = buildHarness({
      users: ['alice', 'bob'],
      cursor: null, // 生产 user_data 无 x_following_cursor 行（实测）
      pages: [
        { tweets: [tw(460, 'alice'), tw(450, 'bob')], cursor: 'page-2' },
        // 第 2 页 mock 未提供 → 空 data 无 cursor → hitBottom
      ],
    });

    const items = await h.connector.fetch('20261020');

    expect(feedCallCount(h.runReach), '无游标 → 翻页至 token 耗尽').toBe(2);
    expect(h.twitterUserPosts.mock.calls.length, '首轮触底严禁回填 user-posts').toBe(0);
    expect(idsOf(items).sort(), '只保留 feed 两条新推').toEqual(
      [`x:${BASE}450`, `x:${BASE}460`].sort(),
    );
    const write = h.ud.setValue.mock.calls.find(([key]) => key === 'x_following_cursor');
    expect(write, '首轮必须建立游标水位').toBeDefined();
    expect(String(write[1].cursor), '游标 = feed/回填最大 id').toBe(`${BASE}460`);
  });

  it('T11 边界：id 恰等于游标的推文计入确认 run 且不入库（防 <= 被改成 < 的回归）', async () => {
    const h = buildHarness({
      users: ['alice'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      pages: [
        // 200 == 游标（上次水位，已入库）：计入 run 首位；200..193 连续 8 → 确认停
        { tweets: [tw(460, 'alice'), tw(200, 'alice'), ...oldRun(199, 'alice', 7)], cursor: 'page-2' },
      ],
    });

    const items = await h.connector.fetch('20261020');

    expect(feedCallCount(h.runReach), '页内确认水位，不翻第 2 页').toBe(1);
    expect(idsOf(items), '只剩 > 游标的新推').toEqual([`x:${BASE}460`]);
    expect(idsOf(items), 'id==游标（已入库水位）必须被拦下——若比较被改成严格 <，此条会每轮重复拉取').not.toContain(`x:${BASE}200`);
    expect(h.twitterUserPosts.mock.calls.length, '水位确认 → 无回填').toBe(0);
  });

  it('T12 失败冷却：冷却窗口内不重试 feed，更不得触发 per-user 扫描', async () => {
    const h = buildHarness({
      users: ['alice', 'bob'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      failureState: {
        last_failure_at: new Date(Date.now() - 3600e3).toISOString(),
        next_attempt_at: new Date(Date.now() + 29 * 60e3).toISOString(),
        reason: 'EXIT_1 — Clienttransaction error',
        count: 1,
      },
    });

    const items = await h.connector.fetch('20261020');

    expect(feedCallCount(h.runReach), '冷却窗口内不得重试 feed').toBe(0);
    expect(h.twitterUserPosts.mock.calls.length, '冷却窗口内不得触发 per-user 扫描').toBe(0);
    expect(items).toEqual([]);
    expect(
      h.ud.setValue.mock.calls.some(([key]) => key === 'x_following_failure'),
      '被抑制的 tick 不得刷新失败账本',
    ).toBe(false);
  });

  it('T12b 冷却过期后重试 feed，失败写入独立 failure ledger 并累计计数', async () => {
    const h = buildHarness({
      users: ['alice', 'bob'],
      cursor: { cursor: CURSOR_ID, updated_at: '2026-10-20T06:00:00+08:00' },
      feedError: { code: 'EXIT_1', message: 'Clienttransaction error' },
      failureState: { last_failure_at: '2026-10-19T00:00:00Z', count: 2 },
    });

    const items = await h.connector.fetch('20261020');

    expect(feedCallCount(h.runReach), 'feed 必须被尝试').toBe(1);
    expect(h.twitterUserPosts.mock.calls.length, 'feed 失败不得触发 per-user 扫描').toBe(0);
    expect(items).toEqual([]);
    const rec = h.ud.setValue.mock.calls.find(([key]) => key === 'x_following_failure');
    expect(rec, '失败必须写独立冷却账本').toBeDefined();
    expect(rec[1]?.last_failure_at, '失败时间戳存在').toBeDefined();
    expect(rec[1]?.next_attempt_at, '下次尝试时间存在').toBeDefined();
    expect(rec[1]?.count, '计数累计').toBe(3);
    expect(rec[2] ?? '', '冷却记录存全局域').toBe('');
  });
});
