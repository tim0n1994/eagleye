// @vitest-environment node
/**
 * 案1 · 重试退避 × 每源预算 冲突 — RED 契约测试（测试作者·预算重试）
 * 分支 fix-morning-1022（worktree /home/user/projects/eaglye-fix-wt，自 main dc1fe65）
 *
 * 事故（CTO 早间裁决要点）：2026-10-22 01:00 三个源
 * （app-store-trend / physical-ai-cn-photonics / physical-ai-humanoid）
 * exceeded 180000ms budget 判 ERRORED —— 退避 30s+120s 再叠加请求超时，
 * 吃穿了每源 180s 预算；同时段 mihomo 12 次 AI-Egress 连接错误触发 9 次重试。
 *
 * 契约（测试作者钉死，GREEN 实现照此落地）：
 *  - server/services/utils.js：
 *      · 退避表 RETRY_BACKOFF_MS 由 [30000, 120000] 改为 [10000, 45000]，
 *        并从 module.exports 导出（常量断言与行为断言共用同一事实源）；
 *      · withFetchRetry 重试感知剩余预算：deadline（epoch 毫秒绝对值，语义同
 *        fetchSource 的 Date.now()+budget）经 options.deadline 或 fetchSource
 *        的 ambient fetch 上下文（runWithFetchContext store.deadline）传入，
 *        解析次序与 stats/signal/sleep 一致：显式 options > ambient store > 无
 *        （无 deadline = 不设限，按新表重试）。每次重试前判
 *        remaining = deadline - Date.now()：remaining 装不下「一轮退避 + 一次
 *        请求」→ 不再重试，直接以最后一次错误结束（不 sleep、不发新请求、
 *        错误原文不变，stats.retries 只计实际发生的重试）；
 *      · fetchURL(url, { deadline }) 透传 deadline 给 withFetchRetry。
 *  - server/connectors/index.js fetchSource：把 deadline 放进
 *        runWithFetchContext 的 store（现仅 { stats, signal }，index.js:194），
 *        使全部 connector 的 fetchURL 零改动获得预算感知。
 *
 * 钉死的可观测边界（本文全部 RED —— main（dc1fe65）现行行为与之冲突）：
 *  ① 剩余预算 40s：首轮 10s 退避照走（40s 装得下 10s 退避 + 1 次请求）；
 *     第二轮 45s 退避不得触发、第二轮重试不得进入 —— 总请求数恰 2，
 *     以最后一次网络错误结束（withFetchRetry 层 / fetchSource 层各一例）；
 *  ② 预算充足（180s，事故当晚预算值）：10s→45s 两轮重试正常走完
 *     （注入 sleep 断言序列），正常重试路径不回退（fetchURL 层 /
 *     fetchSource 层各一例）；
 *  ③ 退避表常量：utils.RETRY_BACKOFF_MS 深等于 [10000, 45000]；
 *  ④ 预算耗尽不新增请求：remaining ≤ 0，或 5s < 首轮退避 10s ——
 *     首发 1 次请求失败后不得再发任何请求、不得 sleep，以该次错误结束。
 *
 * 全 mock（无真实等待、无真实网络、无 DB）：
 *  - 时钟：测试 realm vi.spyOn(Date, 'now')；fetchSource 层 vm harness 的
 *    VDate 与之共享同一可变时刻（单一时钟变量，测试 realm 与 vm realm 无
 *    漂移）；注入 sleep 恰好把时钟推进 ms —— 「退避消耗预算」完全确定。
 *  - HTTP：vi.spyOn(https, 'request') 脚本化（照 fetch-retry-backoff.test.js）。
 *  - DB：vm harness 注入 getDB: () => null —— recordFailedAttempt /
 *    recordFetchDuration 按 best-effort 契约直接 no-op，不落任何库。
 *  - 每个 await 套 2s 真实守卫：若实现绕过注入 sleep 真等 10s/45s，
 *    测试以明确信息失败而非挂到 vitest 超时。
 *
 * 既有测试维护提示（GREEN 时由实现者同步，不属于本文件）：
 * fetch-retry-backoff.test.js / fetch-retry-envelope.test.js 钉死了旧表
 * 30000/120000 与「无预算感知」行为，退避表变更后需同步更新。
 */
const https = require('https');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { EventEmitter } = require('events');
const utils = require('../utils');
const { describe, it, expect, afterEach, vi } = globalThis;

const RealDate = Date; // 在任何 spy 之前捕获
const RED = 'RED（预期失败，非环境错误）';
const T0 = Date.parse('2026-10-21T17:00:00Z'); // 2026-10-22 01:00 Asia/Shanghai —— 事故窗口
const BACKOFF_1 = 10000;  // 案1 新表首轮退避 10s
const BACKOFF_2 = 45000;  // 案1 新表二轮退避 45s
const TEST_URL = 'https://upstream.example.test/api/items';

afterEach(() => { vi.restoreAllMocks(); });

/* ---------- 共享虚拟时钟（测试 realm 与 vm realm 读同一变量） ---------- */
function makeClock() {
  let now = T0;
  return { now: () => now, peek: () => now, tick: (ms) => { now += ms; } };
}

/* ---------- 网络错误样本（照 Node 实际形态；[req-N] 标记可辨「最后一次错误」） ---------- */
function netError(message, code) {
  const err = new Error(message);
  if (code) err.code = code;
  return err;
}
const resetError = (n) => netError(`read ECONNRESET [req-${n}]`, 'ECONNRESET');

/* ---------- 注入 sleep：记录 + 恰好把虚拟时钟推进 ms（退避 = 消耗预算） ---------- */
function sleepRecorder(clock, events = null) {
  const sleeps = [];
  const sleep = (ms) => {
    sleeps.push(ms);
    if (events) events.push(`sleep:${ms}`);
    clock.tick(ms);
    return Promise.resolve();
  };
  return { sleep, sleeps };
}

/* ---------- 脚本化传输：替换 https.request（utils.js fetchOnce 的实际入口） ----------
 * script 按序消耗 step（超出则重复最后一个）：{ error } 或 { status, body }。
 * 模式照 fetch-retry-backoff.test.js；events 可选，用于请求/退避交错断言。
 */
function installTransport(script, events) {
  const calls = [];
  const impl = (reqOpts, onResponse) => {
    const step = script[Math.min(calls.length, script.length - 1)];
    calls.push({ url: `${reqOpts.hostname}${reqOpts.path}` });
    if (events) events.push('request');
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

/* ---------- withFetchRetry 层直连：脚本化 attempt（每次抛带标记的可重试错误） ----------
 * GREEN 修正（实现工程师·预算重试，2026-10-22）：markers 必须是数字 id ——
 * resetError(n) 本身就格式化 `[req-${n}]`，RED 稿传 'req-1' 等字符串会产出
 * `[req-req-1]`（标记前缀翻倍，toContain('[req-1]') 恒 false）。行为断言
 * （尝试数/sleep 序列/retries）在 RED 稿下已按契约通过，仅标记文本错位；
 * 修正与 fetchSource 层 resetError(1/2/…) 的既有用法对齐，不改变任何契约。 */
function scriptedAttempts(markers) {
  const attempts = [];
  const attempt = async () => {
    const idx = Math.min(attempts.length, markers.length - 1);
    attempts.push(markers[idx]);
    throw resetError(markers[idx]);
  };
  return { attempt, attempts };
}

/* ---------- 2s 真实守卫：实现若绕过注入 sleep 真等退避，明确失败而非挂死 ---------- */
function settle(promise, label) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      ok: false,
      timedOut: true,
      err: new Error(`${label}: 2s 内未结束 —— 实现很可能绕过了注入的 sleep（真等 10s/45s 退避）；契约要求全部退避经注入 sleep 走虚拟时钟`),
    }), 2000);
  });
  return Promise.race([
    promise.then(body => ({ ok: true, body }), err => ({ ok: false, err })),
    guard,
  ]).finally(() => clearTimeout(timer));
}

/* ---------- fetchSource 层 vm harness（模式照 sync-source.test.js） ----------
 * 关键点：
 *  - '../services/utils' 直接给真实 utils 模块 —— fetchSource（vm 内）调用的
 *    runWithFetchContext 与 connector 调用的 utils.fetchURL 是同一个
 *    AsyncLocalStorage：fetchSource 放进 store 的字段（现 {stats, signal}，
 *    GREEN 后含 deadline）就是 withFetchRetry 的 ambient 来源；
 *  - VDate 与测试 realm 的 Date.now spy 共享同一时钟变量（makeClock）；
 *  - ScriptedConnector.fetch 只发一次 utils.fetchURL(TEST_URL, { sleep })，
 *    stats/signal/deadline 全走 ambient —— 零改动 connector 的真实姿势；
 *  - '../db/connection' → { getDB: () => null }：簿记 best-effort no-op。
 */
function fetchSourceHarness({ env = {}, clock, sleep, testUrl = TEST_URL }) {
  const serverRoot = path.resolve(__dirname, '../..');
  const cache = new Map();
  class VDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock.now()])); }
    static now() { return clock.now(); }
  }
  function load(relativePath) {
    const filename = path.join(serverRoot, relativePath);
    if (cache.has(filename)) return cache.get(filename);
    const target = { exports: {} };
    const context = {
      module: target,
      exports: target.exports,
      console: { log() {}, warn() {}, error() {} },
      URL,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      AbortController: globalThis.AbortController,
      Date: VDate,
      performance: { now: () => clock.now() },
      process: { env: { ...env } },
      require(name) {
        if (name === '../db/connection') return { getDB: () => null };
        if (name === '../services/utils') return utils;
        if (name === '../services/date-contract') return require('../date-contract');
        if (name === './base') return load('connectors/base.js');
        if (relativePath === 'connectors/index.js' && name.startsWith('./')) {
          const RealBase = load('connectors/base.js');
          return new Proxy({}, {
            get: (t, prop) => {
              if (prop === '__esModule') return false;
              if (typeof prop !== 'string') return undefined;
              return class ScriptedConnector extends RealBase.BaseConnector {
                async fetch() { return utils.fetchURL(testUrl, { sleep }); }
              };
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
  return { registry: load('connectors/index.js') };
}

/* ══════════ ③ 退避表常量 ══════════ */
describe('案1 ③ 退避表常量：30s/120s → 10s/45s', () => {
  it('utils.RETRY_BACKOFF_MS 必须已导出且深等于 [10000, 45000]', () => {
    expect(Array.isArray(utils.RETRY_BACKOFF_MS), `${RED}: ③ utils.js 必须导出退避表常量 utils.RETRY_BACKOFF_MS（现未导出，常量断言与行为断言无法共用同一事实源）；实际类型 ${typeof utils.RETRY_BACKOFF_MS}`).toBe(true);
    expect(utils.RETRY_BACKOFF_MS, `${RED}: ③ 退避表必须由 [30000, 120000] 改为 [10000, 45000]（毫秒，CTO 案1 裁决：30s/120s 叠加请求超时会吃穿每源 180s 预算）；实际 ${JSON.stringify(utils.RETRY_BACKOFF_MS)}`).toEqual([BACKOFF_1, BACKOFF_2]);
  });
});

/* ══════════ ① / ④ withFetchRetry 层（预算感知重试核心） ══════════ */
describe('案1 withFetchRetry 层 — 重试感知剩余预算（options.deadline / ambient store.deadline）', () => {
  it('① 剩余预算 40s（deadline=now+40000）：首轮 10s 退避照走；45s 退避不得触发、第二轮重试不得进入 —— 恰 2 次尝试、sleep=[10000]、以最后一次错误 [req-2] 结束、stats.retries=1', async () => {
    const clock = makeClock();
    vi.spyOn(Date, 'now').mockImplementation(clock.now);
    const { attempt, attempts } = scriptedAttempts([1, 2, 3, 4]);
    const { sleep, sleeps } = sleepRecorder(clock);
    const stats = {};
    const outcome = await settle(
      utils.withFetchRetry(attempt, { sleep, stats, deadline: clock.peek() + 40000, label: '案1-①' }),
      '①',
    );
    expect(outcome.timedOut, `${RED}: ① ${outcome.err?.message}`).toBeFalsy();
    expect(attempts.length, `${RED}: ① 契约——剩余预算 40s 时第二轮重试不得进入：总尝试数必须恰为 2（首发 + 1 次 10s 退避重试；退避后剩余 30s 装不下 45s 退避 + 1 次请求）；实际 ${attempts.length} 次（现行 withFetchRetry 无预算感知，走满全部重试）`).toBe(2);
    expect(sleeps, `${RED}: ① 退避序列必须恰为 [${BACKOFF_1}]（新表首轮 10s）；45s（${BACKOFF_2}）退避不得触发；实际 ${JSON.stringify(sleeps)}`).toEqual([BACKOFF_1]);
    expect(String(outcome.err?.message), `${RED}: ① 预算不足停止重试时必须以「最后一次」错误直接结束（[req-2]），错误原文不变`).toContain('[req-2]');
    expect(String(outcome.err?.message), `${RED}: ① 结束错误不得是更早轮次的错误`).not.toContain('[req-1]');
    expect(stats.retries, `${RED}: ① stats.retries 必须为 1（只实际发生了 1 次重试）`).toBe(1);
  });

  it.each([
    [0, 'deadline 已到（remaining=0）'],
    [5000, '剩余 5s < 首轮退避 10s'],
  ])('④ 预算耗尽不新增请求：%s → 恰 1 次尝试、0 次 sleep、以该次错误 [req-1] 结束、stats.retries=0', async (deltaMs, caseLabel) => {
    const clock = makeClock();
    vi.spyOn(Date, 'now').mockImplementation(clock.now);
    const { attempt, attempts } = scriptedAttempts([1, 2, 3]);
    const { sleep, sleeps } = sleepRecorder(clock);
    const stats = {};
    const outcome = await settle(
      utils.withFetchRetry(attempt, { sleep, stats, deadline: clock.peek() + deltaMs, label: `案1-④ ${caseLabel}` }),
      `④ ${caseLabel}`,
    );
    expect(outcome.timedOut, `${RED}: ④ ${caseLabel} ${outcome.err?.message}`).toBeFalsy();
    expect(attempts.length, `${RED}: ④ ${caseLabel}——预算耗尽后不得新增任何请求：总尝试数必须恰为 1（仅首发）；实际 ${attempts.length} 次`).toBe(1);
    expect(sleeps, `${RED}: ④ ${caseLabel}——预算耗尽不得退避（sleep 必须为空）；实际 ${JSON.stringify(sleeps)}`).toEqual([]);
    expect(String(outcome.err?.message), `${RED}: ④ ${caseLabel}——必须以首发错误 [req-1] 直接结束，错误原文不变`).toContain('[req-1]');
    expect(stats.retries, `${RED}: ④ ${caseLabel}——stats.retries 必须为数字 0`).toBe(0);
  });

  it('②-回归 无 deadline（不设限）：新表 10s→45s 两轮重试正常走完 —— 恰 3 次尝试、sleep=[10000,45000]、以最后一次错误 [req-3] 结束、stats.retries=2', async () => {
    const clock = makeClock();
    vi.spyOn(Date, 'now').mockImplementation(clock.now);
    const { attempt, attempts } = scriptedAttempts([1, 2, 3, 4]);
    const { sleep, sleeps } = sleepRecorder(clock);
    const stats = {};
    const outcome = await settle(utils.withFetchRetry(attempt, { sleep, stats }), '②-回归');
    expect(outcome.timedOut, `${RED}: ②-回归 ${outcome.err?.message}`).toBeFalsy();
    expect(sleeps, `${RED}: ②-回归——无预算（未传 deadline）时正常重试路径不得回退，且必须按新表退避 [10000, 45000]（10s→45s）；实际 ${JSON.stringify(sleeps)}（现行旧表 30000/120000）`).toEqual([BACKOFF_1, BACKOFF_2]);
    expect(attempts.length, `${RED}: ②-回归——两轮重试走满：总尝试数必须恰为 3`).toBe(3);
    expect(String(outcome.err?.message), `${RED}: ②-回归——耗尽重试后以最后一次错误 [req-3] 结束`).toContain('[req-3]');
    expect(stats.retries, `${RED}: ②-回归——stats.retries 必须为 2`).toBe(2);
  });
});

/* ══════════ ② fetchURL 层（deadline 透传 + 预算充足不回退） ══════════ */
describe('案1 fetchURL 层 — options.deadline 透传，预算充足时正常重试不回退', () => {
  it('② 预算充足（deadline=now+180000，事故预算值）：503→503→200 走满两轮重试后成功，退避序列恰 [10000, 45000]，stats.retries=2', async () => {
    const clock = makeClock();
    vi.spyOn(Date, 'now').mockImplementation(clock.now);
    const events = [];
    const t = installTransport([
      { status: 503, body: 'busy-1' },
      { status: 503, body: 'busy-2' },
      { status: 200, body: 'ok-after-retries' },
    ], events);
    const { sleep, sleeps } = sleepRecorder(clock, events);
    const stats = {};
    const outcome = await settle(
      utils.fetchURL(TEST_URL, { sleep, stats, deadline: clock.peek() + 180000 }),
      '②',
    );
    expect(outcome.timedOut, `${RED}: ② ${outcome.err?.message}`).toBeFalsy();
    expect(outcome.ok, `${RED}: ② 预算充足（180s）时正常重试路径不得回退——两次 503 后必须第三轮成功；实际拒绝：${outcome.err?.message}`).toBe(true);
    expect(outcome.body).toBe('ok-after-retries');
    expect(sleeps, `${RED}: ② fetchURL 必须透传 deadline 且预算充足时按新表走满两轮退避 [10000, 45000]；实际 ${JSON.stringify(sleeps)}（现行旧表 30000/120000）`).toEqual([BACKOFF_1, BACKOFF_2]);
    expect(t.calls.length, `${RED}: ② 恰 3 次请求（首发 + 2 次重试）`).toBe(3);
    expect(events, `${RED}: ② 请求/退避交错顺序必须为 请求-10s-请求-45s-请求`).toEqual([
      'request', `sleep:${BACKOFF_1}`, 'request', `sleep:${BACKOFF_2}`, 'request',
    ]);
    expect(stats.retries, `${RED}: ② stats.retries 必须为 2`).toBe(2);
  });
});

/* ══════════ ① / ② fetchSource 层（跨层：预算 deadline 进 ambient fetch 上下文） ══════════ */
describe('案1 fetchSource 层 — 每源预算（SOURCE_TIMEOUT_MS）传入 fetch 上下文，重试不得吃穿预算', () => {
  it('① 预算 40s（SOURCE_TIMEOUT_MS=40000，全 4 步 ECONNRESET）：45s 退避与第二轮重试不得发生 —— 恰 2 次 HTTP 请求、以最后一次网络错误 [req-2] 结束（非 exceeded budget 超时错误）、err.retries=1、sleep=[10000]', async () => {
    const clock = makeClock();
    vi.spyOn(Date, 'now').mockImplementation(clock.now);
    const t = installTransport([
      { error: resetError(1) }, { error: resetError(2) }, { error: resetError(3) }, { error: resetError(4) },
    ], null);
    const { sleep, sleeps } = sleepRecorder(clock);
    const h = fetchSourceHarness({ env: { SOURCE_TIMEOUT_MS: '40000' }, clock, sleep });
    const outcome = await settle(
      h.registry.fetchSource('physical-ai-humanoid', '2026-10-22', { returnDetails: true }),
      'src-①',
    );
    expect(outcome.timedOut, `${RED}: src-① ${outcome.err?.message}`).toBeFalsy();
    expect(t.calls.length, `${RED}: src-① 契约——每源预算 40s：fetchSource 必须把自己的 deadline 传进 fetch 上下文（runWithFetchContext store），剩余预算装不下 45s 退避 + 1 次请求时重试必须停止：总 HTTP 请求数恰为 2（首发 + 1 次 10s 退避重试）；实际 ${t.calls.length} 次（现行 fetchSource 不传预算，重试走满吃穿预算 —— 01:00 三源 ERRORED 的事故形态）`).toBe(2);
    expect(String(outcome.err?.message), `${RED}: src-① 必须以「最后一次」网络错误 [req-2] 直接结束（不得重试成更晚/更早的错误）`).toContain('[req-2]');
    expect(String(outcome.err?.message), `${RED}: src-① 不得以预算超时错误 exceeded 40000ms budget 收场（预算感知停止重试后，错误应是网络错误本身）`).not.toContain('exceeded 40000ms budget');
    expect(outcome.err?.retries, `${RED}: src-① 信封 err.retries 必须为 1（只实际发生了 1 次重试）`).toBe(1);
    expect(sleeps, `${RED}: src-① 退避序列必须恰为 [${BACKOFF_1}]（新表首轮 10s；45s 退避不得触发）；实际 ${JSON.stringify(sleeps)}`).toEqual([BACKOFF_1]);
  });

  it('② 预算充足（默认 180000，事故预算值，全失败）：10s→45s 两轮重试正常走完 —— 恰 3 次 HTTP 请求、sleep=[10000,45000]、以 [req-3] 结束、err.retries=2、非 exceeded budget 错误', async () => {
    const clock = makeClock();
    vi.spyOn(Date, 'now').mockImplementation(clock.now);
    const t = installTransport([
      { error: resetError(1) }, { error: resetError(2) }, { error: resetError(3) }, { error: resetError(4) },
    ], null);
    const { sleep, sleeps } = sleepRecorder(clock);
    const h = fetchSourceHarness({ env: {}, clock, sleep }); // 无 SOURCE_TIMEOUT_MS → 默认 180000
    const outcome = await settle(
      h.registry.fetchSource('physical-ai-humanoid', '2026-10-22', { returnDetails: true }),
      'src-②',
    );
    expect(outcome.timedOut, `${RED}: src-② ${outcome.err?.message}`).toBeFalsy();
    expect(sleeps, `${RED}: src-② 预算充足（180s，两轮退避+请求远小于预算）时正常重试路径不得回退，且必须按新表 [10000, 45000] 走满两轮；实际 ${JSON.stringify(sleeps)}（现行旧表 30000/120000 —— 正是吃穿 180s 预算的组合）`).toEqual([BACKOFF_1, BACKOFF_2]);
    expect(t.calls.length, `${RED}: src-② 恰 3 次 HTTP 请求（首发 + 2 次重试）`).toBe(3);
    expect(String(outcome.err?.message), `${RED}: src-② 耗尽重试后以最后一次网络错误 [req-3] 结束`).toContain('[req-3]');
    expect(String(outcome.err?.message), `${RED}: src-② 预算充足时不得以 exceeded 180000ms budget 收场`).not.toContain('exceeded 180000ms budget');
    expect(outcome.err?.retries, `${RED}: src-② 信封 err.retries 必须为 2`).toBe(2);
  });
});
