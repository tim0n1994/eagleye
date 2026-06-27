/**
 * Eagleye — agent-reach Bridge
 *
 * A thin Node wrapper around the agent-reach CLI backends (twitter-cli, opencli,
 * `agent-reach doctor`). It lets connectors shell out to agent-reach the same
 * way the rest of the server shells out to the KG worker (see kg-worker.js).
 *
 * Why this exists:
 *  - agent-reach backends are CLIs, not Node libraries.
 *  - Each backend emits a different shape (twitter-cli wraps an
 *    {ok,schema_version,data} envelope; opencli returns bare JSON arrays).
 *    This module normalizes them into one result object connectors can branch on.
 *
 * Result shape (runReach NEVER rejects — connectors check `result.ok`):
 *   { ok: true,  data: Array|Object, raw: <parsed>, stdout, stderr }
 *   { ok: false, code: 'AUTH_REQUIRED'|'NOT_FOUND'|'TIMEOUT'|'ENOENT'|
 *                   'BRIDGE_DOWN'|'PARSE_ERROR'|'EXIT_<n>', message, stdout, stderr }
 *
 * The auth/bridge error codes let connectors degrade gracefully (e.g. the
 * X-Following connector falls back to Jina Reader when twitter-cli cookies
 * expire; opencli connectors return [] when the Chrome bridge is down).
 */

const { spawn } = require('child_process');

// ─── Binary resolution ───────────────────────────────────────────────────
// Bins are expected on PATH (server is launched from the user's shell). Allow
// absolute-path overrides for non-PATH environments.

const TWITTER_BIN = process.env.AGENT_REACH_TWITTER_BIN || 'twitter';
const OPENCLI_BIN = process.env.AGENT_REACH_OPENCLI_BIN || 'opencli';
const REACH_BIN = process.env.AGENT_REACH_BIN || 'agent-reach';

const DEFAULT_TIMEOUT_MS = parseInt(process.env.AGENT_REACH_TIMEOUT_MS || '90000', 10);
// opencli drives real Chrome, so each call is multi-second. twitter-cli is faster.
const OPENCLI_TIMEOUT_MS = parseInt(process.env.AGENT_REACH_OPENCLI_TIMEOUT_MS || '120000', 10);

function tail(text, length = 2000) {
  return String(text || '').slice(-length);
}

/**
 * Classify a non-zero exit / stderr blob into a stable error code.
 * Order matters: AUTH_REQUIRED is actionable (re-login), BRIDGE_DOWN means the
 * opencli Chrome bridge itself is offline.
 */
function classifyError(stdout, stderr, exitCode, signal) {
  const blob = `${stdout}\n${stderr}`;
  if (signal === 'SIGTERM' || /timeout|timed out/i.test(blob)) return { code: 'TIMEOUT', message: 'agent-reach command timed out' };
  if (/AUTH_REQUIRED|not.*log(?:ged)?\s*in|login\s*(?:required|expired)|unauthor/i.test(blob)) {
    return { code: 'AUTH_REQUIRED', message: 'login required or session expired' };
  }
  if (/bridge|connectivity|extension|daemon|ECONNREF.*19825/i.test(blob)) {
    return { code: 'BRIDGE_DOWN', message: 'opencli browser bridge unavailable (is Chrome open?)' };
  }
  if (/not_found|HTTP 404|404:\s/i.test(blob)) return { code: 'NOT_FOUND', message: 'endpoint not found (platform API changed?)' };
  return { code: `EXIT_${exitCode ?? 'null'}`, message: tail(stderr, 500) || tail(stdout, 500) || `exit ${exitCode} ${signal || ''}` };
}

/**
 * Parse JSON output according to the backend's envelope convention.
 *  - 'cli-json'     : twitter-cli `--json` → {ok, schema_version, data, error:{code,message}}
 *  - 'opencli-json' : opencli `-f json`    → bare array (or bare object)
 *  - 'json'         : best-effort last-JSON-line parse (kg-worker style)
 */
function parseJSON(stdout, jsonMode) {
  if (jsonMode === 'opencli-json') {
    const parsed = JSON.parse(String(stdout).trim());
    return { ok: true, data: Array.isArray(parsed) ? parsed : [parsed], raw: parsed };
  }
  if (jsonMode === 'cli-json') {
    const env = JSON.parse(String(stdout).trim());
    if (env && env.ok === true) return { ok: true, data: Array.isArray(env.data) ? env.data : [env.data], raw: env };
    if (env && env.ok === false) {
      const e = env.error || {};
      return { ok: false, code: e.code || 'ERROR', message: e.message || 'twitter-cli returned ok:false', raw: env };
    }
    return { ok: false, code: 'PARSE_ERROR', message: 'twitter-cli envelope missing ok field', raw: env };
  }
  // 'json' — last parseable line
  const lines = String(stdout).trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      return { ok: true, data: Array.isArray(parsed) ? parsed : [parsed], raw: parsed };
    } catch { /* try previous line */ }
  }
  return { ok: false, code: 'PARSE_ERROR', message: 'no parseable JSON in stdout' };
}

/**
 * Spawn an agent-reach backend command and resolve with a normalized result.
 * Never rejects — callers inspect `result.ok`.
 *
 * @param {'twitter'|'opencli'|'agent-reach'} cmd
 * @param {string[]} args
 * @param {{timeoutMs?: number, jsonMode?: 'cli-json'|'opencli-json'|'json'}} [opts]
 */
function runReach(cmd, args, opts = {}) {
  const bin = cmd === 'twitter' ? TWITTER_BIN : cmd === 'opencli' ? OPENCLI_BIN : REACH_BIN;
  const timeoutMs = opts.timeoutMs ?? (cmd === 'opencli' ? OPENCLI_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const jsonMode = opts.jsonMode || 'json';

  return new Promise((resolve) => {
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('error', (err) => {
      const enoent = err && err.code === 'ENOENT';
      resolve({
        ok: false,
        code: enoent ? 'ENOENT' : 'SPAWN_ERROR',
        message: enoent ? `binary not found on PATH: ${bin} (set AGENT_REACH_*_BIN override)` : err.message,
        stdout,
        stderr,
      });
    });

    proc.on('close', (code, signal) => {
      if (code === 0) {
        try {
          const parsed = parseJSON(stdout, jsonMode);
          resolve({ ...parsed, stdout, stderr });
        } catch (err) {
          resolve({ ok: false, code: 'PARSE_ERROR', message: err.message, stdout, stderr });
        }
        return;
      }
      const classified = classifyError(stdout, stderr, code, signal);
      resolve({ ok: false, ...classified, stdout, stderr });
    });
  });
}

// ─── Convenience wrappers ────────────────────────────────────────────────

/**
 * Fetch recent posts from a Twitter/X user timeline via twitter-cli.
 * Uses the stable `user-posts` command (search is documented-unstable).
 * @returns {Promise<{ok, data, code?, message?}>}
 */
function twitterUserPosts(username, count = 10) {
  const handle = String(username).replace(/^@/, '');
  return runReach('twitter', ['user-posts', `@${handle}`, '-n', String(count), '--json'], {
    jsonMode: 'cli-json',
  });
}

/**
 * Fetch hot posts from a subreddit via opencli reddit.
 * NOTE: the `subreddit` subcommand names the upvote metric `upvotes`
 * (the `search` subcommand names it `score`). Connectors must read the right one.
 */
function redditSubreddit(subreddit, { sort = 'hot', limit = 20 } = {}) {
  return runReach('opencli', ['reddit', 'subreddit', String(subreddit).replace(/^r\//, ''), '--sort', sort, '--limit', String(limit), '-f', 'json'], {
    jsonMode: 'opencli-json',
  });
}

/**
 * Search XiaoHongShu notes via opencli. Each result carries a full `url`
 * containing the xsec_token required to read the full note later.
 */
function xiaohongshuSearch(keyword, { limit = 20 } = {}) {
  return runReach('opencli', ['xiaohongshu', 'search', String(keyword), '--limit', String(limit), '-f', 'json'], {
    jsonMode: 'opencli-json',
  });
}

// ─── Doctor (health / backend selection) ─────────────────────────────────

let doctorCache = { ts: 0, data: null };
const DOCTOR_TTL_MS = parseInt(process.env.AGENT_REACH_DOCTOR_TTL_MS || '600000', 10); // 10 min

/**
 * Return the agent-reach doctor map, cached for DOCTOR_TTL_MS.
 * Shape: { twitter: {status, active_backend, tier, backends[]}, reddit: {...}, ... }
 */
async function doctorStatus() {
  if (doctorCache.data && Date.now() - doctorCache.ts < DOCTOR_TTL_MS) {
    return doctorCache.data;
  }
  const result = await runReach('agent-reach', ['doctor', '--json'], { jsonMode: 'opencli-json', timeoutMs: 30000 });
  if (result.ok && result.raw && typeof result.raw === 'object' && !Array.isArray(result.raw)) {
    doctorCache = { ts: Date.now(), data: result.raw };
    return result.raw;
  }
  // doctor failed — return a minimal map so isReachReady can answer safely
  return null;
}

/**
 * Coarse readiness gate: is the platform's active backend installed/configured?
 * This does NOT verify live credentials — runtime auth errors surface via the
 * result.code of the actual call. Use this only to skip a backend that's clearly
 * absent (so a connector can fall back or no-op without a slow timeout).
 */
async function isReachReady(platform) {
  const status = await doctorStatus();
  if (!status || !status[platform]) return true; // unknown → be permissive, let the call decide
  const p = status[platform];
  return p.status === 'ok' && p.active_backend !== undefined && p.active_backend !== null;
}

/** Invalidate the doctor cache (e.g. after a backend is reconfigured at runtime). */
function invalidateDoctorCache() {
  doctorCache = { ts: 0, data: null };
}

module.exports = {
  runReach,
  twitterUserPosts,
  redditSubreddit,
  xiaohongshuSearch,
  doctorStatus,
  isReachReady,
  invalidateDoctorCache,
};
