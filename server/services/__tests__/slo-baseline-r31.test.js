// @vitest-environment node
/**
 * R3.1 SLO 判定域扩容 — RED 规格（fixtures 驱动、确定性、离线，不连生产库）。
 *
 * 被测对象: scripts/slo-baseline.py（Python）。本文件只测行为契约（stdout 标记行
 * + 退出码），经子进程 + EAGLEYE_SLO_* 环境变量注入驱动；不 import 其内部，
 * 实现读 env 的时机（import 时 / main 内）不受约束。对应 R3.1 裁决 B（Q5）与
 * 伴随指标（Q4）。测试文件放在 server/services/__tests__/ 是因为 vitest.config.js
 * 的 include 只收 js/ server/ mcp/（scripts/ 下的文件不会被收集），与
 * kg-drain-script.test.js → scripts/kg-drain.js 同一惯例。
 *
 * 契约（实现方照此修改 scripts/slo-baseline.py）:
 *
 * 1) 退出码判定纳入 features 积压与 TOPIC_PENDING（任一超阈 → FAIL 行 + 退出码 1）:
 *        FAIL SLO_EXTRACT_PENDING: EXTRACT_PENDING=<n> >= <th>
 *        FAIL SLO_TOPIC_PENDING:   TOPIC_PENDING=<n>   >= <th>
 *    阈值裁决未给数值，取与既有 TH_BACKLOG 一致的 500（slo-baseline.py 口径
 *    「积压 < 500」，>= 500 违约、含 =500；裁决 A 的 backlog_features>500 同量级）。
 *    若 CTO 另定数值，改 TH_* 常量并同步本文件边界用例（=499 过 / =500 违约）即可。
 *
 * 2) 伴随指标输出行（每轮必出；只输出、不判定、缺源 → NA，绝不因此 exit 2）:
 *        LOAD1=         默认仍读 os.getloadavg()（旧 Python 测试的 mock 兼容）；
 *                       若设 EAGLEYE_SLO_LOADAVG=<path> 则改读该文件首个字段
 *                       （/proc/loadavg 格式 —— 裁决 A「可注入路径 mock」口径）。
 *        GEAR=          最近一条 result JSON 含 mode 的已完成 kg-drain
 *                       background_jobs 记录的 mode（steady/catchup/slow，见
 *                       server/services/kg-drainer.js DRAIN_CAPS）。查询口径:
 *                         SELECT result FROM background_jobs
 *                          WHERE job_type='kg-drain' AND status='completed'
 *                          ORDER BY created_at DESC, rowid DESC
 *                       逐条 json.loads，取第一个解析为对象且含非空 mode 字符串的；
 *                       无 background_jobs 表 / 无记录 / 全部不可解析 → GEAR=NA
 *                       （容忍旧 fixture schema，不得 exit 2）。选它而不在 SLO 侧
 *                       重推 gear: mode 由 drainer 自身写入（jobs.js 把 runKGDrain
 *                       的 {mode,...} JSON.stringify 进 background_jobs.result），
 *                       避免 SLO 复刻 drainer 的滞后状态机（load1≥3.0 连续 2 采样）。
 *        SALON9_COUNT=  生产源 = docker logs --since 15m salon9-asr-agent-1 中匹配
 *                       received|active|final|partial（忽略大小写）的行数（裁决 B
 *                       原文口径；kg-drainer 自身占用探测用 journalctl -30min，
 *                       用途不同、并存）。若设 EAGLEYE_SLO_SALON9_LOG=<path> 则改读
 *                       该 fixture 文件计数（确定性钩子）；源不可读 → NA。
 *                       （可另设 EAGLEYE_SLO_SALON9_UNIT 默认 salon9-asr-agent-1、
 *                       EAGLEYE_SLO_SALON9_SINCE 默认 15m，本文件不锁定。）
 *
 * 3) 48h 追平口径 = features 与 embed 两条 lane 都清零（裁决 A 末句 / 范围末句）:
 *        CATCHUP_FEATURES_H = EXTRACT_PENDING / (近 7 天 item_features.updated_at
 *                                            新增行数 / 7 / 24)  # 生产 006 migration 有该列
 *        CATCHUP_EMBED_H    = EMBED_PENDING / (近 7 天 semantic-hash 向量新增数 / 7 / 24)
 *        单 lane 积压 <= 500 → 该 lane 豁免（NA）；rate<=0 且积压>500 → INF；
 *        CATCHUP_H = 非 NA lane 的最大值（都 NA → NA）；CATCHUP_H > 48 →
 *        FAIL SLO_CATCHUP_48H（消息前缀 "FAIL SLO_CATCHUP_48H: CATCHUP_H=<v>"）。
 *    既有 BACKLOG（无任何向量行口径）判定与 EMBED_PENDING 输出保持不变。
 *
 * 实现联动注意:
 *   - scripts/test_slo_baseline.py（既有 Python 套件）的 fixture SCHEMA 需给
 *     item_features 补 updated_at 列（本文件已按生产 schema 建表）；其既有场景
 *     的 violations 计数不变（该 fixture 全量带 features/topics，新判定不触发）。
 *   - 测量错误语义不变（exit 2，不含 FAIL 行）。
 *
 * RED 门: export PATH=$HOME/.local/bin:$PATH &&
 *         npx vitest run server/services/__tests__/slo-baseline-r31.test.js
 *         在未实现的 b745270 上 16 例全部断言失败，退出码 1。
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
const TEST_TIMEOUT = 60_000;

// 库时间戳口径 = UTC（与生产 datetime('now') 一致）；所有 fixture 时间相对此刻。
const NOW_MS = Date.now();
const ts = hoursAgo => new Date(NOW_MS - hoursAgo * 3_600_000)
  .toISOString().slice(0, 19).replace('T', ' ');

const SCHEMA = `
CREATE TABLE information_items (id INTEGER PRIMARY KEY, created_at TEXT);
ALTER TABLE information_items ADD COLUMN duplicate_of TEXT; -- R3.0: 生产由新迁移提供
CREATE TABLE item_vectors (
    item_id INTEGER, vector_type TEXT, model_name TEXT, created_at TEXT,
    PRIMARY KEY (item_id, vector_type, model_name));
CREATE TABLE item_features (item_id INTEGER PRIMARY KEY, updated_at TEXT);
CREATE TABLE item_topic_assignments (item_id INTEGER, topic_kind TEXT);
`;

const JOBS_SCHEMA = `
CREATE TABLE background_jobs (
    id TEXT PRIMARY KEY, job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', params TEXT DEFAULT '{}',
    result TEXT, error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT, completed_at TEXT);
`;

// docker logs salon9-asr-agent-1 形态: 5 行含 received/active/final|partial，
// 2 行噪音（任何大小写都不含这四个词）。
const SALON9_BUSY = [
  '2026-10-21T01:44:02Z asr-agent received chunk seq=41',
  '2026-10-21T01:44:03Z asr-agent active session=room9',
  '2026-10-21T01:44:05Z heartbeat ok',
  '2026-10-21T01:44:09Z asr-agent partial transcript len=812',
  '2026-10-21T01:44:12Z asr-agent final transcript len=2048',
  '2026-10-21T01:44:15Z metrics flush cpu=0.02',
  '2026-10-21T01:44:18Z asr-agent received chunk seq=42',
];
const SALON9_QUIET = [
  '2026-10-21T01:44:05Z heartbeat ok',
  '2026-10-21T01:44:15Z metrics flush cpu=0.02',
];
const LOADAVG_OK = '2.37 1.10 0.90 3/420 99'; // /proc/loadavg 首字段格式

const tmpdirs = [];
afterEach(() => {
  while (tmpdirs.length) fs.rmSync(tmpdirs.pop(), { recursive: true, force: true });
});

/**
 * 插一条 information_items 及可选行。featuresH 缺省 = 缺 item_features 行
 * （features 积压人口）；topics=false = 缺 item_topic_assignments 行
 * （TOPIC_PENDING 人口）；foreignVecH = 非 semantic-hash 向量（有向量行 →
 * 不计 BACKLOG，但无 hash 向量 → 计 EMBED_PENDING）。
 */
function addItem(db, id, createdH, { hashVecH, foreignVecH, featuresH, topics = true } = {}) {
  db.prepare('INSERT INTO information_items (id, created_at) VALUES (?, ?)').run(id, ts(createdH));
  if (hashVecH !== undefined) {
    db.prepare('INSERT INTO item_vectors VALUES (?,?,?,?)')
      .run(id, 'semantic-hash', 'eagleye-hash-v1', ts(hashVecH));
  }
  if (foreignVecH !== undefined) {
    db.prepare('INSERT INTO item_vectors VALUES (?,?,?,?)')
      .run(id, 'openai-embedding', 'text-embedding-3-small', ts(foreignVecH));
  }
  if (featuresH !== undefined) {
    db.prepare('INSERT INTO item_features VALUES (?, ?)').run(id, ts(featuresH));
  }
  if (topics) {
    db.prepare("INSERT INTO item_topic_assignments VALUES (?, 'dynamic')").run(id);
  }
}

/** 5 条全健康基线（24h 前入库、20h 前出向量/出 features，延迟 4h）。 */
function healthy5(db) {
  for (let i = 1; i <= 5; i++) addItem(db, i, 24, { hashVecH: 20, featuresH: 20 });
}

/** 建 fixture 库; jobs: [[id, job_type, created_h_ago, result_text], ...]。 */
function buildDb(populate, { jobs = [], withJobsTable = true } = {}) {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'slo-r31-'));
  tmpdirs.push(tmpdir);
  const dbPath = path.join(tmpdir, 'fixture.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  if (withJobsTable) db.exec(JOBS_SCHEMA);
  const insertAll = db.transaction(() => {
    populate(db);
    for (const [id, jobType, createdH, result] of jobs) {
      db.prepare('INSERT INTO background_jobs (id, job_type, status, result,'
        + ' created_at, started_at, completed_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, jobType, 'completed', result, ts(createdH), ts(createdH), ts(createdH));
    }
  });
  insertAll();
  db.close();
  return { dbPath, tmpdir };
}

function writeTmp(tmpdir, name, content) {
  const file = path.join(tmpdir, name);
  fs.writeFileSync(file, content);
  return file;
}

/**
 * 子进程跑 slo-baseline.py → { rc, out, err }。
 * loadavg / salon9 传 null → 注入不存在的路径（缺源 → NA 契约）。
 */
function runSlo({ dbPath, tmpdir }, { loadavg = LOADAVG_OK, salon9 = SALON9_QUIET } = {}) {
  const env = { ...process.env };
  for (const key of ['EAGLEYE_SLO_DB', 'EAGLEYE_SLO_LOADAVG', 'EAGLEYE_SLO_SALON9_LOG']) {
    delete env[key];
  }
  env.EAGLEYE_SLO_DB = dbPath;
  env.EAGLEYE_SLO_LOADAVG = loadavg === null
    ? path.join(tmpdir, 'missing-loadavg')
    : writeTmp(tmpdir, 'loadavg', `${loadavg}\n`);
  env.EAGLEYE_SLO_SALON9_LOG = salon9 === null
    ? path.join(tmpdir, 'missing-salon9.log')
    : writeTmp(tmpdir, 'salon9.log', `${salon9.join('\n')}\n`);
  const proc = spawnSync(PYTHON, [SCRIPT], { env, encoding: 'utf8', timeout: 120_000 });
  // python3 缺失 / 超时等环境问题显式抛出（envBad），不伪装成断言失败。
  if (proc.error) throw proc.error;
  return { rc: proc.status, out: proc.stdout, err: proc.stderr };
}

const lines = out => out.split('\n');
/** 整行精确匹配（避免 5/50 前缀误配）。 */
function expectLine(out, exact) {
  expect(lines(out), `missing line ${JSON.stringify(exact)} in output:\n${out}`).toContain(exact);
}
function expectKv(out, key) {
  expect(out, `missing companion line ${key}= in output:\n${out}`)
    .toMatch(new RegExp(`^${key}=\\S+$`, 'm'));
}
/** 伴随指标每轮必出（裁决 Q4）: 三行齐全（值可为 NA）。 */
function expectCompanions(out) {
  for (const key of ['LOAD1', 'GEAR', 'SALON9_COUNT']) expectKv(out, key);
}

// ------------------------------------------------ 判定域扩容: features / topics

describe('slo-baseline R3.1 — EXTRACT_PENDING (features 积压) enters the exit code', () => {
  it('600 pending (>= 500) is RED exit 1 with its own FAIL line; features lane 33.60h stays under 48h', () => {
    // 3000 全健康（拉高 7 天 features 吞吐 3000/7≈428.6/天）+ 600 条缺 features
    // （有 hash 向量 + topics）→ EXTRACT_PENDING=600 ≥ 500 违约；
    // features lane 600/(3000/7/24)=33.60h ≤ 48 → 不追加 CATCHUP 违约。
    const fx = buildDb(db => {
      for (let i = 1; i <= 3000; i++) addItem(db, i, 24, { hashVecH: 20, featuresH: 20 });
      for (let i = 5001; i <= 5600; i++) addItem(db, i, 24, { hashVecH: 20 });
    });
    const { rc, out } = runSlo(fx);
    expectCompanions(out);
    expect(rc, out).toBe(1);
    expectLine(out, 'EXTRACT_PENDING=600');
    expectLine(out, 'FAIL SLO_EXTRACT_PENDING: EXTRACT_PENDING=600 >= 500');
    expectLine(out, 'TOPIC_PENDING=0');
    expectLine(out, 'CATCHUP_FEATURES_H=33.60');
    expectLine(out, 'CATCHUP_EMBED_H=NA');
    expectLine(out, 'CATCHUP_H=33.60');
    expect(out).not.toContain('FAIL SLO_CATCHUP_48H');
    expectLine(out, 'RESULT=FAIL violations=1');
  }, TEST_TIMEOUT);

  it('499 pending (< 500) is GREEN exit 0; features lane waived → CATCHUP_H=NA', () => {
    // 边界（>= 语义，与 BACKLOG「积压 < 500」一致）: 499 → 不违约。
    const fx = buildDb(db => {
      healthy5(db);
      for (let i = 6; i <= 504; i++) addItem(db, i, 24, { hashVecH: 20 }); // 499 条缺 features
    });
    const { rc, out } = runSlo(fx);
    expectCompanions(out);
    expect(rc, out).toBe(0);
    expectLine(out, 'EXTRACT_PENDING=499');
    expectLine(out, 'CATCHUP_H=NA');
    expect(out).not.toContain('FAIL');
    expectLine(out, 'RESULT=PASS violations=0');
  }, TEST_TIMEOUT);
});

describe('slo-baseline R3.1 — TOPIC_PENDING enters the exit code', () => {
  it('600 pending (>= 500) is RED exit 1 with its own FAIL line; both catchup lanes waived', () => {
    // 605 条全有 hash 向量 + features，其中 600 条缺 topics → 仅 TOPIC_PENDING 违约。
    const fx = buildDb(db => {
      healthy5(db);
      for (let i = 6; i <= 605; i++) addItem(db, i, 24, { hashVecH: 20, featuresH: 20, topics: false });
    });
    const { rc, out } = runSlo(fx);
    expectCompanions(out);
    expect(rc, out).toBe(1);
    expectLine(out, 'TOPIC_PENDING=600');
    expectLine(out, 'FAIL SLO_TOPIC_PENDING: TOPIC_PENDING=600 >= 500');
    expectLine(out, 'EXTRACT_PENDING=0');
    expectLine(out, 'CATCHUP_H=NA');
    expectLine(out, 'RESULT=FAIL violations=1');
  }, TEST_TIMEOUT);

  it('499 pending (< 500) is GREEN exit 0', () => {
    const fx = buildDb(db => {
      healthy5(db);
      for (let i = 6; i <= 504; i++) addItem(db, i, 24, { hashVecH: 20, featuresH: 20, topics: false });
    });
    const { rc, out } = runSlo(fx);
    expectCompanions(out);
    expect(rc, out).toBe(0);
    expectLine(out, 'TOPIC_PENDING=499');
    expect(out).not.toContain('FAIL');
    expectLine(out, 'RESULT=PASS violations=0');
  }, TEST_TIMEOUT);

  it('exactly 500 on both lanes violates both (>= semantics) → violations=2', () => {
    const fx = buildDb(db => {
      healthy5(db);
      for (let i = 6; i <= 505; i++) addItem(db, i, 24, { hashVecH: 20 }); // 500 条缺 features
      for (let i = 1006; i <= 1505; i++) addItem(db, i, 24, { hashVecH: 20, featuresH: 20, topics: false }); // 500 条缺 topics
    });
    const { rc, out } = runSlo(fx);
    expect(rc, out).toBe(1);
    expectLine(out, 'FAIL SLO_EXTRACT_PENDING: EXTRACT_PENDING=500 >= 500');
    expectLine(out, 'FAIL SLO_TOPIC_PENDING: TOPIC_PENDING=500 >= 500');
    expectLine(out, 'RESULT=FAIL violations=2');
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------- 48h 口径: 双 lane 都清零

describe('slo-baseline R3.1 — 48h catch-up means BOTH features and embed clear', () => {
  it('features lane with zero throughput never clears → CATCHUP_H=INF is RED even though embed is waived', () => {
    // item_features 全空 → features 吞吐 0 → INF；必然伴随 EXTRACT_PENDING=605
    // 稳态违约（两条判定互补、独立计数）。
    const fx = buildDb(db => {
      for (let i = 1; i <= 605; i++) addItem(db, i, 24, { hashVecH: 20 }); // hash 向量 + topics, 无 features
    });
    const { rc, out } = runSlo(fx);
    expectCompanions(out);
    expect(rc, out).toBe(1);
    expectLine(out, 'CATCHUP_FEATURES_H=INF');
    expectLine(out, 'CATCHUP_EMBED_H=NA');
    expectLine(out, 'CATCHUP_H=INF');
    expect(out).toContain('FAIL SLO_CATCHUP_48H: CATCHUP_H=INF');
    expectLine(out, 'RESULT=FAIL violations=2');
  }, TEST_TIMEOUT);

  it('embed lane over 48h (600 vector-less items at 5 vec/7d → 20160h) keeps the existing RED', () => {
    const fx = buildDb(db => {
      healthy5(db);
      for (let i = 6; i <= 605; i++) addItem(db, i, 30, { featuresH: 20 }); // 600 条 30h 前入库、无向量
    });
    const { rc, out } = runSlo(fx);
    expect(rc, out).toBe(1);
    expectLine(out, 'BACKLOG=600');
    expectLine(out, 'CATCHUP_EMBED_H=20160.00');
    expectLine(out, 'CATCHUP_FEATURES_H=NA');
    expectLine(out, 'CATCHUP_H=20160.00');
    expect(out).toContain('FAIL SLO_CATCHUP_48H: CATCHUP_H=20160.00');
    expect(out).toContain('FAIL SLO_P95_LATENCY');
    expectLine(out, 'RESULT=FAIL violations=3');
  }, TEST_TIMEOUT);

  it('embed lane engaged but clearing in 33.60h is GREEN exit 0', () => {
    // 600 条只有外来向量（非 semantic-hash）→ EMBED_PENDING=600 但 BACKLOG=0；
    // 入库 3h（<6h 不参评 p95）→ p95 只看 3000 条健康（4.00h）。
    const fx = buildDb(db => {
      for (let i = 1; i <= 3000; i++) addItem(db, i, 24, { hashVecH: 20, featuresH: 20 });
      for (let i = 9001; i <= 9600; i++) addItem(db, i, 3, { foreignVecH: 1, featuresH: 1 });
    });
    const { rc, out } = runSlo(fx);
    expectCompanions(out);
    expect(rc, out).toBe(0);
    expectLine(out, 'EMBED_PENDING=600');
    expectLine(out, 'BACKLOG=0');
    expectLine(out, 'CATCHUP_EMBED_H=33.60');
    expectLine(out, 'CATCHUP_FEATURES_H=NA');
    expectLine(out, 'CATCHUP_H=33.60');
    expect(out).not.toContain('FAIL');
    expectLine(out, 'RESULT=PASS violations=0');
  }, TEST_TIMEOUT);

  it('both lanes engaged and both clearing (28.00h each) → no catch-up FAIL (steady-state features FAIL stays)', () => {
    const fx = buildDb(db => {
      for (let i = 1; i <= 3000; i++) addItem(db, i, 24, { hashVecH: 20, featuresH: 20 });
      for (let i = 5001; i <= 5600; i++) addItem(db, i, 24, { hashVecH: 20 }); // 600 条缺 features
      for (let i = 9001; i <= 9600; i++) addItem(db, i, 3, { foreignVecH: 1, featuresH: 1 }); // 600 条仅外来向量
    });
    const { rc, out } = runSlo(fx);
    expectCompanions(out);
    expect(rc, out).toBe(1);
    expectLine(out, 'CATCHUP_FEATURES_H=28.00');
    expectLine(out, 'CATCHUP_EMBED_H=28.00');
    expectLine(out, 'CATCHUP_H=28.00');
    expect(out).not.toContain('FAIL SLO_CATCHUP_48H');
    expectLine(out, 'FAIL SLO_EXTRACT_PENDING: EXTRACT_PENDING=600 >= 500');
    expectLine(out, 'RESULT=FAIL violations=1');
  }, TEST_TIMEOUT);
});

// ------------------------------------------------------------ 伴随指标（Q4）

describe('slo-baseline R3.1 — companion metrics LOAD1= / GEAR= / SALON9_COUNT= every round', () => {
  it('LOAD1 comes from the injected /proc/loadavg-format file', () => {
    const { rc, out } = runSlo(buildDb(healthy5), { loadavg: LOADAVG_OK });
    expectCompanions(out);
    expect(rc, out).toBe(0);
    expectLine(out, 'LOAD1=2.37');
    expectLine(out, 'GEAR=NA');
    expectLine(out, 'SALON9_COUNT=0');
  }, TEST_TIMEOUT);

  it('LOAD1 > 3.0 from the injected file is the existing SLO_LOAD1 violation', () => {
    const { rc, out } = runSlo(buildDb(healthy5), { loadavg: '3.50 3.10 2.00 1/99 7' });
    expect(rc, out).toBe(1);
    expectLine(out, 'LOAD1=3.50');
    expectLine(out, 'FAIL SLO_LOAD1: LOAD1=3.50 > 3.0');
    expectLine(out, 'RESULT=FAIL violations=1');
  }, TEST_TIMEOUT);

  it('missing loadavg source → LOAD1=NA, not judged, not exit 2', () => {
    const { rc, out } = runSlo(buildDb(healthy5), { loadavg: null });
    expectCompanions(out);
    expect(rc, out).toBe(0);
    expectLine(out, 'LOAD1=NA');
    expect(out).not.toContain('FAIL');
    expectLine(out, 'RESULT=PASS violations=0');
  }, TEST_TIMEOUT);

  it('GEAR is the mode of the latest parseable completed kg-drain job (never judged)', () => {
    // j-bad(0.5h, 非 JSON) 跳过 → j-enrich(1h) 非 kg-drain 忽略 → j-slow(2h) 胜 j-steady(10h)。
    const jobs = [
      ['j-steady', 'kg-drain', 10, '{"mode":"steady","caps":{"extract":500}}'],
      ['j-slow', 'kg-drain', 2, '{"mode":"slow","caps":{"extract":200}}'],
      ['j-enrich', 'enrich', 1, '{"mode":"not-a-gear"}'],
      ['j-bad', 'kg-drain', 0.5, 'not-json-at-all'],
    ];
    const { rc, out } = runSlo(buildDb(healthy5, { jobs }));
    expectCompanions(out);
    expect(rc, out).toBe(0);
    expectLine(out, 'GEAR=slow');
    expect(out).not.toContain('FAIL');
    expectLine(out, 'RESULT=PASS violations=0');
  }, TEST_TIMEOUT);

  it('no background_jobs table → GEAR=NA and still exit 0 (companion metrics never exit 2)', () => {
    const { rc, out, err } = runSlo(buildDb(healthy5, { withJobsTable: false }));
    expectCompanions(out);
    expect(rc, out + err).toBe(0);
    expectLine(out, 'GEAR=NA');
    expectLine(out, 'RESULT=PASS violations=0');
  }, TEST_TIMEOUT);

  it('SALON9_COUNT counts received/active/final|partial lines of the injected docker log (5 of 7)', () => {
    const { rc, out } = runSlo(buildDb(healthy5), { salon9: SALON9_BUSY });
    expectCompanions(out);
    expect(rc, out).toBe(0);
    expectLine(out, 'SALON9_COUNT=5');
    expectLine(out, 'LOAD1=2.37');
    expect(out).not.toContain('FAIL');
    expectLine(out, 'RESULT=PASS violations=0');
  }, TEST_TIMEOUT);

  it('missing Salon9 source → SALON9_COUNT=NA, not judged', () => {
    const { rc, out } = runSlo(buildDb(healthy5), { salon9: null });
    expectCompanions(out);
    expect(rc, out).toBe(0);
    expectLine(out, 'SALON9_COUNT=NA');
    expect(out).not.toContain('FAIL');
    expectLine(out, 'RESULT=PASS violations=0');
  }, TEST_TIMEOUT);
});
