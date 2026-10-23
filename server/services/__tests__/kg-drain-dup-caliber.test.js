// @vitest-environment node
/**
 * R3.0 跨天重复治理 — RED 规格: drainer 侧积压口径切换到「非 dup 行」
 * （BACKLOG_REAL 口径）。
 *
 * 背景（2026-10-21, worktree round3-convergence @ 1b8bc3f）: CTO 实测
 * 10-19 入库 4,419 条中 3,638 条（82%）是跨天重插; 全库 32,446 行 dup。
 * 方案 = information_items.duplicate_of TEXT NULL 软标记（回填后 dup 行
 * 指向组内首行 id），积压口径一律排除 duplicate_of IS NOT NULL。
 *
 * 本文件钉的契约 — 两个 drainer 侧的「真默认」积压计数（不是注入的
 * mock，而是各自文件里的 default* 函数）必须排除 dup 行:
 *
 *   1. server/services/kg-drainer.js defaultReadBacklogFeatures
 *      （runKGDrain 的 catch-up 触发输入 backlog_features）:
 *        SELECT COUNT(*) ... WHERE NOT EXISTS (item_features 行)
 *      → 追加排除 duplicate_of IS NOT NULL。
 *      行为断言经公共 API runKGDrain 观察（结果里的 backlogFeatures 与
 *      mode 判定）: 真实积压 300（≤500）+ 5,000 条 dup 缺 features →
 *      mode 'steady'、backlogFeatures === 300（今天: 5,300 → 'catchup'）。
 *      反向钉: 真实积压 501 仍能触发 'catchup' — 排除 dup 不是关掉
 *      catch-up，只是不再被重复行虚抬。
 *
 *   2. scripts/kg-drain.js defaultCountBacklog（timer 火花的 200 条火线）:
 *        NOT EXISTS (item_features) OR NOT EXISTS (semantic-hash 向量)
 *      → 同样排除 dup。行为断言经 main({ fireDrainJob }) 观察: 真实积压
 *      150（<200）+ 3,000 条 dup 缺行 → { skipped: 'backlog-below-threshold',
 *      backlog: 150 }，fireDrainJob 不被调用（今天: 3,150 ≥ 200 → 开火）。
 *
 * 实现约定: fixture DB 通过 EAGLEYE_DB_PATH 注入（server/config.js
 * getDBPath 的既有 env 钩子），两个 default 都经真实 config 解析路径 —
 * 不做模块手术。绝不触生产库。
 *
 * RED 门:
 *   export PATH=/home/user/.local/bin:$PATH &&
 *   npx vitest run server/services/__tests__/kg-drain-dup-caliber.test.js
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const DRAINER_PATH = path.resolve(import.meta.dirname, '../kg-drainer.js');
const FIRE_SCRIPT_PATH = path.resolve(import.meta.dirname, '../../../scripts/kg-drain.js');

/**
 * 编译被测模块。相对依赖里只有 config 走真模块（default* 计数需要真实的
 * getDBPath → EAGLEYE_DB_PATH）；其余相对 require 一律返回空 stub（kg-drainer
 * 的 stage runners / kg-drain 的 jobs 都是惰性 require，测试全部注入）。
 */
function compileSubject(filename, configSpecifier) {
  const subject = new Module(filename, module);
  subject.filename = filename;
  subject.require = id => {
    if (id === configSpecifier) return require('../../config');
    if (id.startsWith('.')) return {};
    return require(id);
  };
  subject._compile(fs.readFileSync(filename, 'utf8'), filename);
  return subject.exports;
}

/**
 * fixture 库: active/inactive sources + duplicate_of 列 + done 表最小 schema。
 * healthy 行 = active 来源、features、当前模型 hash/lite 向量与 dynamic topic
 * 齐备（各口径都不计）; pending 行 = 全缺; dup 行 = 全缺且带软标记。
 */
function buildCaliberDb({
  healthy = 0,
  realPending = 0,
  topicOnlyPending = 0,
  dupPending = 0,
  inactivePending = 0,
  staleHashOnly = 0,
} = {}) {
  const tmpdir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'kg-dup-caliber-')));
  const dbPath = path.join(tmpdir, 'fixture.db');
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE information_items (id INTEGER PRIMARY KEY, source_id TEXT, duplicate_of TEXT);
    CREATE TABLE sources (id TEXT PRIMARY KEY, slug TEXT, is_active INTEGER);
    CREATE TABLE item_features (item_id INTEGER PRIMARY KEY);
    CREATE TABLE item_vectors (item_id INTEGER, vector_type TEXT, model_name TEXT);
    CREATE TABLE item_topic_assignments (item_id INTEGER, topic_kind TEXT);
  `);
  const insertSource = db.prepare('INSERT INTO sources VALUES (?, ?, ?)');
  insertSource.run('active-source', 'active-source', 1);
  insertSource.run('inactive-source', 'inactive-source', 0);
  let id = 0;
  const insertItem = db.prepare('INSERT INTO information_items VALUES (?, ?, ?)');
  const insertFeature = db.prepare('INSERT INTO item_features VALUES (?)');
  const insertVector = db.prepare("INSERT INTO item_vectors VALUES (?, 'semantic-hash', 'eagleye-hash-v1')");
  const insertLiteVector = db.prepare("INSERT INTO item_vectors VALUES (?, 'semantic-lite', 'eagleye-hash-v1')");
  const insertStaleHash = db.prepare("INSERT INTO item_vectors VALUES (?, 'semantic-hash', 'eagleye-hash-v0')");
  const insertDynamicTopic = db.prepare("INSERT INTO item_topic_assignments VALUES (?, 'dynamic')");
  db.transaction(() => {
    for (let i = 0; i < healthy; i++) {
      id += 1; insertItem.run(id, 'active-source', null); insertFeature.run(id); insertVector.run(id);
      insertLiteVector.run(id); insertDynamicTopic.run(id);
    }
    for (let i = 0; i < realPending; i++) {
      id += 1; insertItem.run(id, 'active-source', null);
    }
    for (let i = 0; i < topicOnlyPending; i++) {
      id += 1; insertItem.run(id, 'active-source', null); insertFeature.run(id); insertVector.run(id);
      insertLiteVector.run(id); // has the lite vector, but no dynamic assignment
    }
    for (let i = 0; i < dupPending; i++) {
      id += 1; insertItem.run(id, 'active-source', 'first-row-id'); // 回填语义: dup 行指向组内首行
    }
    for (let i = 0; i < inactivePending; i++) {
      id += 1; insertItem.run(id, 'inactive-source', null); // fair_items can never select this source
    }
    for (let i = 0; i < staleHashOnly; i++) {
      id += 1; insertItem.run(id, 'active-source', null);
      insertFeature.run(id); insertLiteVector.run(id); insertDynamicTopic.run(id);
      insertStaleHash.run(id); // semantic-hash is live-model-aware, so this stays pending
    }
  })();
  db.close();
  return { dbPath, tmpdir };
}

function loadavgFile(load1) {
  const tmpdir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'kg-dup-loadavg-')));
  const file = path.join(tmpdir, 'loadavg');
  fs.writeFileSync(file, `${load1} 0.58 1.12 1/936 2952339\n`);
  return file;
}

const tmpdirs = [];
function track(dir) { tmpdirs.push(dir); return dir; }

let savedDbPath;
let savedDrainer;

beforeEach(() => {
  savedDbPath = process.env.EAGLEYE_DB_PATH;
  savedDrainer = process.env.EAGLEYE_R3_DRAINER;
  process.env.EAGLEYE_R3_DRAINER = '1';
});

describe('R3.1 audit — backlog counts only fair_items-drainable rows', () => {
  it('inactive-source rows never trip the timer fire threshold', async () => {
    const { dbPath } = buildCaliberDb({ healthy: 10, inactivePending: 3000 });
    process.env.EAGLEYE_DB_PATH = dbPath;
    const script = compileSubject(FIRE_SCRIPT_PATH, '../server/config');
    const fireDrainJob = vi.fn(async () => ({ job_id: 'inactive-job' }));
    const result = await script.main({ fireDrainJob });
    expect(result).toEqual({ skipped: 'backlog-below-threshold', backlog: 0 });
    expect(fireDrainJob).not.toHaveBeenCalled();
  });

  it('both drainer default counts exclude inactive sources', async () => {
    const { dbPath } = buildCaliberDb({ healthy: 10, inactivePending: 501 });
    process.env.EAGLEYE_DB_PATH = dbPath;
    const drainer = compileSubject(DRAINER_PATH, '../config');
    const result = await drainer.runKGDrain(drainerDeps());
    expect(result.backlogFeatures).toBe(0);
    expect(result.backlogTopics).toBe(0);
    expect(result.mode).toBe('steady');
  });

  it('a semantic-hash row for a retired model still counts as backlog', async () => {
    const { dbPath } = buildCaliberDb({ healthy: 10, staleHashOnly: 200 });
    process.env.EAGLEYE_DB_PATH = dbPath;
    const script = compileSubject(FIRE_SCRIPT_PATH, '../server/config');
    const fireDrainJob = vi.fn(async () => ({ job_id: 'stale-hash-job' }));
    const result = await script.main({ fireDrainJob });
    expect(result).toEqual({ fired: true, job_id: 'stale-hash-job' });
    expect(fireDrainJob).toHaveBeenCalledWith({ idleWindow: expect.any(Boolean) });
  });
});

afterEach(() => {
  if (savedDbPath === undefined) delete process.env.EAGLEYE_DB_PATH;
  else process.env.EAGLEYE_DB_PATH = savedDbPath;
  if (savedDrainer === undefined) delete process.env.EAGLEYE_R3_DRAINER;
  else process.env.EAGLEYE_R3_DRAINER = savedDrainer;
  vi.restoreAllMocks();
  while (tmpdirs.length) fs.rmSync(tmpdirs.pop(), { recursive: true, force: true });
});

/** runKGDrain 的其余输入全注入: 房间空闲、低载、无历史采样、锁直通、stage 全 mock。 */
function drainerDeps() {
  return {
    readSalon9Count: vi.fn(async () => 0),
    readPreviousLoad1: vi.fn(async () => null),
    loadavgPath: loadavgFile('1.20'),
    acquireLock: vi.fn(async () => vi.fn(async () => {})),
    runExtract: vi.fn(async () => ({ processed: 0 })),
    runEmbed: vi.fn(async () => ({ processed: 0 })),
    runTopics: vi.fn(async () => ({ processed: 0 })),
  };
}

describe('R3.0 — kg-drainer backlog_features counts non-dup rows only (BACKLOG_REAL caliber)', () => {
  it('5,000 dup rows missing features do not trigger catch-up: steady with backlogFeatures = 300', async () => {
    const { dbPath } = buildCaliberDb({ healthy: 50, realPending: 300, dupPending: 5000 });
    process.env.EAGLEYE_DB_PATH = dbPath;
    const drainer = compileSubject(DRAINER_PATH, '../config');
    const result = await drainer.runKGDrain(drainerDeps());
    // 今天（未实现排除）: backlog = 5,350 > 500 且 load1 1.20 < 2.5 → 'catchup'。
    expect(result.backlogFeatures, 'backlog_features 必须排除 duplicate_of IS NOT NULL 的行').toBe(300);
    expect(result.mode, 'dup 行不得虚抬 catch-up 触发').toBe('steady');
  });

  it('a REAL backlog above the trigger still selects catch-up (exclusion is not an off switch)', async () => {
    const { dbPath } = buildCaliberDb({ healthy: 10, realPending: 501, dupPending: 4000 });
    process.env.EAGLEYE_DB_PATH = dbPath;
    const drainer = compileSubject(DRAINER_PATH, '../config');
    const result = await drainer.runKGDrain(drainerDeps());
    expect(result.backlogFeatures).toBe(501);
    expect(result.mode).toBe('catchup');
  });
});

describe('R3.0 — scripts/kg-drain.js fire threshold counts non-dup rows only', () => {
  it('3,000 dup rows do not fire the 200-item floor: skipped with backlog = 150', async () => {
    const { dbPath } = buildCaliberDb({ healthy: 50, realPending: 150, dupPending: 3000 });
    process.env.EAGLEYE_DB_PATH = dbPath;
    const script = compileSubject(FIRE_SCRIPT_PATH, '../server/config');
    const fireDrainJob = vi.fn(async () => ({ job_id: 'job-1' }));
    const result = await script.main({ fireDrainJob });
    // 今天（未实现排除）: backlog = 3,150 ≥ 200 → { fired: true }。
    expect(result).toEqual({ skipped: 'backlog-below-threshold', backlog: 150 });
    expect(fireDrainJob).not.toHaveBeenCalled();
  });

  it('topic-only backlog participates in the 200-item fire threshold', async () => {
    const { dbPath } = buildCaliberDb({ healthy: 10, topicOnlyPending: 150, dupPending: 3000 });
    process.env.EAGLEYE_DB_PATH = dbPath;
    const script = compileSubject(FIRE_SCRIPT_PATH, '../server/config');
    const fireDrainJob = vi.fn(async () => ({ job_id: 'topic-job' }));
    const result = await script.main({ fireDrainJob });
    expect(result).toEqual({ skipped: 'backlog-below-threshold', backlog: 150 });
    expect(fireDrainJob).not.toHaveBeenCalled();
  });

  it('200 topic-only items cross the fire threshold', async () => {
    const { dbPath } = buildCaliberDb({ healthy: 10, topicOnlyPending: 200 });
    process.env.EAGLEYE_DB_PATH = dbPath;
    const script = compileSubject(FIRE_SCRIPT_PATH, '../server/config');
    const fireDrainJob = vi.fn(async () => ({ job_id: 'topic-job' }));
    const result = await script.main({ fireDrainJob });
    expect(result).toEqual({ fired: true, job_id: 'topic-job' });
    expect(fireDrainJob).toHaveBeenCalledWith({ idleWindow: expect.any(Boolean) });
  });
});

describe('R3.1 — kg-drainer catch-up includes topic-only backlog', () => {
  it('501 topic-only items trigger catch-up even when feature backlog is zero', async () => {
    const { dbPath } = buildCaliberDb({ healthy: 10, topicOnlyPending: 501 });
    process.env.EAGLEYE_DB_PATH = dbPath;
    const drainer = compileSubject(DRAINER_PATH, '../config');
    const result = await drainer.runKGDrain(drainerDeps());
    expect(result.backlogFeatures).toBe(0);
    expect(result.backlogTopics).toBe(501);
    expect(result.mode).toBe('catchup');
  });
});
