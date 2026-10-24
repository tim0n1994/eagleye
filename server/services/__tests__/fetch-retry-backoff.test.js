// @vitest-environment node
/**
 * Round 2 · CTO 03:40 追加 — connectors 网络类错误重试契约测试（fetch 层）
 * 测试作者·网络重试
 *
 * 根因（CTO 原文）：01:00:43 mihomo AI-Egress 上游瞬断，同一秒 TLS 断连打空
 * 14 个走代理的源；各源每轮无重试。补丁落点以共享 fetch 层为主
 * （server/services/utils.js fetchURL，utils.js:16-55），让所有 connector 受益；
 * x-following 的 twitter-cli 路径不在本补丁范围。
 *
 * 契约（测试作者钉死，实现照此落地）：
 *  - 可重试（网络类）：
 *      · TLS 断连：message 含
 *        'Client network socket disconnected before secure TLS connection was established'
 *        （Node 实际形态 code=ECONNRESET（_tls_wrap onConnectEnd → ConnResetException）；
 *        被中间层重新包装后可能只剩 message —— 两种形态都要认）
 *      · ECONNRESET · ETIMEDOUT · 'socket hang up'
 *      · HTTP 5xx（utils.fetchURL 以 `Upstream 5xx: …` 拒绝的那一类）
 *  - 不可重试：HTTP 4xx（404/400）、HTTP 304（rss.js:263-267 依赖 `Upstream 304`
 *    原样抛出）、解析错误（fetch 层不看 body；connector 自己的 parse 异常不进入重试）。
 *    不重试路径的错误文本必须与今天逐字一致（`Upstream <status>: <body>`，utils.js:47）。
 *  - 退避：10s → 45s（毫秒 10000、45000 —— 案1 2026-10-22 早间由 30s/120s
 *    收紧：旧表叠加请求超时会吃穿每源 180s 预算），最多重试 2 次（最多 3 次请求）；
 *    最后一次失败后不再 sleep；耗尽后抛出最后一次的错误（message 原文可辨）。
 *    本文件全部用例不传 deadline → 无预算限制走满重试表（预算感知重试契约
 *    见 fetch-retry-budget.test.js）。
 *  - sleep 注入：fetchURL(url, { sleep })，sleep(ms) => Promise；缺省为真计时器。
 *    测试注入记录器，绝不真等。
 *  - 计数通道：fetchURL(url, { stats })，每次重试 stats.retries += 1，累加语义：
 *    stats.retries = (stats.retries || 0) + 本次重试数 —— 未重试时也置为数字 0；
 *    同一 stats 跨多次 fetchURL 累加（HN firebase 路径一轮 1+30 次请求共用一个 stats，
 *    hn.js:77）。connector 把 fetchSource 传入的 opts.stats 转交给 fetchURL
 *    （connectors/index.js:172 → connector.fetch(date, { limit, stats, signal })）。
 *    信封侧契约见 fetch-retry-envelope.test.js。
 *
 * 全 mock：
 *  - HTTP：vi.spyOn(https, 'request') 替换 utils.js:38 实际调用的传输入口为脚本化
 *    序列（无真实网络、无 DNS）。
 *  - 时间：sleep 由测试注入并记录到与请求同一条事件时间线上（可断言交错顺序）；
 *    每次调用再套 2s 真实守卫 —— 若实现绕过注入 sleep 真等退避，测试以明确信息
 *    失败而不是挂到 vitest 超时。
 */
const https = require('https');
const { EventEmitter } = require('events');
const utils = require('../utils');
const { describe, it, expect, afterEach, vi } = globalThis;

const TLS_MSG = 'Client network socket disconnected before secure TLS connection was established';
const URL_OK = 'https://upstream.example.test/api/items';
// 案1（CTO 2026-10-22 早间）：退避表 30s/120s → 10s/45s。本文件钉新表；
// 与 utils.RETRY_BACKOFF_MS 共用同一事实源（fetch-retry-budget.test.js ③ 断言）。
const BACKOFF_1 = 10000;
const BACKOFF_2 = 45000;

/* ---------- 网络错误样本（照 Node 实际形态构造） ---------- */
function netError(message, code, extra = {}) {
  const err = new Error(message);
  if (code) err.code = code;
  return Object.assign(err, extra);
}
// lib/_tls_wrap.js onConnectEnd → ConnResetException(...) → code 'ECONNRESET'
const tlsDisconnect = () => netError(TLS_MSG, 'ECONNRESET');
const econnreset = () => netError('read ECONNRESET', 'ECONNRESET', { syscall: 'read', errno: -104 });
const etimedout = () => netError('connect ETIMEDOUT 104.18.0.1:443', 'ETIMEDOUT', { syscall: 'connect', errno: -110 });
const socketHangUp = () => netError('socket hang up', 'ECONNRESET');

/* ---------- 脚本化传输：替换 https.request（utils.js:38 的实际入口） ---------- */
/**
 * script 为数组：所有请求按序消耗 step（超出则重复最后一个）。
 *   step = { error }                   → 请求对象 'error' 事件（socket 层失败）
 *   step = { status, body?, headers? } → 响应 statusCode + body
 * 每次请求在 events 时间线上记 'request'，与 sleep 记录交错，便于断言顺序。
 */
function installTransport(script, events) {
  const calls = [];
  const impl = (reqOpts, onResponse) => {
    const step = script[Math.min(calls.length, script.length - 1)];
    calls.push({ hostname: reqOpts.hostname, path: reqOpts.path, method: reqOpts.method });
    events.push('request');
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
  return { calls };
}

function sleepRecorder(events) {
  const sleeps = [];
  const sleep = (ms) => { sleeps.push(ms); events.push(`sleep:${ms}`); return Promise.resolve(); };
  return { sleep, sleeps };
}

/** 把 fetchURL 的结局收敛为 { ok, body | err }，并套 2s 真实守卫（见文件头）。 */
function settle(promise, label) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      ok: false,
      timedOut: true,
      err: new Error(`${label}: fetchURL 2s 内未结束 —— 实现很可能绕过了注入的 options.sleep（真等退避）`),
    }), 2000);
  });
  return Promise.race([
    promise.then(body => ({ ok: true, body }), err => ({ ok: false, err })),
    guard,
  ]).finally(() => clearTimeout(timer));
}

afterEach(() => { vi.restoreAllMocks(); });

describe('utils.fetchURL — 网络类错误重试（CTO 03:40 → 案1 2026-10-22：退避 10s→45s，最多 2 次；无 deadline 不设限）', () => {
  it('① 一次 TLS 断连后成功：最终成功、retries=1、退避 10s（注入 sleep 记录调用序列）', async () => {
    const events = [];
    const t = installTransport([{ error: tlsDisconnect() }, { status: 200, body: 'ok-after-retry' }], events);
    const { sleep, sleeps } = sleepRecorder(events);
    const stats = {};
    const outcome = await settle(utils.fetchURL(URL_OK, { sleep, stats }), '①');
    expect(outcome.ok, `①：一次 TLS 断连后必须重试并成功；实际拒绝：${outcome.err?.message}`).toBe(true);
    expect(outcome.body).toBe('ok-after-retry');
    expect(t.calls.length, '①：恰好 2 次请求（首发 + 1 次重试）').toBe(2);
    expect(sleeps, '①：退避序列恰为 [10000]（毫秒）').toEqual([BACKOFF_1]);
    expect(events, '①：请求/退避交错顺序').toEqual(['request', `sleep:${BACKOFF_1}`, 'request']);
    expect(stats.retries, '①：stats.retries=1').toBe(1);
  });

  it('② 连续 3 次 TLS 断连：以失败结束（抛出最后一次错误 → 上层判 ERRORED）、retries=2、退避 10s→45s、末次失败后不再 sleep', async () => {
    const events = [];
    const t = installTransport([{ error: tlsDisconnect() }, { error: tlsDisconnect() }, { error: tlsDisconnect() }], events);
    const { sleep, sleeps } = sleepRecorder(events);
    const stats = {};
    const outcome = await settle(utils.fetchURL(URL_OK, { sleep, stats }), '②');
    expect(outcome.timedOut, outcome.err?.message).toBeFalsy();
    expect(outcome.ok, '②：耗尽重试后必须以失败结束').toBe(false);
    expect(String(outcome.err?.message), '②：抛出最后一次的网络错误，原文可辨').toContain(TLS_MSG);
    expect(t.calls.length, '②：恰好 3 次请求（首发 + 2 次重试），不多不少').toBe(3);
    expect(sleeps, '②：退避序列 10s→45s').toEqual([BACKOFF_1, BACKOFF_2]);
    expect(events, '②：第 3 次失败后不得再 sleep').toEqual([
      'request', `sleep:${BACKOFF_1}`, 'request', `sleep:${BACKOFF_2}`, 'request',
    ]);
    expect(stats.retries, '②：stats.retries=2').toBe(2);
  });

  const RETRYABLE = [
    ['ECONNRESET', () => ({ error: econnreset() })],
    ['ETIMEDOUT', () => ({ error: etimedout() })],
    ['socket hang up', () => ({ error: socketHangUp() })],
    ['HTTP 503', () => ({ status: 503, body: 'Service Unavailable' })],
    ['HTTP 502（代理上游断连时的典型响应）', () => ({ status: 502, body: 'Bad Gateway' })],
    ['TLS 断连（仅 message、无 code —— 被中间层重新包装的形态）', () => ({ error: netError(TLS_MSG) })],
  ];
  it.each(RETRYABLE)('③ 可重试一例：%s → 一次失败后重试成功，retries=1，退避 10s', async (label, makeStep) => {
    const events = [];
    const t = installTransport([makeStep(), { status: 200, body: 'recovered' }], events);
    const { sleep, sleeps } = sleepRecorder(events);
    const stats = {};
    const outcome = await settle(utils.fetchURL(URL_OK, { sleep, stats }), `③ ${label}`);
    expect(outcome.ok, `③ ${label}：必须重试并成功；实际拒绝：${outcome.err?.message}`).toBe(true);
    expect(outcome.body).toBe('recovered');
    expect(t.calls.length, `③ ${label}：恰好 2 次请求`).toBe(2);
    expect(sleeps, `③ ${label}：退避 [10000]`).toEqual([BACKOFF_1]);
    expect(stats.retries, `③ ${label}：stats.retries=1`).toBe(1);
  });

  const NON_RETRYABLE = [
    ['HTTP 404', { status: 404, body: 'Not Found' }, /^Upstream 404\b/],
    ['HTTP 400', { status: 400, body: 'Bad Request' }, /^Upstream 400\b/],
    ['HTTP 304（rss.js:263-267 依赖 `Upstream 304` 原样抛出）', { status: 304, body: '' }, /^Upstream 304\b/],
  ];
  it.each(NON_RETRYABLE)('④ 不重试：%s → 单次请求即失败，retries=0，不 sleep，错误文本不变', async (label, step, pattern) => {
    const events = [];
    const t = installTransport([step, { status: 200, body: 'must-not-be-reached' }], events);
    const { sleep, sleeps } = sleepRecorder(events);
    const stats = {};
    const outcome = await settle(utils.fetchURL(URL_OK, { sleep, stats }), `④ ${label}`);
    expect(outcome.timedOut, outcome.err?.message).toBeFalsy();
    expect(outcome.ok, `④ ${label}：非网络类失败不得被重试成"成功"`).toBe(false);
    expect(String(outcome.err?.message), `④ ${label}：错误文本与今天逐字一致`).toMatch(pattern);
    expect(t.calls.length, `④ ${label}：恰好 1 次请求`).toBe(1);
    expect(sleeps, `④ ${label}：不得退避`).toEqual([]);
    expect(stats.retries, `④ ${label}：stats.retries 为数字 0（字段恒在，信封侧始终可读）`).toBe(0);
  });

  it('④ 解析错误不重试：200 + 畸形 body 由 fetchURL 原样返回（fetch 层不解析 body），单次请求、retries=0', async () => {
    const events = [];
    const t = installTransport([{ status: 200, body: '<<< not json / not xml' }], events);
    const { sleep, sleeps } = sleepRecorder(events);
    const stats = {};
    const outcome = await settle(utils.fetchURL(URL_OK, { sleep, stats }), '④ parse');
    expect(outcome.ok, outcome.err?.message).toBe(true);
    expect(outcome.body).toBe('<<< not json / not xml');
    // 解析错误在 connector 侧才发生，不进入 fetch 层重试
    expect(() => JSON.parse(outcome.body)).toThrow(SyntaxError);
    expect(t.calls.length).toBe(1);
    expect(sleeps).toEqual([]);
    expect(stats.retries, '④ parse：stats.retries 为数字 0').toBe(0);
  });

  it('计数累加语义：同一 stats 跨多次 fetchURL 累加（HN firebase 一轮 1+30 次请求共用一个 stats，hn.js:77）：1 + 0 + 1 → retries=2', async () => {
    const events = [];
    const t = installTransport([
      { error: econnreset() }, { status: 200, body: 'a' },      // 第 1 次调用：重试 1 次后成功
      { status: 200, body: 'b' },                                // 第 2 次调用：干净成功（不得把计数重置为 0）
      { status: 503, body: 'busy' }, { status: 200, body: 'c' }, // 第 3 次调用：重试 1 次后成功
    ], events);
    const { sleep, sleeps } = sleepRecorder(events);
    const stats = {};
    for (const expected of ['a', 'b', 'c']) {
      const outcome = await settle(utils.fetchURL(URL_OK, { sleep, stats }), `acc-${expected}`);
      expect(outcome.ok, `累加：第 ${expected} 次调用必须成功；实际拒绝：${outcome.err?.message}`).toBe(true);
      expect(outcome.body).toBe(expected);
    }
    expect(t.calls.length).toBe(5);
    expect(sleeps).toEqual([BACKOFF_1, BACKOFF_1]);
    expect(stats.retries, '累加语义：1 + 0 + 1 = 2，不得被无重试的调用重置').toBe(2);
  });
});
