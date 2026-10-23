// @vitest-environment node
/**
 * R3.0 迁移契约测试 — information_items.duplicate_of 软标记列（测试作者·迁移回填）
 *
 * 【背景】(ask) R3.0 治理历史跨天重复：生产 65,916 行中 32,446 行是
 * (source_id, canonical_url) 组内非首行（诊断 DUP_DIAG groups=10400 rows=32446；
 * 10-19 单日 3,638/4,419 = 82%，与 CTO 实测一致）。根因是 schema 的
 * UNIQUE(source_id, canonical_url, digest_date) 允许同 URL 每天重插
 * （server/migrations/001_initial_schema.sql:47）。方案＝软标记不物理删除：
 * 新迁移加 duplicate_of TEXT NULL + 索引；回填把组内非首行指向首行 id；
 * 回滚＝整列置空，本轮完全可逆。
 *
 * 【本文件契约】新迁移（按仓库编号惯例应为 043_*.sql；不硬编码文件名，
 * 由"哪条迁移加了 duplicate_of 列"动态识别）必须：
 *  1) 给 information_items 加 duplicate_of 列：类型 TEXT、可空（notnull=0）、
 *     无默认值（或 DEFAULT NULL）——回滚语义（整列置空）与既有写入路径
 *     （不感知该列的 INSERT）都依赖可空无默认；
 *  2) 建一个覆盖 duplicate_of 列的索引——drainer/enrich/kg 的积压选取谓词
 *     一律排除 duplicate_of IS NOT NULL，digest/搜索/计数默认排除，R5
 *     retention 还要沿该列连依赖行，全都要按这列扫；
 *  3) 纯加法：迁移本身不回填（回填是独立脚本 scripts/dup-backfill.*，
 *     契约见 dup-backfill-script.test.js）、不动既有列、不削弱
 *     UNIQUE(source_id, canonical_url, digest_date)（根因修复不在本轮范围）；
 *  4) 走标准 runner（server/db/migrate.js）：_migrations 账本 == 迁移目录
 *     文件清单，fresh 库全量迁移后列即可用。
 *
 * 【RED 口径】当前树无此迁移：'duplicate_of' 的 toBeDefined 断言以
 * assertion FAIL 失败（不是环境错误）。注意 migrations-fresh.test.js 硬编码
 * 迁移文件数（当前 40），043 落地后由实现者机械 +1 —— 那是既有测试文件的
 * 维护，不属于本文件（先例：migration-consecutive-empty.test.js 头注）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const Database = require('better-sqlite3');

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../migrations');
const FILES = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();

// 与 server/db/migrate.js ensureMigrationsTable 的 DDL 一致（直接调 applyMigration 前需自带账本）
const MIGRATIONS_TABLE_DDL =
  "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))";

function loadMigrator(db) {
  const filename = path.resolve(import.meta.dirname, '../../db/migrate.js');
  const subject = new Module(filename, module);
  subject.filename = filename;
  subject.require = id => (id === './connection' ? { getDB: () => db } : require(id));
  subject._compile(fs.readFileSync(filename, 'utf8'), filename);
  return subject.exports;
}

const hasDuplicateOf = db =>
  db.pragma('table_info(information_items)').some(c => c.name === 'duplicate_of');

/**
 * 在 scratch 内存库上按 runner 顺序逐条应用，找出"加了 duplicate_of 列"的
 * 那个迁移文件；当前树不存在 → null（RED）。确定性：只看应用后的 schema
 * 效果，不依赖文件名/文件文本。
 */
function findDuplicateOfMigration() {
  const scratch = new Database(':memory:');
  scratch.exec(MIGRATIONS_TABLE_DDL);
  const migrations = loadMigrator(scratch);
  try {
    for (const file of FILES) {
      migrations.applyMigration(scratch, file, fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      if (hasDuplicateOf(scratch)) return file;
    }
    return null;
  } finally {
    scratch.close();
  }
}

describe('R3.0 — migration adds information_items.duplicate_of (soft dup marker)', () => {
  let db;
  let migrations;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrations = loadMigrator(db);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('fresh DB: ledger == migration files; duplicate_of column is TEXT / nullable / no default', () => {
    migrations.runMigrations();

    expect(db.prepare('SELECT name FROM _migrations ORDER BY name').all().map(r => r.name)).toEqual(FILES);

    const columns = db.pragma('table_info(information_items)');
    const names = columns.map(c => c.name);
    const col = columns.find(c => c.name === 'duplicate_of');
    expect(col, '必须存在新增 information_items.duplicate_of 列的迁移（R3.0 软标记，回填的前置）').toBeDefined();
    expect(col.type.toUpperCase()).toBe('TEXT');
    expect(col.notnull, '必须可空：回滚=整列置空；存量行与不感知该列的 INSERT 都没有值').toBe(0);
    expect(
      col.dflt_value === null || String(col.dflt_value).toUpperCase() === 'NULL',
      `默认值必须是无/NULL，实测 dflt_value=${JSON.stringify(col.dflt_value)}`
    ).toBe(true);

    // 既有列不回归（001 的关键列 + 既存的 duplicate_group_id 不得被动到）
    for (const kept of ['id', 'source_id', 'canonical_url', 'digest_date', 'created_at', 'duplicate_group_id']) {
      expect(names).toContain(kept);
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('fresh DB: an index on information_items covers duplicate_of', () => {
    migrations.runMigrations();

    const col = db.pragma('table_info(information_items)').find(c => c.name === 'duplicate_of');
    expect(col, 'duplicate_of 列必须先存在，才谈得上索引').toBeDefined();

    const indexes = db.pragma('index_list(information_items)');
    const covered = indexes.some(idx =>
      db.pragma(`index_info("${idx.name}")`).some(c => c.name === 'duplicate_of'));
    expect(
      covered,
      `必须有覆盖 duplicate_of 的索引（排除谓词 duplicate_of IS NOT NULL 与 R5 连依赖行都要按该列扫）；实测索引=[${indexes.map(i => i.name).join(', ')}]`
    ).toBe(true);
  });

  it('inserts that do not mention duplicate_of succeed and read back NULL', () => {
    migrations.runMigrations();

    db.prepare("INSERT INTO sources (id, slug, label) VALUES ('s1', 's1', 'S1')").run();
    const hasCol = db.pragma('table_info(information_items)').some(c => c.name === 'duplicate_of');
    expect(hasCol, 'duplicate_of 列必须存在（守卫：后续 SELECT 该列才有意义）').toBe(true);
    db.prepare(
      "INSERT INTO information_items (id, source_id, canonical_url, title, digest_date) " +
      "VALUES ('i1', 's1', 'https://example.invalid/a', 'Title', '2026-10-20')"
    ).run();
    expect(db.prepare("SELECT duplicate_of FROM information_items WHERE id = 'i1'").get().duplicate_of).toBeNull();
  });

  it('migration is additive only: pre-existing dup-group rows keep duplicate_of NULL; UNIQUE triple still enforced', () => {
    const dupFile = findDuplicateOfMigration();
    if (dupFile) expect(FILES).toContain(dupFile);

    // legacy 库 = duplicate_of 迁移之前的全部迁移（当前 RED 树上 = 全部 40 条）
    db.exec(MIGRATIONS_TABLE_DDL);
    for (const file of FILES.filter(f => f !== dupFile)) {
      migrations.applyMigration(db, file, fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    }

    db.prepare("INSERT INTO sources (id, slug, label) VALUES ('s1', 's1', 'S1')").run();
    const ins = db.prepare(
      'INSERT INTO information_items (id, source_id, canonical_url, title, digest_date, created_at) VALUES (?,?,?,?,?,?)');
    ins.run('first', 's1', 'https://example.invalid/dup', 'First insert', '2026-10-01', '2026-10-01 08:00:00');
    ins.run('re-dup', 's1', 'https://example.invalid/dup', 'Re-inserted next day', '2026-10-02', '2026-10-02 08:00:00');

    migrations.runMigrations(); // 补上含 duplicate_of 的新迁移

    const col = db.pragma('table_info(information_items)').find(c => c.name === 'duplicate_of');
    expect(col, `迁移 ${dupFile ?? '(缺失：当前树没有加 duplicate_of 的迁移)'} 必须加上 duplicate_of 列`).toBeDefined();

    // 迁移本身不回填：软标记的写入属于独立脚本 scripts/dup-backfill.*（分离部署，迁移轻量可逆）
    expect(db.prepare('SELECT COUNT(*) AS n FROM information_items WHERE duplicate_of IS NOT NULL').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM information_items').get().n).toBe(2);

    // UNIQUE(source_id, canonical_url, digest_date) 仍在（根因修复不在 R3.0 范围）
    expect(() => ins.run('clash', 's1', 'https://example.invalid/dup', 'Exact triple clash', '2026-10-02', '2026-10-03 08:00:00')).toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
