/**
 * Eagleye — MCP audit log
 *
 * Append-only audit trail for every MCP tool call, kept in a dedicated
 * database so the business database connection stays strictly read-only.
 * Never exposed through MCP itself; inspect with sqlite3 locally.
 */

const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const AUDIT_DB_PATH = process.env.EAGLEYE_MCP_AUDIT_PATH?.trim()
  || path.resolve(__dirname, '..', 'mcp-audit.sqlite');

let db = null;
let insertStmt = null;
const KNOWN_TOOLS = new Set(['system_overview', 'list_sources', 'search_items', 'get_item', 'list_digests', 'get_digest', 'search_topics', 'query_entities', 'llm_usage_stats', 'job_status', 'search', 'fetch', 'initialize/unknown', 'unparseable', 'batch_rejected']);
const KNOWN_STATUSES = new Set(['ok', 'bad_request', 'unauthorized', 'busy', 'error', 'protocol_error', 'tool_error']);

function digest(value) {
  const text = String(value ?? '');
  return JSON.stringify({ sha256: crypto.createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) });
}

function getAuditDB() {
  if (db) return db;
  db = new Database(AUDIT_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      client TEXT NOT NULL DEFAULT '',
      tool TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT ''
    )
  `);
  if (!db.prepare('PRAGMA table_info(mcp_audit)').all().some(column => column.name === 'request_id')) {
    db.exec("ALTER TABLE mcp_audit ADD COLUMN request_id TEXT NOT NULL DEFAULT ''");
  }
  insertStmt = db.prepare(
    'INSERT INTO mcp_audit (client, tool, args_json, status, row_count, duration_ms, error, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  return db;
}

function audit(entry) {
  getAuditDB();
  insertStmt.run(
    entry.client ? digest(entry.client) : '',
    KNOWN_TOOLS.has(entry.tool) ? entry.tool : `unknown:${crypto.createHash('sha256').update(String(entry.tool || '')).digest('hex')}`,
    digest(entry.argsJson),
    KNOWN_STATUSES.has(entry.status || 'ok') ? (entry.status || 'ok') : 'error',
    Number.isInteger(entry.rowCount) ? entry.rowCount : 0,
    Number.isInteger(entry.durationMs) ? entry.durationMs : 0,
    entry.error ? digest(entry.error) : '',
    /^[0-9a-f-]{36}$/.test(entry.requestId || '') ? entry.requestId : crypto.randomUUID()
  );
}

function closeAudit() {
  if (db) {
    db.close();
    db = null;
    insertStmt = null;
  }
}

module.exports = { audit, closeAudit, AUDIT_DB_PATH };
