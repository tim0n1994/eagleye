/**
 * Eagleye — Database Connection
 *
 * Provides a shared better-sqlite3 connection instance.
 */

const path = require('path');

let db = null;

function getDB() {
  if (db) return db;
  
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join(__dirname, '..', '..', 'eagleye.db');
    db = new Database(dbPath);
    
    // Enable WAL mode for better concurrent performance
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    
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
