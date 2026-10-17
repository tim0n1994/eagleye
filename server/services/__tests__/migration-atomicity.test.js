import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { applyMigration } = require('../../db/migrate');

describe('migration atomicity', () => {
  it('rolls back partial DDL and the applied marker so a corrected migration can retry', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE _migrations(name TEXT PRIMARY KEY); CREATE TABLE outputs(id TEXT);');
      expect(() => applyMigration(db, 'new.sql', 'ALTER TABLE outputs ADD COLUMN metadata TEXT; ALTER TABLE missing ADD COLUMN field TEXT;')).toThrow();
      expect(db.pragma('table_info(outputs)').map(c => c.name)).toEqual(['id']);
      expect(db.prepare('SELECT COUNT(*) AS count FROM _migrations').get().count).toBe(0);
      applyMigration(db, 'new.sql', 'ALTER TABLE outputs ADD COLUMN metadata TEXT;');
      expect(db.pragma('table_info(outputs)').map(c => c.name)).toEqual(['id', 'metadata']);
      expect(db.prepare('SELECT name FROM _migrations').get().name).toBe('new.sql');
    } finally { db.close(); }
  });

  it('restores foreign-key enforcement when a legacy rebuild fails', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE _migrations(name TEXT PRIMARY KEY);');
      db.pragma('foreign_keys = ON');
      expect(() => applyMigration(db, 'legacy.sql', 'PRAGMA foreign_keys = OFF; CREATE TABLE transient(id TEXT); SELECT * FROM missing; PRAGMA foreign_keys = ON;')).toThrow();
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='transient'").get()).toBeUndefined();
    } finally { db.close(); }
  });
});
