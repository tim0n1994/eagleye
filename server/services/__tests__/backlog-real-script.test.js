// @vitest-environment node
/**
 * R3.0 跨天重复治理 — RED 规格: scripts/backlog-real.py（新脚本）。
 *
 * 门禁要求（2026-10-21 任务书）: 回填后「积压按新口径重算输出标记
 * BACKLOG_REAL=<n>（CTO 预期约 2k）」。诊断口径: vector 积压（无
 * item_vectors 行）12,092 = 7,478 dup + 4,614 非 dup → BACKLOG_REAL =
 * 非 dup 的无向量行数（与 slo-baseline.py BACKLOG 同 lane、只差排除
 * duplicate_of IS NOT NULL）。
 *
 * 本文件钉的契约:
 *
 *   1. stdout 输出整行标记 `BACKLOG_REAL=<n>`（n = 无 item_vectors 行
 *      且 duplicate_of IS NULL 的 information_items 行数），退出码 0。
 *   2. 对生产库只读: file:…?mode=ro（+ PRAGMA query_only 双保险，
 *      slo-baseline.open_ro 同纪律）。行为级验证 = 跑完全程后库文件
 *      字节不变、目录里不出现 -wal/-journal 副本。
 *   3. DB 缺失/不可开 → 测量错误语义: 退出码非 0 且 stdout 绝不打印
 *      BACKLOG_REAL= 行（没测到的数不冒充测到 — 退出码+stdout 双拦截）。
 *
 * 实现约定（与 slo-baseline.py:72 EAGLEYE_SLO_DB 同款钩子）: 库路径经
 * env EAGLEYE_BACKLOG_REAL_DB 注入; 不设时默认生产库
 * /home/user/projects/eagleye/eagleye.db（默认路径不在本测试内运行 —
 * 2.18GB 生产库的重扫描不属于单测; 生产巡检由门禁 checklist 的
 * mode=ro 流程执行）。features lane 等附加输出行允许并存，本契约只钉
 * BACKLOG_REAL= 一行的值与上述三条款。
 *
 * RED 门（脚本尚不存在 → 第一条用例失败、其余 skip，kg-drain-script
 * .test.js 的 implemented 守卫惯例）:
 *   export PATH=/home/user/.local/bin:$PATH &&
 *   npx vitest run server/services/__tests__/backlog-real-script.test.js
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const SCRIPT = path.resolve(import.meta.dirname, '../../../scripts/backlog-real.py');
const PYTHON = process.env.PYTHON || 'python3';

const SCHEMA = `
CREATE TABLE information_items (id INTEGER PRIMARY KEY, created_at TEXT, duplicate_of TEXT);
CREATE TABLE item_vectors (item_id INTEGER, vector_type TEXT, model_name TEXT);
`;

const tmpdirs = [];
afterEach(() => {
  while (tmpdirs.length) fs.rmSync(tmpdirs.pop(), { recursive: true, force: true });
});

/**
 * fixture: 4 条非 dup 无向量（BACKLOG_REAL 的人口）+ 9 条 dup 无向量
 * （必须被排除）+ 6 条非 dup 有向量 + 2 条 dup 有向量（本就不在积压里）。
 * → 期望 BACKLOG_REAL=4。
 */
function buildDb() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-real-'));
  tmpdirs.push(tmpdir);
  const dbPath = path.join(tmpdir, 'fixture.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  db.transaction(() => {
    const item = db.prepare('INSERT INTO information_items VALUES (?, ?, ?)');
    const vec = db.prepare("INSERT INTO item_vectors VALUES (?, 'semantic-hash', 'eagleye-hash-v1')");
    let id = 0;
    for (let i = 0; i < 4; i++) { id += 1; item.run(id, '2026-10-19 08:00:00', null); }
    for (let i = 0; i < 9; i++) { id += 1; item.run(id, '2026-10-19 09:00:00', 'first'); }
    for (let i = 0; i < 6; i++) { id += 1; item.run(id, '2026-10-18 08:00:00', null); vec.run(id); }
    for (let i = 0; i < 2; i++) { id += 1; item.run(id, '2026-10-18 09:00:00', 'first'); vec.run(id); }
  })();
  db.close();
  return { dbPath, tmpdir };
}

function runScript(dbPath) {
  const env = { ...process.env };
  delete env.EAGLEYE_BACKLOG_REAL_DB;
  if (dbPath !== undefined) env.EAGLEYE_BACKLOG_REAL_DB = dbPath;
  const proc = spawnSync(PYTHON, [SCRIPT], { env, encoding: 'utf8', timeout: 120_000 });
  if (proc.error) throw proc.error;
  return { rc: proc.status, out: proc.stdout, err: proc.stderr };
}

describe('R3.0 — scripts/backlog-real.py presence', () => {
  it('scripts/backlog-real.py exists (RED until implemented)', () => {
    expect(fs.existsSync(SCRIPT), `expected ${SCRIPT} to exist`).toBe(true);
  });
});

const implemented = fs.existsSync(SCRIPT);
(implemented ? describe : describe.skip)('R3.0 — scripts/backlog-real.py BACKLOG_REAL contract', () => {
  it('prints BACKLOG_REAL=<non-dup no-vector rows> and exits 0', () => {
    const { dbPath } = buildDb();
    const run = runScript(dbPath);
    expect(run.out.split('\n'), `missing BACKLOG_REAL marker in output:\n${run.out}`)
      .toContain('BACKLOG_REAL=4');
    expect(run.rc).toBe(0);
  });

  it('never writes the DB: file bytes unchanged, no -wal/-journal sidecars', () => {
    const { dbPath, tmpdir } = buildDb();
    const before = fs.readFileSync(dbPath);
    const listingBefore = fs.readdirSync(tmpdir).sort();
    const run = runScript(dbPath);
    expect(run.rc).toBe(0);
    expect(fs.readFileSync(dbPath).equals(before), 'DB file bytes must be unchanged').toBe(true);
    expect(fs.readdirSync(tmpdir).sort(), 'no WAL/journal sidecars may appear')
      .toEqual(listingBefore);
  });

  it('a missing DB is a measurement error: non-zero exit, no BACKLOG_REAL line on stdout', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-real-missing-'));
    tmpdirs.push(tmpdir);
    const run = runScript(path.join(tmpdir, 'does-not-exist.db'));
    expect(run.rc).not.toBe(0);
    expect(run.out).not.toMatch(/^BACKLOG_REAL=/m);
  });
});
