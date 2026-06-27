/**
 * Eagleye — Migration Runner
 *
 * Reads and applies SQL migration files in order.
 */

const fs = require('fs');
const path = require('path');
const { getDB } = require('./connection');

const MIGRATIONS_TABLE = '_migrations';

function ensureMigrationsTable() {
  const db = getDB();
  if (!db) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
}

function getAppliedMigrations() {
  const db = getDB();
  if (!db) return [];
  return db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).all().map(r => r.name);
}

function runMigrations() {
  const db = getDB();
  if (!db) {
    console.warn('  ⚠  No database available, skipping migrations.');
    return;
  }

  ensureMigrationsTable();
  const applied = new Set(getAppliedMigrations());

  const migrationsDir = path.join(__dirname, '..', 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.warn('  ⚠  No migrations directory found.');
    return;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    console.log(`  📦 Applying migration: ${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

    try {
      db.exec(sql);
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`).run(file);
      console.log(`  ✅ Applied: ${file}`);
    } catch (err) {
      console.error(`  ❌ Migration ${file} failed:`, err.message);
      throw err;
    }
  }

  console.log(`  📋 Migrations complete. ${files.length} total, ${files.length - applied.size} new.`);
}

module.exports = { runMigrations };
