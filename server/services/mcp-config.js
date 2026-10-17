/**
 * Eagleye — MCP Server Configuration
 *
 * Admin switch for the MCP data service. Stored in the user_data table under
 * the global scope (user_id ''), following the user-data getValue/setValue
 * pattern. The MCP process reads the same row with a read-only connection:
 *
 *   SELECT value FROM user_data WHERE key = 'mcp_server_config' AND user_id = ''
 *
 * Default on: a missing row reads back { enabled: true }. Fail-closed on
 * corruption: unparseable JSON or a non-boolean enabled field reads
 * { enabled: false }.
 */

const { getValue, setValue } = require('../db/user-data');
const { getDB } = require('../db/connection');

const CONFIG_KEY = 'mcp_server_config';

function getMcpServerConfig() {
  const stored = getValue(CONFIG_KEY);
  if (stored === null || stored === undefined) {
    // getValue returns null for both a missing row and unparseable JSON; a raw
    // row probe keeps corruption fail-closed while absence defaults to on.
    return { enabled: !rawConfigRowExists() };
  }
  if (stored && typeof stored === 'object' && !Array.isArray(stored) && typeof stored.enabled === 'boolean') {
    return { enabled: stored.enabled };
  }
  return { enabled: false };
}

function rawConfigRowExists() {
  const db = getDB();
  if (!db) return false;
  return Boolean(db.prepare("SELECT 1 FROM user_data WHERE key = ? AND user_id = ''").get(CONFIG_KEY));
}

function saveMcpServerConfig({ enabled } = {}) {
  if (typeof enabled !== 'boolean') {
    throw new Error('MCP server config requires a boolean "enabled" field');
  }
  setValue(CONFIG_KEY, { enabled });
  return { enabled };
}

module.exports = { getMcpServerConfig, saveMcpServerConfig, CONFIG_KEY };
