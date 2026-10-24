// @vitest-environment node
/* global describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi */

/**
 * Round 2 · ③ RSS 条件请求（ETag / Last-Modified + 304）— 契约测试（RED 先行）
 *
 * 所有权：server/connectors/rss.js。契约（开关 RSS_CONDITIONAL，默认开）：
 *   C1 默认开：首次抓取收到 ETag（或 Last-Modified）后持久保存；后续抓取
 *      回发 If-None-Match（或 If-Modified-Since）。“持久”以跨 connector 实例
 *      与跨模块图（每轮抓取都是新进程语义）验证 —— 状态必须存到进程外可见处
 *      （惯例：user_data 全全局域单键 JSON，参考 scheduler_config）。
 *   C2 304 Not Modified：视为“无新内容”，fetch() 正常 resolve 为空数组，
 *      不抛错、不解析空 body。
 *   C3 ETag 刷新：服务器换发新 ETag 后，旧 ETag 的条件请求拿 200 + 新 ETag，
 *      下一轮必须回发新值。
 *   C4 开关 RSS_CONDITIONAL=0：完全关闭条件头，照常 200 全量解析（旧行为）。
 *   C5 多源隔离：A 源的 ETag 绝不发给 B 源。
 *
 * HTTP mock 方式（传输无关）：本地真 node:http server 监听 127.0.0.1 随机端口，
 * 记录每个请求的头；带匹配 If-None-Match / If-Modified-Since 时回 304。无论
 * rss.js 内部走 utils.fetchURL、原生 fetch 还是 http.request，都会真连本 server，
 * 断言点只在 server 侧观测到的请求头 —— 不绑定实现选型。
 *
 * 时间基准（不依赖真实时钟）：now = 2026-10-20 01:00 Asia/Shanghai
 * （= 2026-10-19T17:00:00Z），digest = '20261020'；feed 夹具 pubDate 落在 36h
 * 窗内。vi.useFakeTimers({ toFake: ['Date'] }) 只替换 Date，真 socket 不受影响。
 */

process.env.TZ = 'Asia/Shanghai';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const Database = require('better-sqlite3');
const { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } = globalThis;

const dateContract = require('../../services/date-contract');
const utils = require('../../services/utils');

/* ---------- 伪造时间轴（01:00 CST 调度时刻） ---------- */
const HOUR = 3600e3;
const NOW = Date.UTC(2026, 9, 19, 17, 0, 0); // 2026-10-20 01:00 Asia/Shanghai
const DIGEST = '20261020';
const T_IN = NOW - HOUR; // 2026-10-19T16:00:00Z，36h 窗内

const pubRss = (t) => new Date(t).toUTCString();

const feedBody = (label, n) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Mock ${label}</title><link>https://ex.com/</link><description>mock</description>
${Array.from({ length: n }, (_, i) => `  <item><title>${label} item ${i + 1}</title><link>https://ex.com/${label.toLowerCase()}/${i + 1}</link><pubDate>${pubRss(T_IN)}</pubDate><description>desc ${label} ${i + 1}</description></item>`).join('\n')}
</channel></rss>`;

/* ---------- 本地受控 feed server（唯一的 HTTP 观测点） ---------- */
function makeFeedServer() {
  const state = {
    requests: [], // { method, path, headers }
    bodies: {
      '/a.xml': feedBody('A', 2),
      '/b.xml': feedBody('B', 1),
      '/c.xml': feedBody('C', 1),
    },
    etags: {
      '/a.xml': '"etag-a-v1"',
      '/b.xml': '"etag-b-v1"',
      '/c.xml': null, // C 源只发 Last-Modified
    },
    lastModified: {
      '/c.xml': 'Sun, 18 Oct 2026 16:00:00 GMT',
    },
  };
  const server = http.createServer((req, res) => {
    state.requests.push({ method: req.method, path: req.url, headers: { ...req.headers } });
    const etag = state.etags[req.url] || null;
    const lastMod = state.lastModified[req.url] || null;
    if (etag && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    if (!etag && lastMod && req.headers['if-modified-since'] === lastMod) {
      res.writeHead(304, { 'Last-Modified': lastMod });
      return res.end();
    }
    const headers = { 'Content-Type': 'application/rss+xml' };
    if (etag) headers.ETag = etag;
    if (lastMod) headers['Last-Modified'] = lastMod;
    res.writeHead(200, headers);
    res.end(state.bodies[req.url] || '');
  });
  return { state, server };
}

const feedServer = makeFeedServer();
let base = '';

function requestsFor(feedPath) {
  return feedServer.state.requests.filter((r) => r.path === feedPath);
}

/* ---------- vm harness（sync-source / connector-date-window 同款） ----------
 * getDB 指向内存库；utils/date-contract 直接给测试进程的真模块对象（fetchURL
 * 真发 http.request，直连本地 server，闭包在测试进程、不受 vm context 影响）；
 * context 同时注入原生 fetch —— 传输路径全部真实，观测点在 server。
 * process.env 每次调用方给定（开关时序不依赖模块加载细节）。
 * 每次 buildHarness 重建模块图 = 一轮抓取一个新进程。 */
function buildHarness(db, env = {}) {
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
      fetch: globalThis.fetch, // GREEN 阶段 rss.js 若直接用原生 fetch，同样真连本地 server
      Date: globalThis.Date,   // vi 假时钟
      AbortController: globalThis.AbortController,
      setTimeout,
      clearTimeout,
      process: { env: { ...env } },
      require(name) {
        if (name === 'fast-xml-parser') return require(name);
        if (name === '../db/connection') return { getDB: () => db };
        if (name === '../services/utils' || name === './utils') return utils;
        if (name === '../services/date-contract' || name === './date-contract') return dateContract;
        if (name === "../services/secret-redaction") return require("../../services/secret-redaction"); // 案2 redaction lane: rss writeCondState 写库前脱敏（真实模块，纯叶子）
        if (name === './base') return load('connectors/base.js');
        if (name === './rss') return load('connectors/rss.js');
        throw new Error(`Unexpected require ${name} from ${relativePath}`);
      },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    cache.set(filename, module.exports);
    return module.exports;
  }
  return { load };
}

/** 每轮抓取 = 新 harness（新模块图）+ 新 connector 实例；错误转断言失败。 */
async function fetchRound(db, slug, env) {
  const { RSSConnector } = buildHarness(db, env).load('connectors/rss.js');
  const conn = new RSSConnector(slug);
  try {
    return { err: null, items: await conn.fetch(DIGEST) };
  } catch (e) {
    return { err: e };
  }
}

function expectNoErr(r, msg) {
  expect(r.err, `${msg}（got: ${r.err && r.err.message}）`).toBeNull();
}

describe('Round2 ③ RSS conditional requests (ETag / Last-Modified / 304 / RSS_CONDITIONAL)', () => {
  let db;
  beforeAll(async () => {
    await new Promise((resolve) => feedServer.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${feedServer.server.address().port}`;
  });
  afterAll(async () => {
    feedServer.server.closeAllConnections();
    await new Promise((resolve) => feedServer.server.close(resolve));
  });
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    feedServer.state.requests.length = 0; // 每用例隔离 server 侧观测（server 本身复用）
    db = new Database(':memory:');
    db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/001_initial_schema.sql'), 'utf8'));
    // user_data（028 迁移后的形态）：ETag/Last-Modified 持久层的常规落点，
    // 供 GREEN 实现使用；本测试不检查存储介质，只检查跨实例行为。
    db.exec(`CREATE TABLE IF NOT EXISTS user_data (key TEXT, user_id TEXT DEFAULT '', value TEXT, PRIMARY KEY (key, user_id))`);
    const ins = db.prepare('INSERT INTO sources (id, slug, label, feed_url) VALUES (?, ?, ?, ?)');
    ins.run('src-a', 'rss-a', 'RSS A', `${base}/a.xml`);
    ins.run('src-b', 'rss-b', 'RSS B', `${base}/b.xml`);
    ins.run('src-c', 'rss-c', 'RSS C', `${base}/c.xml`);
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('C1: default-on — second round replays the stored ETag as If-None-Match (across a fresh connector/module graph)', async () => {
    const first = await fetchRound(db, 'rss-a', {}); // RSS_CONDITIONAL 未设置 → 默认开
    expectNoErr(first, '首轮抓取不得抛错');
    if (first.err) return;
    expect(first.items, '首轮 200 应解析出条目').toHaveLength(2);

    const second = await fetchRound(db, 'rss-a', {}); // 新模块图 + 新实例 = 新进程语义
    expectNoErr(second, '第二轮抓取不得抛错');
    if (second.err) return;

    const reqs = requestsFor('/a.xml');
    expect(reqs, 'server 应恰好收到两轮 /a.xml 请求').toHaveLength(2);
    expect(reqs[1].headers['if-none-match'],
      '第二轮必须回发首轮保存的 ETag（got headers: ' + JSON.stringify(reqs[1].headers) + '）')
      .toBe('"etag-a-v1"');
  });

  it('C2: 304 Not Modified resolves to zero items without parsing', async () => {
    const first = await fetchRound(db, 'rss-a', {});
    expectNoErr(first, '首轮抓取不得抛错');
    if (first.err) return;

    const second = await fetchRound(db, 'rss-a', {});
    expectNoErr(second, '304 必须视为“无新内容”而非错误');
    if (second.err) return;
    expect(Array.isArray(second.items), '304 时 fetch() 仍返回数组').toBe(true);
    expect(second.items, '304 时跳过解析，返回空数组（got ' + second.items.length + ' items）').toHaveLength(0);
    const reqs = requestsFor('/a.xml');
    expect(reqs).toHaveLength(2);
    expect(reqs[1].headers['if-none-match'], 'server 收到 304 请求的前提是回发了 ETag').toBe('"etag-a-v1"');
  });

  it('C3: refreshed ETag replaces the stored one on the next round', async () => {
    const first = await fetchRound(db, 'rss-a', {});
    expectNoErr(first, '首轮抓取不得抛错');
    if (first.err) return;

    feedServer.state.etags['/a.xml'] = '"etag-a-v2"'; // 服务器换发新 ETag
    const second = await fetchRound(db, 'rss-a', {}); // 旧 ETag → 200 + 新 ETag + 全量
    expectNoErr(second, 'ETag 变化后的 200 不得抛错');
    if (second.err) return;
    expect(second.items, 'ETag 变化时 200 应照常解析').toHaveLength(2);

    const third = await fetchRound(db, 'rss-a', {}); // 应带新 ETag → 304
    expectNoErr(third, '第三轮不得抛错');
    if (third.err) return;

    const reqs = requestsFor('/a.xml');
    expect(reqs).toHaveLength(3);
    expect(reqs[1].headers['if-none-match'], '第二轮回发旧 ETag').toBe('"etag-a-v1"');
    expect(reqs[2].headers['if-none-match'],
      '拿到新 ETag 后下一轮必须回发新值（got: ' + JSON.stringify(reqs[2].headers['if-none-match']) + '）')
      .toBe('"etag-a-v2"');
    expect(third.items, '新 ETag 命中 304 → 空数组').toHaveLength(0);
  });

  it('C4: RSS_CONDITIONAL=0 disables conditional headers and keeps the legacy full fetch', async () => {
    const first = await fetchRound(db, 'rss-a', {});
    expectNoErr(first, '首轮抓取不得抛错');
    if (first.err) return;

    const second = await fetchRound(db, 'rss-a', { RSS_CONDITIONAL: '0' });
    expectNoErr(second, '开关关闭时抓取不得抛错');
    if (second.err) return;

    const reqs = requestsFor('/a.xml');
    expect(reqs).toHaveLength(2);
    expect(reqs[1].headers['if-none-match'],
      'RSS_CONDITIONAL=0 时不得发送条件头（got: ' + JSON.stringify(reqs[1].headers['if-none-match']) + '）')
      .toBeUndefined();
    expect(second.items, '开关关闭时照常 200 全量解析').toHaveLength(2);
  });

  it('C1b: Last-Modified-only feed replays If-Modified-Since and 304 yields zero items', async () => {
    const first = await fetchRound(db, 'rss-c', { RSS_CONDITIONAL: '1' });
    expectNoErr(first, '首轮抓取不得抛错');
    if (first.err) return;
    expect(first.items).toHaveLength(1);

    const second = await fetchRound(db, 'rss-c', { RSS_CONDITIONAL: '1' });
    expectNoErr(second, '第二轮不得抛错');
    if (second.err) return;

    const reqs = requestsFor('/c.xml');
    expect(reqs).toHaveLength(2);
    expect(reqs[1].headers['if-modified-since'],
      '无 ETag 的源必须回发 Last-Modified（got headers: ' + JSON.stringify(reqs[1].headers) + '）')
      .toBe('Sun, 18 Oct 2026 16:00:00 GMT');
    expect(second.items, 'If-Modified-Since 命中 304 → 空数组').toHaveLength(0);
  });

  it('C5: per-source isolation — feed A’s ETag is never replayed to feed B', async () => {
    const a1 = await fetchRound(db, 'rss-a', {});
    expectNoErr(a1, 'A 源首轮不得抛错');
    if (a1.err) return;

    const b1 = await fetchRound(db, 'rss-b', {});
    expectNoErr(b1, 'B 源首轮不得抛错');
    if (b1.err) return;
    const b1Reqs = requestsFor('/b.xml');
    expect(b1Reqs).toHaveLength(1);
    expect(b1Reqs[0].headers['if-none-match'],
      'B 源首轮请求不得携带 A 源的 ETag（got: ' + JSON.stringify(b1Reqs[0].headers['if-none-match']) + '）')
      .toBeUndefined();

    const b2 = await fetchRound(db, 'rss-b', {});
    expectNoErr(b2, 'B 源第二轮不得抛错');
    if (b2.err) return;
    const bReqs = requestsFor('/b.xml');
    expect(bReqs).toHaveLength(2);
    expect(bReqs[1].headers['if-none-match'],
      'B 源第二轮回发的是自己的 ETag，绝不串源（got: ' + JSON.stringify(bReqs[1].headers['if-none-match']) + '）')
      .toBe('"etag-b-v1"');
  });
});
