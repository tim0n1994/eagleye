// @vitest-environment node
/**
 * R2 观测性补丁 A — HN 后端分派日志行（RED 先行，零行为变化）。
 * 测试作者·观测性
 *
 * 夜验证据链缺口①：hn.js 两条后端路径（algolia / firebase）成功时都静默，
 * journal 里 ALGOLIA_COUNT=0 无法区分「HN_BACKEND=algolia 未生效」与
 * 「生效了但没打日志」。本文件钉死分派处必须打的那一行。
 *
 * 契约（实现照此落地；只加日志，不改抓取/游标/窗口语义）：
 *  1. HNConnector.fetch 的分派处（hn.js:79-82，algolia / firebase 二选一）每次
 *     fetch 打一条非 error 级日志行（console.log 或仓库惯用 info 级），骨架：
 *       [hacker-news] backend=<algolia|firebase> items=<n> since=<cursor|window-floor>
 *  2. algolia 行必须带 items=<n> 与 since=<cursor|window-floor>；
 *     firebase 行同款骨架：backend=firebase 与 items=<n>。
 *  3. 空结果轮（窗内 0 条）同样必须打行，items=0 —— 沉默正是要消灭的缺口；
 *     items=<n> 是返回条数（窗外被 skip 的不算），不是 stats.requested。
 *  4. 不得走 console.error：error 级是条目失败通道（hn.js:183 / :266）。
 *
 * RED 说明：当前 hn.js 分派处无任何日志，三条用例在「必须出现 backend=… 行」处
 * 以 AssertionError 失败；夹具自检（条目数）在当前实现上即绿。
 *
 * harness 与 hn-algolia-backend.test.js 同款 vm 沙箱（注入 env / getDB /
 * fetchURL HTTP mock / user-data 桩 / 假时钟），唯一差异是 console 改为捕获：
 * log / info / debug / warn → logs[]，error → errors[]。零真实网络。
 *
 * 时间基准：now = 2026-10-20 01:00 Asia/Shanghai（= 2026-10-19 17:00 UTC），
 * digest '20261020'；窗内夹具落在 [now−36h, now+1h]。
 */

process.env.TZ = 'Asia/Shanghai';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');
const { describe, it, expect, beforeAll, beforeEach, afterEach, vi } = globalThis;
const utils = require('../utils');
const dateContract = require('../date-contract');

const HOUR = 3600e3;
const NOW = Date.UTC(2026, 9, 19, 17, 0, 0); // 2026-10-20 01:00 CST
const DIGEST = '20261020';
const SEC = (ms) => Math.floor(ms / 1000);
const ISO = (sec) => new Date(sec * 1000).toISOString();

const TOPSTORIES = 'https://hacker-news.firebaseio.com/v0/topstories.json';
const ALGOLIA_HOST = 'hn.algolia.com';

const hostCalls = (calls, host) => calls.filter((u) => new URL(u).host === host);

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
const fbStory = (id) => ({
  id,
  title: `Legacy story ${id}`,
  url: `https://example.com/legacy-${id}`,
  by: 'bob',
  score: 5 + (id % 10),
  descendants: 1,
  time: SEC(NOW - 4 * HOUR),
  type: 'story',
});

/** HTTP mock 路由：algolia / topstories / item 全部应答，未知 URL 回 '{}'。 */
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

/** user-data 桩：内存存储（algolia 路径的 hn_cursor 读写落这里）。 */
function makeUserData() {
  const store = new Map();
  return {
    GLOBAL_SCOPE: '',
    getValue(key) { return store.has(key) ? store.get(key) : null; },
    setValue(key, value) { store.set(key, value); },
  };
}

/**
 * vm harness：connector 源码加载进受控上下文；console 为捕获桩。
 * logs = log|info|debug|warn 四个非 error 级通道合流；errors = error 级。
 */
function buildHarness(db, env, respond) {
  const calls = [];
  const logs = [];
  const errors = [];
  const capture = (sink) => (...args) => sink.push(args.map(String).join(' '));
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
      console: {
        log: capture(logs),
        info: capture(logs),
        debug: capture(logs),
        warn: capture(logs),
        error: capture(errors),
      },
      URL,
      setTimeout,
      clearTimeout,
      AbortController: globalThis.AbortController,
      Date: globalThis.Date, // 假时钟
      process: { env }, // 每套 harness 独立 env：HN_BACKEND 在 fetch 时读取
      require(name) {
        if (name === '../db/connection') return { getDB: () => db };
        if (name === '../db/user-data') return ud;
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
  return { load, calls, logs, errors };
}

const BACKEND_LINE = (backend) => (line) => line.includes('[hacker-news]') && new RegExp(`\\bbackend=${backend}\\b`).test(line);

describe('R2 观测性 A：HN 分派日志行 [hacker-news] backend=<algolia|firebase> items=<n> since=<…>', () => {
  let db;
  beforeAll(() => {
    delete process.env.SOURCE_LOOKBACK_HOURS; // date-contract 走真实 process.env：默认 36h 窗
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

  it('A1 HN_BACKEND=algolia：fetch 成功后必须出现非 error 级「[hacker-news] backend=algolia items=<n> since=<…>」行', async () => {
    const h = buildHarness(db, { HN_BACKEND: 'algolia' }, hnRespond({
      algoliaHits: inWindowHits(6),
      topIds: [9001],
      stories: { 9001: fbStory(9001) },
    }));
    const { HNConnector } = h.load('connectors/hn.js');
    const items = await new HNConnector().fetch(DIGEST, { limit: 6 });

    // 夹具自检（当前实现即绿）：确实走了 algolia 并产出条目
    expect(hostCalls(h.calls, ALGOLIA_HOST).length, '夹具自检：HN_BACKEND=algolia 必须请求 hn.algolia.com').toBeGreaterThan(0);
    expect(items.length, '夹具自检：窗内命中产出条目').toBe(6);

    const lines = h.logs.filter(BACKEND_LINE('algolia'));
    expect(lines.length,
      `A1：algolia 分派路径成功时必须打 backend=algolia 日志行（缺口①：成功即静默，journal 无法自证后端已生效）；非 error 级捕获 ${JSON.stringify(h.logs)}`)
      .toBeGreaterThanOrEqual(1);
    expect(lines.some((l) => /\bitems=\d+\b/.test(l) && /\bsince=\S+/.test(l)),
      `A1：行格式契约 [hacker-news] backend=algolia items=<n> since=<cursor|window-floor>；实际 ${JSON.stringify(lines)}`)
      .toBe(true);
    expect(h.errors.some((l) => /\bbackend=/.test(l)), 'A1：分派日志不得走 console.error（error 是条目失败通道）').toBe(false);
  });

  it('A2 HN_BACKEND=algolia 空结果轮（命中全在窗外）也必须打行：items=0，不是沉默', async () => {
    const stale = SEC(NOW - 100 * HOUR); // 远在 36h 窗外 → isWithinFetchWindow 拒绝 → skipped
    const hit = {
      objectID: '8001',
      title: 'Stale story',
      url: 'https://example.com/stale',
      author: 'alice',
      points: 1,
      num_comments: 0,
      created_at_i: stale,
      created_at: ISO(stale),
    };
    const h = buildHarness(db, { HN_BACKEND: 'algolia' }, hnRespond({ algoliaHits: [hit] }));
    const { HNConnector } = h.load('connectors/hn.js');
    const stats = { requested: 0, failed: 0, skipped: 0 };
    const items = await new HNConnector().fetch(DIGEST, { stats });

    expect(hostCalls(h.calls, ALGOLIA_HOST).length, '夹具自检：必须请求 hn.algolia.com').toBeGreaterThan(0);
    expect(items, '夹具自检：窗外命中 → 返回 0 条').toHaveLength(0);
    expect(stats.requested, '夹具自检：requested=1 ≠ items=0，用来区分 items=<n> 口径').toBe(1);

    const lines = h.logs.filter(BACKEND_LINE('algolia'));
    expect(lines.length,
      `A2：空结果轮同样必须打 backend=algolia 行（夜验要能区分「后端未生效」与「无新内容」）；非 error 级捕获 ${JSON.stringify(h.logs)}`)
      .toBeGreaterThanOrEqual(1);
    expect(lines.some((l) => /\bitems=0\b/.test(l)),
      `A2：items=<n> 是返回条数（窗外 skip 后为 0），不是 stats.requested=1；实际 ${JSON.stringify(lines)}`)
      .toBe(true);
  });

  it('A3 HN_BACKEND=firebase：同款骨架「[hacker-news] backend=firebase items=<n>」行', async () => {
    const stories = { 9001: fbStory(9001), 9002: fbStory(9002) };
    const h = buildHarness(db, { HN_BACKEND: 'firebase' }, hnRespond({ topIds: [9001, 9002], stories }));
    const { HNConnector } = h.load('connectors/hn.js');
    const items = await new HNConnector().fetch(DIGEST);

    expect(hostCalls(h.calls, ALGOLIA_HOST), '夹具自检：firebase 后端不得请求 algolia').toHaveLength(0);
    expect(h.calls.includes(TOPSTORIES), '夹具自检：firebase 后端走 topstories').toBe(true);
    expect(items, '夹具自检：firebase 路径产出 2 条').toHaveLength(2);

    const lines = h.logs.filter(BACKEND_LINE('firebase'));
    expect(lines.length,
      `A3：firebase 分派路径同样必须打 backend=firebase 日志行（两条路径都打）；非 error 级捕获 ${JSON.stringify(h.logs)}`)
      .toBeGreaterThanOrEqual(1);
    expect(lines.some((l) => /\bitems=\d+\b/.test(l)),
      `A3：行格式契约 [hacker-news] backend=firebase items=<n>；实际 ${JSON.stringify(lines)}`)
      .toBe(true);
    expect(h.errors.some((l) => /\bbackend=/.test(l)), 'A3：分派日志不得走 console.error').toBe(false);
  });
});
