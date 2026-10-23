// @vitest-environment node
/**
 * Round 1.1 · §7 Q2（CTO 裁决 A，2026-10-20）— markHealthy 必须清空
 * sources.last_error_class — 测试作者·Q1Q2（先 RED 后实现）
 *
 * 裁决：markHealthy 的 SET 补 ', last_error_class = NULL'（列探测门控不变）；
 * 测试覆盖「失败轮写入 error_class 后，下一成功轮清空」。
 *
 * 契约：error 轮（两条错误路径同罪：index.js recordFailedAttempt —— fetch 在
 * saveItems 之前抛错；base.js saveItems 事务 catch 的 recordFailedRound）写入
 * sources.last_error_class 后，紧接的一个成功轮（情形1 new-content，走
 * writeRoundBookkeeping 的 markHealthy 分支）必须把 last_error_class 清回
 * NULL，且 health_status='healthy'。
 *
 * 不清空的后果（语义动机）：evaluateHealth（source-health.js:101-103）只要
 * lastErrorClass 非空，源一旦超过 healthyLimit 就被打成 failing
 * （"…h since last success; last error …"）—— 一次历史故障会永远压制早已
 * 康复的源；「当前最后一个错误」与「健康」互斥，成功轮清空才是自洽簿记。
 *
 * 时间口径：与 base-saveitems-round1-1-bookkeeping.test.js 完全一致 ——
 * process.env.TZ='Asia/Shanghai'，now 钉死 2026-10-19T17:00:00Z（= 2026-10-20
 * 01:00 CST 日常轮时刻）；SQL 通道 db 代理把 datetime('now') 重写为钉死值、
 * JS 通道 vi.setSystemTime；两轮（error 轮 + 成功轮）发生在同一钉死时刻，
 * 断言不依赖真实时钟。
 *
 * GREEN 阶段实现落点（预期）：server/connectors/base.js —— markHealthy 的
 * prepared statement 改为 "UPDATE sources SET health_status = 'healthy',
 * last_error_class = NULL WHERE id = ?"；列探测门控 sourceColumns.has
 * ('health_status') 不变（缺列库照常静默跳过）；last_error_class 列 037
 * 已加，绝不新建迁移。
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
const R2_DIGEST = '2026-10-20';
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

describe('Round1.1 Q2 — a new-content round clears last_error_class (01:00 CST, TZ=Asia/Shanghai)', () => {
  let db;
  let hnSourceId;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO)); // 伪造 now = 2026-10-20 01:00 CST
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    loadMigrator(db).runMigrations(); // 全量迁移：037 的 last_error_class/health_status 列在内
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

  it('fetch-error round writes error_class; the very next new-content round clears it to NULL and regrades healthy', async () => {
    seedHealth({ health_status: 'unknown' }); // 从未成功过（last_* 全 NULL）
    // batches 传可变引用：同一 registry 上先后跑 error 轮与成功轮（紧邻两轮）
    const batches = {};
    const h = harness(db, { batches });

    // 第 1 轮：fetch 抛错 → index.js recordFailedAttempt（fetch 在 saveItems 之前）
    batches['hacker-news'] = Object.assign(new Error('upstream connection reset'), { code: 'ECONNRESET' });
    await expect(h.registry.fetchSource('hacker-news', R2_DIGEST)).rejects.toThrow('upstream connection reset');
    const afterError = hnRow();
    expect(afterError.last_error_class, '前置（Round 1.1 已实现）：失败轮按 err.code=ECONNRESET 归桶为 network').toBe('network');
    expect(afterError.health_status, '前置（Round 1.1 已实现）：失败轮 failing').toBe('failing');

    // 第 2 轮（紧接）：抓到 1 条当日新内容 → 情形1 new-content，走 markHealthy
    batches['hacker-news'] = [
      { title: 'Recovered', url: 'https://example.com/q2-recovered', publishedAt: PUBLISHED_N, score: 1 },
    ];
    const r2 = await h.registry.fetchSource('hacker-news', R2_DIGEST, { returnDetails: true });
    expect(r2.inserted, '前置：下一轮是 new-content（情形1）').toBe(1);

    const row = hnRow();
    expect(row.last_error_class, 'Q2：成功轮必须把 last_error_class 清回 NULL（当前 8e9f068 的 markHealthy 只写 health_status，error_class 残留 → evaluateHealth 的 lastErrorClass 分支会永远压制已康复的源）').toBe(null);
    expect(row.health_status, 'Q2：成功轮 → healthy').toBe('healthy');
    expect(row.last_success_at, '前置（Round 1.1 已实现）：成功轮刷 last_success_at').toBe(NOW_SQL);
  });

  it('saveItems transaction-failure round then new-content round: same clearing contract', async () => {
    seedHealth({ health_status: 'unknown' });
    // 第 1 轮：registerEvent 在事务内抛错 → base.js saveItems 事务 catch
    //（recordFailedRound —— 与 recordFailedAttempt 同罪的另一条错误路径）
    const doomed = harness(db, {
      outboxThrows: true,
      batches: { 'hacker-news': [
        { title: 'Fresh but doomed', url: 'https://example.com/q2-doomed', publishedAt: PUBLISHED_N, score: 1 },
      ] },
    });
    const r1 = await doomed.registry.fetchSource('hacker-news', R2_DIGEST, { returnDetails: true });
    expect(r1.inserted).toBe(0);
    expect(r1.error, '前置：saveItems 吞掉事务错误 → details.error（证明确实走了 catch 路径）').toBeTruthy();
    const afterError = hnRow();
    expect(typeof afterError.last_error_class, '前置（Round 1.1 已实现）：事务失败轮同样记录 error_class').toBe('string');
    expect(afterError.last_error_class.length > 0).toBe(true);
    expect(afterError.health_status, '前置（Round 1.1 已实现）：事务失败轮 failing').toBe('failing');

    // 第 2 轮（紧接）：干净 harness（outbox 正常）跑 new-content 轮
    const healed = harness(db, { batches: { 'hacker-news': [
      { title: 'Recovered', url: 'https://example.com/q2-recovered-2', publishedAt: PUBLISHED_N, score: 1 },
    ] } });
    const r2 = await healed.registry.fetchSource('hacker-news', R2_DIGEST, { returnDetails: true });
    expect(r2.inserted, '前置：下一轮是 new-content（情形1）').toBe(1);

    const row = hnRow();
    expect(row.last_error_class, 'Q2（base.js catch 变体）：无论 error_class 由哪条错误路径写入，成功轮都要清回 NULL').toBe(null);
    expect(row.health_status, 'Q2：成功轮 → healthy').toBe('healthy');
  });
});
