// @vitest-environment node
/**
 * R2 观测性补丁 B — RSS 304 短路的显式凭证（RED 先行，零行为变化）。
 * 测试作者·观测性
 *
 * 夜验证据链缺口②：rss.js 的 304 短路（fetchFeedOnce :131-132 检出，
 * fetchFeedAndParse :331-337 静默返回 []）既不进 envelope 也不打含 304 的日志。
 * techmeme 二抓全零（inserted=0/dup=0/skipped=0）只是指纹级证据，缺显式凭证。
 *
 * 契约（实现照此落地；不改抓取/重试/窗口语义，200 路径不动）：
 *  1. 304 短路时打一条非 error 级日志行「↻ 304 <feed-url>」
 *     （↻ 前缀沿用 utils.js:98 fetch-retry 的仓库惯例；level 为 log/info/warn 任一）。
 *  2. stats 增加 notModified 计数：304 短路 +1。经 fetchSource(returnDetails)
 *     信封透出为 envelope.notModified（connectors/index.js:235-247，与 retries
 *     同级、同语义：字段恒在，无 304 时为数字 0）。
 *  3. fetchAllSources 的逐源 summary 行携带 notModified（index.js:350-353）。
 *  4. 行为不回归：304 轮照旧返回 0 条、不 ERRORED、validators 照旧重放。
 *
 * RED 说明：当前信封无 notModified 字段（undefined），日志无 ↻ 304 行；
 * B1 在「200 轮 notModified=0」、B2 在「envelope.notModified=1」、B3 在「summary 行
 * notModified=1」处以 AssertionError 失败。夹具自检（If-None-Match 重放、0 条）在
 * 当前实现上即绿。
 *
 * harness：真 connectors/index.js + 真 connectors/rss.js + 真 base.js 进 vm
 * （其余 connector 由 Proxy 桩掉，模式取 sync-source.test.js /
 * fetch-retry-envelope.test.js）。DB = 001 + 028 内存库：sources.techmeme 由 001
 * 种入 feed_url，user_data（rss_conditional_state）由 028 建表。vm 全局注入
 * 脚本化 fetch（rss.js:311 useNative 走原生 fetch 才能看见 304 状态），零真实网络。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');
const utils = require('../utils');
const { describe, it, expect, beforeEach, afterEach } = globalThis;

const DIGEST = '20261020';
const SLUG = 'techmeme';
const FEED_URL = 'https://www.techmeme.com/feed.xml'; // 001_initial_schema.sql:273 种入
const ETAG = '"tm-r2-42"';
// 首抓用空 channel：走真 fast-xml-parser 解析、0 条入库，只为让 validators 落盘。
const EMPTY_RSS = '<?xml version="1.0" encoding="UTF-8"?>'
  + '<rss version="2.0"><channel><title>Techmeme</title><link>https://www.techmeme.com/</link></channel></rss>';

const is304Line = (line) => /↻\s*304\b/.test(line) && line.includes(FEED_URL);

/* ---------- 脚本化原生 fetch（按序消耗 step，超出重复末步；记录请求头） ---------- */
function scriptedFetch(steps) {
  const calls = [];
  let cursor = 0;
  const fn = async (url, options = {}) => {
    const step = steps[Math.min(cursor, steps.length - 1)];
    cursor += 1;
    calls.push({ url: String(url), headers: { ...(options.headers || {}) } });
    const respHeaders = step.headers || {};
    const get = (name) => {
      const key = Object.keys(respHeaders).find((k) => k.toLowerCase() === String(name).toLowerCase());
      return key === undefined ? null : respHeaders[key];
    };
    if (step.status === 304) return { status: 304, headers: { get } };
    return { status: step.status, headers: { get }, text: async () => step.body ?? '' };
  };
  return { fn, calls };
}

/* ---------- 内存库：001（sources 含 techmeme feed_url）+ 028（user_data） ---------- */
function freshDB({ onlyTechmeme = false } = {}) {
  const db = new Database(':memory:');
  const migration = (name) => fs.readFileSync(path.resolve(__dirname, '../../migrations', name), 'utf8');
  db.exec(migration('001_initial_schema.sql'));
  db.exec(migration('019_seen_items.sql')); // 028 搬迁语句引用 seen_items
  db.exec(migration('026_users.sql')); // 028 搬迁子查询引用 users 表
  db.exec(migration('028_user_scoped_data.sql'));
  if (onlyTechmeme) db.prepare('UPDATE sources SET is_active = 0 WHERE slug != ?').run(SLUG);
  return db;
}

/* ---------- vm harness：console 捕获（log|info|debug|warn → logs，error → errors） ---------- */
function harness(db, fetchImpl) {
  const cache = new Map();
  const logs = [];
  const errors = [];
  const capture = (sink) => (...args) => sink.push(args.map(String).join(' '));
  const serverRoot = path.resolve(__dirname, '../..');
  function load(relativePath) {
    const filename = path.join(serverRoot, relativePath);
    if (cache.has(filename)) return cache.get(filename);
    const target = { exports: {} };
    const context = {
      module: target,
      exports: target.exports,
      __dirname: path.dirname(filename),
      __filename: filename,
      console: {
        log: capture(logs),
        info: capture(logs),
        debug: capture(logs),
        warn: capture(logs),
        error: capture(errors),
      },
      URL,
      Buffer,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      setImmediate,
      clearImmediate,
      queueMicrotask,
      AbortController: globalThis.AbortController,
      fetch: fetchImpl, // rss.js:311 typeof fetch === 'function' → 原生条件请求路径
      Date,
      performance,
      process: { env: {}, hrtime: process.hrtime, nextTick: process.nextTick }, // RSS_CONDITIONAL 默认 ON
      require(name) {
        if (name === '../db/connection') return { getDB: () => db };
        if (name === '../services/utils') return utils;
        if (name === '../services/date-contract') return require('../date-contract');
        if (name === '../services/secret-redaction') return require('../secret-redaction'); // 案2: rss writeCondState 写库前脱敏（真实模块，纯叶子）
        if (name === '../services/x-following-config') return { readBlocklist: () => new Set(), isBlocked: () => false };
        if (name === '../services/outbox') return { registerEvent() {} };
        if (name === 'fast-xml-parser') return require('fast-xml-parser');
        if (name === './base') return load('connectors/base.js');
        if (name === './rss') return load('connectors/rss.js'); // 真 RSSConnector
        if (relativePath === 'connectors/index.js' && name.startsWith('./')) {
          const RealBase = load('connectors/base.js');
          const kebab = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
          const makeClass = (fallbackSlug) => class StubConnector extends RealBase.BaseConnector {
            constructor(arg) { super(typeof arg === 'string' && arg ? arg : fallbackSlug); }
            async fetch() { return []; } // 非 rss 连接器：零请求零条目
            saveItems(items, { returnDetails } = {}) {
              const envelope = { inserted: items.length, existing: 0, duplicates: 0, skipped: 0, failed: 0, items };
              return returnDetails ? envelope : items;
            }
          };
          return new Proxy({}, {
            get: (_t, prop) => {
              if (prop === '__esModule') return false;
              if (typeof prop !== 'string') return undefined;
              return makeClass(prop === 'HNConnector' ? 'hacker-news' : kebab(prop.replace(/Connector$/, '')));
            },
          });
        }
        throw new Error(`Unexpected require ${name} from ${relativePath}`);
      },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    cache.set(filename, target.exports);
    return target.exports;
  }
  return { registry: load('connectors/index.js'), logs, errors };
}

describe('R2 观测性 B：RSS 304 短路 → 「↻ 304 <feed-url>」日志 + envelope.notModified 计数', () => {
  let db;
  afterEach(() => {
    if (db) { db.close(); db = null; }
  });

  it('B1 基线：200 轮 envelope.notModified 恒为数字 0（字段恒在，与 retries 同语义）', async () => {
    db = freshDB();
    const t = scriptedFetch([{ status: 200, headers: { etag: ETAG }, body: EMPTY_RSS }]);
    const h = harness(db, t.fn);
    const r = await h.registry.fetchSource(SLUG, DIGEST, { returnDetails: true });

    expect(t.calls, '夹具自检：首抓 1 次原生 fetch').toHaveLength(1);
    expect(t.calls[0].url).toBe(FEED_URL);
    expect(r.items, '夹具自检：空 channel → 0 条').toEqual([]);
    expect(typeof r.retries, '前提（CTO 03:40）：信封已有 retries').toBe('number');
    expect(h.logs.some(is304Line), 'B1：200 轮不得出现 ↻ 304 行').toBe(false);
    expect(r.notModified,
      'B1：200 轮 envelope.notModified 必须是数字 0（字段恒在：夜验要区分「无 304」与「补丁未部署」）')
      .toBe(0);
  });

  it('B2 二抓指纹：首抓 200+ETag 落 validators → 二抓带 If-None-Match 收 304 → envelope.notModified=1 + ↻ 304 日志，仍 0 条', async () => {
    db = freshDB();
    const t = scriptedFetch([
      { status: 200, headers: { etag: ETAG }, body: EMPTY_RSS },
      { status: 304, headers: { etag: ETAG } },
    ]);
    const h = harness(db, t.fn);
    await h.registry.fetchSource(SLUG, DIGEST, { returnDetails: true }); // 首抓：落 validators
    const logsAfterRun1 = h.logs.length;
    const r = await h.registry.fetchSource(SLUG, DIGEST, { returnDetails: true }); // 二抓：304

    // 夹具自检（当前实现即绿）：确实经由条件请求收到 304 并短路
    expect(t.calls, '夹具自检：两次原生 fetch').toHaveLength(2);
    expect(t.calls[1].headers['If-None-Match'], '夹具自检：validators 重放 → 二抓携带首抓 ETag').toBe(ETAG);
    expect(r.items, '行为不变：304 短路 → 0 条').toEqual([]);
    expect(r.inserted, '行为不变：inserted=0').toBe(0);
    expect(r.error, '行为不变：304 不是错误轮').toBeUndefined();
    expect(h.errors.some((l) => /\b304\b/.test(l)), '304 不得走 console.error').toBe(false);

    expect(r.notModified,
      `B2：304 短路必须把 stats.notModified 透出为 envelope.notModified=1；实际信封键 ${JSON.stringify(Object.keys(r))}`)
      .toBe(1);
    const run2Logs = h.logs.slice(logsAfterRun1);
    expect(run2Logs.some(is304Line),
      `B2：304 短路必须打「↻ 304 ${FEED_URL}」日志行（当前 rss.js:331-337 静默返回）；二抓非 error 级捕获 ${JSON.stringify(run2Logs)}`)
      .toBe(true);
  });

  it('B3 fetchAllSources summary 行：techmeme 304 轮携带 notModified=1，items=0 且不 ERRORED', async () => {
    db = freshDB({ onlyTechmeme: true });
    const t = scriptedFetch([{ status: 304, headers: { etag: ETAG } }]);
    const h = harness(db, t.fn);
    const results = await h.registry.fetchAllSources(DIGEST);
    const row = results.find((x) => x.source === SLUG);

    expect(row, '夹具自检：techmeme 有 summary 行').toBeDefined();
    expect(t.calls, '夹具自检：1 次原生 fetch').toHaveLength(1);
    expect(row.error, '行为不变：304 轮不 ERRORED').toBeUndefined();
    expect(row.items, '行为不变：304 轮 items=0').toBe(0);
    expect(h.logs.some((l) => /Fetch summary/.test(l) && /no errors/.test(l)), '夹具自检：summary 日志 no errors').toBe(true);

    expect(row.notModified,
      `B3：summary 行必须携带 notModified=1（与 duration_ms/retries 同级，index.js:350-353）；实际行 ${JSON.stringify(row)}`)
      .toBe(1);
    expect(h.logs.some(is304Line),
      `B3：fetchAllSources 路径同样必须出现「↻ 304 ${FEED_URL}」行；非 error 级捕获 ${JSON.stringify(h.logs)}`)
      .toBe(true);
  });
});
