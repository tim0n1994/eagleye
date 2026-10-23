// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */

/**
 * Round 2 · ④ RSS 解析换 fast-xml-parser — 解析契约测试（RED 先行）
 *
 * 所有权：server/connectors/rss.js（+ package.json / package-lock.json 加依赖）。
 * 本文件只测 parseRSS 的解析行为，不触网、不碰真实库；夹具覆盖 CDATA、
 * Atom、RSS 2.0 与混合格式。
 *
 * 回归锚（当前正则实现已通过；换 fast-xml-parser 后必须保持）：
 *   R1 RSS 2.0 基线：title / link / pubDate / description / guid(isPermaLink
 *      属性) 全部就位，digest_date 取传入值。
 *   R2 CDATA：title/description 的 CDATA 内容按字面保留（CDATA 内的标签不剥、
 *      实体不解码）；description 内 <img src> 抽进 source_payload.image。
 *   R3 Atom 1.0（无前缀）：entry 的 link[@href] / id / published / summary 映射。
 *   R4 D2 时间窗：40h 前的窗外条目仍被剔除（换解析器不得丢掉过滤）。
 *
 * 新契约（当前手写正则失败 → RED；fast-xml-parser 实现应通过）：
 *   N1 XML 实体解码：&amp; &lt; &gt; &quot; &apos; &#39; 出现在文本节点时解码为
 *      对应字符（CDATA 内容除外，见 R2 —— CDATA 是字面字符数据）。
 *   N2 <item> 开标签带属性（如 rdf:about="…"）：条目不得因带属性而丢失。
 *   N3 <content:encoded>：条目无 <description> 时以其为正文来源（剥标签后）。
 *   N4 atom: 前缀的 Atom feed（<atom:feed>/<atom:entry>）：不得被入口格式校验
 *      拒绝，条目字段正常映射。
 *   N5 混合格式：以上变体共存于同一 channel 时逐条正确。
 *
 * 时间基准（不依赖真实时钟）：now = 2026-10-20 01:00 Asia/Shanghai
 * （= 2026-10-19T17:00:00Z），digest = '20261020'；夹具 pubDate 相对 now 落在
 * 36h 抓取窗内 / 40h 窗外各一。vi.useFakeTimers({ toFake: ['Date'] }) 钉死时钟，
 * 真实 timer 队列不受影响。
 */

process.env.TZ = 'Asia/Shanghai';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');
const { describe, it, expect, beforeEach, afterEach, vi } = globalThis;

const dateContract = require('../../services/date-contract');
const utils = require('../../services/utils');
const { normalizeDigestDate } = dateContract;

/* ---------- 伪造时间轴（01:00 CST 调度时刻） ---------- */
const HOUR = 3600e3;
const NOW = Date.UTC(2026, 9, 19, 17, 0, 0); // 2026-10-20 01:00 Asia/Shanghai
const DIGEST = '20261020';
const T_IN = NOW - HOUR;       // 2026-10-19T16:00:00Z —— 36h 窗内
const T_OLD = NOW - 40 * HOUR; // 窗外（D2 应剔除）

const pubRss = (t) => new Date(t).toUTCString();
const pubIso = (t) => new Date(t).toISOString();
const FEED = 'https://mock.local/feed.xml';

/* ---------- vm harness（sync-source / connector-date-window 同款） ----------
 * rss.js + base.js 加载进受控上下文；getDB 指向内存库；utils / date-contract
 * 用真货（本文件只调 parseRSS 纯函数，fetchURL 不触网；真模块闭包在测试进程，
 * 不受 vm context 缺宿主全局影响）；process.env 注入
 * 干净环境（无 SOLIDOT_RSS_FALLBACK_URL）。fast-xml-parser 放行给 GREEN 阶段
 * 的新 rss.js（依赖装入 worktree node_modules 后自动可用）。 */
function buildHarness(db) {
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
      Date: globalThis.Date, // vi 假时钟（useFakeTimers 后 globalThis.Date 即假实现）
      process: { env: {} },
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

function newConnector(db) {
  const { RSSConnector } = buildHarness(db).load('connectors/rss.js');
  return new RSSConnector('rss-fixture');
}

/* ---------- 夹具 ---------- */

const RSS20_BASELINE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Mock RSS</title><link>https://ex.com/</link><description>mock</description>
  <item><title>Plain baseline</title><link>https://ex.com/plain</link><pubDate>${pubRss(T_IN)}</pubDate><description>plain description</description><guid isPermaLink="false">guid-plain</guid></item>
</channel></rss>`;

const RSS20_CDATA = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Mock RSS</title><link>https://ex.com/</link><description>mock</description>
  <item>
    <title><![CDATA[Rust & <b>systems</b> weekly]]></title>
    <link>https://ex.com/cdata</link>
    <pubDate>${pubRss(T_IN)}</pubDate>
    <description><![CDATA[<p>body with image</p><img src="https://ex.com/img.png" alt="i"/>]]></description>
  </item>
</channel></rss>`;

// P0 follow-up（2026-10-23）：feedburner fallback feed 的 <link> 用 CDATA 包裹
// （本文件解析器 cdataPropName:#cdata 下成 { '#cdata': url }）。linkOf 若不认
// 该形状 → canonical_url 为空 → base.saveItems 整批 skip（solidot 空轮事故实测）。
const RSS20_LINK_CDATA = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Mock RSS</title><link>https://ex.com/</link><description>mock</description>
  <item><title>Feedburner-style cdata link</title><link><![CDATA[https://ex.com/cdata-link]]></link><pubDate>\${pubRss(T_IN)}</pubDate><description>cdata link body</description></item>
</channel></rss>`;

// N1：文本节点里的预定义实体与数字实体必须解码；CDATA 内的字面 & 不动（R2）。
const RSS20_ENTITIES = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Mock RSS</title><link>https://ex.com/</link><description>mock</description>
  <item><title>Ben &amp; Jerry&apos;s &lt;roadtrip&gt;</title><link>https://ex.com/entity</link><pubDate>${pubRss(T_IN)}</pubDate><description>AT&amp;T launches &quot;5G&quot; &#39;lite&#39;</description></item>
</channel></rss>`;

// N2：<item> 开标签带属性（RDF 风格 rdf:about，真实 feed 常见变体）。
const RSS20_ITEM_ATTR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><channel><title>Mock RSS</title><link>https://ex.com/</link><description>mock</description>
  <item rdf:about="https://ex.com/attr"><title>Item with attributes</title><link>https://ex.com/attr</link><pubDate>${pubRss(T_IN)}</pubDate><description>attr item body</description></item>
</channel></rss>`;

// N3：正文只有 <content:encoded>、没有 <description>（博客 feed 常态）。
const RSS20_CONTENT_ENCODED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Mock RSS</title><link>https://ex.com/</link><description>mock</description>
  <item><title>Full body only</title><link>https://ex.com/cenc</link><pubDate>${pubRss(T_IN)}</pubDate><content:encoded><![CDATA[<p>The full story body</p>]]></content:encoded></item>
</channel></rss>`;

// N4：带 atom: 命名空间前缀的 Atom feed（Google Alerts 等真实来源形态）。
const ATOM_PREFIXED = `<?xml version="1.0" encoding="utf-8"?>
<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">
  <atom:title>Prefixed Atom</atom:title>
  <atom:entry>
    <atom:title type="html">Prefixed entry</atom:title>
    <atom:link rel="alternate" type="text/html" href="https://ex.com/atom-prefixed"/>
    <atom:id>urn:uuid:1111-2222</atom:id>
    <atom:updated>${pubIso(T_IN)}</atom:updated>
    <atom:summary><![CDATA[prefixed summary]]></atom:summary>
  </atom:entry>
</atom:feed>`;

// R3：无前缀 Atom 1.0（当前实现可解析）。
const ATOM_PLAIN = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Plain Atom</title>
  <entry>
    <title>Atom entry</title>
    <link rel="alternate" type="text/html" href="https://ex.com/atom"/>
    <id>urn:uuid:aaaa-bbbb</id>
    <published>${pubIso(T_IN)}</published>
    <updated>${pubIso(T_IN)}</updated>
    <summary>atom summary</summary>
  </entry>
</feed>`;

// N5：混合格式 —— 同一 channel 里基线 / 属性 item / content:encoded 共存，
// 外加一条 40h 窗外条目验证 D2 过滤仍在（R4）。
const RSS20_MIXED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><channel><title>Mixed</title><link>https://ex.com/</link><description>mock</description>
  <item><title>mixed plain</title><link>https://ex.com/m1</link><pubDate>${pubRss(T_IN)}</pubDate><description>m1</description></item>
  <item rdf:about="https://ex.com/m2"><title>mixed &amp; attr</title><link>https://ex.com/m2</link><pubDate>${pubRss(T_IN)}</pubDate><description><![CDATA[<p>m2 body</p>]]></description></item>
  <item><title>mixed content</title><link>https://ex.com/m3</link><pubDate>${pubRss(T_IN)}</pubDate><content:encoded><![CDATA[<p>m3 full</p>]]></content:encoded></item>
  <item><title>stale</title><link>https://ex.com/stale</link><pubDate>${pubRss(T_OLD)}</pubDate><description>old</description></item>
</channel></rss>`;

/* ---------- 断言辅助：先断言“没抛错”，再短路，保证失败形态是 AssertionError ---------- */
function parseQuiet(conn, xml) {
  try {
    return { err: null, items: conn.parseRSS(xml, DIGEST, FEED) };
  } catch (e) {
    return { err: e };
  }
}

function expectNoErr(r, msg) {
  expect(r.err, `${msg}（got: ${r.err && r.err.message}）`).toBeNull();
}

describe('Round2 ④ RSS parsing — regression anchors (must stay green)', () => {
  let db;
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    db = new Database(':memory:');
    db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/001_initial_schema.sql'), 'utf8'));
    db.prepare("INSERT INTO sources (id, slug, label, feed_url) VALUES ('src-fx', 'rss-fixture', 'Fixture', 'https://mock.local/feed.xml')").run();
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('R1: RSS 2.0 baseline — title/link/pubDate/description/guid all mapped', () => {
    const conn = newConnector(db);
    const r = parseQuiet(conn, RSS20_BASELINE);
    expectNoErr(r, 'RSS 2.0 基线不得抛错');
    if (r.err) return;
    expect(r.items, '基线夹具必须解析出恰好 1 条').toHaveLength(1);
    const it = r.items[0];
    expect(it.title).toBe('Plain baseline');
    expect(it.canonical_url).toBe('https://ex.com/plain');
    expect(it.original_summary).toBe('plain description');
    expect(it.published_at).toBe(new Date(T_IN).toISOString());
    expect(it.digest_date).toBe(DIGEST);
    expect(normalizeDigestDate(it.digest_date)).toBe('2026-10-20');
    expect(JSON.parse(it.source_payload).guid).toBe('guid-plain');
  });

  it('R2: CDATA kept verbatim; <img src> extracted into source_payload.image', () => {
    const conn = newConnector(db);
    const r = parseQuiet(conn, RSS20_CDATA);
    expectNoErr(r, 'CDATA 夹具不得抛错');
    if (r.err) return;
    expect(r.items).toHaveLength(1);
    const it = r.items[0];
    expect(it.title, 'CDATA 内标签按字面保留（<b> 不剥、不解码）').toBe('Rust & <b>systems</b> weekly');
    expect(it.original_summary, 'CDATA description 剥外层 HTML 标签后入库').toContain('body with image');
    expect(it.original_summary).not.toContain('<p>');
    expect(JSON.parse(it.source_payload).image, 'description 内 <img src> 抽进 image').toBe('https://ex.com/img.png');
  });

  it('R3: Atom 1.0 without prefix — entry/link[@href]/published/summary mapped', () => {
    const conn = newConnector(db);
    const r = parseQuiet(conn, ATOM_PLAIN);
    expectNoErr(r, '无前缀 Atom 不得抛错');
    if (r.err) return;
    expect(r.items).toHaveLength(1);
    const it = r.items[0];
    expect(it.title).toBe('Atom entry');
    expect(it.canonical_url).toBe('https://ex.com/atom');
    expect(it.original_summary).toBe('atom summary');
    expect(it.published_at).toBe(new Date(T_IN).toISOString());
  });
});

describe('Round2 ④ RSS parsing — new contracts (RED on current regex parser)', () => {
  let db;
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    db = new Database(':memory:');
    db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/001_initial_schema.sql'), 'utf8'));
    db.prepare("INSERT INTO sources (id, slug, label, feed_url) VALUES ('src-fx', 'rss-fixture', 'Fixture', 'https://mock.local/feed.xml')").run();
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('N1: decodes XML entities in text nodes (title and description)', () => {
    const conn = newConnector(db);
    const r = parseQuiet(conn, RSS20_ENTITIES);
    expectNoErr(r, '实体夹具不得抛错');
    if (r.err) return;
    expect(r.items).toHaveLength(1);
    const it = r.items[0];
    expect(it.title, '预定义实体 &amp;/&apos;/&lt;/&gt; 必须解码').toBe("Ben & Jerry's <roadtrip>");
    expect(it.original_summary, '&amp;/&quot;/数字实体 &#39; 必须解码').toBe("AT&T launches \"5G\" 'lite'");
  });

  it('N2: keeps <item> whose opening tag carries attributes (rdf:about)', () => {
    const conn = newConnector(db);
    const r = parseQuiet(conn, RSS20_ITEM_ATTR);
    expectNoErr(r, '带属性的 <item> 不得导致整体抛错');
    if (r.err) return;
    const urls = r.items.map((i) => i.canonical_url);
    expect(urls, '开标签带属性的条目不得丢失（got: ' + JSON.stringify(urls) + '）').toContain('https://ex.com/attr');
    const it = r.items.find((i) => i.canonical_url === 'https://ex.com/attr');
    expect(it.title).toBe('Item with attributes');
    expect(it.original_summary).toBe('attr item body');
  });

  it('N3: falls back to <content:encoded> when <description> is absent', () => {
    const conn = newConnector(db);
    const r = parseQuiet(conn, RSS20_CONTENT_ENCODED);
    expectNoErr(r, 'content:encoded 夹具不得抛错');
    if (r.err) return;
    expect(r.items).toHaveLength(1);
    const it = r.items[0];
    expect(it.original_summary, '无 description 时正文取 content:encoded（剥标签）').toContain('The full story body');
    expect(it.original_summary).not.toContain('<p>');
  });

  it('N4: accepts atom:-prefixed Atom feeds instead of rejecting them', () => {
    const conn = newConnector(db);
    const r = parseQuiet(conn, ATOM_PREFIXED);
    expectNoErr(r, 'atom: 前缀 feed 不得被入口格式校验拒绝');
    if (r.err) return;
    expect(r.items, 'atom:entry 必须被解析为条目').toHaveLength(1);
    const it = r.items[0];
    expect(it.title).toBe('Prefixed entry');
    expect(it.canonical_url).toBe('https://ex.com/atom-prefixed');
    expect(it.original_summary).toBe('prefixed summary');
  });

  it('N5+R4: mixed-format channel parses every variant and still drops out-of-window items', () => {
    const conn = newConnector(db);
    const r = parseQuiet(conn, RSS20_MIXED);
    expectNoErr(r, '混合夹具不得抛错');
    if (r.err) return;
    const urls = r.items.map((i) => i.canonical_url);
    expect(urls, '三条窗内变体条目都必须保留（got: ' + JSON.stringify(urls) + '）').toContain('https://ex.com/m1');
    expect(urls).toContain('https://ex.com/m2');
    expect(urls).toContain('https://ex.com/m3');
    expect(urls, '40h 前的窗外条目必须剔除（D2 不得因换解析器而丢失）').not.toContain('https://ex.com/stale');
    const m2 = r.items.find((i) => i.canonical_url === 'https://ex.com/m2');
    expect(m2.title, '带属性 item 的实体也必须解码').toBe('mixed & attr');
    const m3 = r.items.find((i) => i.canonical_url === 'https://ex.com/m3');
    expect(m3.original_summary, 'content:encoded 条目正文入摘要').toContain('m3 full');
    for (const it of r.items) {
      expect(normalizeDigestDate(it.digest_date), 'digest_date 取传入日期').toBe('2026-10-20');
    }
  });
});

/* ---------- P0 follow-up（2026-10-23）：feedburner CDATA <link> ---------- */
describe('P0 follow-up — CDATA-wrapped <link> (feedburner fallback shape)', () => {
  let db;
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    db = new Database(':memory:');
    db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/001_initial_schema.sql'), 'utf8'));
    db.prepare("INSERT INTO sources (id, slug, label, feed_url) VALUES ('src-fx', 'rss-fixture', 'Fixture', 'https://mock.local/feed.xml')").run();
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('P1: <link><![CDATA[…]]></link> maps to canonical_url instead of empty', () => {
    const conn = newConnector(db);
    const r = parseQuiet(conn, RSS20_LINK_CDATA);
    expectNoErr(r, 'CDATA link 夹具不得抛错');
    if (r.err) return;
    expect(r.items, '夹具必须解析出 1 条').toHaveLength(1);
    expect(r.items[0].canonical_url, 'CDATA 包裹的 link 必须取出 URL（否则整批被 base.saveItems skip）').toBe('https://ex.com/cdata-link');
  });
});
