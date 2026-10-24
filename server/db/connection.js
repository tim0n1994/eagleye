/**
 * Eagleye — Database Connection
 *
 * Provides a shared better-sqlite3 connection instance.
 */

const { getDBPath } = require('../config');

let db = null;

function getDB() {
  if (db) return db;
  
  try {
    const Database = require('better-sqlite3');
    const dbPath = getDBPath();
    db = new Database(dbPath);
    
    // Enable WAL mode for better concurrent performance
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // D7 WAL governance: cap the -wal file at 64MB so it cannot grow
    // unbounded (production WAL reached 172MB). The TRUNCATE checkpoints
    // issued after the daily pipeline / enrich drain jobs (services/jobs.js)
    // shrink the file back under this cap.
    db.pragma('journal_size_limit = 67108864');
    
    return db;
  } catch (e) {
    console.error('Failed to initialize SQLite:', e.message);
    return null;
  }
}

function closeDB() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDB, closeDB };
