/**
 * Eagleye — User Data Helpers
 *
 * Read/write key-value pairs in the user_data table (legacy API support).
 */

const { getDB } = require('./connection');

function getValue(key) {
  const db = getDB();
  if (!db) return null;
  const row = db.prepare('SELECT value FROM user_data WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

function setValue(key, value) {
  const db = getDB();
  if (!db) return;
  db.prepare('INSERT OR REPLACE INTO user_data (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

module.exports = { getValue, setValue };
