/**
 * Eagleye — Rate Limiting
 *
 * Sliding-window limiter for the unauthenticated auth endpoints. The origin is
 * published through a Cloudflare tunnel, so /api/auth/login and friends are
 * reachable from the internet with no brake other than bcrypt's cost.
 *
 * Keying note: every tunnelled request reaches the origin from 127.0.0.1, so
 * keying on the socket address alone would make the limiter global — one
 * attacker would lock out the real user. cloudflared overwrites CF-Connecting-IP
 * on the way in, so trusting it is correct here; spoofing it requires already
 * having local access to the origin, which is a far higher bar.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const MAX_TRACKED_KEYS = 10000;

function clientKey(req) {
  return (
    req.headers?.['cf-connecting-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

/**
 * Record an attempt and report whether the caller is over budget.
 * Returns { limited, remaining, retryAfterSec }.
 */
function hit(store, key, now = Date.now(), opts = {}) {
  const windowMs = opts.windowMs || WINDOW_MS;
  const max = opts.max || MAX_ATTEMPTS;

  const recent = (store.get(key) || []).filter((t) => now - t < windowMs);

  if (recent.length >= max) {
    store.set(key, recent);
    const retryAfterSec = Math.ceil((windowMs - (now - recent[0])) / 1000);
    return { limited: true, remaining: 0, retryAfterSec };
  }

  recent.push(now);
  store.set(key, recent);

  // Bound memory: drop the coldest keys once the map gets large. Unbounded
  // growth here would be a remote memory-exhaustion vector on a public origin.
  if (store.size > MAX_TRACKED_KEYS) {
    for (const [k, times] of store) {
      if (!times.length || now - times[times.length - 1] >= windowMs) store.delete(k);
    }
  }

  return { limited: false, remaining: max - recent.length, retryAfterSec: 0 };
}

/** Clear a key's budget — call after a successful login so real users aren't punished. */
function reset(store, key) {
  store.delete(key);
}

const _authStore = new Map();

/** Convenience wrapper bound to the shared auth store. */
function checkAuthAttempt(req) {
  return hit(_authStore, clientKey(req));
}

function resetAuthAttempts(req) {
  reset(_authStore, clientKey(req));
}

module.exports = {
  clientKey,
  hit,
  reset,
  checkAuthAttempt,
  resetAuthAttempts,
  WINDOW_MS,
  MAX_ATTEMPTS,
  _authStore,
};
