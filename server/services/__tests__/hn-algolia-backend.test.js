// @vitest-environment node
/* global beforeAll, describe, it, expect, beforeEach, afterEach, vi */

/**
 * Round 2 ② HN 改 Algolia 后端 — 契约测试（RED 先行）。
 *
 * 契约（server/connectors/hn.js，开关 HN_BACKEND=algolia|firebase）：
 *   1. HN_BACKEND=algolia：改用 hn.algolia.com/api/v1/search_by_date?tags=story
 *      一次拉取增量，消灭 topstories+逐条 item 的 N+1（现状 30+ 次请求）。
 *   2. created_at_i 游标增量：游标存 user_data 全局域（user_id=''，migration 028
 *      惯例；参照 scheduler_config 单键 JSON 风格）。首轮无游标时允许无
 *      numericFilters（或 created_at_i>0 基线）；拉取后必须把本轮最大
 *      created_at_i 写回；次轮请求必须带 numericFilters=created_at_i>{cursor}。
 *   3. 30 条上限保留：>30 条增量命中时只保留 30 条（parseItemLimit 默认 30）。
 *   4. 分数口径不变：algolia points→score、num_comments→popularity.comments，
 *      source_payload.hnId=objectID、无 url 时回退 news.ycombinator.com 条目页，
 *      created_at_i(秒)→published_at ISO，与 firebase 路径同构。
 *   5. HN_BACKEND=firebase：旧路径完整保留（topstories+item 映射、30 上限不变）。
 *   6. 未设置 HN_BACKEND：fetch 不抛错、正常返回条目（任一默认后端皆须满足）。
 *
 * RED 说明：algolia 组测试在当前实现（无 HN_BACKEND 分支）上，第一条断言
 * 「必须出现 hn.algolia.com 请求」即以 AssertionError 失败；firebase 组是
 * 守护旧路径的回归测试，当前即绿、改造后必须保持绿。
 *
 * 时间基准（不依赖真实时间）：now = 2026-10-20 01:00 Asia/Shanghai
 * （= 2026-10-19 17:00 UTC），digest '20261020'；所有夹具发布时间落在
 * [now−36h, now+1h] 抓取窗内（Round 1 D2 契约）。
 *
 * vm harness 与 connector-date-window.test.js / sync-source.test.js 同款：
 * 注入内存库 getDB、mock fetchURL（HTTP mock，零真实网络）和带调用记录的
 * user-data 桩；Date 注入测试进程假时钟。外部调用与时间全 mock。
 */

process.env.TZ = 'Asia/Shanghai';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');
const { vi } = globalThis; // globals: true（vitest 4 的 CJS 测试不可 require('vitest')）
const utils = require('../utils');
const dateContract = require('../date-contract');

const HOUR = 3600e3;
// now = 2026-10-20 01:00 CST = 2026-10-19 17:00 UTC（每日 01:00 调度时刻）
const NOW = Date.UTC(2026, 9, 19, 17, 0, 0);
const DIGEST = '20261020';
const SEC = (ms) => Math.floor(ms / 1000);
const ISO = (sec) => new Date(sec * 1000).toISOString();

const TOPSTORIES = 'https://hacker-news.firebaseio.com/v0/topstories.json';

const urlOf = (u) => new URL(u);
const algoliaCallsIn = (calls) => calls.map(urlOf).filter((u) => u.host === 'hn.algolia.com');
const itemCallsIn = (calls) => calls
  .map(urlOf)
  .filter((u) => u.host === 'hacker-news.firebaseio.com' && /\/item\/\d+\.json$/.test(u.pathname));

/** 窗内 algolia hit 夹具（发布时间铺满 [now-20h, now-1h]）。 */
const inWindowHits = (count) => Array.from({ length: count }, (_, i) => {
  const t = SEC(NOW - 20 * HOUR) + i * Math.floor((19 * HOUR) / 1000 / Math.max(count - 1, 1));
  return {
    objectID: String(7000 + i),
    title: `Algolia story ${i}`,
    url: `https://example.com/alg-${i}`,
    author: 'alice',
    points: 100 + i,
    num_comments: 7,
    created_at_i: t,
    created_at: ISO(t),
  };
});

/** 窗内 firebase story 夹具。 */
const fbStory = (id, over = {}) => ({
  id,
  title: `Legacy story ${id}`,
  url: `https://example.com/legacy-${id}`,
  by: 'bob',
  score: 5 + (id % 10),
  descendants: 1,
  time: SEC(NOW - 4 * HOUR),
  type: 'story',
  ...over,
});

/**
 * HTTP mock 路由：algolia / topstories / item 三类端点全部应答（对未知 URL
 * 返回 '{}' 而不是抛错，保证失败以断言而非环境错误呈现）。
 */
function hnRespond({ algoliaHits = [], topIds = [], stories = {} } = {}) {
  return (url) => {
    if (url.startsWith('https://hn.algolia.com/api/v1/search_by_date')) {
      return JSON.stringify({
        hits: algoliaHits,
        nbHits: algoliaHits.length,
        page: 0,
        nbPages: 1,
        hitsPerPage: Math.max(algoliaHits.length, 1),
      });
    }
    if (url === TOPSTORIES) return JSON.stringify(topIds);
    const m = url.match(/hacker-news\.firebaseio\.com\/v0\/item\/(\d+)\.json$/);
    if (m) {
      const story = stories[Number(m[1])];
      return story ? JSON.stringify(story) : '{}';
    }
    return '{}';
  };
}

/** user-data 桩：内存存储 + getValue/setValue 调用记录（key/value/userId）。 */
function makeUserData() {
  const store = new Map();
  const calls = { get: [], set: [] };
  return {
    calls,
    module: {
      GLOBAL_SCOPE: '',
      getValue(key, userId) {
        calls.get.push({ key, userId });
        return store.has(key) ? store.get(key) : null;
      },
      setValue(key, value, userId) {
        calls.set.push({ key, value, userId });
        store.set(key, value);
      },
    },
  };
}

/** vm harness：connector 源码加载进受控上下文，注入 env / getDB / fetchURL / user-data。 */
function buildHarness(db, env, respond) {
  const calls = [];
  const ud = makeUserData();
  const fetchURL = async (url, options) => {
    if (options && options.signal && typeof options.signal.throwIfAborted === 'function') {
      options.signal.throwIfAborted();
    }
    calls.push(String(url));
    const body = respond(String(url));
    return body == null ? '{}' : body;
  };
  const serverRoot = path.resolve(__dirname, '../..');
  const cache = new Map();
  function load(relativePath) {
    const filename = path.join(serverRoot, relativePath);
    if (cache.has(filename)) return cache.get(filename);
    const module = { exports: {} };
    const context = {
      module,
      console: { log() {}, warn() {}, error() {} },
      URL,
      setTimeout,
      clearTimeout,
      AbortController: globalThis.AbortController,
      Date: globalThis.Date, // 假时钟（vi.useFakeTimers 后 globalThis.Date 即假实现）
      process: { env }, // 每套 harness 独立 env：HN_BACKEND 在 load 前设好
      require(name) {
        if (name === '../db/connection') return { getDB: () => db };
        if (name === '../db/user-data') return ud.module;
        if (name === '../services/utils' || name === './utils') return { ...utils, fetchURL };
        if (name === '../services/date-contract' || name === './date-contract') return dateContract;
        if (name === './base') return load('connectors/base.js');
        if (name === './hn') return load('connectors/hn.js');
        const resolved = name.startsWith('.') ? path.resolve(path.dirname(filename), name) : name;
        return require(resolved);
      },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    cache.set(filename, module.exports);
    return module.exports;
  }
  return { load, calls, ud };
}

describe('Round 2 HN Algolia backend (HN_BACKEND=algolia|firebase)', () => {
  let db;
  beforeAll(() => {
    delete process.env.SOURCE_LOOKBACK_HOURS; // date-contract 走真实 process.env，确保默认 36h 窗
    delete process.env.HN_BACKEND;
  });
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    db = new Database(':memory:');
    db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/001_initial_schema.sql'), 'utf8'));
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('1. HN_BACKEND=algolia: one search_by_date?tags=story pull instead of topstories+per-item N+1', async () => {
    const h = buildHarness(db, { HN_BACKEND: 'algolia' }, hnRespond({
      algoliaHits: inWindowHits(6),
      topIds: [9001],
      stories: { 9001: fbStory(9001) },
    }));
    const { HNConnector } = h.load('connectors/hn.js');
    const items = await new HNConnector().fetch(DIGEST, { limit: 6 });
    const algolia = algoliaCallsIn(h.calls);
    expect(algolia.length, 'HN_BACKEND=algolia 必须请求 hn.algolia.com（当前实现仍走 firebase topstories，N+1 未消除）').toBeGreaterThan(0);
    expect(algolia[0].pathname, 'Algolia 增量端点是 /api/v1/search_by_date').toBe('/api/v1/search_by_date');
    expect(algolia[0].searchParams.get('tags') || '', 'tags 必须含 story：只要故事条目').toContain('story');
    expect(items.length, 'algolia 命中应产出条目').toBeGreaterThan(0);
    expect(itemCallsIn(h.calls), 'algolia 后端不得退化为 firebase 逐条 item N+1').toHaveLength(0);
  });

  it('2. created_at_i cursor: run 1 persists max created_at_i to user_data global scope, run 2 sends numericFilters=created_at_i>{cursor}', async () => {
    const base = SEC(NOW - 10 * HOUR);
    const hits = [0, 4000, 8000].map((off, i) => {
      const t = base + off;
      return {
        objectID: String(7100 + i),
        title: `Cursor story ${i}`,
        url: `https://example.com/cur-${i}`,
        author: 'alice',
        points: 10 + i,
        num_comments: 1,
        created_at_i: t,
        created_at: ISO(t),
      };
    });
    const C1 = base + 8000; // 本轮最大 created_at_i（全部窗内 → 亦为保留条目的最大值）
    const h = buildHarness(db, { HN_BACKEND: 'algolia' }, hnRespond({
      algoliaHits: hits,
      topIds: [1, 2, 3],
      stories: {},
    }));
    const { HNConnector } = h.load('connectors/hn.js');

    await new HNConnector().fetch(DIGEST, { stats: { requested: 0, failed: 0, skipped: 0 } }); // 首轮：无游标
    let algolia = algoliaCallsIn(h.calls);
    expect(algolia.length, '首轮必须请求 search_by_date').toBeGreaterThan(0);
    for (const u of algolia) {
      const nf = (u.searchParams.get('numericFilters') || '').replace(/\s+/g, '');
      expect(nf === '' || /created_at_i>\d+/.test(nf), '首轮无游标：允许无 numericFilters 或 created_at_i>0 基线').toBe(true);
    }
    expect(h.ud.calls.get.length, '游标必须先经 user_data.getValue 读取').toBeGreaterThan(0);
    expect(h.ud.calls.set.length, '游标必须经 user_data.setValue 持久化').toBeGreaterThan(0);
    const cursorWrites = h.ud.calls.set.filter((c) => JSON.stringify(c.value).includes(String(C1)));
    expect(cursorWrites.length, `写回值必须包含本轮最大 created_at_i=${C1}`).toBeGreaterThan(0);
    for (const c of cursorWrites) {
      expect(c.userId === undefined || c.userId === '', 'HN 游标是服务器级键：必须写全局域 user_id=\'\'（migration 028 惯例）').toBe(true);
    }

    const callsAfterRun1 = h.calls.length;
    await new HNConnector().fetch(DIGEST, { stats: { requested: 0, failed: 0, skipped: 0 } }); // 次轮：游标已存
    algolia = algoliaCallsIn(h.calls.slice(callsAfterRun1));
    expect(algolia.length, '次轮仍必须请求 search_by_date').toBeGreaterThan(0);
    const seen = algolia.map((u) => (u.searchParams.get('numericFilters') || '').replace(/\s+/g, ''));
    expect(seen.every((nf) => nf.split(',').includes(`created_at_i>${C1}`)), `次轮请求必须带 numericFilters=created_at_i>${C1}（got ${JSON.stringify(seen)}）`).toBe(true);
  });

  it('3. 30-item cap preserved: 45 fresh algolia hits yield exactly 30 items', async () => {
    const h = buildHarness(db, { HN_BACKEND: 'algolia' }, hnRespond({ algoliaHits: inWindowHits(45) }));
    const { HNConnector } = h.load('connectors/hn.js');
    const items = await new HNConnector().fetch(DIGEST);
    expect(algoliaCallsIn(h.calls).length, 'algolia 后端必须发请求').toBeGreaterThan(0);
    expect(items.length, '30 条上限必须保留（默认 limit 30，与 firebase 口径一致）').toBe(30);
  });

  it('4. score semantics unchanged: points->score, num_comments->popularity.comments, HN-page URL fallback', async () => {
    const t = SEC(NOW - 6 * HOUR);
    const hit = {
      objectID: '9901',
      title: 'Score contract story',
      author: 'alice',
      points: 123,
      num_comments: 45,
      created_at_i: t,
      created_at: ISO(t),
      // 故意不带 url：必须回退到 news.ycombinator.com/item?id=<objectID>
    };
    const h = buildHarness(db, { HN_BACKEND: 'algolia' }, hnRespond({ algoliaHits: [hit] }));
    const { HNConnector } = h.load('connectors/hn.js');
    const items = await new HNConnector().fetch(DIGEST);
    expect(algoliaCallsIn(h.calls).length, 'algolia 后端必须发请求').toBeGreaterThan(0);
    expect(items.length).toBeGreaterThan(0);
    const it0 = items[0];
    expect(it0.score, 'algolia points 必须沿用现有 score 口径').toBe(123);
    expect(JSON.parse(it0.popularity), 'popularity 口径与 firebase 相同').toEqual({ points: 123, comments: 45 });
    expect(it0.canonical_url, '无 url 的 hit 回退到 HN 条目页').toBe('https://news.ycombinator.com/item?id=9901');
    expect(it0.author).toBe('alice');
    expect(it0.published_at, 'created_at_i(秒)→ISO，与 firebase time 口径一致').toBe(ISO(t));
    const payload = JSON.parse(it0.source_payload);
    expect(String(payload.hnId), 'source_payload.hnId = algolia objectID').toBe('9901');
    expect(payload.points).toBe(123);
  });

  it('5a. firebase legacy path preserved under HN_BACKEND=firebase: topstories+item mapping, score, payload all unchanged', async () => {
    const t = SEC(NOW - 5 * HOUR);
    const stories = {
      9001: { id: 9001, title: 'Legacy story', url: 'https://example.com/hn-legacy', by: 'bob', score: 321, descendants: 45, time: t, type: 'story' },
    };
    const h = buildHarness(db, { HN_BACKEND: 'firebase' }, hnRespond({ topIds: [9001], stories }));
    const { HNConnector } = h.load('connectors/hn.js');
    const items = await new HNConnector().fetch(DIGEST);
    expect(algoliaCallsIn(h.calls), 'firebase 后端不得请求 algolia').toHaveLength(0);
    expect(items).toHaveLength(1);
    const it0 = items[0];
    expect(it0.score).toBe(321);
    expect(it0.canonical_url).toBe('https://example.com/hn-legacy');
    expect(JSON.parse(it0.popularity)).toEqual({ points: 321, comments: 45 });
    expect(it0.published_at).toBe(ISO(t));
    const payload = JSON.parse(it0.source_payload);
    expect(String(payload.hnId)).toBe('9001');
  });

  it('5b. firebase legacy cap: 40 topstories yield exactly 30 per-item fetches and 30 items', async () => {
    const stories = {};
    const topIds = [];
    for (let i = 0; i < 40; i++) {
      const id = 9100 + i;
      topIds.push(id);
      stories[id] = fbStory(id);
    }
    const h = buildHarness(db, { HN_BACKEND: 'firebase' }, hnRespond({ topIds, stories }));
    const { HNConnector } = h.load('connectors/hn.js');
    const items = await new HNConnector().fetch(DIGEST);
    expect(itemCallsIn(h.calls), '默认 limit 30：只逐条拉 30 个 item').toHaveLength(30);
    expect(items).toHaveLength(30);
  });

  it('5c. backend switch isolation: same process, two harnesses route by their own HN_BACKEND env', async () => {
    const respond = hnRespond({
      algoliaHits: inWindowHits(6),
      topIds: [9001, 9002, 9003],
      stories: Object.fromEntries([9001, 9002, 9003].map((id) => [id, fbStory(id)])),
    });
    const fb = buildHarness(db, { HN_BACKEND: 'firebase' }, respond);
    const al = buildHarness(db, { HN_BACKEND: 'algolia' }, respond);
    const fbItems = await new (fb.load('connectors/hn.js').HNConnector)().fetch(DIGEST, { limit: 3 });
    const alItems = await new (al.load('connectors/hn.js').HNConnector)().fetch(DIGEST, { limit: 3 });
    expect(fbItems.length + alItems.length, '两套后端各自产出 3 条').toBe(6);
    expect(algoliaCallsIn(al.calls).length, 'algolia env 下必须走 algolia').toBeGreaterThan(0);
    expect(algoliaCallsIn(fb.calls), 'firebase env 下不得请求 algolia').toHaveLength(0);
    expect(fb.calls.includes(TOPSTORIES), 'firebase env 下必须走 topstories').toBe(true);
  });

  it('6. HN_BACKEND unset: fetch still returns well-formed items under either default backend', async () => {
    const stories = {};
    const topIds = [];
    for (let i = 0; i < 40; i++) {
      const id = 9200 + i;
      topIds.push(id);
      stories[id] = fbStory(id, { url: `https://example.com/unset-${id}` });
    }
    const h = buildHarness(db, {}, hnRespond({ algoliaHits: inWindowHits(40), topIds, stories }));
    const { HNConnector } = h.load('connectors/hn.js');
    const items = await new HNConnector().fetch(DIGEST, { limit: 5 });
    expect(items, 'limit=5 必须被尊重（任一后端）').toHaveLength(5);
    expect(items[0].canonical_url).toMatch(/^https:\/\//);
    expect(items.every((x) => typeof x.score === 'number')).toBe(true);
  });
});
