// @vitest-environment node
/**
 * Round 2 · ⑤ 每源抓取耗时契约测试 — 测试作者·耗时
 *
 * 覆盖（CTO 方案第⑤项，测试范围原文）：
 *  - 每源抓取耗时写入 fetch summary 行（connectors/index.js：
 *    fetchSource(returnDetails) 信封 + fetchAllSources 的逐源结果行，
 *    错误行也携带）；
 *  - sources 表新列（迁移，按编号惯例应为 043_*.sql）：
 *    sources.last_fetch_duration_ms INTEGER（毫秒），成功轮、空轮、
 *    失败轮都写入（"耗时含成功与失败轮"），后一轮覆盖前一轮（语义是
 *    "最近一轮耗时"）；
 *  - 尚未跑到新迁移的老生产库（pre-043，= 今天的 001–042 全量态）没有
 *    该列时，抓取不得因此失败 —— 列写入 best-effort 跳过，信封里的
 *    duration_ms 照常返回（沿用 base.js D4 的"簿记绝不破坏 ingestion"
 *    不变量，base.js:90-97）。
 *
 * 命名契约（测试作者钉死，实现照此落地）：
 *  - 信封/结果行字段：duration_ms（snake_case，与现有 requested/fetched/
 *    skipped/failed 同风格），整数毫秒；
 *  - DB 列：sources.last_fetch_duration_ms（与 last_fetched_at /
 *    last_attempt_at 同风格）。
 *
 * 时钟虚拟化（重要）：本 harness 往 vm 上下文注入同一虚拟时钟的三个入口
 * —— Date.now()、performance.now()、process.hrtime()/hrtime.bigint()。
 * 实现测耗时必须走其中之一（都是标准做法）；scripted connector 在 fetch
 * 里 tick 虚拟时钟 N 毫秒，期望 duration_ms === N（确定性，非 flaky）。
 * vi.setSystemTime 只作用于测试 realm（date-contract / utils），vm 里的
 * 被测代码看到的是注入的 VDate。
 *
 * TZ=Asia/Shanghai（生产调度时区）；所有时间均为显式常量。
 *
 * GREEN 阶段实现落点（均在文件边界内）：
 *  - server/connectors/index.js —— fetchSource 计时 + 信封/结果行透出 +
 *    失败轮列写入（与 recordFailedAttempt 同路径）；
 *  - server/migrations/043_*.sql —— sources.last_fetch_duration_ms 列；
 *  - server/connectors/base.js —— 若计时落在 saveItems 侧则在此（信封
 *    字段契约不变）。
 * 注意：migrations-fresh.test.js 若硬编码迁移文件数，043 落地时需由实现
 * 者同步 +1（既有测试维护，不属于本文件）。
 */
process.env.TZ = 'Asia/Shanghai';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');
const utils = require('../utils');
const { describe, it, expect, beforeEach, afterEach, vi } = globalThis;

/* ---------- 常量时间轴（与 Round1 测试同款 01:00 CST 边界） ---------- */
const R2 = { digest: '2026-10-20', now: '2026-10-19T17:00:00Z' }; // 2026-10-20 01:00 Asia/Shanghai
const PUBLISHED_N = '2026-10-19T09:00:00Z'; // R2 now−8h，36h 窗内

const DURATION_COL = 'last_fetch_duration_ms';

// 在 vi.useFakeTimers() 之前抓真实 Date，供 VDate 继承
const RealDate = Date;

/* ---------- 用真实迁移 runner 建全新 schema（未来 043 落地后自动纳入） ---------- */
function loadMigrator(db) {
  const filename = path.resolve(__dirname, '../../db/migrate.js');
  const target = { exports: {} };
  const context = {
    module: target,
    exports: target.exports,
    __dirname: path.dirname(filename),
    __filename: filename,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === './connection') return { getDB: () => db };
      return require(name); // fs / path 等 builtins
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return target.exports;
}

/* ---------- vm harness（模式照 base-saveitems-dedup-health.test.js） ----------
 * 差异仅两处：
 *  1. 注入统一虚拟时钟（VDate / performance / process.hrtime），scripted
 *     connector 通过 tick(ms) 推进 —— 被测的耗时测量因此完全确定；
 *  2. batches 支持 advance 配置（slug → 该源 fetch 期间虚拟流逝的毫秒）。
 * connector 全部替换为可控 ScriptedConnector：saveItems/getSourceId/
 * normalize 继承真实 BaseConnector（被测代码），只有 fetch 是假的。
 */
function harness(db, options = {}) {
  const cache = new Map();
  const logs = [];
  const batches = options.batches || {}; // slug -> 原始条目数组（或 Error 使 fetch 抛错）
  const advance = options.advance || {}; // slug -> fetch 期间虚拟流逝的毫秒数
  let virtualNow = Date.parse(R2.now); // vm 侧统一虚拟时钟（与测试 realm 的 vi 时间钉在同一点）
  const tick = (ms) => { virtualNow += ms; };

  class VDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [virtualNow])); }
    static now() { return virtualNow; }
  }
  const vPerformance = { now: () => virtualNow };
  const hrtimeNS = () => BigInt(virtualNow) * 1000000n;
  const vHrtime = (time) => {
    const nowNS = hrtimeNS();
    if (time) {
      const prevNS = BigInt(time[0]) * 1000000000n + BigInt(time[1]);
      const d = nowNS - prevNS;
      return [Number(d / 1000000000n), Number(d % 1000000000n)];
    }
    return [Number(nowNS / 1000000000n), Number(nowNS % 1000000000n)];
  };
  vHrtime.bigint = hrtimeNS;

  const serverRoot = path.resolve(__dirname, '../..');
  function load(relativePath) {
    const filename = path.join(serverRoot, relativePath);
    if (cache.has(filename)) return cache.get(filename);
    const target = { exports: {} };
    const context = {
      module: target,
      exports: target.exports,
      console: {
        log: (...a) => logs.push(a.join(' ')),
        warn: (...a) => logs.push(a.join(' ')),
        error: (...a) => logs.push(a.join(' ')),
      },
      URL,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      AbortController: globalThis.AbortController,
      Date: VDate,
      performance: vPerformance,
      process: { env: {}, hrtime: vHrtime },
      require(name) {
        if (name === '../db/connection') return { getDB: () => db };
        if (name === '../services/utils') return utils;
        if (name === '../services/date-contract') return require('../date-contract');
        if (name === '../services/x-following-config') return { readBlocklist: () => new Set(), isBlocked: () => false };
        if (name === '../services/outbox') return require('../outbox');
        if (name === './base') return load('connectors/base.js');
        if (relativePath === 'connectors/index.js' && name.startsWith('./')) {
          const RealBase = load('connectors/base.js');
          const kebab = (exportName) => exportName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
          const makeClass = (fallbackSlug) => class ScriptedConnector extends RealBase.BaseConnector {
            constructor(arg) { super(typeof arg === 'string' && arg ? arg : fallbackSlug); }
            async fetch(dateArg) {
              // 先让虚拟时钟流逝本轮配置的毫秒数，再返回/抛出 —— 无论成败，
              // 这段"抓取耗时"都必须被测量。
              const adv = Number(advance[this.slug] || 0);
              if (adv > 0) tick(adv);
              const batch = batches[this.slug];
              if (batch instanceof Error) throw batch;
              if (!Array.isArray(batch)) return [];
              return batch.map(raw => ({ ...this.normalize(raw), digest_date: dateArg }));
            }
          };
          return new Proxy({}, {
            get: (t, prop) => {
              if (prop === '__esModule') return false;
              if (typeof prop !== 'string') return undefined;
              const fallbackSlug = prop === 'HNConnector'
                ? 'hacker-news'
                : kebab(prop.replace(/Connector$/, ''));
              return makeClass(fallbackSlug);
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
  return {
    registry: load('connectors/index.js'),
    BaseConnector: load('connectors/base.js').BaseConnector,
    logs,
  };
}

/* ---------- 全量迁移 schema 的公共夹具 ---------- */
function freshMigratedDB() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  loadMigrator(db).runMigrations(); // 全量迁移（含未来的 043；部分迁移会播种 sources 行）
  const ensureSource = (slug) => {
    const existing = db.prepare('SELECT id FROM sources WHERE slug = ?').get(slug);
    if (existing) {
      db.prepare('UPDATE sources SET is_active = 1 WHERE slug = ?').run(slug);
      return existing.id;
    }
    const id = `src-${slug}`;
    db.prepare('INSERT INTO sources (id, slug, label, is_active) VALUES (?, ?, ?, 1)').run(id, slug, slug);
    return id;
  };
  ensureSource('hacker-news');
  ensureSource('techmeme');
  return db;
}

describe('Round2 ⑤ per-source fetch duration (TZ=Asia/Shanghai, virtual clock)', () => {
  describe('migration — sources.last_fetch_duration_ms 新列', () => {
    let db;
    beforeEach(() => { db = freshMigratedDB(); });
    afterEach(() => db.close());

    it('fresh database gains an INTEGER last_fetch_duration_ms column on sources', () => {
      const columns = db.pragma('table_info(sources)');
      const names = columns.map(c => c.name);
      const col = columns.find(c => c.name === DURATION_COL);
      expect(col, `迁移必须给 sources 增加 ${DURATION_COL} 列（⑤：耗时写 sources 新列）`).toBeDefined();
      expect(String(col.type).toUpperCase()).toContain('INT');

      // 既有健康列不回归（037/041）
      for (const kept of ['last_fetched_at', 'last_attempt_at', 'consecutive_empty', 'health_status']) {
        expect(names).toContain(kept);
      }

      // 老行可读：不显式给列时为 NULL（语义＝从未测量，不伪造 0）
      db.prepare("INSERT INTO sources (id, slug, label) VALUES ('sd1', 'dur-probe', 'DurProbe')").run();
      const probe = db.prepare(`SELECT * FROM sources WHERE slug = 'dur-probe'`).get();
      expect(probe[DURATION_COL]).toBeNull();

      expect(db.pragma('foreign_key_check')).toEqual([]);
    });
  });

  describe('fetchSource — duration_ms 信封字段', () => {
    let db;
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(R2.now));
      db = freshMigratedDB();
    });
    afterEach(() => {
      db.close();
      vi.useRealTimers();
    });

    const hnRow = () => db.prepare("SELECT * FROM sources WHERE slug = 'hacker-news'").get();

    it('successful round: envelope carries integer duration_ms and the sources row is stamped (success rounds count)', async () => {
      const h = harness(db, {
        batches: { 'hacker-news': [
          { title: 'Fresh N', url: 'https://example.com/n', publishedAt: PUBLISHED_N, score: 7 },
        ] },
        advance: { 'hacker-news': 4200 },
      });
      const r = await h.registry.fetchSource('hacker-news', R2.digest, { returnDetails: true });
      expect(r.inserted).toBe(1); // 夹具自检：条目确实入库
      expect(r.duration_ms, '⑤：fetchSource 信封必须携带 duration_ms（整数毫秒）').toBe(4200);
      expect(Number.isInteger(r.duration_ms)).toBe(true);
      const row = hnRow();
      expect(row[DURATION_COL], '成功轮必须把耗时写进 sources 新列').toBe(4200);
    });

    it('empty round: duration is still measured and recorded (no items is still a round)', async () => {
      const h = harness(db, { batches: { 'hacker-news': [] }, advance: { 'hacker-news': 1500 } });
      const r = await h.registry.fetchSource('hacker-news', R2.digest, { returnDetails: true });
      expect(r.inserted).toBe(0);
      expect(r.duration_ms, '空轮也要有耗时（空 ≠ 没跑）').toBe(1500);
      expect(hnRow()[DURATION_COL], '空轮耗时同样落列').toBe(1500);
    });

    it('failed round: fetch rejects as before, but the burned time is still recorded on the sources row', async () => {
      const h = harness(db, {
        batches: { 'hacker-news': new Error('upstream down') },
        advance: { 'hacker-news': 7300 },
      });
      // 原有错误语义不变：错误照原样抛出
      await expect(h.registry.fetchSource('hacker-news', R2.digest)).rejects.toThrow('upstream down');
      const row = hnRow();
      expect(row[DURATION_COL], '失败轮也必须记录耗时（测试范围："耗时含成功与失败轮"）').toBe(7300);
      expect(row.last_attempt_at, 'D4 既有簿记不回归').toBeTruthy();
    });

    it('consecutive rounds overwrite: the column holds the LATEST round duration, not an accumulation', async () => {
      const batch = [{ title: 'S', url: 'https://example.com/s', publishedAt: PUBLISHED_N }];
      const h1 = harness(db, { batches: { 'hacker-news': batch }, advance: { 'hacker-news': 4200 } });
      await h1.registry.fetchSource('hacker-news', R2.digest, { returnDetails: true });
      expect(hnRow()[DURATION_COL]).toBe(4200);
      // 第二轮（同 URL 全重复）：耗时 900ms，列值必须被覆盖为 900
      const h2 = harness(db, { batches: { 'hacker-news': batch }, advance: { 'hacker-news': 900 } });
      const r2 = await h2.registry.fetchSource('hacker-news', R2.digest, { returnDetails: true });
      expect(r2.inserted).toBe(0);
      expect(r2.duration_ms).toBe(900);
      expect(hnRow()[DURATION_COL], '语义是"最近一轮耗时"：覆盖，不是累加/取最小').toBe(900);
    });

    it('old database without the duration column (pre-043 state): fetch must not break; envelope still carries duration_ms', async () => {
      // 现实的部分 schema 场景：部署中的生产库 = 今天的全量迁移态（001–042，
      // 无 043 耗时列）。043 落地后本测试在测试库内 DROP 该列来复现同一状态
      // （仅测试内存库操作）。列写入必须 best-effort 跳过，抓取与信封字段
      // 照常（沿用 base.js D4 的"簿记绝不破坏 ingestion"不变量，base.js:90-97）。
      // 注：不能真用 001-only 库——033 之前的 information_items 连
      // published_raw 列都没有，saveItems 本身就无法工作，与本特性无关。
      const partial = freshMigratedDB();
      try {
        const hasCol = partial.pragma('table_info(sources)').some(c => c.name === DURATION_COL);
        if (hasCol) partial.prepare(`ALTER TABLE sources DROP COLUMN ${DURATION_COL}`).run();
        const h = harness(partial, {
          batches: { 'hacker-news': [
            { title: 'Old schema', url: 'https://example.com/old', publishedAt: PUBLISHED_N },
          ] },
          advance: { 'hacker-news': 4200 },
        });
        const r = await h.registry.fetchSource('hacker-news', R2.digest, { returnDetails: true });
        expect(r.inserted).toBe(1); // 抓取本身必须成功
        expect(r.duration_ms, '无耗时列的老库：信封 duration_ms 照常返回').toBe(4200);
      } finally {
        partial.close();
      }
    });
  });

  describe('fetchAllSources — fetch summary 行携带 duration_ms（成功行与错误行都带）', () => {
    let db;
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(R2.now));
      db = freshMigratedDB();
    });
    afterEach(() => {
      db.close();
      vi.useRealTimers();
    });

    it('summary rows carry per-source duration_ms for both successful and errored sources', async () => {
      const h = harness(db, {
        batches: {
          'hacker-news': [
            { title: 'L', url: 'https://example.com/l', publishedAt: PUBLISHED_N },
          ],
          'techmeme': new Error('techmeme exploded'),
        },
        advance: { 'hacker-news': 4200, 'techmeme': 7300 },
      });
      const results = await h.registry.fetchAllSources(R2.digest);
      const bySource = Object.fromEntries(results.map(r => [r.source, r]));
      expect(bySource['hacker-news'].items, '夹具自检：HN 有产出').toBe(1);
      expect(bySource['hacker-news'].duration_ms, 'fetch summary 成功行必须带 duration_ms').toBe(4200);
      expect(bySource['techmeme'].error, '错误语义不回归').toBe('techmeme exploded');
      expect(bySource['techmeme'].duration_ms, 'fetch summary 错误行也必须带 duration_ms（失败轮耗时可见）').toBe(7300);
      // 既有 summary 日志行为不回归（仍打印 Fetch summary 行）
      expect(h.logs.find(line => /Fetch summary/.test(line))).toBeDefined();
    });
  });
});
