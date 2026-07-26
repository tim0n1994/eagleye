/**
 * Eagleye — User Data Helpers
 *
 * Read/write key-value pairs in the user_data table.
 *
 * Rows are keyed by (key, user_id). Server-level settings — llm_config,
 * scheduler_config, es_last_sync — describe the machine rather than a person
 * and use the global scope (user_id ''), which is the default. Anything
 * personal (watchlist, personal_lens, es_saved_searches) MUST pass the owning
 * user id; omitting it silently reads and writes the shared global row, which
 * is exactly the single-user bug migration 028 fixed.
 */

const { getDB } = require('./connection');

const GLOBAL_SCOPE = '';

function getValue(key, userId = GLOBAL_SCOPE) {
  const db = getDB();
  if (!db) return null;
  const row = db.prepare('SELECT value FROM user_data WHERE key = ? AND user_id = ?')
    .get(key, userId || GLOBAL_SCOPE);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

function setValue(key, value, userId = GLOBAL_SCOPE) {
  const db = getDB();
  if (!db) return;
  db.prepare('INSERT OR REPLACE INTO user_data (key, user_id, value) VALUES (?, ?, ?)')
    .run(key, userId || GLOBAL_SCOPE, JSON.stringify(value));
}

module.exports = { getValue, setValue, GLOBAL_SCOPE };
