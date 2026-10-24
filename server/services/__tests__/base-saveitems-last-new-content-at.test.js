// @vitest-environment node
/**
 * Round 1.1 · §7 Q1（CTO 裁决 A，2026-10-20）— sources.last_new_content_at
 * 戳记契约 — 测试作者·Q1Q2（先 RED 后实现）
 *
 * 裁决：补 stampNewContent —— 只在情形 1（saved>0 或 existing>0）的轮次写
 * sources.last_new_content_at；dup-only 轮不写（保持 NULL/旧值）；empty 轮、
 * error 轮同样不写。
 *
 * 为什么这列必须有运行时写入者（语义动机）：source-health.js evaluateHealth
 * 的 "success/content" = latestOf(last_success_at, last_new_content_at)
 * （source-health.js:82）。Round 1.1 起 dup-only 轮也刷 last_success_at（源是
 * 活的）,于是「最近一次真正产出新内容」只能由 last_new_content_at 单独表达；
 * 当前 8e9f068 运行时零写入者（base.js saveItems 的列探测只准备了
 * attempt/success/error_class/health/streak 五条语句），该列是 037 一次性
 * 回填后的冻结死数据 —— 与 Round 1.1 修复前 last_success_at 的病灶同构。
 *
 * 时间口径：与 base-saveitems-round1-1-bookkeeping.test.js 完全一致 ——
 * process.env.TZ='Asia/Shanghai'，now 钉死 2026-10-19T17:00:00Z（= 2026-10-20
 * 01:00 CST 日常轮时刻）；SQL 通道 db 代理把 datetime('now') 重写为钉死值、
 * JS 通道 vi.setSystemTime，实现侧无论走哪条路写出的值都必须等于 SQLite
 * UTC canonical 格式 '2026-10-19 17:00:00'（037 的健康回填 CASE 用的是与
 * datetime('now') 的字符串比较，非该格式会静默误判）。
 *
 * GREEN 阶段实现落点（预期）：server/connectors/base.js —— 在
 * writeRoundBookkeeping 的 roundKind==='new-content' 分支（hasOutput =
 * saved.length>0 || details.existing>0 的分派已在 base.js 现行代码里）补
 * stampNewContent 语句，列探测门控风格与既有五条语句一致（缺列库静默跳过、
 * 绝不新建迁移，037 已有列）；dup-only/empty/error 轮不触及该列。
 */
process.env.TZ = 'Asia/Shanghai';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');
const utils = require('../utils');
const { describe, it, expect, beforeEach, afterEach, vi } = globalThis;

/* ---------- 钉死的时间轴（坐标系与 base-saveitems-round1-1-bookkeeping.test.js 一致） ---------- */
const NOW_ISO = '2026-10-19T17:00:00Z'; // = 2026-10-20 01:00 Asia/Shanghai（R2 轮次时刻）
const NOW_SQL = '2026-10-19 17:00:00';  // SQLite canonical UTC（datetime('now') 的产物格式）
const STALE_SUCCESS = '2026-08-01 17:00:20'; // 生产实测冻结值：last_new_content_at 的 037 回填快照
const R1_DIGEST = '2026-10-19';
const R2_DIGEST = '2026-10-20';
const PUBLISHED_P = '2026-10-18T10:00:00Z'; // 跨天 duplicate 素材（R1 已入库）
const PUBLISHED_N = '2026-10-19T09:00:00Z'; // 当日新条目

/* ---------- 用真实迁移 runner 建全新 schema（037 健康列即来自真实迁移） ---------- */
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

/* ---------- SQL 时钟注入：prepare() 里的 datetime('now') 一律重写为钉死值 ---------- */
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

/* ---------- vm harness（模式照 base-saveitems-round1-1-bookkeeping.test.js）---------- */
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

describe('Round1.1 Q1 — last_new_content_at stamped only on case-1 rounds (01:00 CST, TZ=Asia/Shanghai)', () => {
  let db;
  let hnSourceId;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO)); // 伪造 now = 2026-10-20 01:00 CST
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    loadMigrator(db).runMigrations(); // 全量迁移：037 的 last_new_content_at 列在内
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

  const hnRow = () => db.prepare("SELECT * FROM sources WHERE slug = 'hacker-news'").get();
  // 把 sources 行预置成任意起点（未给的字段清回 NULL/默认值）
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

  describe('情形1 — productive round stamps last_new_content_at', () => {
    it('saved>0 (fresh insert): stamps last_new_content_at to the round clock', async () => {
      // 起点 = 事故现场：last_new_content_at 冻结在 037 回填快照，本轮有 1 条新产出
      seedHealth({
        last_attempt_at: STALE_SUCCESS,
        last_success_at: STALE_SUCCESS,
        last_new_content_at: STALE_SUCCESS,
        last_fetched_at: STALE_SUCCESS,
        health_status: 'failing',
      });
      const h = harness(db, { batches: { 'hacker-news': [
        { title: 'Fresh Q1', url: 'https://example.com/q1-fresh', publishedAt: PUBLISHED_N, score: 1 },
      ] } });
      const r = await h.registry.fetchSource('hacker-news', R2_DIGEST, { returnDetails: true });
      expect(r.inserted, '前置：确实落了 1 条新行（saved>0 → 情形1）').toBe(1);

      const row = hnRow();
      expect(row.last_new_content_at, `Q1 情形1（saved>0）：必须把 last_new_content_at 刷新到本轮时刻（SQLite UTC 口径，钉死时钟下的期望值 ${NOW_SQL}；当前 8e9f068 运行时零写入者，该列仍是 037 回填冻结值）`).toBe(NOW_SQL);
    });

    it('existing>0 (same-day re-run, zero fresh inserts): still a case-1 round, stamps last_new_content_at', async () => {
      // 同日重跑：URL 已以相同 digest_date 入库，UNIQUE(source_id, canonical_url,
      // digest_date)（001_initial_schema.sql:47）令 INSERT OR IGNORE 落空 →
      // details.existing=1、inserted=0；base.js 的 hasOutput 分派
      // （saved.length>0 || details.existing>0）把它归入情形1。
      presetItem('pre-q1-same-day', 'https://example.com/q1-same-day', R2_DIGEST);
      seedHealth({
        last_attempt_at: STALE_SUCCESS,
        last_success_at: STALE_SUCCESS,
        last_new_content_at: STALE_SUCCESS,
        last_fetched_at: STALE_SUCCESS,
        health_status: 'failing',
      });
      const h = harness(db, { batches: { 'hacker-news': [
        { title: 'Same-day rerun', url: 'https://example.com/q1-same-day', publishedAt: PUBLISHED_N, score: 1 },
      ] } });
      const r = await h.registry.fetchSource('hacker-news', R2_DIGEST, { returnDetails: true });
      expect(r.inserted, '前置：同日重跑没有新行').toBe(0);
      expect(r.existing, '前置：UNIQUE 拦下 → existing=1（hasOutput 仍为 true → 情形1）').toBe(1);
      expect(r.duplicates, '前置：不是跨天 duplicates').toBe(0);

      const row = hnRow();
      expect(row.last_new_content_at, `Q1 情形1（existing>0 变体，CTO 裁决把 existing-only 归情形1）：existing 轮同样是产出轮，必须刷 last_new_content_at 到 ${NOW_SQL}`).toBe(NOW_SQL);
    });
  });

  describe('情形2 — dup-only round does NOT stamp', () => {
    it('all items cross-day deduped: last_new_content_at keeps its old value untouched', async () => {
      // 昨日(R1)已入库的 URL 在 R2 轮整批再现 → 全为跨天 duplicates（dup-only）。
      // last_success_at 照刷（Round 1.1 定案2，源是活的），但「新内容」并没有
      // 发生 —— last_new_content_at 必须纹丝不动，否则该列退化成第二个
      // last_success_at，latestOf 语义（source-health.js:82）失去信息量。
      presetItem('pre-q1-dup', 'https://example.com/q1-dup', R1_DIGEST);
      seedHealth({
        consecutive_empty: 2,
        last_attempt_at: STALE_SUCCESS,
        last_success_at: STALE_SUCCESS,
        last_new_content_at: STALE_SUCCESS,
        last_fetched_at: STALE_SUCCESS,
        health_status: 'stale',
      });
      const h = harness(db, { batches: { 'hacker-news': [
        { title: 'Dup again', url: 'https://example.com/q1-dup', publishedAt: PUBLISHED_P },
      ] } });
      const r = await h.registry.fetchSource('hacker-news', R2_DIGEST, { returnDetails: true });
      expect(r.duplicates, '前置：整批确为跨天 duplicates（dup-only）').toBe(1);
      expect(r.inserted).toBe(0);
      expect(r.existing).toBe(0);

      const row = hnRow();
      expect(row.last_success_at, '前置（Round 1.1 已实现）：dup-only 轮 last_success_at 照样刷新（对照：新内容戳不得跟着刷）').toBe(NOW_SQL);
      expect(row.last_new_content_at, 'Q1 情形2：dup-only 不写 last_new_content_at —— 必须保持旧值（不得刷新到本轮时刻）').toBe(STALE_SUCCESS);
    });
  });

  describe('情形3 — empty round does NOT stamp', () => {
    it('zero items fetched: last_new_content_at untouched', async () => {
      seedHealth({
        consecutive_empty: 2,
        last_attempt_at: STALE_SUCCESS,
        last_success_at: STALE_SUCCESS,
        last_new_content_at: STALE_SUCCESS,
        health_status: 'stale',
      });
      const h = harness(db, { batches: {} }); // connector fetch 返回空批次
      const r = await h.registry.fetchSource('hacker-news', R2_DIGEST, { returnDetails: true });
      expect(r.inserted).toBe(0);
      expect(r.duplicates).toBe(0);
      expect(r.existing).toBe(0);

      const row = hnRow();
      expect(row.last_new_content_at, 'Q1 情形3：空轮（0 条目、0 重复）不写 last_new_content_at').toBe(STALE_SUCCESS);
    });
  });

  describe('情形4 — error rounds do NOT stamp', () => {
    it('fetch error (index.js recordFailedAttempt path): error ledger written, last_new_content_at untouched', async () => {
      seedHealth({ last_new_content_at: STALE_SUCCESS });
      const upstreamErr = Object.assign(new Error('upstream connection reset'), { code: 'ECONNRESET' });
      const h = harness(db, { batches: { 'hacker-news': upstreamErr } });
      await expect(h.registry.fetchSource('hacker-news', R2_DIGEST)).rejects.toThrow('upstream connection reset');

      const row = hnRow();
      expect(row.last_error_class, '前置（Round 1.1 已实现）：失败轮按 err.code 归桶记录 error_class').toBe('network');
      expect(row.health_status, '前置（Round 1.1 已实现）：失败轮 failing').toBe('failing');
      expect(row.last_new_content_at, 'Q1 情形4：异常轮不写 last_new_content_at（既无新内容也不算成功轮）').toBe(STALE_SUCCESS);
    });

    it('saveItems transaction failure (base.js catch path): last_new_content_at untouched', async () => {
      seedHealth({ last_new_content_at: STALE_SUCCESS });
      const h = harness(db, {
        outboxThrows: true, // registerEvent 在事务内抛错 → saveItems 事务 catch
        batches: { 'hacker-news': [
          { title: 'Fresh but doomed', url: 'https://example.com/q1-doomed', publishedAt: PUBLISHED_N, score: 1 },
        ] },
      });
      const r = await h.registry.fetchSource('hacker-news', R2_DIGEST, { returnDetails: true });
      expect(r.inserted).toBe(0);
      expect(r.error, '前置：saveItems 吞掉事务错误 → details.error（证明确实走了 catch 路径）').toBeTruthy();

      const row = hnRow();
      expect(typeof row.last_error_class, '前置（Round 1.1 已实现）：事务失败轮同样记录 error_class').toBe('string');
      expect(row.last_new_content_at, 'Q1 情形4（base.js catch 变体）：事务失败轮不写 last_new_content_at').toBe(STALE_SUCCESS);
    });
  });
});
