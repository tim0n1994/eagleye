/**
 * R0-02 date contract (plan §4.2): raw source timestamps are preserved,
 * parsed timestamps are stored normalized, and precision/parse status travel
 * with the value. Day-only source dates never gain fake second precision,
 * unknown dates never masquerade as fetch time (OBS-01), and digest dates
 * are canonical YYYY-MM-DD with legacy compact values accepted on read.
 */

'use strict';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const COMPACT_DATE = /^\d{8}$/;

/**
 * Parse a raw source timestamp into the contract triple. Accepts anything
 * ECMAScript Date.parse understands (ISO 8601, RFC 5322 RSS dates, ...).
 * @param {string | null | undefined} raw
 * @returns {{ iso: string | null, precision: 'day' | 'second' | 'unknown', status: 'ok' | 'unparseable' | 'missing' }}
 */
function parsePublishedDate(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { iso: null, precision: 'unknown', status: 'missing' };
  const ts = Date.parse(text);
  if (!Number.isFinite(ts)) return { iso: null, precision: 'unknown', status: 'unparseable' };
  return {
    iso: new Date(ts).toISOString(),
    precision: ISO_DATE.test(text) ? 'day' : 'second',
    status: 'ok',
  };
}

/**
 * Accept both the canonical YYYY-MM-DD form and the legacy compact YYYYMMDD
 * form at API boundaries. Returns the canonical form, or null when the value
 * is neither (callers decide between 400 and fallback).
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
function normalizeDigestDate(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (ISO_DATE.test(text)) return text;
  if (COMPACT_DATE.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return null;
}

/**
 * Canonical-to-compact digest date (YYYY-MM-DD -> YYYYMMDD). Connectors and
 * feed filters compare compact day strings; API and storage use canonical.
 * Returns null for values that are neither form.
 */
function compactDigestDate(value) {
  const canonical = normalizeDigestDate(value);
  return canonical ? canonical.replace(/-/g, '') : null;
}

/** Local-calendar today in canonical form (the writer's timezone basis). */
function todayDigestDate(now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ---------------------------------------------------------------------------
// D2 fetch-window contract (decision D2, Round 1): "new" is a time window,
// not a calendar-day equality. The daily 01:00 Asia/Shanghai pipeline used to
// require digest_date (local calendar) == the item's UTC calendar day, which
// skipped every cross-UTC-day item. Items are new when their publish time
// falls inside [now - LOOKBACK, now + future tolerance] (closed interval).
// ---------------------------------------------------------------------------

const HOUR_MS = 3600e3;
const DEFAULT_FETCH_LOOKBACK_HOURS = 36;
const DEFAULT_FETCH_FUTURE_HOURS = 1;
// Repo convention for source-fetch tuning knobs follows SOURCE_TIMEOUT_MS,
// so the lookback override is SOURCE_LOOKBACK_HOURS (positive number).
const LOOKBACK_HOURS_ENV = 'SOURCE_LOOKBACK_HOURS';

function envPositiveHours(name) {
  const raw = process.env ? process.env[name] : undefined;
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Default lookback (hours), overridable via SOURCE_LOOKBACK_HOURS. */
function fetchLookbackHours() {
  return envPositiveHours(LOOKBACK_HOURS_ENV) ?? DEFAULT_FETCH_LOOKBACK_HOURS;
}

/**
 * Resolve a publish timestamp to epoch milliseconds. Accepts epoch
 * milliseconds (number), 'YYYYMMDD' compact strings (resolved to that day's
 * UTC midnight), plus any Date.parse-able string and Date-like objects.
 * @param {number | string | Date | null | undefined} published
 * @returns {number | null} epoch ms, or null when missing/unparseable
 */
function resolvePublishedMs(published) {
  if (typeof published === 'number') return Number.isFinite(published) ? published : null;
  if (typeof published === 'string') {
    const text = published.trim();
    if (!text) return null;
    if (COMPACT_DATE.test(text)) {
      return Date.UTC(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)));
    }
    const ts = Date.parse(text);
    return Number.isFinite(ts) ? ts : null;
  }
  if (published && typeof published.getTime === 'function') {
    const ts = published.getTime();
    return Number.isFinite(ts) ? ts : null;
  }
  return null;
}

/**
 * D2 time-window freshness test. An item is "new" when its publish time is
 * within the closed interval [now - lookbackHours, now + futureHours]
 * (defaults 36h back / 1h ahead). Missing or unparseable input is always
 * outside the window. All connectors share this single implementation.
 *
 * @param {number | string | Date | null | undefined} published epoch ms,
 *        'YYYYMMDD'/'YYYY-MM-DD' string, or Date-like
 * @param {{ now?: number, lookbackHours?: number, futureHours?: number }} [options]
 * @returns {boolean}
 */
function isWithinFetchWindow(published, options) {
  const opts = options || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const lookbackHours = Number.isFinite(opts.lookbackHours) && opts.lookbackHours > 0
    ? opts.lookbackHours
    : fetchLookbackHours();
  const futureHours = Number.isFinite(opts.futureHours) && opts.futureHours > 0
    ? opts.futureHours
    : DEFAULT_FETCH_FUTURE_HOURS;
  const ts = resolvePublishedMs(published);
  if (ts === null) return false;
  return ts >= now - lookbackHours * HOUR_MS && ts <= now + futureHours * HOUR_MS;
}

/**
 * Boot-time backfill for rows written before the contract existed. Idempotent:
 * only rows without a parse status are touched, and the original string is
 * always preserved in published_raw. Unparseable dates become NULL published_at
 * so they can no longer poison lexicographic range queries; sorting treats
 * NULLs as unknown and keeps them last.
 * @param {import('better-sqlite3').Database} db
 * @returns {{ scanned: number, ok: number, unparseable: number, missing: number }}
 */
function backfillPublishedProvenance(db) {
  if (!db) return { scanned: 0, ok: 0, unparseable: 0, missing: 0 };
  const rows = db.prepare(
    'SELECT id, published_at FROM information_items WHERE published_parse_status IS NULL'
  ).all();
  const update = db.prepare(
    'UPDATE information_items SET published_at = ?, published_raw = ?, published_precision = ?, published_parse_status = ? WHERE id = ?'
  );
  const tally = { scanned: rows.length, ok: 0, unparseable: 0, missing: 0 };
  db.transaction(() => {
    for (const row of rows) {
      const parsed = parsePublishedDate(row.published_at);
      update.run(
        parsed.iso,
        typeof row.published_at === 'string' ? row.published_at : null,
        parsed.precision,
        parsed.status,
        row.id,
      );
      tally[parsed.status] += 1;
    }
  })();
  return tally;
}

module.exports = {
  parsePublishedDate,
  normalizeDigestDate,
  compactDigestDate,
  todayDigestDate,
  backfillPublishedProvenance,
  isWithinFetchWindow,
  fetchLookbackHours,
};
