// @vitest-environment node
/**
 * P0 热修 B② · 死 feed 从 config 移除后其余 feed 正常 — RED 契约测试（测试作者·P0热修）
 * worktree ~/projects/eagleye-p0-wt（自 main ec93cec）
 *
 * 事实（CTO 2026-10-23 02:33 CST 探活，双路由=经代理 127.0.0.1:17898 + 直连各一次）：
 * server/connectors/cn-photonics.js:19-28 的 CN_FEEDS 全部 8 个 feed 已死 ——
 *   laser.ofweek.com/rss.xml           404 / TLS reset（RSS 路径被 OFweek 下线）
 *   optics.ofweek.com/rss.xml          404 / TLS reset
 *   semiconductor.ofweek.com/rss.xml   404 / RST
 *   www.c114.com.cn/rss/optical.xml    404
 *   www.c114.com.cn/rss/all.xml        404
 *   www.eeworld.com.cn/rss/semiconductor.xml  403（WAF 拦 RSS 路径）
 *   www.laoyaoba.com/rss               200 但 text/html SPA，0 个 <item>（RSS 已停）
 *   www.gelonghui.com/feed/semiconductor      404
 * CTO 裁决（repairable[1]）：config 级移除全部 8 个死 feed；清空后 connector
 * 自动落回 CN_COMPANIES 占位路径（cn-photonics.js:66-71，10 条/轮）。
 *
 * 契约（测试作者钉死，GREEN 实现照此落地）：
 *  - CN_FEEDS（server/connectors/cn-photonics.js:19-28）不得再包含上述 8 个
 *    确认死亡的 feed URL —— config 移除是本 fix 的交付物之一（与 B① per-feed
 *    保护互补：B① 防"活源被死 feed 拖死"，B② 把已知死 feed 从配置里拿掉）。
 *  - 移除后其余 feed（若保留/将来新增）必须正常工作：任何非死 URL 在本测试
 *    的脚本化传输里都会拿到 200 + 1 条窗口内 RSS 条目 → 其条目必须被采集。
 *  - 若 CN_FEEDS 被清空（CTO 建议全移）：fetch() 必须走 CN_COMPANIES 占位
 *    兜底，恰好返回 10 条占位（is_placeholder=true），源健康（resolve 不抛）。
 *    两种 GREEN 形态（保留若干活 feed / 全移落占位）都被本测试接受，但
 *    "死 feed 仍在配置里" 必须失败。
 *
 * RED（main ec93cec 现行）：8 个死 feed 仍逐个被请求 → 断言"死 URL 请求数=0"
 * 失败，失败消息列出仍被请求的死 URL。
 *
 * 全 mock（零真实网络、零 DB、零真实等待）：
 *  - 传输：vi.spyOn(https,'request') 按 URL 分派（utils.fetchOnce 实际入口）：
 *    8 个死 URL → 各自真实观测到的失败形态（404×5 / 403 / 200-HTML / 404）；
 *    其余任意 URL → 200 + 好 RSS。
 *    注意：semiconductor.ofweek 的真实形态是 RST（可重试类）——此处刻意脚本化
 *    为 404：现行实现无 sleep 注入，可重试错误会触发 10s/45s 真实退避等待，
 *    把 RED 变成慢挂；可重试形态的"不得吃穿预算"行为已由 B①①b 钉死，此处
 *    只钉 config 移除，不重复。
 *  - DB：vm harness 注入 getDB:()=>null；无时钟 spy（真实 now，pubDate 用
 *    真实 now-1h 保持窗口内）。
 *  - settle 守卫 2s（现行 RED 全程 <100ms 结束，守卫仅防回归挂死）。
 */
const https = require('https');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { EventEmitter } = require('events');
const utils = require('../../services/utils');
const dateContract = require('../../services/date-contract');
const { describe, it, expect, afterEach, vi } = globalThis;

const RealDate = Date;
const RED = 'RED（预期失败，非环境错误）';

const urlKey = (hostname, p) => `${hostname}${p}`;

// CTO 2026-10-23 02:33 双路由探活确认死亡的 8 个 feed（cn-photonics.js:19-28）
// key = hostname+path（utils.fetchOnce 的 https.request reqOpts 形态）
const DEAD_FEED_STEPS = new Map([
  ['laser.ofweek.com/rss.xml', { status: 404, body: '<html>404</html>' }],
  ['optics.ofweek.com/rss.xml', { status: 404, body: '<html>404</html>' }],
  ['semiconductor.ofweek.com/rss.xml', { status: 404, body: '<html>404</html>' }], // 真实=RST；见文件头注释
  ['www.c114.com.cn/rss/optical.xml', { status: 404, body: '<html>404</html>' }],
  ['www.c114.com.cn/rss/all.xml', { status: 404, body: '<html>404</html>' }],
  ['www.eeworld.com.cn/rss/semiconductor.xml', { status: 403, body: 'Forbidden' }],
  ['www.laoyaoba.com/rss', { status: 200, body: '<!doctype html><html><body><div id="app">SPA</div></body></html>' }],
  ['www.gelonghui.com/feed/semiconductor', { status: 404, body: 'not found' }],
]);

const GOOD_TITLE_FOR = (key) => `live-feed item [${key}]`;

function goodFeedBody(key) {
  const pub = new RealDate(Date.now() - 3600e3).toUTCString(); // 真实 now-1h，窗口内
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Mock Live</title><link>https://ex.test/</link><description>mock</description>
<item><title>${GOOD_TITLE_FOR(key)}</title><link>https://ex.test/item/${encodeURIComponent(key)}</link><pubDate>${pub}</pubDate><description>d</description></item>
</channel></rss>`;
}

afterEach(() => { vi.restoreAllMocks(); });

/* ---------- 脚本化传输：死 URL → 观测到的失败；其余任意 URL → 200 好 RSS ---------- */
function installTransport(calls) {
  const impl = (reqOpts, onResponse) => {
    const key = urlKey(reqOpts.hostname, reqOpts.path);
    const step = DEAD_FEED_STEPS.get(key) || { status: 200, body: goodFeedBody(key) };
    calls.push({ key });
    const req = new EventEmitter();
    req.setTimeout = function () { return this; };
    req.setHeader = function () { return this; };
    req.write = function () { return true; };
    req.abort = req.destroy = function () { return this; };
    req.end = function () {
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = step.status;
        res.statusMessage = '';
        res.headers = {};
        res.resume = res.setEncoding = res.destroy = function () { return this; };
        onResponse(res);
        res.emit('data', Buffer.from(String(step.body)));
        res.emit('end');
      });
      return this;
    };
    return req;
  };
  vi.spyOn(https, 'request').mockImplementation(impl);
}

/* ---------- 2s 真实守卫（照 B① / fetch-retry-budget.test.js） ---------- */
function settle(promise, label) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      ok: false,
      timedOut: true,
      err: new Error(`${label}: 2s 内未结束 —— 实现回归挂死或真等退避`),
    }), 2000);
  });
  return Promise.race([
    promise.then(body => ({ ok: true, body }), err => ({ ok: false, err })),
    guard,
  ]).finally(() => clearTimeout(timer));
}

/* ---------- vm harness（真实 cn-photonics.js / base.js；utils、date-contract 真模块；getDB null） ---------- */
function loadConnector() {
  const serverRoot = path.resolve(__dirname, '../..');
  const cache = new Map();
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
      Date: RealDate,
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

const feedUrlOf = (item) => {
  try { return JSON.parse(item.source_payload || '{}').feed_url; } catch { return null; }
};
const isPlaceholder = (item) => {
  try { return JSON.parse(item.source_payload || '{}').is_placeholder === true; } catch { return false; }
};

/* ══════════ ② 死 feed 移除后其余 feed 正常（fixture） ══════════ */
describe('P0 B② 死 feed 从 config 移除 — 其余 feed 正常（fixture）', () => {
  it('② CN_FEEDS 不得再请求 8 个确认死亡 feed；移除后：其余 feed 条目被采集，或（全移时）CN_COMPANIES 占位 10 条兜底 —— fetch resolve 不抛', async () => {
    const calls = [];
    installTransport(calls);
    const connector = loadConnector();

    // opts.sleep/stats 注入与 B① 同族（现行忽略之；404/403 非可重试，无退避）
    const sleeps = [];
    const sleep = (ms) => { sleeps.push(ms); return Promise.resolve(); };
    const r = await settle(connector.fetch(dateContract.compactDigestDate(dateContract.todayDigestDate()), { sleep, stats: {} }), '②');

    // 1) fetch 必须 settle 且 resolve（每 feed try/catch 已存在；占位兜底保证非空产出）
    expect(r.ok, `${RED}: ② connector.fetch 必须在守卫内结束 —— config 移除不应引入任何挂死/真退避路径。err=${r.err && r.err.message}`).toBe(true);
    const items = Array.isArray(r.body) ? r.body : [];
    expect(Array.isArray(r.body) && items.length >= 1, `${RED}: ② fetch 必须返回非空数组（活 feed 条目或 CN_COMPANIES 占位 10 条）；实际 ${items.length} 条`).toBe(true);

    // 2) 核心 RED 断言：8 个确认死亡的 feed URL 一个都不得被请求
    const deadHits = calls.filter(c => DEAD_FEED_STEPS.has(c.key));
    expect(deadHits.length, `${RED}: ② CN_FEEDS 必须已移除全部 8 个确认死亡 feed（CTO 2026-10-23 02:33 双路由探活 8/8 死，repairable[1] config 级交付物）—— 以下死 feed 仍被请求: ${deadHits.map(h => h.key).join(', ')}；共 ${deadHits.length}/${DEAD_FEED_STEPS.size}`).toBe(0);

    // 3) 移除后的其余 feed 正常（两种 GREEN 形态都接受）
    const liveCalls = calls.filter(c => !DEAD_FEED_STEPS.has(c.key));
    if (liveCalls.length > 0) {
      // 形态 A：保留了活 feed —— 每个被请求的活 feed 的条目必须被采集
      const liveKeys = new Set(liveCalls.map(c => c.key));
      const liveItems = items.filter(i => liveKeys.has(String(feedUrlOf(i)).replace(/^https:\/\//, '')));
      expect(liveItems.length >= 1, `${RED}: ② 保留的活 feed（${[...liveKeys].join(', ')}）在 fixture 传输下应产出条目；实际 items=${JSON.stringify(items.map(i => i.title).slice(0, 12))}`).toBe(true);
      expect(items.every(i => !isPlaceholder(i)), `${RED}: ② 有活 feed 条目时不得混入占位（cn-photonics.js:66-71 items.length>0 不触发占位）`).toBe(true);
    } else {
      // 形态 B：CN_FEEDS 全移（CTO 建议）—— 必须落 CN_COMPANIES 占位兜底，恰好 10 条
      expect(items.length, `${RED}: ② CN_FEEDS 全移后应走 CN_COMPANIES 占位路径（cn-photonics.js:66-71），恰好 10 条；实际 ${items.length}`).toBe(10);
      expect(items.every(isPlaceholder), `${RED}: ② 全移形态下全部条目应为占位（is_placeholder=true）`).toBe(true);
    }
  });
});
