// @vitest-environment node
/**
 * R3.0 回填脚本契约测试 — scripts/dup-backfill.{py,js,mjs,cjs}（测试作者·迁移回填）
 *
 * 【背景】(ask) 软标记治理：新迁移加 information_items.duplicate_of TEXT NULL
 * （契约见 migration-duplicate-of.test.js），回填把 (source_id, canonical_url)
 * 重复组的非首行指向组内首行 id；幂等（checklist 21：stdout OK/ALREADY 标记）；
 * 回滚＝整列置空后重跑必须能重新标记（ALREADY 是状态判定，不是账本判定）。
 * 生产口径（诊断 DUP_DIAG）：65,916 行 / 33,470 组 / 32,446 dup 行；本测试用
 * fixture DB 复算同口径（绝不触生产库）。
 *
 * 【脚本位置裁决】scripts/dup-backfill.{py,js,mjs,cjs} 恰好一个（.py →
 * python3；.js/.mjs/.cjs → 运行中的 node）。命名跟随 scripts/ 既有的
 * backfill 家族（backfill-30days.js、master-backfill.js）；换语言实现时须
 * 删掉旧扩展名桩（先例：kg-cost-baseline-script.test.js 契约 1）。
 *
 * 【标记行契约】行首锚定 KEY=VALUE；行尾允许追加额外 KEY=VALUE 字段：
 *   - 首跑（有行被标记）：DUP_BACKFILL_OK marked=<int>   （marked=本次置
 *     duplicate_of 的行数）
 *   - 已回填（零变更）：DUP_BACKFILL_ALREADY marked=0
 *   - 两种成功跑都追加：BACKLOG_REAL vectors=<int> features=<int>
 *     （新口径积压：duplicate_of IS NULL 且无 item_vectors / item_features 行；
 *     即诊断口径 "BACKLOG_REAL(vectors)" 与 feature backlog 合并为一行两字段。
 *     CTO 预期生产 ~2k，实测 4,614——数字对不对在生产跑时看，本测试只钉口径）
 * 退出码：成功 0（含 ALREADY）；错误 2 且 stderr 含 ERROR（不可把错误伪装成
 * OK 标记；checklist 双拦截＝退出码+stdout 标记同时判定）。
 *
 * 【回填语义】组键 (source_id, canonical_url)（canonical_url NOT NULL、生产
 * 0 个 NULL source_id——诊断已验证 grouping clean）。组内保留
 * ORDER BY created_at ASC, id ASC 的首行（id 是 PK → 全序 → 确定性；生产
 * dup_tie_groups=1 的 created_at 平局由 id 决定），其余行 duplicate_of=首行 id。
 * 只写 duplicate_of，不动其他列。
 *
 * 【回填后判定 SQL】（gate 的确定性判据，本测试逐条执行，0 违例才算过）：
 *   V1 组内首行唯一：无组拥有 >1 个 duplicate_of IS NULL 的行；
 *   V2 首行是最早行：duplicate_of IS NULL 的行，组内不存在
 *      (created_at, id) 更小的行；
 *   V3 dup 指向本组首行：duplicate_of IS NOT NULL 的行，其目标行存在、
 *      同组、且自身 duplicate_of IS NULL（同时排除孤儿指针/链式指向）；
 *   V4 dup 行数 == 诊断值（fixture 口径）：COUNT(duplicate_of IS NOT NULL)
 *      == 独立 ROW_NUMBER 口径复算值 == 脚本上报的 marked。
 *
 * 【fixture 口径】真实 DDL 子集（001_initial_schema.sql:26 information_items、
 * 006_kg_v2 的 item_features / item_vectors；REFERENCES 摘除），并已含
 * duplicate_of TEXT 列——即"043 迁移已应用、回填未跑"的形态。11 行覆盖：
 * 跨天重复组、同日重复组、created_at 平局（id 决胜）、created_at 主导 id
 * （乱序插入）、单例组、同 URL 跨 source 独立成组。绝无生产库访问。
 *
 * 【RED 口径】当前树无 scripts/dup-backfill.*：契约 1（存在性）以 assertion
 * FAIL 失败；其余 describe.skip（先例：kg-cost-baseline-script.test.js）。
 * 【不在契约】（实现者自定）：--dry-run、进度输出、marked/groups 之外的
 * 字段、并行/分批策略。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const SCRIPTS_DIR = path.resolve(import.meta.dirname, '../../../scripts');
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const CANDIDATES = ['dup-backfill.py', 'dup-backfill.js', 'dup-backfill.mjs', 'dup-backfill.cjs'];
const PYTHON = fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
const RUN_TIMEOUT_MS = 120_000;
const FIXED_TS = '2026-10-20 00:00:00'; // 确定性 UTC 戳（跟随 slo-baseline / kg-cost-baseline 口径）

const OK_RE = /^DUP_BACKFILL_OK marked=(\d+)(?=\s|$)/m;
const ALREADY_RE = /^DUP_BACKFILL_ALREADY marked=(\d+)(?=\s|$)/m;
const BACKLOG_RE = /^BACKLOG_REAL vectors=(\d+) features=(\d+)(?=\s|$)/m;

// Real DDL subset (REFERENCES dropped; names/types/NOT NULL/DEFAULT/PK/UNIQUE kept),
// + duplicate_of TEXT —— "043 迁移已应用、回填未跑" 的输入形态。
const SCHEMA = `
CREATE TABLE information_items (
  id TEXT PRIMARY KEY,
  source_id TEXT,
  canonical_url TEXT NOT NULL,
  external_id TEXT,
  title TEXT NOT NULL,
  original_summary TEXT,
  content_text TEXT,
  language TEXT DEFAULT 'en',
  author TEXT,
  published_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  digest_date TEXT NOT NULL,
  source_payload TEXT NOT NULL DEFAULT '{}',
  normalized_payload TEXT NOT NULL DEFAULT '{}',
  score REAL DEFAULT 0,
  popularity TEXT DEFAULT '{}',
  content_hash TEXT,
  duplicate_group_id TEXT,
  duplicate_of TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_id, canonical_url, digest_date)
);
CREATE TABLE item_features (
  item_id TEXT PRIMARY KEY,
  source_slug TEXT NOT NULL,
  domain TEXT,
  author_norm TEXT,
  language_detected TEXT,
  content_hash TEXT,
  title_tokens TEXT NOT NULL DEFAULT '[]',
  keyword_candidates TEXT NOT NULL DEFAULT '[]',
  source_features TEXT NOT NULL DEFAULT '{}',
  quality_score REAL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE item_vectors (
  item_id TEXT NOT NULL,
  vector_type TEXT NOT NULL,
  model_name TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, vector_type, model_name)
);
`;

// (id, source_id, canonical_url, digest_date, created_at)
// 组内 digest_date 两两互异 —— 生产根因正是 UNIQUE(source_id, canonical_url,
// digest_date) 允许不同 digest_date 的同 URL 重插。
const ROWS = [
  ['a1', 'src-x', 'https://fx.invalid/a', '2026-10-01', '2026-10-01 06:00:00'],
  ['a2', 'src-x', 'https://fx.invalid/a', '2026-10-02', '2026-10-02 06:00:00'],
  ['a3', 'src-x', 'https://fx.invalid/a', '2026-10-03', '2026-10-03 06:00:00'],
  // created_at 平局 → id 决胜（生产 dup_tie_groups=1 的真实形态）
  ['b-aaa', 'src-x', 'https://fx.invalid/b', '2026-10-06', '2026-10-05 12:00:00'],
  ['b-bbb', 'src-x', 'https://fx.invalid/b', '2026-10-07', '2026-10-05 12:00:00'],
  // 同日重复（生产 373 行的同日口径：created 同日、digest_date 不同）
  ['c1', 'src-x', 'https://fx.invalid/c', '2026-10-07', '2026-10-06 08:00:00'],
  ['c2', 'src-x', 'https://fx.invalid/c', '2026-10-08', '2026-10-06 09:00:00'],
  // 单例组：永不标记
  ['d1', 'src-x', 'https://fx.invalid/d', '2026-10-09', '2026-10-09 08:00:00'],
  // 同 URL 跨 source：独立成组（组键含 source_id），不受 src-x 的 /a 组影响
  ['e1', 'src-y', 'https://fx.invalid/a', '2026-10-03', '2026-10-03 08:00:00'],
  // created_at 主导 id：更早 created_at 但更大 id 的 f-002 是首行
  ['f-001', 'src-x', 'https://fx.invalid/f', '2026-10-08', '2026-10-07 12:00:00'],
  ['f-002', 'src-x', 'https://fx.invalid/f', '2026-10-07', '2026-10-07 06:00:00'],
];

// 期望的软标记终态（回填语义的手工推导值）
const EXPECTED_MAP = {
  a1: null, a2: 'a1', a3: 'a1',
  'b-aaa': null, 'b-bbb': 'b-aaa',
  c1: null, c2: 'c1',
  d1: null,
  e1: null,
  'f-001': 'f-002', 'f-002': null,
};
const EXPECTED_MARKED = 5;      // a2 a3 b-bbb c2 f-001
const EXPECTED_BACKLOG = { vectors: 4, features: 4 }; // 非dup且缺行：b-aaa c1 e1 f-002
const VECTORIZED = ['a1', 'd1']; // dup 行 a2/a3 有向量也不影响口径（本 fixture 未给）

function locateScripts() {
  return CANDIDATES.map(c => path.join(SCRIPTS_DIR, c))
    .filter(p => fs.existsSync(p) && fs.statSync(p).isFile());
}

function interpreterFor(scriptPath) {
  return scriptPath.endsWith('.py') ? PYTHON : process.execPath;
}

function runCli(scriptPath, ...args) {
  const r = spawnSync(interpreterFor(scriptPath), [scriptPath, ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: RUN_TIMEOUT_MS,
  });
  if (r.error) throw r.error; // 解释器缺失/超时 → 测试错误，不算契约 FAIL
  return { rc: r.status, stdout: r.stdout, stderr: r.stderr };
}

function buildFixture(dir) {
  const dbPath = path.join(dir, 'fixture.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  const ins = db.prepare(
    'INSERT INTO information_items (id, source_id, canonical_url, title, digest_date, created_at, updated_at, fetched_at, content_hash) ' +
    'VALUES (?,?,?,?,?,?,?,?,?)');
  for (const [id, sourceId, url, digestDate, createdAt] of ROWS) {
    ins.run(id, sourceId, url, `Fixture ${id}`, digestDate, createdAt, FIXED_TS, FIXED_TS, `hash-${id}`);
  }
  const insVec = db.prepare(
    'INSERT INTO item_vectors (item_id, vector_type, model_name, dimension, vector_json, content_hash, created_at) VALUES (?,?,?,?,?,?,?)');
  const insFeat = db.prepare(
    'INSERT INTO item_features (item_id, source_slug, updated_at) VALUES (?,?,?)');
  for (const itemId of VECTORIZED) {
    insVec.run(itemId, 'semantic_hash', 'fx-model', 8, '[0.1,0.2]', `hash-${itemId}`, FIXED_TS);
    insFeat.run(itemId, 'src-x', FIXED_TS);
  }
  db.close();
  return dbPath;
}

function readMapping(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT id, duplicate_of FROM information_items ORDER BY id').all();
  } finally {
    db.close();
  }
}

function readUntouchedSnapshot(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(
      'SELECT id, source_id, canonical_url, digest_date, created_at, updated_at, title, content_hash ' +
      'FROM information_items ORDER BY id').all();
  } finally {
    db.close();
  }
}

/** 判定 SQL V1-V4（gate 判据）；返回 {v1,v2,v3,rowCountCaliber,markedCount}，违例数应全 0 */
function runVerdictSql(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const v1 = db.prepare(
      'SELECT COUNT(*) AS n FROM (' +
      '  SELECT source_id, canonical_url FROM information_items' +
      '  WHERE duplicate_of IS NULL' +
      '  GROUP BY source_id, canonical_url HAVING COUNT(*) > 1)').get().n;
    const v2 = db.prepare(
      'SELECT COUNT(*) AS n FROM information_items later_row WHERE later_row.duplicate_of IS NULL AND EXISTS (' +
      '  SELECT 1 FROM information_items earlier' +
      '  WHERE earlier.source_id = later_row.source_id AND earlier.canonical_url = later_row.canonical_url' +
      '    AND (earlier.created_at < later_row.created_at' +
      '         OR (earlier.created_at = later_row.created_at AND earlier.id < later_row.id)))').get().n;
    const v3 = db.prepare(
      'SELECT COUNT(*) AS n FROM information_items dup_row WHERE dup_row.duplicate_of IS NOT NULL AND NOT EXISTS (' +
      '  SELECT 1 FROM information_items target' +
      '  WHERE target.id = dup_row.duplicate_of' +
      '    AND target.source_id = dup_row.source_id AND target.canonical_url = dup_row.canonical_url' +
      '    AND target.duplicate_of IS NULL)').get().n;
    const rowCountCaliber = db.prepare(
      'SELECT COUNT(*) AS n FROM (' +
      '  SELECT id, ROW_NUMBER() OVER (PARTITION BY source_id, canonical_url ORDER BY created_at ASC, id ASC) AS rn' +
      '  FROM information_items) WHERE rn > 1').get().n;
    const markedCount = db.prepare(
      'SELECT COUNT(*) AS n FROM information_items WHERE duplicate_of IS NOT NULL').get().n;
    return { v1, v2, v3, rowCountCaliber, markedCount };
  } finally {
    db.close();
  }
}

function expectMarkerMatch(stdout, re, label) {
  const m = re.exec(stdout);
  expect(m, `${label}: stdout 缺行首锚定标记 ${re}; stdout=${JSON.stringify(stdout)}`).not.toBeNull();
  return m;
}

describe('scripts/dup-backfill presence (R3.0 回填)', () => {
  it('exactly one scripts/dup-backfill.{py,js,mjs,cjs} exists', () => {
    const found = locateScripts();
    expect(found, `契约 1: 实际找到=${JSON.stringify(found)}（候选=${CANDIDATES.join(', ')}）`).toHaveLength(1);
  });
});

const located = locateScripts();
const SCRIPT = located.length === 1 ? located[0] : null;

(SCRIPT ? describe : describe.skip)('scripts/dup-backfill CLI contract (R3.0 回填)', () => {
  const tmpDirs = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function fixture() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-backfill-fixture-'));
    tmpDirs.push(d);
    return { dir: d, dbPath: buildFixture(d) };
  }

  it('--help exits 0, prints usage and documents --db', () => {
    const p = runCli(SCRIPT, '--help');
    expect(p.rc, `--help rc=${p.rc} stderr=${JSON.stringify(p.stderr)}`).toBe(0);
    expect(p.stdout.toLowerCase(), `--help 必须打印 usage; stdout=${JSON.stringify(p.stdout)}`).toContain('usage');
    expect(p.stdout, '--help 必须列出 --db').toContain('--db');
  });

  it('first run: DUP_BACKFILL_OK marked=5, BACKLOG_REAL vectors=4 features=4, and DB passes 判定 SQL V1-V4', () => {
    const { dbPath } = fixture();
    const untouchedBefore = readUntouchedSnapshot(dbPath);

    const p = runCli(SCRIPT, '--db', dbPath);
    expect(p.rc, `首跑 rc=${p.rc} stderr=${JSON.stringify(p.stderr)}`).toBe(0);

    const ok = expectMarkerMatch(p.stdout, OK_RE, '首跑');
    expect(Number(ok[1]), `首跑 marked 应为 ${EXPECTED_MARKED}; stdout=${JSON.stringify(p.stdout)}`).toBe(EXPECTED_MARKED);

    const backlog = expectMarkerMatch(p.stdout, BACKLOG_RE, '首跑 BACKLOG_REAL');
    expect(Number(backlog[1]), `BACKLOG_REAL vectors 应为 ${EXPECTED_BACKLOG.vectors}（非dup且无 item_vectors 行）`).toBe(EXPECTED_BACKLOG.vectors);
    expect(Number(backlog[2]), `BACKLOG_REAL features 应为 ${EXPECTED_BACKLOG.features}（非dup且无 item_features 行）`).toBe(EXPECTED_BACKLOG.features);

    // 判定 SQL：0 违例 + 诊断值对账（V4）
    const v = runVerdictSql(dbPath);
    expect(v.v1, 'V1 组内首行唯一：无组拥有多个 duplicate_of IS NULL 行').toBe(0);
    expect(v.v2, 'V2 首行是组内 (created_at,id) 最小行').toBe(0);
    expect(v.v3, 'V3 dup 行指向本组首行（无孤儿/链式指针）').toBe(0);
    expect(v.markedCount, 'V4a DB 内 dup 行数').toBe(EXPECTED_MARKED);
    expect(v.rowCountCaliber, 'V4b 独立 ROW_NUMBER 口径复算').toBe(EXPECTED_MARKED);

    // 精确终态（手工推导的期望映射）
    expect(readMapping(dbPath)).toEqual(
      Object.entries(EXPECTED_MAP).map(([id, duplicate_of]) => ({ id, duplicate_of })));

    // 只写 duplicate_of：其他列逐行不变
    expect(readUntouchedSnapshot(dbPath)).toEqual(untouchedBefore);
  });

  it('second run is a no-op: DUP_BACKFILL_ALREADY marked=0, identical mapping, same BACKLOG_REAL', () => {
    const { dbPath } = fixture();
    const first = runCli(SCRIPT, '--db', dbPath);
    expect(first.rc, `首跑 rc=${first.rc}`).toBe(0);
    expectMarkerMatch(first.stdout, OK_RE, '首跑');
    const before = readMapping(dbPath);

    const second = runCli(SCRIPT, '--db', dbPath);
    expect(second.rc, `重跑 rc=${second.rc} stderr=${JSON.stringify(second.stderr)}`).toBe(0);

    const already = expectMarkerMatch(second.stdout, ALREADY_RE, '重跑');
    expect(Number(already[1]), `幂等重跑 marked 必须为 0; stdout=${JSON.stringify(second.stdout)}`).toBe(0);

    const backlog = expectMarkerMatch(second.stdout, BACKLOG_RE, '重跑 BACKLOG_REAL');
    expect(Number(backlog[1])).toBe(EXPECTED_BACKLOG.vectors);
    expect(Number(backlog[2])).toBe(EXPECTED_BACKLOG.features);

    expect(readMapping(dbPath), '幂等重跑后 duplicate_of 映射必须逐行不变').toEqual(before);
  });

  it('rollback (整列置空) then re-run re-marks: ALREADY 判定基于 DB 状态而非账本', () => {
    const { dbPath } = fixture();
    const first = runCli(SCRIPT, '--db', dbPath);
    expect(first.rc, `首跑 rc=${first.rc}`).toBe(0);
    expectMarkerMatch(first.stdout, OK_RE, '首跑');

    // ask 的回滚语义：回滚＝把该列置空（完全可逆）
    const db = new Database(dbPath);
    try {
      db.prepare('UPDATE information_items SET duplicate_of = NULL').run();
    } finally {
      db.close();
    }
    expect(readMapping(dbPath).every(r => r.duplicate_of === null)).toBe(true);

    const third = runCli(SCRIPT, '--db', dbPath);
    expect(third.rc, `回滚后重跑 rc=${third.rc} stderr=${JSON.stringify(third.stderr)}`).toBe(0);
    const ok = expectMarkerMatch(third.stdout, OK_RE, '回滚后重跑');
    expect(Number(ok[1]), '回滚（整列置空）后重跑必须重新标记满额').toBe(EXPECTED_MARKED);

    expect(readMapping(dbPath)).toEqual(
      Object.entries(EXPECTED_MAP).map(([id, duplicate_of]) => ({ id, duplicate_of })));
    const v = runVerdictSql(dbPath);
    expect([v.v1, v.v2, v.v3], '回滚后重跑仍满足判定 SQL').toEqual([0, 0, 0]);
  });

  it('unreadable db path: rc 2 and stderr contains ERROR (never a disguised OK)', () => {
    const missing = path.join(os.tmpdir(), `dup-backfill-missing-${process.pid}-${Date.now()}`, 'nope.db');
    const p = runCli(SCRIPT, '--db', missing);
    expect(p.rc, `错误路径 rc=${p.rc}（0=把错误伪装成成功；1=未定义语义）`).toBe(2);
    expect(p.stderr.toUpperCase(), `stderr 必须含 ERROR; stderr=${JSON.stringify(p.stderr)}`).toContain('ERROR');
    expect(OK_RE.test(p.stdout), '错误路径绝不能打印 DUP_BACKFILL_OK').toBe(false);
    expect(ALREADY_RE.test(p.stdout), '错误路径绝不能打印 DUP_BACKFILL_ALREADY').toBe(false);
  });
});
