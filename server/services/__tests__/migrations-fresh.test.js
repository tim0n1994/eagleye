import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const Module = require('node:module');
const Database = require('better-sqlite3');
const directory = path.resolve(import.meta.dirname, '../../migrations');
const files = fs.readdirSync(directory).filter(file => file.endsWith('.sql')).sort();

describe('complete migrations on fresh and legacy SQLite databases', () => {
  let db;
  let migrations;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const filename = path.resolve(import.meta.dirname, '../../db/migrate.js');
    const subject = new Module(filename, module);
    subject.filename = filename;
    subject.require = id => id === './connection' ? { getDB: () => db } : require(id);
    subject._compile(fs.readFileSync(filename, 'utf8'), filename);
    migrations = subject.exports;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  function expectAllApplied() {
    expect(files).toHaveLength(38);
    expect(db.prepare('SELECT name FROM _migrations ORDER BY name').all().map(row => row.name)).toEqual(files);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    for (const table of ['ai_summaries', 'daily_digests', 'research_reports']) {
      expect(db.pragma(`table_info(${table})`).map(column => column.name)).toContain('llm_metadata');
    }
  }

  it('applies all 36 migrations to an empty database and skips their markers on restart', () => {
    migrations.runMigrations();
    expectAllApplied();
    expect(db.pragma('table_info(user_data)').map(column => column.name)).toEqual(['key', 'user_id', 'value']);
    db.prepare('INSERT INTO user_data (key,user_id,value) VALUES (?,?,?)').run('watchlist', 'new-owner', 'preserve after restart');
    const markers = db.prepare('SELECT * FROM _migrations ORDER BY name').all();
    migrations.runMigrations();
    expect(db.prepare('SELECT * FROM _migrations ORDER BY name').all()).toEqual(markers);
    expect(db.prepare('SELECT * FROM user_data').all()).toEqual([{ key: 'watchlist', user_id: 'new-owner', value: 'preserve after restart' }]);
  });

  it('moves legacy personal data to the sole account and preserves global configuration and saved/seen items', () => {
    db.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP);');
    for (const file of files.filter(file => file < '028')) {
      migrations.applyMigration(db, file, fs.readFileSync(path.join(directory, file), 'utf8'));
    }
    db.exec(`CREATE TABLE user_data (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO users (id,email,password_hash) VALUES ('owner','owner@example.invalid','fixture');
      INSERT INTO information_items (id,source_id,canonical_url,title,digest_date)
        VALUES ('kept-item','s001','https://example.invalid/kept','Kept item','20260909');
      INSERT INTO saved_items (user_id,item_id,note) VALUES ('anonymous','kept-item','Keep this note');
      INSERT INTO seen_items (user_id,item_id) VALUES ('anonymous','kept-item');`);
    const rows = [
      ['watchlist', '["kept"]'], ['personal_lens', 'my interests'], ['es_saved_searches', '["my search"]'],
      ['llm_config', '{"fixture":true}'], ['scheduler_config', '{"enabled":false}'],
    ];
    for (const row of rows) db.prepare('INSERT INTO user_data (key,value) VALUES (?,?)').run(...row);
    migrations.runMigrations();
    expectAllApplied();
    const personal = new Set(['watchlist', 'personal_lens', 'es_saved_searches']);
    for (const [key, value] of rows) {
      expect(db.prepare('SELECT user_id,value FROM user_data WHERE key=?').get(key)).toEqual({ user_id: personal.has(key) ? 'owner' : '', value });
    }
    expect(db.prepare('SELECT user_id,item_id,note FROM saved_items').all()).toEqual([{ user_id: 'owner', item_id: 'kept-item', note: 'Keep this note' }]);
    expect(db.prepare('SELECT user_id,item_id FROM seen_items').all()).toEqual([{ user_id: 'owner', item_id: 'kept-item' }]);
    const before = db.prepare('SELECT * FROM user_data ORDER BY key').all();
    migrations.runMigrations();
    expect(db.prepare('SELECT * FROM user_data ORDER BY key').all()).toEqual(before);
  });
});
