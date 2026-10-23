// @vitest-environment node
/**
 * Round 1 · 入库层契约测试（D3 跨天去重 + D4 源健康簿记）— 测试作者 B
 *
 * 覆盖：
 *  - D3：saveItems 入库前按 (source_id, canonical_url) 跨 digest_date 查重，
 *        命中则跳过并计入 details.duplicates，随 fetchSource(returnDetails) 透出；
 *        fetch summary 日志行（connectors/index.js）并入 duplicate 数。
 *        不改 UNIQUE(source_id,canonical_url,digest_date)，不动历史重复行。
 *  - D4：sources.last_attempt_at 每轮无论成败必写（037 列已存在但当前无人写）；
 *        sources.consecutive_empty 空轮 +1、有产出清零（需新迁移 041 加列；
 *        Round 1.1 定案2 修订：全重 dup-only 轮不算空轮，streak 不变，
 *        详见 base-saveitems-round1-1-bookkeeping.test.js）；
 *        last_fetched_at 维持"有产出才刷新"的现有语义。
 *
 * 01:00 CST 边界样例（process.env.TZ='Asia/Shanghai'；所有时间均为显式常量，
 * 主上下文时钟用 vi.setSystemTime 钉死，断言不依赖真实时钟）：
 *  - 样例①：now = 2026-10-19 01:00 CST（= 2026-10-18T17:00Z）。条目 P 发布于
 *    2026-10-18T10:00:00Z（= 10-18 18:00 CST，now−7h，36h 窗内 → 应通过；其 UTC
 *    日期 10-18 ≠ 本轮 digest 10-19 —— 旧的"digest 日期 == 条目 UTC 日期"严格相等
 *    过滤正是在这里全量 skip）。次日 R2 = 2026-10-20 01:00 CST（= 2026-10-19T17:00Z）
 *    时 P 已 31h 仍在窗内：连续两轮 01:00 都能看到它 → 必须只落一行（D3）。
 *  - 样例②：条目 Q 发布于 2026-10-18T01:00:00Z：R1 时 16h（窗内，已入库）；R2 时
 *    40h（> 36h，D2 应在 connector 层排除）。即便它仍出现在批次里，入库层也必须
 *    以跨天查重兜底：不新增行、计 duplicates。
 *  - 样例③（仅契约说明，不在入库层断言）：发布时间 > now+1h 的未来条目由 D2 在
 *    connector 层排除；全新 URL 无历史行，D3 按设计不丢弃。
 *
 * GREEN 阶段实现落点：
 *  - server/connectors/base.js —— details.duplicates、consecutive_empty 维护。
 *  - server/migrations/041_*.sql —— sources.consecutive_empty 列（NOT NULL DEFAULT 0）。
 *  - server/connectors/index.js —— last_attempt_at 写入 + fetch summary 并入
 *    duplicates（⚠ 跨文件需求：index.js 不在入库层所有权清单内，需走仲裁）。
 */
process.env.TZ = 'Asia/Shanghai';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');
const utils = require('../utils');
const { describe, it, expect, beforeEach, afterEach, vi } = globalThis;

/* ---------- 伪造的 01:00 CST 边界时间轴 ---------- */
const R1 = { digest: '2026-10-19', now: '2026-10-18T17:00:00Z' }; // 2026-10-19 01:00 Asia/Shanghai
const R2 = { digest: '2026-10-20', now: '2026-10-19T17:00:00Z' }; // 2026-10-20 01:00 Asia/Shanghai
const PUBLISHED_P = '2026-10-18T10:00:00Z'; // 样例①：R1 now−7h；R2 时 31h（均 < 36h）
const PUBLISHED_Q = '2026-10-18T01:00:00Z'; // 样例②：R1 时 16h；R2 时 40h（> 36h 出窗）
const PUBLISHED_N = '2026-10-19T09:00:00Z'; // R2 now−8h 的当日新条目（36h 窗内）

/* ---------- 用真实迁移 runner 建全新 schema（未来 041 落地后自动纳入） ---------- */
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

/* ---------- vm harness（模式照 sync-source.test.js）：connector 全部替换为可控 ScriptedConnector ---------- */
function harness(db, options = {}) {
  const cache = new Map();
  const logs = [];
  const batches = options.batches || {}; // slug -> 原始条目数组（或 Error 使 fetch 抛错）
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
      process: { env: {} },
      require(name) {
        if (name === '../db/connection') return { getDB: () => db };
        if (name === '../services/utils') return utils;
        if (name === '../services/date-contract') return require('../date-contract');
        if (name === '../services/x-following-config') return { readBlocklist: () => new Set(), isBlocked: () => false };
        if (name === '../services/outbox') return require('../outbox');
        if (name === './base') return load('connectors/base.js');
        if (relativePath === 'connectors/index.js' && name.startsWith('./')) {
          // 注册表里的 16 个 connector 全部映射到可编程 connector：
          // saveItems/getSourceId/normalize 继承真实 BaseConnector（被测代码），
          // 只有 fetch 是假的 —— 它体现 D2 之后的 connector 契约：digest_date 取
          // 本轮传入日期（compact/canonical 皆可，入库时 normalizeDigestDate 归一），
          // 与条目 UTC 日期无关；时间窗过滤属 connector 层（D2），这里刻意不做，
          // 以便入库层测试能验证"窗外条目混入批次时 D3 的兜底"。
          // 无参构造的 connector 按导出名推导互不冲突的 fallback slug，避免
          // fetchAllSources 里多个注册项共享 slug 互抢批次（HN 特判 hacker-news）。
          const RealBase = load('connectors/base.js');
          const kebab = (exportName) => exportName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
          const makeClass = (fallbackSlug) => class ScriptedConnector extends RealBase.BaseConnector {
            constructor(arg) { super(typeof arg === 'string' && arg ? arg : fallbackSlug); }
            async fetch(dateArg) {
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

describe('Round1 D3/D4 storage layer (01:00 CST boundary, TZ=Asia/Shanghai)', () => {
  let db;
  let hnSourceId;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(R2.now)); // 伪造 now = 2026-10-20 01:00 CST
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    loadMigrator(db).runMigrations(); // 全量迁移（含未来的 041；部分迁移会播种 sources 行）
    // 迁移可能已播种同名 slug：存在则复用其真实 id（connector 按 slug 反查），否则补插
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
    hnSourceId = ensureSource('hacker-news');
    ensureSource('techmeme');
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  const sourceColumns = () => db.pragma('table_info(sources)').map(c => c.name);
  const hnRow = () => db.prepare("SELECT * FROM sources WHERE slug = 'hacker-news'").get();
  const rowsFor = url => db.prepare(
    'SELECT digest_date FROM information_items WHERE source_id = ? AND canonical_url = ? ORDER BY digest_date'
  ).all(hnSourceId, url);

  describe('D3 — cross-day dedup in saveItems/fetchSource', () => {
    it('样例①: now−7h item (UTC date ≠ digest date) is stored under the passed digest date, and the next 01:00 run dedups it instead of re-inserting', async () => {
      const h = harness(db, { batches: { 'hacker-news': [
        { title: 'Boundary item P', url: 'https://example.com/p', publishedAt: PUBLISHED_P, score: 42 },
      ] } });

      // R1 = 2026-10-19 01:00 CST：P 为 now−7h，36h 窗内 → 应通过并入库
      const r1 = await h.registry.fetchSource('hacker-news', R1.digest, { returnDetails: true });
      expect(r1.inserted).toBe(1);
      expect(r1.duplicates, 'D3 契约：saveItems details 必须携带 duplicates 计数').toBe(0);
      // digest_date 取本轮传入日期（不是条目 UTC 日期 10-18；compact YYYYMMDD 会被归一）
      expect(rowsFor('https://example.com/p')).toEqual([{ digest_date: R1.digest }]);

      // R2 = 2026-10-20 01:00 CST：同一 URL 再现（31h，仍在窗内）→ 只能有一行
      const r2 = await h.registry.fetchSource('hacker-news', R2.digest, { returnDetails: true });
      expect(r2.inserted, '跨天重插正是全库 49.9% 重复行的来源：第二轮不得再插入').toBe(0);
      expect(r2.duplicates).toBe(1);
      expect(r2.existing).toBe(0); // 跨天命中算 duplicate，不是同日 existing
      expect(rowsFor('https://example.com/p')).toEqual([{ digest_date: R1.digest }]);
    });

    it('样例②: a 40h-old re-appearance (outside the 36h window) must not create a cross-day row — storage backstop', async () => {
      const h = harness(db, { batches: { 'hacker-news': [
        { title: 'Old item Q', url: 'https://example.com/q', publishedAt: PUBLISHED_Q },
      ] } });

      const r1 = await h.registry.fetchSource('hacker-news', R1.digest, { returnDetails: true });
      expect(r1.inserted).toBe(1); // R1 时 Q 为 16h，窗内，正常入库

      // R2 时 Q 已 40h（D2 窗外，connector 层应排除）；即便批次仍含它，入库层必须兜底
      const r2 = await h.registry.fetchSource('hacker-news', R2.digest, { returnDetails: true });
      expect(r2.inserted, '窗外旧条目再现不得新增行（D3 跨天查重兜底）').toBe(0);
      expect(r2.duplicates).toBe(1);
      expect(rowsFor('https://example.com/q')).toEqual([{ digest_date: R1.digest }]);
    });

    it('same-day re-runs stay idempotent (UNIQUE(source_id, canonical_url, digest_date) untouched)', async () => {
      const h = harness(db, { batches: { 'hacker-news': [
        { title: 'S', url: 'https://example.com/s', publishedAt: PUBLISHED_N },
      ] } });
      await h.registry.fetchSource('hacker-news', R2.digest, { returnDetails: true });
      const again = await h.registry.fetchSource('hacker-news', R2.digest, { returnDetails: true });
      expect(again.inserted).toBe(0);
      expect((again.existing || 0) + (again.duplicates || 0)).toBe(1); // 同日语义归 existing 或 duplicates 均可
      expect(rowsFor('https://example.com/s')).toHaveLength(1);
    });

    it('mixed batch: duplicates and fresh inserts are counted separately in one pass', async () => {
      // 首轮（R1）状态预置【主脚本仲裁修正】：原实现用同一批次 [p,n] 真跑 R1，
      // 但按 01:00 边界样例③契约，n（发布于 2026-10-19T09:00Z）在 R1 时刻
      // （now=2026-10-18T17:00Z）是 +16h 的未来条目，应由 D2 时间窗在 connector
      // 层排除，根本不会出现在 R1 批次——而本 harness 刻意不实现 D2 窗过滤
      // （见上方 fetch stub 注释），真跑 R1 会把 n 一并入库到 10-19，使 R2 的
      // "n 为新插入"断言在物理上不可满足。这里用直插 SQL 预置 R1 的正确终态
      // （仅 p @10-19，与下方 fetch-summary 用例的预置手法一致），断言零削弱。
      db.prepare(
        'INSERT INTO information_items (id, source_id, canonical_url, title, digest_date, content_hash) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('pre-mixed-p', hnSourceId, 'https://example.com/p', 'P', R1.digest, 'hash-mixed-p');
      const h = harness(db, { batches: { 'hacker-news': [
        { title: 'P again', url: 'https://example.com/p', publishedAt: PUBLISHED_P },
        { title: 'New today', url: 'https://example.com/n', publishedAt: PUBLISHED_N },
      ] } });
      const r2 = await h.registry.fetchSource('hacker-news', R2.digest, { returnDetails: true });
      expect(r2.inserted).toBe(1); // 只有 n 是新的
      expect(r2.duplicates).toBe(1);
      expect(rowsFor('https://example.com/n')).toEqual([{ digest_date: R2.digest }]);
      expect(rowsFor('https://example.com/p')).toEqual([{ digest_date: R1.digest }]);
    });
  });

  describe('D4 — source bookkeeping (last_attempt_at / consecutive_empty)', () => {
    it('a productive round resets consecutive_empty to 0 and keeps last_fetched_at semantics', async () => {
      expect(sourceColumns(), 'D4 迁移必须新增 sources.consecutive_empty').toContain('consecutive_empty');
      db.prepare("UPDATE sources SET consecutive_empty = 3 WHERE slug = 'hacker-news'").run();
      const h = harness(db, { batches: { 'hacker-news': [
        { title: 'Fresh', url: 'https://example.com/f', publishedAt: PUBLISHED_N },
      ] } });
      const r = await h.registry.fetchSource('hacker-news', R2.digest, { returnDetails: true });
      expect(r.inserted).toBe(1);
      const row = hnRow();
      expect(row.consecutive_empty, '有产出的轮次必须清零').toBe(0);
      expect(row.last_fetched_at).toBeTruthy(); // 现有语义保留：有产出即刷新
      expect(row.item_count).toBe(1);
    });

    it('an all-duplicate round is NOT an empty round — consecutive_empty unchanged (Round 1.1 定案2)', async () => {
      expect(sourceColumns(), 'D4 迁移必须新增 sources.consecutive_empty').toContain('consecutive_empty');
      const h = harness(db, { batches: { 'hacker-news': [
        { title: 'P', url: 'https://example.com/p', publishedAt: PUBLISHED_P },
      ] } });
      await h.registry.fetchSource('hacker-news', R1.digest, { returnDetails: true }); // 首轮入库（并把计数清零）
      db.prepare("UPDATE sources SET consecutive_empty = 3 WHERE slug = 'hacker-news'").run();
      const r2 = await h.registry.fetchSource('hacker-news', R2.digest, { returnDetails: true });
      expect(r2.duplicates).toBe(1);
      expect(hnRow().consecutive_empty, 'Round 1.1 定案2：全重（dup-only）轮不算空轮 —— 源是活的，streak 不变；last_success_at 照刷的断言在 round1-1-bookkeeping 测试').toBe(3);
    });

    it('every attempt records last_attempt_at — empty fetch round included', async () => {
      const h = harness(db, { batches: {} }); // connector 返回空批次
      const r = await h.registry.fetchSource('hacker-news', R2.digest, { returnDetails: true });
      expect(r.inserted).toBe(0);
      const row = hnRow();
      expect(row.last_attempt_at, 'D4：无论成败每轮必写 last_attempt_at（037 已加列但当前无人写）').toBeTruthy();
      expect(sourceColumns(), 'D4 迁移必须新增 sources.consecutive_empty').toContain('consecutive_empty');
      db.prepare("UPDATE sources SET consecutive_empty = 2 WHERE slug = 'hacker-news'").run();
      await h.registry.fetchSource('hacker-news', R2.digest, { returnDetails: true });
      expect(hnRow().consecutive_empty, '空批次也算空轮').toBe(3);
    });

    it('a failed fetch round still records last_attempt_at', async () => {
      const h = harness(db, { batches: { 'hacker-news': new Error('upstream down') } });
      await expect(h.registry.fetchSource('hacker-news', R2.digest)).rejects.toThrow('upstream down');
      expect(hnRow().last_attempt_at, '失败轮也要记账（无论成败）').toBeTruthy();
    });
  });

  describe('D3 — duplicate stats in the fetch summary (⚠ connectors/index.js，跨文件)', () => {
    it('the fetch summary log line surfaces the duplicate count', async () => {
      db.prepare(
        'INSERT INTO information_items (id, source_id, canonical_url, title, digest_date, content_hash) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('pre-p', hnSourceId, 'https://example.com/p', 'P', R1.digest, 'hash-p'); // 预置昨日的行，制造跨天重复
      const h = harness(db, { batches: {
        'hacker-news': [{ title: 'P again', url: 'https://example.com/p', publishedAt: PUBLISHED_P }],
        'techmeme': [{ title: 'L', url: 'https://example.com/l', publishedAt: PUBLISHED_N }],
      } });
      const results = await h.registry.fetchAllSources(R2.digest);
      const bySource = Object.fromEntries(results.map(r => [r.source, r]));
      expect(bySource['hacker-news'].items, '全重复轮不得计入新条目').toBe(0);
      expect(bySource['techmeme'].items).toBe(1);
      const summary = h.logs.find(line => /Fetch summary/.test(line));
      expect(summary).toBeDefined();
      expect(summary, 'fetch summary 日志行必须并入 duplicate 统计（D3）').toMatch(/duplicat/i);
    });
  });
});
