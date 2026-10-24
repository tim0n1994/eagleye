// @vitest-environment node
/**
 * Round 2 · CTO 03:40 追加 — 重试次数进入逐源 envelope（⑤：与 R2 ⑤ duration_ms 同级）
 * 测试作者·网络重试
 *
 * 契约（测试作者钉死，实现照此落地；fetch 层契约见 fetch-retry-backoff.test.js）：
 *  - fetchSource(returnDetails) 成功信封字段 `retries`：整数（无重试时为 0，字段恒在），
 *    与 duration_ms 同级（connectors/index.js:213-224）；来源 = fetchSource 自建的 stats
 *    （index.js:126）经 connector 转交 fetchURL(url, { stats }) 累加出的 stats.retries。
 *  - 失败轮：fetchSource 照旧 rethrow，但在错误对象上挂 err.retries（与 err.duration_ms
 *    同级、同路径，index.js:232-234）。
 *  - fetchAllSources 的 fetch summary 行：成功行与错误行都带 `retries`
 *    （index.js:321-323 成功行、index.js:333 错误行），错误行照旧计入 "N ERRORED"。
 *  - 解析错误（connector 侧 JSON/XML parse 异常）不重试：错误行 retries=0，传输只请求 1 次。
 *
 * harness：照 fetch-duration-summary.test.js 的 vm 模式加载 connectors/index.js + base.js
 * （注入 require：db/connection → 内存库；services/utils → 真模块，其 https.request 传输入口
 * 已被 vi.spyOn 脚本化替换；其余 connector 模块 → ScriptedConnector）。saveItems 用
 * returnDetails 形状的桩隔离 information_items schema（本文件只测 retries 的信封透出）。
 * sources 表为最小列集（含 043 的 last_fetch_duration_ms，供 R2 ⑤ 簿记照常工作）。
 * 全 mock：无真实网络；sleep 注入记录，不真等。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const https = require('https');
const { EventEmitter } = require('events');
const Database = require('better-sqlite3');
const utils = require('../utils');
const { describe, it, expect, afterEach, vi } = globalThis;

const TLS_MSG = 'Client network socket disconnected before secure TLS connection was established';
const DIGEST = '2026-10-20';
// 案1（CTO 2026-10-22 早间）：退避表 30s/120s → 10s/45s（fetch-retry-budget.test.js ③ 钉死）
const BACKOFF_1 = 10000;
const BACKOFF_2 = 45000;
// 注册表里 HNConnector/RSSConnector('techmeme')/LobstersConnector 的 slug 可由 harness
// 稳定推出（见 makeClass），所以用这三个源；每源独立 host，供并行抓取时分流脚本。
const HOSTS = { 'hacker-news': 'hn.example.test', techmeme: 'rss.example.test', lobsters: 'lobsters.example.test' };
const urlFor = (slug) => `https://${HOSTS[slug]}/feed`;
const ITEM_BODY = JSON.stringify([{ title: 'T', url: 'https://example.com/t' }]);

function netError(message, code) {
  const err = new Error(message);
  if (code) err.code = code;
  return err;
}
// lib/_tls_wrap.js onConnectEnd → ConnResetException(...) → code 'ECONNRESET'
const tlsDisconnect = () => netError(TLS_MSG, 'ECONNRESET');

/* ---------- 按 hostname 分流的脚本化传输（fetchAllSources 并行抓多个源，需各源独立队列） ---------- */
/**
 * routes: hostname → step[]，每个 host 按序消耗自己的 step（超出则重复最后一个）。
 *   step = { error }                   → 请求对象 'error' 事件（socket 层失败）
 *   step = { status, body?, headers? } → 响应 statusCode + body
 */
function installTransport(routes) {
  const calls = [];
  const cursors = {};
  const impl = (reqOpts, onResponse) => {
    const host = reqOpts.hostname;
    const steps = routes[host] || [];
    const i = cursors[host] || 0;
    cursors[host] = i + 1;
    const step = steps.length
      ? steps[Math.min(i, steps.length - 1)]
      : { error: new Error(`no transport script for host ${host}`) };
    calls.push({ hostname: host, path: reqOpts.path });
    const req = new EventEmitter();
    req.setTimeout = function () { return this; };
    req.setHeader = function () { return this; };
    req.write = function () { return true; };
    req.abort = req.destroy = function () { this.destroyed = true; return this; };
    req.end = function () {
      setImmediate(() => {
        if (step.error) { req.emit('error', step.error); return; }
        const res = new EventEmitter();
        res.statusCode = step.status;
        res.statusMessage = '';
        res.headers = step.headers || {};
        res.resume = res.setEncoding = res.destroy = function () { return this; };
        onResponse(res);
        if (step.body) res.emit('data', Buffer.from(String(step.body)));
        res.emit('end');
      });
      return this;
    };
    return req;
  };
  vi.spyOn(https, 'request').mockImplementation(impl);
  return { calls, byHost: (host) => calls.filter(c => c.hostname === host).length };
}

function sleepRecorder() {
  const sleeps = [];
  return { sleeps, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } };
}

/* ---------- 最小 sources 表（fetchAllSources 选源 + R2 ⑤/D4 簿记列） ---------- */
function minimalSourcesDB(slugs) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    label TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_attempt_at TEXT,
    consecutive_empty INTEGER NOT NULL DEFAULT 0,
    last_fetch_duration_ms INTEGER
  )`);
  const insert = db.prepare('INSERT INTO sources (id, slug, label) VALUES (?, ?, ?)');
  for (const slug of slugs) insert.run(`src-${slug}`, slug, slug);
  return db;
}

/* ---------- vm harness（模式照 fetch-duration-summary.test.js） ----------
 * scripts: slug → async (opts) => rawItems | throws —— ScriptedConnector.fetch 的脚本；
 * opts 即 fetchSource 传给 connector.fetch 的 { limit, stats, signal }（index.js:172），
 * 脚本用它调用 utils.fetchURL(url, { stats, signal, sleep })。
 */
function harness(db, scripts) {
  const cache = new Map();
  const logs = [];
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
        log: (...a) => logs.push(a.join(' ')),
        warn: (...a) => logs.push(a.join(' ')),
        error: (...a) => logs.push(a.join(' ')),
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
      Date,
      performance,
      process: { env: {}, hrtime: process.hrtime, nextTick: process.nextTick },
      require(name) {
        if (name === '../db/connection') return { getDB: () => db };
        if (name === '../services/utils') return utils;
        if (name === '../services/date-contract') return require('../date-contract');
        if (name === '../services/x-following-config') return { readBlocklist: () => new Set(), isBlocked: () => false };
        if (name === '../services/outbox') return { registerEvent() {} };
        if (name === './base') return load('connectors/base.js');
        if (relativePath === 'connectors/index.js' && name.startsWith('./')) {
          const RealBase = load('connectors/base.js');
          const kebab = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
          const makeClass = (fallbackSlug) => class ScriptedConnector extends RealBase.BaseConnector {
            constructor(arg) { super(typeof arg === 'string' && arg ? arg : fallbackSlug); }
            async fetch(_dateArg, opts = {}) {
              const script = scripts[this.slug];
              if (!script) return [];
              return script(opts);
            }
            // 隔离 information_items schema：只测 retries 的信封透出，不测入库
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
  return { registry: load('connectors/index.js'), logs };
}

/** connector 脚本：走真 utils.fetchURL（stats/signal 原样转交，sleep 注入），再 JSON 解析 */
const viaFetch = (slug, sleep) => async ({ stats, signal }) => (
  JSON.parse(await utils.fetchURL(urlFor(slug), { stats, signal, sleep }))
);

describe('connectors/index.js — retries 进入逐源 envelope（与 duration_ms 同级）', () => {
  let db;
  afterEach(() => {
    if (db) { db.close(); db = null; }
    vi.restoreAllMocks();
  });

  it('⑤ fetchSource 成功信封：一次 TLS 断连后成功 → retries=1（整数），与 duration_ms 同级', async () => {
    db = minimalSourcesDB(['hacker-news']);
    const t = installTransport({ [HOSTS['hacker-news']]: [{ error: tlsDisconnect() }, { status: 200, body: ITEM_BODY }] });
    const { sleep, sleeps } = sleepRecorder();
    const h = harness(db, { 'hacker-news': viaFetch('hacker-news', sleep) });
    const outcome = await h.registry.fetchSource('hacker-news', DIGEST, { returnDetails: true })
      .then(r => ({ ok: true, r }), err => ({ ok: false, err }));
    expect(outcome.ok, `⑤：一次 TLS 断连后该源必须成功；实际拒绝：${outcome.err?.message}`).toBe(true);
    const r = outcome.r;
    expect(r.inserted, '夹具自检：条目进入信封').toBe(1);
    expect(typeof r.duration_ms, '前提（R2 ⑤）：信封已有 duration_ms').toBe('number');
    expect(Object.keys(r), '⑤：retries 与 duration_ms 同级（同一信封对象）').toEqual(expect.arrayContaining(['duration_ms', 'retries']));
    expect(r.retries, '⑤：信封必须携带 retries=1').toBe(1);
    expect(Number.isInteger(r.retries)).toBe(true);
    expect(sleeps, '退避 10s').toEqual([BACKOFF_1]);
    expect(t.byHost(HOSTS['hacker-news'])).toBe(2);
  });

  it('⑤ 无重试的干净成功：retries 字段恒在且为 0（不是有重试才出现）', async () => {
    db = minimalSourcesDB(['hacker-news']);
    installTransport({ [HOSTS['hacker-news']]: [{ status: 200, body: ITEM_BODY }] });
    const { sleep, sleeps } = sleepRecorder();
    const h = harness(db, { 'hacker-news': viaFetch('hacker-news', sleep) });
    const r = await h.registry.fetchSource('hacker-news', DIGEST, { returnDetails: true });
    expect(r.inserted).toBe(1);
    expect(sleeps).toEqual([]);
    expect(r.retries, '⑤：无重试时 retries 必须是数字 0（字段恒在）').toBe(0);
  });

  it('⑤ 失败轮：连续 3 次 TLS 断连 → fetchSource 拒绝（上层判 ERRORED），err.retries=2 与 err.duration_ms 同级', async () => {
    db = minimalSourcesDB(['hacker-news']);
    const t = installTransport({ [HOSTS['hacker-news']]: [{ error: tlsDisconnect() }] }); // 末步重复：每次都断
    const { sleep, sleeps } = sleepRecorder();
    const h = harness(db, { 'hacker-news': viaFetch('hacker-news', sleep) });
    const err = await h.registry.fetchSource('hacker-news', DIGEST, { returnDetails: true }).then(() => null, e => e);
    expect(err, '耗尽重试后 fetchSource 必须拒绝').not.toBeNull();
    expect(String(err.message), '抛出最后一次网络错误，原文可辨').toContain(TLS_MSG);
    expect(typeof err.duration_ms, '前提（R2 ⑤）：err.duration_ms 已挂在错误上').toBe('number');
    expect(err.retries, '⑤：失败轮 err.retries=2（与 err.duration_ms 同级）').toBe(2);
    expect(sleeps, '退避 10s→45s').toEqual([BACKOFF_1, BACKOFF_2]);
    expect(t.byHost(HOSTS['hacker-news']), '3 次请求后放弃').toBe(3);
    // D4 既有簿记不回归：失败轮仍记 last_attempt_at
    const row = db.prepare("SELECT last_attempt_at FROM sources WHERE slug = 'hacker-news'").get();
    expect(row.last_attempt_at).toBeTruthy();
  });

  it('⑤ fetchAllSources summary：成功行 retries=1；错误行（3 次断连）retries=2 并计入 ERRORED；解析错误行 retries=0、只请求 1 次', async () => {
    db = minimalSourcesDB(['hacker-news', 'techmeme', 'lobsters']);
    const t = installTransport({
      [HOSTS['hacker-news']]: [{ error: tlsDisconnect() }, { status: 200, body: ITEM_BODY }],
      [HOSTS.techmeme]: [{ error: tlsDisconnect() }],          // 每次都断 → 3 次后 ERRORED
      [HOSTS.lobsters]: [{ status: 200, body: '<<< not json' }], // 200 但 connector 解析失败 → 不重试
    });
    const { sleep } = sleepRecorder();
    const h = harness(db, {
      'hacker-news': viaFetch('hacker-news', sleep),
      techmeme: viaFetch('techmeme', sleep),
      lobsters: viaFetch('lobsters', sleep),
    });
    const results = await h.registry.fetchAllSources(DIGEST);
    const by = Object.fromEntries(results.map(r => [r.source, r]));
    expect(Object.keys(by).sort(), '夹具自检：三个源都有 summary 行').toEqual(['hacker-news', 'lobsters', 'techmeme']);

    expect(by['hacker-news'].error, `成功源不得报错：${by['hacker-news'].error}`).toBeUndefined();
    expect(by['hacker-news'].items).toBe(1);
    expect(typeof by['hacker-news'].duration_ms, '前提（R2 ⑤）：成功行已有 duration_ms').toBe('number');
    expect(by['hacker-news'].retries, '⑤ summary 成功行 retries=1').toBe(1);
    expect(t.byHost(HOSTS['hacker-news'])).toBe(2);

    expect(String(by.techmeme.error)).toContain(TLS_MSG);
    expect(typeof by.techmeme.duration_ms, '前提（R2 ⑤）：错误行已有 duration_ms').toBe('number');
    expect(by.techmeme.retries, '⑤ summary 错误行 retries=2').toBe(2);
    expect(t.byHost(HOSTS.techmeme), '错误源 3 次请求后放弃').toBe(3);

    expect(String(by.lobsters.error)).toMatch(/not valid JSON|Unexpected token|JSON/);
    expect(by.lobsters.retries, '④/⑤ 解析错误不重试：错误行 retries=0').toBe(0);
    expect(t.byHost(HOSTS.lobsters), '解析错误不得触发二次请求').toBe(1);

    expect(h.logs.find(l => /2 ERRORED/.test(l)), '判 ERRORED：summary 日志计入 2 个错误源').toBeDefined();
  });
});
