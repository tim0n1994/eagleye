/**
 * Eagleye — X Following Config
 *
 * Reads either a newline/comma-separated account list or a Twitter/X following
 * export JSON array. The repo-local config path is the default so the app can
 * run without writing outside the project workspace.
 */

const fs = require('fs');
const path = require('path');

const REPO_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'x-following.txt');
const HOME_CONFIG_PATH = path.join(process.env.HOME || '/root', '.eagleye', 'x-following.txt');
const BLOCKLIST_PATH = path.join(__dirname, '..', '..', 'config', 'x-following-blocklist.txt');

function cleanHandle(value) {
  if (!value) return '';
  return String(value)
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(?:www\.)?(?:twitter|x)\.com\//i, '')
    .split(/[/?#]/)[0]
    .replace(/[^A-Za-z0-9_]/g, '');
}

function dedupeHandles(handles) {
  const seen = new Set();
  const out = [];
  for (const raw of handles) {
    const handle = cleanHandle(raw);
    if (!handle) continue;
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(handle);
  }
  return out;
}

function parseXFollowingText(text) {
  return dedupeHandles(text.split(/[\n,]/));
}

function parseXFollowingJSON(text, opts = {}) {
  const { includeProtected = false } = opts;
  const parsed = JSON.parse(text);
  const users = Array.isArray(parsed) ? parsed : (parsed.users || parsed.following || []);
  if (!Array.isArray(users)) {
    throw new Error('X following JSON must be an array or contain a users/following array');
  }

  return dedupeHandles(users
    .filter(user => user && user.following !== false)
    .filter(user => includeProtected || !user.protected)
    .map(user => user.screen_name || user.username || user.handle || user.url));
}

function parseXFollowingConfig(text, opts = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return parseXFollowingJSON(trimmed, opts);
  }
  return parseXFollowingText(trimmed);
}

function getConfigPathCandidates() {
  return [
    process.env.X_FOLLOWING_CONFIG_PATH,
    REPO_CONFIG_PATH,
    HOME_CONFIG_PATH,
  ].filter(Boolean);
}

function getWritableConfigPath() {
  return process.env.X_FOLLOWING_CONFIG_PATH || REPO_CONFIG_PATH;
}

function readXFollowingConfig() {
  for (const configPath of getConfigPathCandidates()) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const text = fs.readFileSync(configPath, 'utf8');
      return {
        users: parseXFollowingConfig(text),
        path: configPath,
        exists: true,
        source: configPath === REPO_CONFIG_PATH ? 'repo' : (configPath === HOME_CONFIG_PATH ? 'home' : 'env'),
      };
    } catch (err) {
      return { users: [], path: configPath, exists: false, error: err.message };
    }
  }
  return { users: [], path: getWritableConfigPath(), exists: false, source: 'default' };
}

function writeXFollowingConfig(users) {
  const configPath = getWritableConfigPath();
  const cleaned = dedupeHandles(users);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, cleaned.join('\n') + '\n', 'utf8');
  return { users: cleaned, path: configPath };
}

// ─── Blocklist ──────────────────────────────────────────────────────────
// Blocked X handles are excluded from saveItems (no new items enter the DB)
// and can be purged from signal_scores via the cleanup API.

function readBlocklist() {
  const envList = (process.env.X_FOLLOWING_BLOCKLIST || '').split(',').map(s => s.trim()).filter(Boolean);
  let handles = [];
  try {
    if (fs.existsSync(BLOCKLIST_PATH)) {
      handles = parseXFollowingText(fs.readFileSync(BLOCKLIST_PATH, 'utf8'));
    }
  } catch { /* ignore read errors */ }
  // Merge env + file, dedupe (lowercase keys)
  const merged = new Set();
  for (const h of [...handles, ...envList]) {
    const clean = cleanHandle(h).toLowerCase();
    if (clean) merged.add(clean);
  }
  return merged;
}

function getBlocklistArray() {
  return [...readBlocklist()].sort();
}

function writeBlocklist(handles) {
  const cleaned = dedupeHandles(handles);
  fs.mkdirSync(path.dirname(BLOCKLIST_PATH), { recursive: true });
  fs.writeFileSync(BLOCKLIST_PATH, cleaned.join('\n') + '\n', 'utf8');
  return { users: cleaned, path: BLOCKLIST_PATH };
}

/** Check if an author string ('@username') is in the blocklist. */
function isBlocked(author, blocklist) {
  if (!author || !blocklist || blocklist.size === 0) return false;
  const handle = cleanHandle(author).toLowerCase();
  return handle ? blocklist.has(handle) : false;
}

module.exports = {
  REPO_CONFIG_PATH,
  HOME_CONFIG_PATH,
  BLOCKLIST_PATH,
  cleanHandle,
  dedupeHandles,
  parseXFollowingConfig,
  parseXFollowingJSON,
  parseXFollowingText,
  readXFollowingConfig,
  writeXFollowingConfig,
  readBlocklist,
  getBlocklistArray,
  writeBlocklist,
  isBlocked,
};
