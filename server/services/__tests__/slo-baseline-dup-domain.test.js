// @vitest-environment node
/**
 * R3.0 跨天重复治理 — RED 规格: R3/R3.1 的 SLO 判定域切换到「非 dup 行」
 * （BACKLOG_REAL 口径）。
 *
 * 背景（2026-10-21, worktree round3-convergence @ 1b8bc3f）: 诊断实测
 * vector 积压 12,092 = 7,478 dup + 4,614 非 dup; feature 积压 13,292 =
 * 8,197 dup + 5,095 非 dup — 全部积压 dup 行都是跨天重复。方案 =
 * information_items 新增 duplicate_of TEXT NULL 软标记（回填后 dup 行指向
 * 组内首行 id），SLO 的判定域（各 pending 计数与 P95 人口）一律改按
 * 非 dup 行判定，否则 32,446 行 dup 会让 SLO 永远红、追平推算永远虚高。
 *
 * 本文件钉的契约 — scripts/slo-baseline.py（Python, 子进程驱动，与
 * slo-baseline-r31.test.js 同一惯例）:
 *
 *   1. 判定域计数排除 duplicate_of IS NOT NULL:
 *        BACKLOG / EMBED_PENDING / EXTRACT_PENDING / TOPIC_PENDING
 *      四个标记行全部只数非 dup 行。端到端效应: 600 条 dup 缺行 + 100 条
 *      真实缺行 → RESULT=PASS 退出码 0（今天: 700 ≥ 500 → FAIL 退出码 1）。
 *   2. P95 判定人口同样排除 dup 行: 窗口内一条无向量的 dup 行不算
 *      censored — P95_POPULATION / P95_CENSORED 只数非 dup，且不触发
 *      FAIL SLO_P95_LATENCY（今天: 该行 censored → p95=inf → FAIL）。
 *   3. 新口径内部的边界语义保持: 真实（非 dup）积压 =500 仍然违约
 *      （BACKLOG=500 >= 500, 退出码 1, FAIL SLO_BACKLOG 行）— 排除 dup
 *      不是放宽阈值。
 *
 * 实现约定: fixture 经 EAGLEYE_SLO_DB 注入（slo-baseline.py:72 既有 env
 * 钩子）; LOAD1 / SALON9 经 r31 已实现的注入钩子固定为低载/安静，测试
 * 确定性。fixture schema 在 r31 基础上加 duplicate_of 列（生产由新迁移
 * 提供）。绝不触生产库。
 *
 * RED 门:
 *   export PATH=/home/jc/.local/bin:$PATH &&
 *   npx vitest run server/services/__tests__/slo-baseline-dup-domain.test.js
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const SCRIPT = path.resolve(import.meta.dirname, '../../../scripts/slo-baseline.py');
const PYTHON = process.env.PYTHON || 'python3';

const NOW_MS = Date.now();
const ts = hoursAgo => new Date(NOW_MS - hoursAgo * 3_600_000)
  .toISOString().slice(0, 19).replace('T', ' ');

const SCHEMA = `
CREATE TABLE information_items (id INTEGER PRIMARY KEY, created_at TEXT, duplicate_of TEXT);
CREATE TABLE item_vectors (
    item_id INTEGER, vector_type TEXT, model_name TEXT, created_at TEXT,
    PRIMARY KEY (item_id, vector_type, model_name));
CREATE TABLE item_features (item_id INTEGER PRIMARY KEY, updated_at TEXT);
CREATE TABLE item_topic_assignments (item_id INTEGER, topic_kind TEXT);
`;

const TEST_TIMEOUT = 120_000; // vitest 默认 5s 撑不住重载机器上的 fixture 构建+子进程（r31 同款）
const LOADAVG_OK = '2.37 1.10 0.90 3/420 99';
const SALON9_QUIET = ['2026-10-21T01:44:05Z heartbeat ok'];

const tmpdirs = [];
afterEach(() => {
  while (tmpdirs.length) fs.rmSync(tmpdirs.pop(), { recursive: true, force: true });
});

/**
 * 插一条 information_items 及可选 done 行，并支持软标记 duplicate_of。
 * hashVecH/featuresH 缺省 = 缺行（积压人口）; 传数字 = 该时刻完成。
 */
function addItem(db, id, createdH, { hashVecH, featuresH, topics = true, dupOf = null } = {}) {
  db.prepare('INSERT INTO information_items VALUES (?, ?, ?)').run(id, ts(createdH), dupOf);
  if (hashVecH !== undefined) {
    db.prepare('INSERT INTO item_vectors VALUES (?,?,?,?)')
      .run(id, 'semantic-hash', 'eagleye-hash-v1', ts(hashVecH));
  }
  if (featuresH !== undefined) {
    db.prepare('INSERT INTO item_features VALUES (?, ?)').run(id, ts(featuresH));
  }
  if (topics) {
    db.prepare("INSERT INTO item_topic_assignments VALUES (?, 'dynamic')").run(id);
  }
}

/** 5 条全健康基线（24h 前入库、20h 前完成，延迟 4h — P95 窗口内唯一人口）。 */
function healthy5(db) {
  for (let i = 1; i <= 5; i++) addItem(db, i, 24, { hashVecH: 20, featuresH: 20 });
}

/** 旧积压行: 200h 前入库（48h P95 窗口外）且三行全缺 → 只进 pending 计数。 */
function oldPending(db, id, dupOf) {
  addItem(db, id, 200, { topics: false, dupOf });
}

function buildDb(populate) {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'slo-dup-'));
  tmpdirs.push(tmpdir);
  const dbPath = path.join(tmpdir, 'fixture.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  db.transaction(() => populate(db))(); // 单事务建库: 免去逐行 autocommit fsync
  db.close();
  return { dbPath, tmpdir };
}

function runSlo({ dbPath, tmpdir }) {
  const env = { ...process.env };
  for (const key of ['EAGLEYE_SLO_DB', 'EAGLEYE_SLO_LOADAVG', 'EAGLEYE_SLO_SALON9_LOG']) {
    delete env[key];
  }
  env.EAGLEYE_SLO_DB = dbPath;
  env.EAGLEYE_SLO_LOADAVG = path.join(tmpdir, 'loadavg');
  fs.writeFileSync(env.EAGLEYE_SLO_LOADAVG, `${LOADAVG_OK}\n`);
  env.EAGLEYE_SLO_SALON9_LOG = path.join(tmpdir, 'salon9.log');
  fs.writeFileSync(env.EAGLEYE_SLO_SALON9_LOG, `${SALON9_QUIET.join('\n')}\n`);
  const proc = spawnSync(PYTHON, [SCRIPT], { env, encoding: 'utf8', timeout: 120_000 });
  if (proc.error) throw proc.error;
  return { rc: proc.status, out: proc.stdout, err: proc.stderr };
}

function expectLine(out, exact) {
  expect(out.split('\n'), `missing line ${JSON.stringify(exact)} in output:\n${out}`).toContain(exact);
}

describe('slo-baseline R3.0 — the judgment domain is non-dup rows (BACKLOG_REAL caliber)', () => {
  it('600 dup + 100 real pending rows: all four pending markers count 100 and the run is GREEN', { timeout: TEST_TIMEOUT }, () => {
    const run = runSlo(buildDb(db => {
      healthy5(db);
      for (let i = 0; i < 100; i++) oldPending(db, 1000 + i, null);       // 真实积压
      for (let i = 0; i < 600; i++) oldPending(db, 2000 + i, 'first');    // dup 软标记
    }));
    // 今天（未实现排除）: 四个计数都是 700 → FAIL SLO_* + RESULT=FAIL 退出码 1。
    expectLine(run.out, 'BACKLOG=100');
    expectLine(run.out, 'EMBED_PENDING=100');
    expectLine(run.out, 'EXTRACT_PENDING=100');
    expectLine(run.out, 'TOPIC_PENDING=100');
    expectLine(run.out, 'RESULT=PASS violations=0');
    expect(run.rc).toBe(0);
  });

  it('a dup row with no vector inside the P95 window is not censored population', { timeout: TEST_TIMEOUT }, () => {
    const run = runSlo(buildDb(db => {
      healthy5(db);
      // 24h 前入库、无任何向量、features/topics 齐全的 dup 行: 唯一可能的影响
      // 是 P95 人口（旧口径把它当 censored → p95=inf → FAIL）。
      addItem(db, 99, 24, { featuresH: 20, dupOf: 'first' });
    }));
    expectLine(run.out, 'P95_POPULATION=5');
    expectLine(run.out, 'P95_CENSORED=0');
    expect(run.out).not.toContain('FAIL SLO_P95_LATENCY');
    expectLine(run.out, 'RESULT=PASS violations=0');
    expect(run.rc).toBe(0);
  });

  it('a REAL (non-dup) backlog of exactly 500 still violates: exclusion is not a looser threshold', { timeout: TEST_TIMEOUT }, () => {
    const run = runSlo(buildDb(db => {
      healthy5(db);
      for (let i = 0; i < 500; i++) oldPending(db, 1000 + i, null);       // 真实积压 =500
      for (let i = 0; i < 3000; i++) oldPending(db, 2000 + i, 'first');   // dup 不参与判定
    }));
    expectLine(run.out, 'BACKLOG=500');
    expectLine(run.out, 'FAIL SLO_BACKLOG: BACKLOG=500 >= 500');
    // 500 条真实缺行同样落在 extract/topic 两个判定上（r31 已钉 =500 违约）;
    // 这里不钉 violations 总数，只钉 RESULT=FAIL 与退出码。
    expect(run.out).toMatch(/^RESULT=FAIL violations=\d+$/m);
    expect(run.rc).toBe(1);
  });
});
