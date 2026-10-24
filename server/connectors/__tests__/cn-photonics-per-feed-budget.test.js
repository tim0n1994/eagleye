// @vitest-environment node
/**
 * P0 热修 B① · per-feed 超时保护 — RED 契约测试（测试作者·P0热修）
 * worktree /home/jc/projects/eagleye-p0-wt（自 main ec93cec）
 *
 * 事故（CTO 2026-10-23 02:10 巡检 + 01:00-03:30 journal 实况）：
 * physical-ai-cn-photonics 于 10-23 01:00 轮 ERRORED ——
 * "Error fetching physical-ai-cn-photonics: exceeded 180000ms budget"
 * （last_error_class=timeout, last_fetch_duration_ms=180002）。机理：
 * OFweek 三个子 feed 各吃 10s/45s 退避重试 ≈ 耗掉 ~100s+，01:03:57 剩余
 * 5 个 feed 被 fetchSource 的源级 180s 预算集体杀死（connectors/index.js:151-159
 * 的 SOURCE_TIMEOUT_* 预算 + utils.js withFetchRetry 的退避表）。案1 已让重试
 * 感知【源级】deadline（退避装不下就跳过重试），但没有【单 feed 级】上限 ——
 * 单个挂死/拒连 feed 仍可吃穿整源预算，把好 feed 一起拖进 ERRORED。
 *
 * 契约（测试作者钉死，GREEN 实现照此落地；与 rss.js fetch(date,{signal,sleep,stats})
 * 注入同族）：
 *  - server/connectors/cn-photonics.js `fetch(date, opts)` 接受注入：
 *      · opts.feeds   —— fixture 覆盖 CN_FEEDS（数组项 {name,url,lang}）。
 *        测试必需的 seam：B② 会把生产 CN_FEEDS 清空/裁剪，per-feed 保护必须有
 *        独立于生产配置的可驱动入口（首选 opts 注入；rss.js 的 opts 注入是本仓
 *        既有惯例）。
 *      · opts.sleep   —— 可注入计时（退避/放弃计时走它 → 测试里是虚拟时钟，
 *        零真实等待；案1 同款契约："全部退避经注入 sleep 走虚拟时钟"）。
 *      · opts.stats / opts.deadline —— 与 fetchSource ambient store
 *        （index.js:201 runWithFetchContext({stats,signal,deadline})）同义；
 *        deadline 为 epoch 毫秒绝对值（源级预算）。
 *  - per-feed 保护（可观测行为，不锁实现细节）：
 *      · 单个 feed 的总成本（首次请求 + 重试 + 退避 + 放弃等待）必须有上限
 *        （per-feed deadline/cap），上限必须远小于整源预算 —— 一个挂死或拒连
 *        风暴的 feed 被放弃后，循环必须继续抓后续 feed；
 *      · 参考 GREEN 形态（不强制）：fetchURL(feed.url, { sleep, stats,
 *        deadline: min(源级 deadline, Date.now()+PER_FEED_CAP) }) ——
 *        withFetchRetry 的预算感知会让"10s 退避 + 15s 请求"装不进 per-feed
 *        剩余预算而直接跳过重试；对永不响应的 feed 再用注入 sleep 的
 *        Promise.race 兜底放弃；
 *      · fetch() 必须 resolve（connector 对单 feed 的 try/catch 已存在，
 *        cn-photonics.js:57-64）—— resolve 且带好 feed 条目 = 源不 ERRORED
 *        的 connector 层等价物（源级 ERRORED = fetchSource 预算 abort）。
 *
 * 钉死的可观测边界（本文全部 RED —— main（ec93cec）现行行为与之冲突）：
 *  ①a 永不响应 feed（请求挂死，仅靠 req 超时/SIGABORT 才会醒）排在最前 +
 *     两个好 feed：好 feed 仍被请求且条目被采集、fetch resolve、resolve 时
 *     虚拟时钟仍在源级 deadline 内（预算未被单 feed 吃穿）；
 *  ①b 拒连风暴 feed（每次尝试立即 ECONNRESET，可重试类）+ 一个好 feed：
 *     不得进入真实 10s/45s 退避（2s 守卫拦截即 RED），好 feed 仍被采集。
 *
 * 全 mock（零真实网络、零真实等待、零 DB）：
 *  - 传输：vi.spyOn(https,'request') 按 URL 脚本化（照 fetch-retry-budget/
 *    fetch-retry-backoff.test.js 模式；utils.fetchOnce 的实际入口）。
 *    现行实现忽略 opts.feeds 时会请求生产 CN_FEEDS 的 8 个真 URL —— 全部落
 *    default 分支 = 404（非可重试、瞬间、零悬挂定时器），RED 因此干净失败。
 *  - 时钟：vi.spyOn(Date,'now') 虚拟时钟；vm realm 的 VDate 与测试 realm 共享
 *    同一可变时刻（单一时钟变量，照 fetch-retry-budget.test.js）。
 *  - DB：vm harness 注入 getDB:()=>null（base.js normalize/getSourceId 纯净）。
 *  - 每个 await 套 2s 真实守卫：实现若绕过注入 sleep 真等 10s/45s 退避或
 *    挂死不放，测试以明确信息失败而非挂到 vitest 超时。
 *  - FETCH_TIMEOUT_MS=3000（测试 realm env，utils.fetchOnce 每次调用时读取）
 *    让挂死 feed 的 req 超时为 3s：> 2s 守卫（无保护的中间态被守卫拦截）
 *    且 < vitest 默认超时；GREEN 的放弃机制必须先于它生效。
 */
const https = require('https');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { EventEmitter } = require('events');
const utils = require('../../services/utils');
const dateContract = require('../../services/date-contract');
const { describe, it, expect, afterEach, vi } = globalThis;

const RealDate = Date; // 在任何 spy 之前捕获
const RED = 'RED（预期失败，非环境错误）';
const T0 = Date.parse('2026-10-22T17:00:00Z'); // 2026-10-23 01:00 Asia/Shanghai —— 事故当晚 01:00 轮
const SOURCE_BUDGET_MS = 5000; // 源级预算（虚拟时间；生产 180s，测试同构缩小）

const HANG_URL = 'https://hang.example.test/rss.xml';
const RESET_URL = 'https://reset.example.test/rss.xml';
const GOOD_A_URL = 'https://good-a.example.test/rss.xml';
const GOOD_B_URL = 'https://good-b.example.test/rss.xml';
const GOOD_A_TITLE = 'good-a fresh item';
const GOOD_B_TITLE = 'good-b fresh item';

const urlKey = (hostname, p) => `${hostname}${p}`;

afterEach(() => {
  clearHangTimers();
  vi.restoreAllMocks();
  delete process.env.FETCH_TIMEOUT_MS;
});

/* ---------- 共享虚拟时钟（测试 realm 与 vm realm 读同一变量） ---------- */
function makeClock() {
  let now = T0;
  return { now: () => now, peek: () => now, tick: (ms) => { now += ms; } };
}

/* ---------- 注入 sleep：记录 + 恰好把虚拟时钟推进 ms（退避/放弃 = 消耗预算） ---------- */
function sleepRecorder(clock) {
  const sleeps = [];
  const sleep = (ms) => { sleeps.push(ms); clock.tick(ms); return Promise.resolve(); };
  return { sleep, sleeps };
}

/* ---------- 脚本化传输：按 URL 分派（utils.fetchOnce 的实际入口 https.request） ----------
 * stepFor(hostname, path) → step；step 形态：
 *   { status, body }                → setImmediate 回包（2xx 才 resolve，404/403 同理）
 *   { error }                       → setImmediate 抛错（可重试类如 ECONNRESET 会触发退避）
 *   { hangMs }                      → 永不回包：req.setTimeout(ms,cb) 用真实 setTimeout(ms)
 *                                     兑现（模拟"服务器不应答、靠客户端超时兜底"），
 *                                     reqOpts.signal abort 时立刻以 AbortError 收尾；
 *                                     定时器登记进 hangTimers 由 afterEach 清理。
 *   null（未登记的 URL）            → 404（非可重试、瞬间）—— 现行实现打真 CN_FEEDS
 *                                     URL 时走这里，保证 RED 干净且零真实网络。
 */
const hangTimers = [];
function clearHangTimers() { while (hangTimers.length) clearTimeout(hangTimers.pop()); }

function installTransport(stepFor, calls) {
  const impl = (reqOpts, onResponse) => {
    const key = urlKey(reqOpts.hostname, reqOpts.path);
    const step = stepFor(key, reqOpts);
    calls.push({ key, timeoutMs: reqOpts.timeoutMs ?? null });
    const req = new EventEmitter();
    req.setTimeout = function (ms, cb) {
      if (step && typeof step.hangMs === 'number') {
        hangTimers.push(setTimeout(cb, ms));
      }
      return this;
    };
    req.setHeader = function () { return this; };
    req.write = function () { return true; };
    req.abort = req.destroy = function () { return this; };
    req.end = function () {
      if (step && typeof step.hangMs === 'number') {
        // 永不响应：不回包；仅 signal abort 唤醒（真实 Node 形态：AbortError）
        const signal = reqOpts.signal;
        signal?.addEventListener('abort', () => {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          err.code = 'ABRT';
          req.emit('error', err);
        }, { once: true });
        return this;
      }
      setImmediate(() => {
        if (step && step.error) { req.emit('error', step.error); return; }
        const res = new EventEmitter();
        res.statusCode = step ? step.status : 404;
        res.statusMessage = '';
        res.headers = {};
        res.resume = res.setEncoding = res.destroy = function () { return this; };
        onResponse(res);
        if (step && step.body) res.emit('data', Buffer.from(String(step.body)));
        res.emit('end');
      });
      return this;
    };
    return req;
  };
  vi.spyOn(https, 'request').mockImplementation(impl);
}

/* ---------- 好 feed 的 RSS 体：1 条窗口内条目（pubDate 相对虚拟时钟 -1h） ---------- */
function feedBody(clock, title) {
  const pub = new RealDate(clock.peek() - 3600e3).toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Mock</title><link>https://ex.test/</link><description>mock</description>
<item><title>${title}</title><link>https://ex.test/item/${encodeURIComponent(title)}</link><pubDate>${pub}</pubDate><description>d</description></item>
</channel></rss>`;
}

/* ---------- 2s 真实守卫：实现若真等退避/挂死不放，明确失败而非挂死 ---------- */
function settle(promise, label) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      ok: false,
      timedOut: true,
      err: new Error(`${label}: 2s 内未结束 —— 实现很可能绕过注入 sleep 真等 10s/45s 退避，或挂死 feed 未被 per-feed 上限放弃；契约要求单 feed 成本有界且放弃计时走注入 sleep / 有界真实计时`),
    }), 2000);
  });
  return Promise.race([
    promise.then(body => ({ ok: true, body }), err => ({ ok: false, err })),
    guard,
  ]).finally(() => clearTimeout(timer));
}

/* ---------- vm harness（模式照 fetch-retry-budget.test.js fetchSourceHarness） ----------
 * 真实文件 connectors/cn-photonics.js + connectors/base.js；utils / date-contract
 * 给真实模块；getDB:()=>null。VDate 与测试 realm 共享同一虚拟时钟。
 */
function loadConnector(clock) {
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
      AbortController: globalThis.AbortController,
      Date: VDate,
      process: { env: {} },
      require(name) {
        if (name === '../db/connection') return { getDB: () => null };
        if (name === '../services/utils') return utils;
        if (name === '../services/date-contract') return dateContract;
        if (name === './base') return load('connectors/base.js');
        throw new Error(`Unexpected require ${name} from ${relativePath}`);
      },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    cache.set(filename, target.exports);
    return target.exports;
  }
  const { CNPhotonicsConnector } = load('connectors/cn-photonics.js');
  return new CNPhotonicsConnector();
}

const itemFeedUrl = (item) => {
  try { return JSON.parse(item.source_payload || '{}').feed_url; } catch { return null; }
};
const isPlaceholder = (item) => {
  try { return JSON.parse(item.source_payload || '{}').is_placeholder === true; } catch { return false; }
};

/* ══════════ ①a 永不响应 feed 不得拖垮整源 ══════════ */
describe('P0 B① per-feed 超时保护 — 挂死 feed 不得吃穿整源预算', () => {
  it('①a 永不响应 feed 排最前 + 两个好 feed：好 feed 仍被请求且条目被采集、fetch resolve（源不 ERRORED）、resolve 时预算未耗尽', async () => {
    const clock = makeClock();
    vi.spyOn(Date, 'now').mockImplementation(clock.now);
    process.env.FETCH_TIMEOUT_MS = '3000'; // 挂死 feed 的 req 超时（真实 3s；GREEN 放弃机制必须先于它）

    const FIXTURE_FEEDS = [
      { name: 'Dead Hang Feed', url: HANG_URL, lang: 'zh' },
      { name: 'Good Feed A', url: GOOD_A_URL, lang: 'zh' },
      { name: 'Good Feed B', url: GOOD_B_URL, lang: 'zh' },
    ];
    const calls = [];
    installTransport((key) => {
      if (key === urlKey('hang.example.test', '/rss.xml')) return { hangMs: 3000 };
      if (key === urlKey('good-a.example.test', '/rss.xml')) return { status: 200, body: feedBody(clock, GOOD_A_TITLE) };
      if (key === urlKey('good-b.example.test', '/rss.xml')) return { status: 200, body: feedBody(clock, GOOD_B_TITLE) };
      return null; // 现行实现打真 CN_FEEDS URL → 404（瞬间、非可重试、零网络）
    }, calls);

    const connector = loadConnector(clock);
    const { sleep } = sleepRecorder(clock);
    const stats = {};
    const deadline = clock.peek() + SOURCE_BUDGET_MS;

    const r = await settle(connector.fetch(dateContract.compactDigestDate(dateContract.todayDigestDate()), {
      feeds: FIXTURE_FEEDS, sleep, stats, deadline,
    }), '①a');

    // 1) fetch 必须 settle（resolve 或显式拒绝都算"结束"；挂死=守卫超时）
    expect(r.ok, `${RED}: ①a connector.fetch 必须在守卫内结束 —— 现行实现要么挂死在永不响应的 feed 上（无 per-feed 放弃），要么其重试退避真等 10s/45s（未注入 sleep）。现行（忽略 opts.feeds）实际会打真 CN_FEEDS 8 URL（脚本化为 404）→ 返回 10 条占位、缺好 feed 条目。err=${r.err && r.err.message}`).toBe(true);

    const items = Array.isArray(r.body) ? r.body : [];
    // 2) 好 feed 必须确实被请求（fixture seam 生效 + 循环没被挂死 feed 卡断）
    expect(calls.some(c => c.key === urlKey('good-a.example.test', '/rss.xml')), `${RED}: ①a opts.feeds 注入必须生效（rss.js fetch(date,opts) 同族 seam）且挂死 feed 被放弃后循环继续 —— good-a URL 从未被请求；实际请求: ${calls.map(c => c.key).join(', ') || '(无)'}`).toBe(true);
    expect(calls.some(c => c.key === urlKey('good-b.example.test', '/rss.xml')), `${RED}: ①a good-b URL 必须被请求（挂死 feed 之后的第二个好 feed 也要抓到）；实际请求: ${calls.map(c => c.key).join(', ')}`).toBe(true);
    // 3) 好 feed 条目被采集（不是占位兜底）
    const titles = items.map(i => i.title);
    expect(titles.includes(GOOD_A_TITLE) && titles.includes(GOOD_B_TITLE), `${RED}: ①a 好_feed 条目必须被采集（标题 ${GOOD_A_TITLE} / ${GOOD_B_TITLE}）；实际 items=${JSON.stringify(titles)}（现行会退化为 10 条 CN_COMPANIES 占位或 0 条）`).toBe(true);
    expect(items.every(i => !isPlaceholder(i)), `${RED}: ①a 有好 feed 条目时不得混入 CN_COMPANIES 占位（items.length>0 时占位路径必须不触发，cn-photonics.js:66-71）`).toBe(true);
    // 4) 预算未被单 feed 吃穿（resolve 时虚拟时钟仍在源级 deadline 内）
    expect(clock.peek(), `${RED}: ①a 单 feed 总成本必须有界且远小于整源预算 —— resolve 时虚拟时钟 ${clock.peek()} 已达/超过源级 deadline ${deadline}（预算被吃穿 = fetchSource 层 180s ERRORED 的机理，CTO 10-23 01:03:57 事故形态）`).toBeLessThan(deadline);
  });

  it('①b 拒连风暴 feed（每次尝试立即 ECONNRESET，可重试类）+ 一个好 feed：不得真等 10s/45s 退避吃穿预算；好 feed 仍被采集、fetch resolve', async () => {
    const clock = makeClock();
    vi.spyOn(Date, 'now').mockImplementation(clock.now);
    process.env.FETCH_TIMEOUT_MS = '3000';

    const resetErr = new Error('read ECONNRESET [feed-reset]');
    resetErr.code = 'ECONNRESET';
    const FIXTURE_FEEDS = [
      { name: 'Dead Reset Feed', url: RESET_URL, lang: 'zh' },
      { name: 'Good Feed A', url: GOOD_A_URL, lang: 'zh' },
    ];
    const calls = [];
    installTransport((key) => {
      if (key === urlKey('reset.example.test', '/rss.xml')) return { error: resetErr };
      if (key === urlKey('good-a.example.test', '/rss.xml')) return { status: 200, body: feedBody(clock, GOOD_A_TITLE) };
      return null;
    }, calls);

    const connector = loadConnector(clock);
    const { sleep } = sleepRecorder(clock);
    const stats = {};
    const deadline = clock.peek() + SOURCE_BUDGET_MS;

    const r = await settle(connector.fetch(dateContract.compactDigestDate(dateContract.todayDigestDate()), {
      feeds: FIXTURE_FEEDS, sleep, stats, deadline,
    }), '①b');

    expect(r.ok, `${RED}: ①b connector.fetch 必须在守卫内结束 —— ECONNRESET 属可重试类，现行实现（无 per-feed 预算上限）会让 withFetchRetry 走 10s/45s 真实退避（无注入 sleep 可用），一个拒连 feed 即吃穿整源预算（10-23 01:00 事故：OFweek×3 ≈100s+）。err=${r.err && r.err.message}`).toBe(true);

    const items = Array.isArray(r.body) ? r.body : [];
    expect(calls.some(c => c.key === urlKey('good-a.example.test', '/rss.xml')), `${RED}: ①b 拒连风暴 feed 被放弃后，好 feed 仍必须被请求（per-feed deadline 应让"10s 退避+15s 请求"装不进剩余预算而跳过重试，直接以最后错误结束该 feed）；实际请求: ${calls.map(c => c.key).join(', ')}`).toBe(true);
    expect(items.some(i => i.title === GOOD_A_TITLE), `${RED}: ①b 好 feed 条目必须被采集；实际 items=${JSON.stringify(items.map(i => i.title))}`).toBe(true);
    expect(clock.peek(), `${RED}: ①b 单 feed 的退避成本必须有界 —— resolve 时虚拟时钟 ${clock.peek()} 已达/超过源级 deadline ${deadline}（退避不得吃穿整源预算）`).toBeLessThan(deadline);
  });
});
