// @vitest-environment node
/**
 * Round 1 · D4 迁移契约测试 — sources.consecutive_empty（测试作者 B）
 *
 * 新迁移（按仓库编号惯例应为 041_*.sql）必须：
 *  - 给 sources 表加 consecutive_empty INTEGER NOT NULL DEFAULT 0；
 *  - 幂等走标准 runner（账本 _migrations），fresh 库全量迁移后列即可用；
 *  - 不破坏 037 已有的健康列（last_attempt_at / last_success_at /
 *    last_new_content_at / last_error_class / health_status）。
 *
 * 注意：migrations-fresh.test.js 里硬编码了迁移文件数（当前 38），041 落地后
 * 该断言需由实现者同步 +1 —— 那是既有测试文件的维护，不属于本文件。
 */
process.env.TZ = 'Asia/Shanghai';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');
const { describe, it, expect, beforeEach, afterEach } = globalThis;

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const FILES = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();

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
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return target.exports;
}

describe('Round1 D4 — migration adds sources.consecutive_empty (041)', () => {
  let db;
  let migrations;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrations = loadMigrator(db);
  });
  afterEach(() => db.close());

  it('fresh database gains a NOT NULL consecutive_empty counter defaulting to 0, without touching 037 columns', () => {
    migrations.runMigrations();

    // 账本完整（含新迁移；不硬编码文件数）
    expect(db.prepare('SELECT name FROM _migrations ORDER BY name').all().map(r => r.name)).toEqual(FILES);

    const columns = db.pragma('table_info(sources)');
    const names = columns.map(c => c.name);
    const col = columns.find(c => c.name === 'consecutive_empty');
    expect(col, '必须存在一个新增 sources.consecutive_empty 列的迁移（D4 空轮计数）').toBeDefined();
    expect(col.notnull).toBe(1);
    expect(String(col.dflt_value).replace(/'/g, '')).toBe('0');
    expect(col.type.toUpperCase()).toContain('INT');

    // 037 健康列仍在（不回归）
    for (const kept of ['last_attempt_at', 'last_success_at', 'last_new_content_at', 'last_error_class', 'health_status']) {
      expect(names).toContain(kept);
    }

    // 默认值可写可读：不显式给列时为 0
    db.prepare("INSERT INTO sources (id, slug, label) VALUES ('s1', 's1', 'S1')").run();
    expect(db.prepare("SELECT consecutive_empty FROM sources WHERE slug = 's1'").get().consecutive_empty).toBe(0);

    // 外键完整性不受影响
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
