// @vitest-environment node
/**
 * Round 1.1 · 源健康簿记语义测试（四情形定案）— 测试作者·簿记语义
 *
 * 语义定案（CTO 20:30 只读核验后拍板，本文件是修复实现的唯一契约）：
 *  1) 抓取成功且有新条目：consecutive_empty 清零、last_success_at 刷新、
 *     health_status='healthy'；
 *  2) 抓取成功但全部条目被去重拦下（dup-only，含跨天 duplicates）：不算空轮
 *     ——源是活的，last_success_at 照样刷新，consecutive_empty 不变；
 *  3) 抓取成功、0 个条目（连重复都没有）：consecutive_empty +1；
 *  4) 抓取异常：记录 sources.last_error_class（037 已加列，勿新建迁移）并置
 *     health_status='failing'；异常轮不属于情形 3 的空轮，consecutive_empty
 *     不动。两条错误路径同罪：index.js recordFailedAttempt（fetch 在 saveItems
 *     之前抛错）与 base.js saveItems 事务 catch。
 *
 * 生产事故回放（种子值取自生产实测）：
 *  - lobsters(+24)/solidot(+11)：last_success_at 冻结在 2026-08-01 17:00:20，
 *    今日 16:00 CST 有产出却仍 'failing'（情形 1 的 last_success_at 刷新与
 *    health 重算调用双双缺失，health_status 是 09-18 迁移 037 的冻结快照）；
 *  - hacker-news(+21)/techmeme(+15)：验证员同源二次抓取、第二批全为跨天
 *    duplicates（16:01 CST 探针 job duplicates=21/5），被旧语义记成空轮
 *    consecutive_empty+1（情形 2 被违反）。
 *
 * ⚠ 与既有断言的冲突（修复者必须处理）：base-saveitems-dedup-health.test.js
 *   中「an all-duplicate round counts as an empty round (consecutive_empty +1)」
 *   固化的是旧语义，与本文件情形 2 相互排斥 —— GREEN 阶段应翻转那条旧断言
 *   （及 041 头注释），以本文件的定案为准。
 *
 * 时间口径：process.env.TZ='Asia/Shanghai'，now 钉死为 2026-10-19T17:00:00Z
 * （= 2026-10-20 01:00 CST 日常轮时刻），断言不依赖真实时钟。伪造时钟双通道
 * 注入，实现侧无论用 SQL datetime('now') 还是 JS new Date()，写出的健康列
 * 时间戳都必须等于 '2026-10-19 17:00:00'（sources 健康列的既定口径是 SQLite
 * UTC canonical 格式；037 的健康回填 CASE 用的正是与 datetime('now') 的字符串
 * 比较，非该格式会静默误判）：
 *  - JS 通道：vm context 注入外层（被 vi.setSystemTime 钉死的）Date；
 *  - SQL 通道：db 代理把 prepare() 里的 datetime('now') 重写为
 *    datetime('2026-10-19 17:00:00')（better-sqlite3 的 datetime('now') 走
 *    真实时钟，vitest 假时钟管不到它）。
 *
 * GREEN 阶段实现落点（诊断已确认：运行时无任何 last_success_at / health_status
 * 写入者）：
 *  - server/connectors/base.js —— saveItems 正常轮（含 dup-only）：刷新
 *    last_success_at；事务 catch：记 last_error_class + failing；
 *  - server/connectors/index.js —— recordFailedAttempt：按 err.name/err.code
 *    归桶写 last_error_class + failing，并把 consecutive_empty+1 从错误路径
 *    移除（定案 3/4 分离）；
 *  - 绝不新建迁移：last_error_class 列 037 已加（对已应用 037 的库再 ALTER
 *    会 duplicate column 中止启动）。
 */
process.env.TZ = 'Asia/Shanghai';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');
const utils = require('../utils');
const { describe, it, expect, beforeEach, afterEach, vi } = globalThis;

/* ---------- 钉死的时间轴（坐标系与 base-saveitems-dedup-health.test.js 一致） ---------- */
const NOW_ISO = '2026-10-19T17:00:00Z'; // = 2026-10-20 01:00 Asia/Shanghai（R2 轮次时刻）
const NOW_SQL = '2026-10-19 17:00:00';  // SQLite canonical UTC（datetime('now') 的产物格式）
const STALE_SUCCESS = '2026-08-01 17:00:20'; // 生产实测：lobsters/solidot last_success_at 冻结值
const R1_DIGEST = '2026-10-19';
const R2_DIGEST = '2026-10-20';
const PUBLISHED_P = '2026-10-18T10:00:00Z'; // R1 时 now−7h；R2 复现时 31h（跨天 duplicate 素材）
const PUBLISHED_N = '2026-10-19T09:00:00Z'; // NOW−8h 的当日新条目

/* ---------- 用真实迁移 runner 建全新 schema（037/041 健康列即来自真实迁移） ---------- */
function loadMigrator(rawDb) {
  const filename = path.resolve(__dirname, '../../db/migrate.js');
  const target = { exports: {} };
  const context = {
    module: target,
    exports: target.exports,
    __dirname: path.dirname(filename),
    __filename: filename,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === './connection') return { getDB: () => rawDb };
      return require(name); // fs / path 等 builtins
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return target.exports;
}

/* ---------- SQL 时钟注入：prepare() 里的 datetime('now') 一律重写为钉死值 ----------
 * better-sqlite3 的 datetime('now') 取真实系统时钟，vitest 假时钟无法影响；
 * 健康簿记的既有写法（base.js:102/:174、index.js:66）全部经由 db.prepare，
 * 在这里统一改写后，SQL 路线与 JS 路线（vi.setSystemTime）写出的值相同。 */
const DATETIME_NOW_RE = /datetime\(\s*(['"])now\1\s*\)/g;
function fakeClockDb(rawDb) {
  return new Proxy(rawDb, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql) => target.prepare(String(sql).replace(DATETIME_NOW_RE, `datetime('${NOW_SQL}')`));
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/* ---------- vm harness（模式照 base-saveitems-dedup-health.test.js）----------
 * 与原版的差异（本文件所需）：
 *  - getDB 返回 fakeClockDb 包装后的 db（SQL 时钟注入）；
 *  - context 额外注入外层 Date（被 vi.setSystemTime 钉死；vm 自带 Date 是真时钟）；
 *  - require 映射新增 '../services/source-health'（GREEN 阶段 base/index 可能
 *    import 它做 recomputeSourceHealth）；
 *  - options.outboxThrows：把 registerEvent 换成抛错 stub，驱动 saveItems
 *    事务失败路径（情形 4 的 base.js catch）。 */
function harness(rawDb, options = {}) {
  const db = fakeClockDb(rawDb);
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
      Date: globalThis.Date, // 钉死的假时钟（vi.setSystemTime）
      process: { env: {} },
      require(name) {
        if (name === '../db/connection') return { getDB: () => db };
        if (name === '../services/utils') return utils;
        if (name === '../services/date-contract') return require('../date-contract');
        if (name === '../services/x-following-config') return { readBlocklist: () => new Set(), isBlocked: () => false };
        if (name === '../services/outbox') {
          return options.outboxThrows
            ? { registerEvent() { throw new Error('outbox write failed'); } }
            : require('../outbox');
        }
        if (name === '../services/source-health') return require('../source-health');
        if (name === './base') return load('connectors/base.js');
        if (relativePath === 'connectors/index.js' && name.startsWith('./')) {
          // 注册表里的 connector 全部映射到可编程 ScriptedConnector：
          // saveItems/getSourceId/normalize 继承真实 BaseConnector（被测代码），
          // 只有 fetch 是假的（批次可控 / 可抛错），digest_date 取本轮传入日期。
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

describe('Round1.1 source round bookkeeping semantics (01:00 CST, TZ=Asia/Shanghai)', () => {
  let db;
  let hnSourceId;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO)); // 伪造 now = 2026-10-20 01:00 CST
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    loadMigrator(db).runMigrations(); // 全量迁移：037 健康列 + 041 consecutive_empty 都在
    const existing = db.prepare('SELECT id FROM sources WHERE slug = ?').get('hacker-news');
    if (existing) {
      db.prepare('UPDATE sources SET is_active = 1 WHERE slug = ?').run('hacker-news');
      hnSourceId = existing.id;
    } else {
      hnSourceId = 'src-hacker-news';
      db.prepare('INSERT INTO sources (id, slug, label, is_active) VALUES (?, ?, ?, 1)').run(hnSourceId, 'hacker-news', 'hacker-news');
    }
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  const sourceColumns = () => db.pragma('table_info(sources)').map(c => c.name);
  const hnRow = () => db.prepare("SELECT * FROM sources WHERE slug = 'hacker-news'").get();
  // 把 sources 行预置成事故现场的任意组合（未给的字段清回 NULL/默认值）
  const seedHealth = (fields = {}) => db.prepare(`
    UPDATE sources SET
      last_attempt_at = ?, last_success_at = ?, last_new_content_at = ?,
      last_error_class = ?, health_status = ?, consecutive_empty = ?, last_fetched_at = ?
    WHERE slug = 'hacker-news'
  `).run(
    fields.last_attempt_at ?? null,
    fields.last_success_at ?? null,
    fields.last_new_content_at ?? null,
    fields.last_error_class ?? null,
    fields.health_status ?? 'unknown',
    fields.consecutive_empty ?? 0,
    fields.last_fetched_at ?? null,
  );
  const presetItem = (id, url, digest) => db.prepare(
    'INSERT INTO information_items (id, source_id, canonical_url, title, digest_date, content_hash) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, hnSourceId, url, id, digest, `hash-${id}`);

  it('schema ground truth: health columns exist via real migrations (037+041), no new migration needed', () => {
    for (const col of ['last_attempt_at', 'last_success_at', 'last_new_content_at', 'last_error_class', 'health_status', 'consecutive_empty']) {
      expect(sourceColumns(), `迁移必须已提供 sources.${col}（Round 1.1 禁止新建迁移）`).toContain(col);
    }
  });

  describe('情形1 — productive round (new items)', () => {
    it('resets consecutive_empty, refreshes last_success_at to the round clock, and regrades health_status to healthy', async () => {
      // 复盘 lobsters/solidot：failing + last_success_at 冻结 08-01，今日有 24/11 条新产出
      seedHealth({
        consecutive_empty: 3,
        last_attempt_at: STALE_SUCCESS,
        last_success_at: STALE_SUCCESS,
        last_new_content_at: STALE_SUCCESS,
        last_fetched_at: STALE_SUCCESS,
        health_status: 'failing',
      });
      const h = harness(db, { batches: { 'hacker-news': [
        { title: 'Fresh', url: 'https://example.com/fresh', publishedAt: PUBLISHED_N, score: 1 },
      ] } });
      const r = await h.registry.fetchSource('hacker-news', R2_DIGEST, { returnDetails: true });
      expect(r.inserted).toBe(1);

      const row = hnRow();
      expect(row.consecutive_empty, '情形1：有新条目必须清零').toBe(0);
      expect(row.last_success_at, `情形1：last_success_at 必须刷新到本轮时刻（SQLite UTC 口径，钉死时钟下的期望值 ${NOW_SQL}；当前生产 bug 是该字段自 037 回填后无人再写）`).toBe(NOW_SQL);
      expect(row.health_status, "情形1：成功且有产出 → health_status='healthy'（当前生产 bug：recomputeSourceHealth 零调用，health 冻结在 09-18 快照）").toBe('healthy');
    });
  });

  describe('情形2 — dup-only round is NOT an empty round', () => {
    it('all items cross-day deduped: consecutive_empty unchanged AND last_success_at still refreshed', async () => {
      // 复盘 hacker-news 16:01 CST 探针：昨日(R1)已入库的 P 在 R2 轮整批再现，
      // 全为跨天 duplicates（saveItems details.duplicates>0、inserted=0、existing=0）
      presetItem('pre-r11-p', 'https://example.com/p', R1_DIGEST);
      seedHealth({
        consecutive_empty: 2,
        last_attempt_at: STALE_SUCCESS,
        last_success_at: STALE_SUCCESS,
        last_fetched_at: STALE_SUCCESS,
        health_status: 'stale',
      });
      const h = harness(db, { batches: { 'hacker-news': [
        { title: 'P again', url: 'https://example.com/p', publishedAt: PUBLISHED_P },
      ] } });
      const r = await h.registry.fetchSource('hacker-news', R2_DIGEST, { returnDetails: true });
      expect(r.duplicates, '前置：整批确为跨天 duplicates（dup-only）').toBe(1);
      expect(r.inserted).toBe(0);

      const row = hnRow();
      expect(row.last_attempt_at, '前置（现行行为，兼作 SQL 时钟注入金丝雀）：每轮必写 last_attempt_at').toBe(NOW_SQL);
      expect(row.consecutive_empty, '情形2：dup-only 不是空轮 —— consecutive_empty 不得 +1（现行代码违反：hasOutput 不计 duplicates，全重轮被当成空轮 +1，hacker-news/techmeme 的 streak=1 正是这么来的）').toBe(2);
      expect(row.last_success_at, '情形2：源是活的 —— dup-only 轮 last_success_at 照样刷新到本轮时刻').toBe(NOW_SQL);
    });
  });

  describe('情形3 — zero-item round (not even duplicates)', () => {
    it('increments consecutive_empty by exactly 1', async () => {
      seedHealth({
        consecutive_empty: 2,
        last_attempt_at: STALE_SUCCESS,
        last_success_at: STALE_SUCCESS,
        health_status: 'stale',
      });
      const h = harness(db, { batches: {} }); // connector fetch 返回空批次：0 条目、0 重复
      const r = await h.registry.fetchSource('hacker-news', R2_DIGEST, { returnDetails: true });
      expect(r.inserted).toBe(0);
      expect(r.duplicates).toBe(0);

      const row = hnRow();
      expect(row.last_attempt_at, '前置（现行行为）：空轮也必写 last_attempt_at').toBe(NOW_SQL);
      expect(row.consecutive_empty, '情形3：抓取成功但 0 条目（连重复都没有）才是空轮 → +1（守护断言：修情形2时不得把情形3一并放走）').toBe(3);
    });
  });

  describe('情形4 — fetch error round (index.js recordFailedAttempt path)', () => {
    it('records last_error_class, marks health failing, and leaves the empty streak alone', async () => {
      seedHealth({ consecutive_empty: 2, health_status: 'unknown' }); // 从未成功过（last_* 全 NULL）
      const h = harness(db, { batches: { 'hacker-news': new Error('upstream down') } });
      await expect(h.registry.fetchSource('hacker-news', R2_DIGEST)).rejects.toThrow('upstream down');

      const row = hnRow();
      expect(row.last_attempt_at, '前置（现行行为）：失败轮也要记账 last_attempt_at').toBe(NOW_SQL);
      expect(typeof row.last_error_class, '情形4：抓取异常必须归桶记录 sources.last_error_class（037 列已在，禁止新建迁移；现行生产 18 行全 NULL 因为无人写它）').toBe('string');
      expect(row.last_error_class.length > 0, '情形4：last_error_class 不得是空串').toBe(true);
      expect(row.health_status, "情形4：异常轮 → health_status='failing'").toBe('failing');
      expect(row.consecutive_empty, '情形4：异常不是空轮 —— consecutive_empty 不得 +1（定案3/4 必须分离；现行 index.js recordFailedAttempt 把异常轮也 +1）').toBe(2);
    });
  });

  describe('情形4 — saveItems transaction failure round (base.js catch path)', () => {
    it('a mid-transaction failure records last_error_class + failing, streak untouched', async () => {
      seedHealth({ consecutive_empty: 2, health_status: 'unknown' });
      const h = harness(db, {
        outboxThrows: true, // registerEvent 在事务内抛错 → saveItems 事务 catch（base.js:329-342）
        batches: { 'hacker-news': [
          { title: 'Fresh but doomed', url: 'https://example.com/doomed', publishedAt: PUBLISHED_N },
        ] },
      });
      const r = await h.registry.fetchSource('hacker-news', R2_DIGEST, { returnDetails: true });
      expect(r.inserted).toBe(0);
      expect(r.error, '前置：saveItems 吞掉事务错误 → details.error（证明确实走了 catch 路径）').toBeTruthy();

      const row = hnRow();
      expect(row.last_attempt_at, '前置（现行行为）：事务失败轮也必写 last_attempt_at').toBe(NOW_SQL);
      expect(row.consecutive_empty, '前置（现行行为）：事务失败轮不动 streak（maintainStreak:false）').toBe(2);
      expect(typeof row.last_error_class, '情形4：事务 catch 同样必须记录 last_error_class').toBe('string');
      expect(row.health_status, "情形4：事务失败轮 → health_status='failing'").toBe('failing');
    });
  });
});
