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

module.exports = { parsePublishedDate, normalizeDigestDate, compactDigestDate, todayDigestDate, backfillPublishedProvenance };
