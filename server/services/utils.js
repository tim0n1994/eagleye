/**
 * Eagleye — Server Utilities
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { setTimeout: timersSleep } = require('node:timers/promises');

const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 16, timeout: 30000, proxyEnv: process.env });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 16, timeout: 30000, proxyEnv: process.env });

function generateId() {
  return crypto.randomUUID();
}

// ─── Round 2 · CTO 03:40 — network-class retry with backoff ──────────────
// Root cause on record: a one-second upstream blip of the egress proxy
// (01:00:43) TLS-disconnected 14 proxied sources in the same second and every
// source gave up on its first failure. Network-class failures now back off
// 10s → 45s (max 2 retries = 3 requests); definitive failures (HTTP 4xx incl.
// 304, and parse errors which happen in connectors above this layer) never
// retry and keep today's exact error text (`Upstream <status>: <body>`).
//
// ─── 案1 · CTO 2026-10-22 morning — backoff × per-source budget ──────────
// Incident on record: 2026-10-22 01:00 the OLD table (30s → 120s) plus one
// request timeout each burned straight through the 180s per-source budget —
// three sources (app-store-trend / physical-ai-cn-photonics /
// physical-ai-humanoid) ended as "exceeded 180000ms budget" ERRORED instead
// of surfacing their last network error, while the egress proxy logged 12
// connection errors that fanned out into 9 retries. Two-part fix:
//   1. the table itself is shortened to 10s → 45s;
//   2. withFetchRetry is budget-aware: a retry may only start when the
//      remaining budget covers one full backoff plus one more request, so a
//      constrained source ends on its LAST network error, not on a budget
//      timeout that ate the backoff. RETRY_BACKOFF_MS is exported so tests
//      and behavior assert one shared source of truth.
const RETRY_BACKOFF_MS = [10000, 45000];
// Worst-case cost of ONE more request, for the budget check in
// withFetchRetry: fetchOnce bounds a single attempt by its request timeout
// (default FETCH_TIMEOUT_MS=15000, utils.js fetchOnce). Deliberately a fixed
// constant — the retry decision must not depend on ambient env at decision
// time — and it matches that default. "One more retry fits" therefore means
// remaining >= backoff + 15s.
const RETRY_REQUEST_COST_MS = 15000;
const TLS_DISCONNECT_MSG = 'Client network socket disconnected before secure TLS connection was established';

/**
 * Per-source fetch context ({ stats, signal, deadline }) propagated implicitly
 * from fetchSource to every fetchURL call a connector makes. None of the 17
 * connector call sites forward opts.stats (or, bar rss.js, signal) today, so
 * without this the retry counter could never reach the per-source envelope.
 * `deadline` (案1) carries fetchSource's per-source budget epoch-ms so every
 * connector's retries become budget-aware with zero connector changes.
 * Explicit options always win over the ambient context.
 */
const fetchContext = new AsyncLocalStorage();
function runWithFetchContext(store, fn) {
  return fetchContext.run(store, fn);
}

/**
 * Ambient per-source fetch deadline (epoch ms) from the fetchSource context,
 * or null when no context is active. P0 热修 B① (2026-10-23): lets a connector
 * bound its per-feed work by the source budget without fetchSource threading
 * `deadline` through every connector's opts.
 */
function currentFetchDeadline() {
  const dl = fetchContext.getStore()?.deadline;
  return Number.isFinite(dl) ? Number(dl) : null;
}

/**
 * Classify a fetch failure. Retryable = network class: TLS disconnect (by
 * message — Node emits it as code ECONNRESET, but middleware may rewrap it and
 * keep only the text), ECONNRESET, ETIMEDOUT (incl. our own idle-timeout
 * abort), 'socket hang up', HTTP 5xx. Native fetch (undici) wraps transport
 * failures as `TypeError: fetch failed` with the real error on `.cause`
 * (codes ECONNRESET / ETIMEDOUT / UND_ERR_CONNECT_TIMEOUT / UND_ERR_SOCKET /
 * UND_ERR_*_TIMEOUT), so the cause chain is classified too. Not retryable =
 * cancellation (AbortError), HTTP 4xx and 304, anything else.
 */
function isRetryableFetchError(err, depth = 0) {
  if (!err || typeof err !== 'object') return false;
  if (err.name === 'AbortError') return false;
  if (depth < 3 && err.cause && typeof err.cause === 'object' && err.cause !== err
    && isRetryableFetchError(err.cause, depth + 1)) return true;
  const code = String(err.code || '');
  const msg = String(err.message || '');
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT') return true;
  if (/^UND_ERR_(CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT|BODY_TIMEOUT)$/.test(code)) return true;
  if (msg.includes(TLS_DISCONNECT_MSG)) return true;
  if (/socket hang up|ECONNRESET|ETIMEDOUT/i.test(msg)) return true;
  const status = Number(err.upstreamStatus ?? (msg.match(/^Upstream (\d{3})\b/) || [])[1]);
  return status >= 500 && status <= 599;
}

function defaultSleep(ms, { signal } = {}) {
  return timersSleep(ms, undefined, { signal });
}

/**
 * Run `attempt({ signal })` under the shared network-retry policy — the one
 * place the backoff schedule, the classifier, the injectable sleep and the
 * stats counter live. fetchURL is built on it; transports that bypass
 * fetchURL (rss.js uses Node's native fetch on the production runtime) wrap
 * their single-request function in it so every source gets the same policy.
 *   options.signal / stats / sleep / deadline — explicit, else the ambient
 *   fetchSource context (runWithFetchContext), else none / default timer.
 *   options.deadline — epoch ms (same semantics as fetchSource's
 *   Date.now() + SOURCE_TIMEOUT_MS). Before each retry the remaining budget
 *   must cover one full backoff plus one more request
 *   (RETRY_REQUEST_COST_MS); otherwise the LAST error is rethrown as-is —
 *   no sleep, no new request (案1: backoffs must never eat through the
 *   per-source budget). No deadline → unlimited (retry the full table).
 *   options.label — for the retry log line.
 */
async function withFetchRetry(attempt, options = {}) {
  const store = fetchContext.getStore();
  const signal = options.signal ?? store?.signal;
  const stats = (options.stats && typeof options.stats === 'object') ? options.stats
    : (store?.stats && typeof store.stats === 'object') ? store.stats : null;
  const sleep = typeof options.sleep === 'function' ? options.sleep
    : typeof store?.sleep === 'function' ? store.sleep : defaultSleep;
  const rawDeadline = options.deadline ?? store?.deadline;
  const deadline = Number.isFinite(rawDeadline) ? Number(rawDeadline) : null;
  const label = options.label || 'fetch';
  signal?.throwIfAborted();
  let retries = 0;
  try {
    for (;;) {
      try {
        return await attempt({ signal });
      } catch (err) {
        if (retries >= RETRY_BACKOFF_MS.length || !isRetryableFetchError(err)) throw err;
        signal?.throwIfAborted();
        const waitMs = RETRY_BACKOFF_MS[retries];
        // 案1: budget-aware retry. A retry is only worth starting when the
        // remaining budget fits the whole round — backoff AND one more
        // request. If it does not, rethrow the last error untouched so the
        // source reports its network error instead of timing out mid-backoff
        // ("exceeded <budget>ms budget" ERRORED, the 01:00 incident shape).
        if (deadline !== null) {
          const remainingMs = deadline - Date.now();
          if (remainingMs < waitMs + RETRY_REQUEST_COST_MS) {
            console.warn(`  ⏱ fetch retry skipped — ${Math.round(remainingMs / 1000)}s left of budget < ${Math.round(waitMs / 1000)}s backoff + ${Math.round(RETRY_REQUEST_COST_MS / 1000)}s request — ${label}: ${err.message}`);
            throw err;
          }
        }
        retries += 1;
        console.warn(`  ↻ fetch retry ${retries}/${RETRY_BACKOFF_MS.length} in ${Math.round(waitMs / 1000)}s — ${label}: ${err.message}`);
        await sleep(waitMs, { signal });
        signal?.throwIfAborted();
      }
    }
  } finally {
    if (stats) stats.retries = (Number.isFinite(stats.retries) ? stats.retries : 0) + retries;
  }
}

/** One HTTP(S) request; rejects with the historical error shapes/texts. */
function fetchOnce(targetUrl, options, signal) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const timeoutMs = options.timeoutMs || parseInt(process.env.FETCH_TIMEOUT_MS || '15000', 10);
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      signal,
      agent: isHttps ? HTTPS_AGENT : HTTP_AGENT,
      headers: {
        'User-Agent': 'EagleyeBot/1.0',
        'Accept': 'application/json, application/xml, text/xml, */*',
        'Connection': 'keep-alive',
        ...options.headers,
      },
    };

    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(reqOpts, (proxyRes) => {
      const chunks = [];
      proxyRes.on('error', reject);
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          resolve(body);
        } else {
          // Text kept byte-identical to the pre-retry era: rss.js keys its
          // conditional-request path on `Upstream 304`. The status rides
          // along as a property so the retry classifier need not re-parse.
          const err = new Error(`Upstream ${proxyRes.statusCode}: ${body.slice(0, 200)}`);
          err.upstreamStatus = proxyRes.statusCode;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      const err = new Error('Request timeout');
      err.code = 'ETIMEDOUT';
      reject(err);
    });
    req.end();
  });
}

/**
 * fetchURL(url, options)
 *   options.timeoutMs / headers / signal — as before.
 *   options.sleep(ms, { signal })        — injectable backoff timer (tests never wait).
 *   options.stats                        — counter channel: stats.retries accumulates
 *                                          across calls sharing one stats object and is
 *                                          always set to a number (0 when nothing retried).
 *   options.deadline                     — epoch ms budget (案1): forwarded to
 *                                          withFetchRetry; a retry only starts when the
 *                                          remaining budget covers backoff + one request.
 *                                          Overrides the ambient fetchSource deadline.
 * Without explicit stats/signal/deadline the ambient fetchSource context (see
 * runWithFetchContext) is used, so every connector gets counted, cancelled and
 * budget-constrained. Retry policy lives in withFetchRetry.
 */
function fetchURL(targetUrl, options = {}) {
  return withFetchRetry(({ signal }) => fetchOnce(targetUrl, options, signal), {
    signal: options.signal,
    stats: options.stats,
    sleep: options.sleep,
    deadline: options.deadline,
    label: targetUrl,
  });
}

/**
 * Simple hash for deduplication
 */
function contentHash(text) {
  if (!text) return '';
  return crypto.createHash('md5').update(text).digest('hex');
}

/**
 * Escape a string for safe use in XML/Atom feeds.
 */
function escapeXML(str) {
  return String(str || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { generateId, fetchURL, contentHash, escapeXML, runWithFetchContext, currentFetchDeadline, withFetchRetry, isRetryableFetchError, RETRY_BACKOFF_MS };
