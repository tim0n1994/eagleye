// @vitest-environment node
/**
 * Round 2 · CTO 03:40 重试补丁 — 复检 blocker：RSS 原生 fetch 传输必须走共享重试策略。
 *
 * 背景：生产运行时 node v24（全局 fetch 存在）→ rss.js fetchFeedAndParse 恒走
 * fetchFeedNative（裸 `fetch()`），utils.fetchURL 分支是生产不可达的回落；
 * 330756e 只给 fetchURL 加了重试，techmeme/solidot 在根因故障类（同一秒 TLS
 * 断连）下仍首次失败即打空。本文件钉死：原生传输外层包 utils.withFetchRetry，
 * 与 fetchURL 共用 RETRY_BACKOFF_MS / 分类器 / 可注入 sleep / stats 累加。
 *
 * 原生 fetch（undici）的失败形态：`TypeError: fetch failed` 且 err.cause 带
 * code（ECONNRESET / ETIMEDOUT / UND_ERR_CONNECT_TIMEOUT / UND_ERR_SOCKET）或
 * cause.message 含 TLS 原文；HTTP 5xx 由 rss.js 以 `Upstream 5xx: …` 抛出。
 * 304 / 4xx 不重试（条件请求路径依赖 304 原样返回 notModified）。
 *
 * harness：照 rss-conditional-fetch.test.js 的 vm 模式加载 rss.js（utils /
 * date-contract 为真模块），context 注入脚本化 fetch（无真实网络）；sleep 经
 * connector.fetch(date, { sleep, stats }) 透传；每次 settle 套 2s 真实守卫 ——
 * 实现若绕过注入 sleep 真等退避，以明确信息失败而非挂到 vitest 超时。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const utils = require('../../services/utils');
const dateContract = require('../../services/date-contract');
const { describe, it, expect, afterEach, vi } = globalThis;

const TLS_MSG = 'Client network socket disconnected before secure TLS connection was established';
// 案1（CTO 2026-10-22 早间）：退避表 30s/120s → 10s/45s（与 utils.RETRY_BACKOFF_MS 同源，
// fetch-retry-budget.test.js ③ 钉死）。本文件直连 connector.fetch，无 ambient
// fetchSource 上下文 → 无 deadline，重试走满整表。
const BACKOFF_1 = 10000;
const BACKOFF_2 = 45000;
const FEED_URL = 'https://feed.example.test/rss.xml';
const DIGEST = dateContract.compactDigestDate(dateContract.todayDigestDate()); // yyyymmdd, as fetchSource passes it

const feedBody = () => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Mock</title><link>https://ex.com/</link><description>mock</description>
<item><title>fresh item</title><link>https://ex.com/fresh/1</link><pubDate>${new Date(Date.now() - 3600e3).toUTCString()}</pubDate><description>d</description></item>
</channel></rss>`;

/* ---------- undici 形态的网络错误 ---------- */
function undiciError(causeCode, causeMessage) {
  const cause = new Error(causeMessage || causeCode);
  if (causeCode) cause.code = causeCode;
  return new TypeError('fetch failed', { cause });
}

/* ---------- 脚本化 fetch：按序消耗 step（超出重复最后一个） ---------- */
/** step = { error } → reject；step = { status, body?, headers? } → Response-like */
function scriptedFetch(script, events) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const step = script[Math.min(calls.length, script.length - 1)];
    calls.push({ url: String(url), headers: init.headers || {} });
    events.push('fetch');
    if (step.error) throw step.error;
    const headers = step.headers || {};
    return {
      status: step.status,
      headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
      text: async () => String(step.body ?? ''),
    };
  };
  return { impl, calls };
}

function sleepRecorder(events) {
  const sleeps = [];
  const sleep = (ms) => { sleeps.push(ms); events.push(`sleep:${ms}`); return Promise.resolve(); };
  return { sleep, sleeps };
}

function loadConnector(fetchImpl, env = {}) {
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
      fetch: fetchImpl,
      Date: globalThis.Date,
      AbortController: globalThis.AbortController,
      setTimeout,
      clearTimeout,
      process: { env: { ...env } },
      require(name) {
        if (name === 'fast-xml-parser') return require(name);
        if (name === '../db/connection') return { getDB: () => null };
        if (name === '../services/utils' || name === './utils') return utils;
        if (name === '../services/date-contract' || name === './date-contract') return dateContract;
        // 案2 redaction lane: rss writeCondState 写库前脱敏（真实模块，纯叶子）——
        // 与 rss-304-notmodified-log.test.js 的同款映射同步（跨 lane 协调，
        // rss.js 新增此 require，否则本 harness 抛 Unexpected require）。
        if (name === '../services/secret-redaction') return require('../../services/secret-redaction');
        if (name === './base') return load('connectors/base.js');
        throw new Error(`Unexpected require ${name} from ${relativePath}`);
      },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    cache.set(filename, module.exports);
    return module.exports;
  }
  const { RSSConnector } = load('connectors/rss.js');
  const connector = new RSSConnector('techmeme');
  connector.getFeedUrl = () => FEED_URL;
  return connector;
}

function settle(promise, label) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      ok: false, timedOut: true,
      err: new Error(`${label}: 2s 内未结束 —— 实现很可能绕过了注入的 sleep（真等退避）`),
    }), 2000);
  });
  return Promise.race([
    promise.then(items => ({ ok: true, items }), err => ({ ok: false, err })),
    guard,
  ]).finally(() => clearTimeout(timer));
}

afterEach(() => { vi.restoreAllMocks(); });

describe('rss.js native-fetch transport — shared network retry (CTO 03:40 复检)', () => {
  it('R1 一次 undici ECONNRESET（cause.code）后成功：条目返回、retries=1、sleeps=[10000]、fetch 2 次', async () => {
    const events = [];
    const f = scriptedFetch([{ error: undiciError('ECONNRESET', 'read ECONNRESET') }, { status: 200, body: feedBody() }], events);
    const { sleep, sleeps } = sleepRecorder(events);
    const stats = {};
    const c = loadConnector(f.impl);
    const outcome = await settle(c.fetch(DIGEST, { sleep, stats }), 'R1');
    expect(outcome.timedOut, outcome.err?.message).toBeFalsy();
    expect(outcome.ok, `R1：一次网络类失败后必须重试并成功；实际拒绝：${outcome.err?.message}`).toBe(true);
    expect(outcome.items.length, '解析路径完好：条目进入结果').toBeGreaterThanOrEqual(1);
    expect(f.calls.length, 'R1：恰好 2 次 fetch').toBe(2);
    expect(sleeps, 'R1：退避 [10000]').toEqual([BACKOFF_1]);
    expect(events, 'R1：fetch/退避交错').toEqual(['fetch', `sleep:${BACKOFF_1}`, 'fetch']);
    expect(stats.retries, 'R1：stats.retries=1').toBe(1);
  });

  const RETRYABLE = [
    ['undici cause TLS 原文（无 code）', () => ({ error: undiciError(undefined, TLS_MSG) })],
    ['undici cause ETIMEDOUT', () => ({ error: undiciError('ETIMEDOUT', 'connect ETIMEDOUT') })],
    ['undici cause UND_ERR_CONNECT_TIMEOUT', () => ({ error: undiciError('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error') })],
    ['undici cause UND_ERR_SOCKET', () => ({ error: undiciError('UND_ERR_SOCKET', 'other side closed') })],
    ['HTTP 503', () => ({ status: 503, body: 'Service Unavailable' })],
    ['HTTP 502', () => ({ status: 502, body: 'Bad Gateway' })],
  ];
  it.each(RETRYABLE)('R2 可重试：%s → 重试一次后成功，retries=1', async (label, makeStep) => {
    const events = [];
    const f = scriptedFetch([makeStep(), { status: 200, body: feedBody() }], events);
    const { sleep, sleeps } = sleepRecorder(events);
    const stats = {};
    const c = loadConnector(f.impl);
    const outcome = await settle(c.fetch(DIGEST, { sleep, stats }), `R2 ${label}`);
    expect(outcome.timedOut, outcome.err?.message).toBeFalsy();
    expect(outcome.ok, `R2 ${label}：必须重试并成功；实际拒绝：${outcome.err?.message}`).toBe(true);
    expect(f.calls.length).toBe(2);
    expect(sleeps).toEqual([BACKOFF_1]);
    expect(stats.retries).toBe(1);
  });

  it('R3 耗尽：连续 3 次 TLS 断连 → 拒绝（原文可辨）、retries=2、sleeps=[10000,45000]、末次不 sleep', async () => {
    const events = [];
    const f = scriptedFetch([{ error: undiciError('ECONNRESET', TLS_MSG) }], events); // 末步重复
    const { sleep, sleeps } = sleepRecorder(events);
    const stats = {};
    const c = loadConnector(f.impl);
    const outcome = await settle(c.fetch(DIGEST, { sleep, stats }), 'R3');
    expect(outcome.timedOut, outcome.err?.message).toBeFalsy();
    expect(outcome.ok, 'R3：耗尽后必须失败').toBe(false);
    const text = `${outcome.err?.message} ${outcome.err?.cause?.message ?? ''}`;
    expect(text, 'R3：最后一次错误原文可辨（message 或 cause）').toContain(TLS_MSG);
    expect(f.calls.length, 'R3：恰好 3 次 fetch').toBe(3);
    expect(sleeps).toEqual([BACKOFF_1, BACKOFF_2]);
    expect(events).toEqual(['fetch', `sleep:${BACKOFF_1}`, 'fetch', `sleep:${BACKOFF_2}`, 'fetch']);
    expect(stats.retries).toBe(2);
  });

  it('R4 304 不重试：notModified → 零条目、fetch 1 次、不 sleep、retries=0（条件请求语义保持）', async () => {
    const events = [];
    const f = scriptedFetch([{ status: 304, headers: { etag: '"v1"' } }, { status: 200, body: feedBody() }], events);
    const { sleep, sleeps } = sleepRecorder(events);
    const stats = {};
    const c = loadConnector(f.impl, { RSS_CONDITIONAL: '1' });
    const outcome = await settle(c.fetch(DIGEST, { sleep, stats }), 'R4');
    expect(outcome.ok, outcome.err?.message).toBe(true);
    expect(outcome.items, 'R4：304 = 无新内容 → []').toEqual([]);
    expect(f.calls.length, 'R4：304 不得触发二次请求').toBe(1);
    expect(sleeps).toEqual([]);
    expect(stats.retries, 'R4：retries 为数字 0').toBe(0);
  });

  it('R5 4xx 不重试：Upstream 404 原样抛出、fetch 1 次、不 sleep、retries=0', async () => {
    const events = [];
    const f = scriptedFetch([{ status: 404, body: 'Not Found' }, { status: 200, body: feedBody() }], events);
    const { sleep, sleeps } = sleepRecorder(events);
    const stats = {};
    const c = loadConnector(f.impl);
    const outcome = await settle(c.fetch(DIGEST, { sleep, stats }), 'R5');
    expect(outcome.timedOut, outcome.err?.message).toBeFalsy();
    expect(outcome.ok, 'R5：4xx 不得被重试成成功').toBe(false);
    expect(String(outcome.err?.message)).toMatch(/^Upstream 404\b/);
    expect(f.calls.length).toBe(1);
    expect(sleeps).toEqual([]);
    expect(stats.retries).toBe(0);
  });

  it('R6 解析错误不重试：200 + 非 RSS body → connector 侧报错、fetch 1 次、retries=0', async () => {
    const events = [];
    const f = scriptedFetch([{ status: 200, body: '<<< not xml' }], events);
    const { sleep, sleeps } = sleepRecorder(events);
    const stats = {};
    const c = loadConnector(f.impl);
    const outcome = await settle(c.fetch(DIGEST, { sleep, stats }), 'R6');
    expect(outcome.timedOut, outcome.err?.message).toBeFalsy();
    expect(outcome.ok, 'R6：解析失败应报错而非重试').toBe(false);
    expect(f.calls.length, 'R6：解析错误不得触发二次请求').toBe(1);
    expect(sleeps).toEqual([]);
    expect(stats.retries).toBe(0);
  });
});
