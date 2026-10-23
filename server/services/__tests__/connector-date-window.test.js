// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */

/**
 * D2 日期契约（时间窗判新）— connector 过滤行为测试（RED 先行）。
 *
 * 契约（对每个 connector 的 fetch(compactDigestDate)）：
 *   1. 条目发布时间 ≥ now − 36h 且 ≤ now + 1h（闭区间）→ 保留；
 *      其中“发布时间在窗内、但条目 UTC 日期 ≠ 本地 digest 日期”的条目必须保留
 *      （旧的 UTC 日期严格相等过滤在 01:00 CST 调度时会错杀全部条目）。
 *   2. 窗外条目（40h 前）与 now+1h 之后的未来条目 → 剔除
 *      （未来条目即便 UTC 日期恰等于 digest 日期也必须剔除）。
 *   3. 保留条目的 digest_date 取本轮传入的 digest 日期（canonical 2026-10-20），
 *      不再取条目自身 UTC 日期。
 *   4. humanoid 的公司页附加门（_scrapePage）在“请求日期 == 本地今天”时必须打开
 *      （现状用 UTC 今天比较，01:00 CST 运行时永远关闭）。
 *
 * 时间基准（不依赖真实时间）：伪造 now = 2026-10-20 01:00 Asia/Shanghai
 * （= 2026-10-19 17:00 UTC），digest 日期 '20261020' / canonical '2026-10-20'。
 *
 * 01:00 CST 边界样例（决策 D2，三条全覆盖）：
 *   ① UTC 前一日 18:00（北京时）发布 = now − 7h，UTC 日期 ≠ digest 日期 → 通过
 *   ② 40h 前发布 → 排除
 *   ③ now + 1h 之后的未来时间戳 → 排除
 *
 * 本文件只测 fetch()（纯抓取+过滤），不触碰 saveItems / 真实网络 / 真实库。
 */

process.env.TZ = 'Asia/Shanghai';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');
const { vi } = globalThis; // globals: true（vitest 4 的 CJS 测试不可 require('vitest')）
const utils = require('../utils');
const dateContract = require('../date-contract');

const { normalizeDigestDate } = dateContract;

const HOUR = 3600e3;
// now = 2026-10-20 01:00 CST = 2026-10-19 17:00 UTC（每日 01:00 调度时刻）
const NOW = Date.UTC(2026, 9, 19, 17, 0, 0);
const DIGEST = '20261020';          // fetchSource 传入 connector 的压缩 digest 日期（本地日历今天）
const DIGEST_CANONICAL = '2026-10-20';

const T_IN = NOW - 7 * HOUR;   // 2026-10-19T10:00:00Z  窗内；UTC 日期 2026-10-19 ≠ digest 日期（边界样例①）
const T_OLD = NOW - 40 * HOUR; // 2026-10-17T01:00:00Z  窗外（边界样例②）
const T_FUT = NOW + 7 * HOUR;  // 2026-10-20T00:00:00Z  未来（边界样例③）；UTC 日期恰 == digest 日期

const rssDate = (t) => new Date(t).toUTCString();
const isoDate = (t) => new Date(t).toISOString();

const rssXml = (items) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>mock feed</title><link>https://mock.local/</link><description>mock</description>
${items.map(([title, url, t]) => `  <item><title>${title}</title><link>${url}</link><pubDate>${rssDate(t)}</pubDate><description>mock description</description></item>`).join('\n')}
</channel></rss>`;

const atomXml = (entries) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Product Hunt</title>
${entries.map(([title, url, t]) => `  <entry><title>${title}</title><link rel="alternate" type="text/html" href="${url}"/><published>${isoDate(t)}</published><updated>${isoDate(t)}</updated><content type="html">mock content</content></entry>`).join('\n')}
</feed>`;

/**
 * 与 sync-source.test.js 同款 vm harness：把 connector 源码加载进受控上下文，
 * 注入内存库 getDB 与 mock fetchURL；Date 注入测试进程的（假）Date，
 * 使 vi 假时钟对 vm 内的 new Date() 生效。
 */
function buildHarness(db, respond) {
  const calls = [];
  const fetchURL = async (url) => {
    calls.push(String(url));
    const hit = respond(String(url));
    if (hit instanceof Error) throw hit;
    if (typeof hit !== 'string') throw new Error(`no mock response for ${url}`);
    return hit;
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
      setInterval,
      clearInterval,
      AbortController: globalThis.AbortController,
      Date: globalThis.Date, // 假时钟（vi.useFakeTimers 后 globalThis.Date 即假实现）
      process: { env: {} },  // 无 PRODUCT_HUNT_API_KEY → feed 路径；无 SOLIDOT fallback
          require(name) {
            if (name === 'https' || name === 'http' || name === 'crypto' || name === 'child_process') return require(name);
            if (name === '../db/connection') return { getDB: () => db };
            if (name === '../services/utils' || name === './utils') return { ...utils, fetchURL };
            if (name === '../services/date-contract' || name === './date-contract') return dateContract;
        if (name === "../services/secret-redaction") return require("../secret-redaction"); // 案2 redaction lane: rss writeCondState 写库前脱敏（真实模块，纯叶子）
            if (name === '../services/x-following-config') return { readBlocklist: () => new Set(), isBlocked: () => false };
            if (name === '../services/outbox') return { registerEvent() {} };
            if (name === './base') return load('connectors/base.js');
            if (name === './hn') return load('connectors/hn.js');
            if (name === './lobsters') return load('connectors/lobsters.js');
            if (name === './v2ex') return load('connectors/v2ex.js');
            if (name === './rss') return load('connectors/rss.js');
            if (name === './humanoid') return load('connectors/humanoid.js');
            if (name === './producthunt') return load('connectors/producthunt.js');
            if (name === './cn-photonics') return load('connectors/cn-photonics.js');
            if (name === './appstore') return load('connectors/appstore.js');
            if (name === './sec-8k') return load('connectors/sec-8k.js');
            if (name === './startup-archive') return load('connectors/startup-archive.js');
            throw new Error(`Unexpected require ${name} from ${relativePath}`);
          },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    cache.set(filename, module.exports);
    return module.exports;
  }
  return { load, calls };
}

/** 统一断言：三时间戳夹具下，只有窗内跨 UTC 日条目存活且 digest_date 取传入日期。 */
function expectWindowContract(items, urls) {
  const got = items.map((i) => i.canonical_url);
  expect(got, `01:00 CST 运行时窗内跨 UTC 日条目必须保留（got: ${JSON.stringify(got)}）`).toContain(urls.in);
  expect(got, '40h 前的窗外条目必须剔除').not.toContain(urls.old);
  expect(got, 'now+1h 之后的未来条目必须剔除（即便 UTC 日期恰为 digest 日期）').not.toContain(urls.fut);
  const kept = items.find((i) => i.canonical_url === urls.in);
  expect(normalizeDigestDate(kept.digest_date), 'digest_date 必须取本轮传入的 digest 日期').toBe(DIGEST_CANONICAL);
}

describe('D2 connector date-window filtering (01:00 CST schedule)', () => {
  let db;
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    db = new Database(':memory:');
    db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/001_initial_schema.sql'), 'utf8'));
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('hacker-news keeps the in-window cross-UTC-day story, drops stale and future stories', async () => {
    const stories = {
      1: { id: 1, title: 'In-window story', url: 'https://example.com/hn-in', by: 'a', score: 10, descendants: 1, time: Math.floor(T_IN / 1000) },
      2: { id: 2, title: 'Stale story', url: 'https://example.com/hn-old', by: 'a', score: 9, descendants: 1, time: Math.floor(T_OLD / 1000) },
      3: { id: 3, title: 'Future story', url: 'https://example.com/hn-fut', by: 'a', score: 8, descendants: 1, time: Math.floor(T_FUT / 1000) },
    };
    const h = buildHarness(db, (url) => {
      if (url.endsWith('topstories.json')) return JSON.stringify([1, 2, 3]);
      const m = url.match(/item\/(\d+)\.json/);
      if (m) return JSON.stringify(stories[m[1]]);
      return new Error(`unexpected url ${url}`);
    });
    const { HNConnector } = h.load('connectors/hn.js');
    const stats = { requested: 0, failed: 0, skipped: 0 };
    const items = await new HNConnector().fetch(DIGEST, { limit: 10, stats });
    expectWindowContract(items, { in: 'https://example.com/hn-in', old: 'https://example.com/hn-old', fut: 'https://example.com/hn-fut' });
  });

  it('lobsters keeps the in-window cross-UTC-day story, drops stale and future stories', async () => {
    const h = buildHarness(db, (url) => {
      if (url === 'https://lobste.rs/hottest.json') {
        return JSON.stringify([
          { short_id: 'in1', short_id_url: 'https://lobste.rs/s/in1', title: 'In-window lob', created_at: isoDate(T_IN), score: 5, comment_count: 1, submitter_user: { username: 'u' }, tags: ['ai'], description: '' },
          { short_id: 'old1', short_id_url: 'https://lobste.rs/s/old1', title: 'Stale lob', created_at: isoDate(T_OLD), score: 4, comment_count: 1, submitter_user: { username: 'u' }, tags: ['ai'], description: '' },
          { short_id: 'fut1', short_id_url: 'https://lobste.rs/s/fut1', title: 'Future lob', created_at: isoDate(T_FUT), score: 3, comment_count: 1, submitter_user: { username: 'u' }, tags: ['ai'], description: '' },
        ]);
      }
      return new Error(`unexpected url ${url}`);
    });
    const { LobstersConnector } = h.load('connectors/lobsters.js');
    const items = await new LobstersConnector().fetch(DIGEST);
    expectWindowContract(items, { in: 'https://lobste.rs/s/in1', old: 'https://lobste.rs/s/old1', fut: 'https://lobste.rs/s/fut1' });
  });

  it('v2ex keeps the in-window cross-UTC-day topic, drops stale and future topics', async () => {
    const topic = (id, title, t) => ({
      id, title, url: `https://www.v2ex.com/t/${id}`, content: 'c',
      created: Math.floor(t / 1000), replies: 3,
      member: { username: 'u' }, node: { name: 'python', title: 'Python' },
    });
    const h = buildHarness(db, (url) => {
      if (url === 'https://www.v2ex.com/api/topics/hot.json') {
        return JSON.stringify([topic(1, 'In-window topic', T_IN), topic(2, 'Stale topic', T_OLD), topic(3, 'Future topic', T_FUT)]);
      }
      return new Error(`unexpected url ${url}`);
    });
    const { V2EXConnector } = h.load('connectors/v2ex.js');
    const items = await new V2EXConnector().fetch(DIGEST);
    expectWindowContract(items, { in: 'https://www.v2ex.com/t/1', old: 'https://www.v2ex.com/t/2', fut: 'https://www.v2ex.com/t/3' });
  });

  it('rss (techmeme/solidot shared RSSConnector) keeps the in-window cross-UTC-day item, drops stale and future items', async () => {
    // 001 迁移已种子 techmeme（s005），这里只把 feed_url 指到 mock（无种子行时插入）
    db.prepare(`
      INSERT INTO sources (id, slug, label, feed_url) VALUES ('src-tm', 'techmeme', 'Techmeme', 'https://mock.local/techmeme.xml')
      ON CONFLICT(slug) DO UPDATE SET feed_url = excluded.feed_url
    `).run();
    const h = buildHarness(db, (url) => {
      if (url === 'https://mock.local/techmeme.xml') {
        return rssXml([
          ['Techmeme in-window', 'https://example.com/tm-in', T_IN],
          ['Techmeme stale', 'https://example.com/tm-old', T_OLD],
          ['Techmeme future', 'https://example.com/tm-fut', T_FUT],
        ]);
      }
      return new Error(`unexpected url ${url}`);
    });
    const { RSSConnector } = h.load('connectors/rss.js');
    const items = await new RSSConnector('techmeme').fetch(DIGEST);
    expectWindowContract(items, { in: 'https://example.com/tm-in', old: 'https://example.com/tm-old', fut: 'https://example.com/tm-fut' });
  });

  it('physical-ai-humanoid RSS keeps the in-window cross-UTC-day item, drops stale and future items', async () => {
    const h = buildHarness(db, (url) => {
      if (url === 'https://spectrum.ieee.org/feeds/topic/robotics.rss') {
        return rssXml([
          ['Humanoid in-window', 'https://example.com/hum-in', T_IN],
          ['Humanoid stale', 'https://example.com/hum-old', T_OLD],
          ['Humanoid future', 'https://example.com/hum-fut', T_FUT],
        ]);
      }
      // 其余 RSS feed 与公司页一律失败（连接器会静默跳过）
      return new Error(`boom ${url}`);
    });
    const { HumanoidConnector } = h.load('connectors/humanoid.js');
    const items = await new HumanoidConnector().fetch(DIGEST);
    expectWindowContract(items, { in: 'https://example.com/hum-in', old: 'https://example.com/hum-old', fut: 'https://example.com/hum-fut' });
  });

  it('physical-ai-humanoid scrapes company pages when the requested digest date is local today (01:00 CST run)', async () => {
    // 请求日期 20261020 == 假时钟下的本地今天（2026-10-20 01:00 CST）。
    // 现状 _scrapePage 用 UTC 今天（20261019）比较，附加门在 01:00 CST 永远关闭。
    const h = buildHarness(db, (url) => {
      if (url === 'https://www.tesla.com/blog') {
        return `<html><body><main><a href="https://www.tesla.com/blog/optimus-v3-line">Tesla shows Optimus v3 walking the production line</a></main></body></html>`;
      }
      return new Error(`boom ${url}`);
    });
    const { HumanoidConnector } = h.load('connectors/humanoid.js');
    const items = await new HumanoidConnector().fetch(DIGEST);
    const scrape = items.filter((i) => JSON.parse(i.source_payload).feed_type === 'scrape');
    expect(scrape.length, '请求本地今天的 digest 时公司页附加门必须打开（01:00 CST 边界）').toBeGreaterThan(0);
    expect(
      scrape.every((i) => normalizeDigestDate(i.digest_date) === DIGEST_CANONICAL),
      'scrape 条目 digest_date 也必须取本轮传入的 digest 日期'
    ).toBe(true);
  });

  it('product-hunt (Atom feed path) keeps the in-window cross-UTC-day launch, drops stale and future launches', async () => {
    const h = buildHarness(db, (url) => {
      if (url === 'https://www.producthunt.com/feed') {
        return atomXml([
          ['InWindow App: ship it', 'https://www.producthunt.com/posts/in-window', T_IN],
          ['Stale App: old news', 'https://www.producthunt.com/posts/stale', T_OLD],
          ['Future App: tomorrow', 'https://www.producthunt.com/posts/future', T_FUT],
        ]);
      }
      return new Error(`unexpected url ${url}`);
    });
    const { ProductHuntConnector } = h.load('connectors/producthunt.js');
    const items = await new ProductHuntConnector().fetch(DIGEST);
    expectWindowContract(items, { in: 'https://www.producthunt.com/posts/in-window', old: 'https://www.producthunt.com/posts/stale', fut: 'https://www.producthunt.com/posts/future' });
  });

  it('physical-ai-cn-photonics keeps the in-window cross-UTC-day item, drops stale and future items', async () => {
    const h = buildHarness(db, (url) => {
      if (url === 'https://laser.ofweek.com/rss.xml') {
        return rssXml([
          ['光子学窗内条目', 'https://example.com/cn-in', T_IN],
          ['光子学过期条目', 'https://example.com/cn-old', T_OLD],
          ['光子学未来条目', 'https://example.com/cn-fut', T_FUT],
        ]);
      }
      return new Error(`boom ${url}`);
    });
    const { CNPhotonicsConnector } = h.load('connectors/cn-photonics.js');
    // P0 热修 B②（2026-10-23）：生产 CN_FEEDS 已清空（8 feed 双路由探活全死，
    // cn-photonics.js:19-31），本用例只钉 _parseRSS 的窗口契约，feed 改经
    // opts.feeds 注入（与 rss.js fetch(date,opts) 同族 seam）。
    const items = await new CNPhotonicsConnector().fetch(DIGEST, {
      feeds: [{ name: 'OFweek Laser', url: 'https://laser.ofweek.com/rss.xml', lang: 'zh' }],
    });
    expectWindowContract(items, { in: 'https://example.com/cn-in', old: 'https://example.com/cn-old', fut: 'https://example.com/cn-fut' });
  });

  it('physical-ai-cn-photonics empty-feed placeholder fallback keeps the passed-in digest date (regression canary)', async () => {
    // 全部 feed 失败/为空 → 生成公司 placeholder。现状 digest_date 已取传入日期，
    // D2 改造后必须保持（该用例在修复前后都应为绿）。
    const h = buildHarness(db, () => '');
    const { CNPhotonicsConnector } = h.load('connectors/cn-photonics.js');
    const items = await new CNPhotonicsConnector().fetch(DIGEST);
    expect(items).toHaveLength(10);
    expect(items.every((i) => JSON.parse(i.source_payload).is_placeholder === true)).toBe(true);
    expect(items.every((i) => normalizeDigestDate(i.digest_date) === DIGEST_CANONICAL)).toBe(true);
  });

  it('startup-archive window-filters the <time> day string and takes digest_date from the request (D2 review gap)', async () => {
    // 页面结构（React SSR）：<time>Mon D, YYYY</time> ... <h2>Person on insight</h2>。
    // 三天字号距 25h/73h/未来 23h（按 CST 或 UTC 解析均不翻转归属）。
    // 旧代码 dateStr !== date 为恒真式（从不过滤），历史语录每轮以当日 digest_date 重放。
    const html = [
      '<time>Oct 19, 2026</time><h2>Ada on shipping fast</h2>',
      '<time>Oct 16, 2026</time><h2>Grace on compilers</h2>',
      '<time>Oct 21, 2026</time><h2>Linus on the future</h2>',
    ].join('\n');
    const h = buildHarness(db, (url) => {
      if (url === 'https://www.startuparchive.org/') return html;
      return new Error(`unexpected url ${url}`);
    });
    const { StartupArchiveConnector } = h.load('connectors/startup-archive.js');
    const items = await new StartupArchiveConnector().fetch(DIGEST);
    // 站点条目共用同一 canonical_url（connector 固定 url），故按标题断言窗口行为
    const titles = items.map((i) => i.title);
    expect(titles.some((t) => t.includes('Ada')), '01:00 CST 窗内（UTC 前一日）条目必须保留').toBe(true);
    expect(titles.some((t) => t.includes('Grace')), '40h 级别窗外条目必须剔除（恒真式已根治）').toBe(false);
    expect(titles.some((t) => t.includes('Linus')), 'now+1h 之后的未来条目必须剔除').toBe(false);
    expect(items).toHaveLength(1);
    expect(normalizeDigestDate(items[0].digest_date), 'digest_date 必须取本轮传入的 digest 日期').toBe(DIGEST_CANONICAL);
  });

  it('sec-8k window-filters filingDate and takes digest_date from the request (D2 review gap)', async () => {
    // 只放行 NVDA（cik 0001045810）一家：其余 26 家抛错走 catch，
    // 既省时也免去每家 200ms 的 SEC 限速睡眠。
    const h = buildHarness(db, (url) => {
      if (url === 'https://data.sec.gov/submissions/CIK0001045810.json') {
        return JSON.stringify({ filings: { recent: [
          { form: '8-K', filingDate: '2026-10-19', accessionNumber: '0001045810-26-000001', primaryDocument: 'nvda8k.htm', items: '2.02' },
          { form: '8-K', filingDate: '2026-10-16', accessionNumber: '0001045810-26-000002', primaryDocument: 'nvda8k2.htm', items: '5.02' },
          { form: '8-K', filingDate: '2026-10-21', accessionNumber: '0001045810-26-000003', primaryDocument: 'nvda8k3.htm', items: '8.01' },
          { form: '10-K', filingDate: '2026-10-19', accessionNumber: '0001045810-26-000004', primaryDocument: 'nvda10k.htm' },
        ] } });
      }
      return new Error('offline');
    });
    const { SEC8KConnector } = h.load('connectors/sec-8k.js');
    const items = await new SEC8KConnector().fetch(DIGEST);
    expectWindowContract(items, {
      in: 'https://www.sec.gov/Archives/edgar/data/1045810/000104581026000001/nvda8k.htm',
      old: 'https://www.sec.gov/Archives/edgar/data/1045810/000104581026000002/nvda8k2.htm',
      fut: 'https://www.sec.gov/Archives/edgar/data/1045810/000104581026000003/nvda8k3.htm',
    });
  });

  it('app-store takes digest_date from the requested digest date instead of UTC today', async () => {
    const h = buildHarness(db, (url) => {
      if (url === 'https://rss.marketingtools.apple.com/api/v2/us/apps/top-free/50/apps.json') {
        return JSON.stringify({
          feed: { results: [{ id: '1', name: 'MockApp', artistName: 'MockCorp', url: 'https://apps.apple.com/us/app/id1', genres: [{ name: 'Tools' }] }] },
        });
      }
      return new Error(`unexpected url ${url}`);
    });
    const { AppStoreRankConnector } = h.load('connectors/appstore.js');
    const items = await new AppStoreRankConnector().fetch(DIGEST);
    expect(items, '榜单数据是“当前”数据，D2 后仍应返回条目').toHaveLength(1);
    expect(
      normalizeDigestDate(items[0].digest_date),
      'digest_date 必须取本轮传入的 digest 日期（现状恒为 UTC 今天）'
    ).toBe(DIGEST_CANONICAL);
  });
});
