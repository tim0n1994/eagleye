// @vitest-environment node
/* global describe, it, expect */
const Database = require('better-sqlite3');
const { parsePublishedDate, normalizeDigestDate, todayDigestDate, backfillPublishedProvenance } = require('../date-contract');

describe('R0 date contract', () => {
  it('parses raw timestamps into the provenance triple', () => {
    expect(parsePublishedDate('2026-09-09')).toEqual({ iso: '2026-09-09T00:00:00.000Z', precision: 'day', status: 'ok' });
    expect(parsePublishedDate('Wed, 09 Sep 2026 01:00:00 GMT')).toEqual({ iso: '2026-09-09T01:00:00.000Z', precision: 'second', status: 'ok' });
    expect(parsePublishedDate('not-a-date')).toEqual({ iso: null, precision: 'unknown', status: 'unparseable' });
    expect(parsePublishedDate('')).toEqual({ iso: null, precision: 'unknown', status: 'missing' });
    expect(parsePublishedDate(null)).toEqual({ iso: null, precision: 'unknown', status: 'missing' });
  });

  it('normalizes digest dates in both accepted forms and rejects the rest', () => {
    expect(normalizeDigestDate('2026-09-09')).toBe('2026-09-09');
    expect(normalizeDigestDate('20260909')).toBe('2026-09-09');
    expect(normalizeDigestDate(' 20260909 ')).toBe('2026-09-09');
    expect(normalizeDigestDate('2026/09/09')).toBeNull();
    expect(normalizeDigestDate('')).toBeNull();
    expect(normalizeDigestDate(undefined)).toBeNull();
  });

  it('formats local-calendar today as canonical YYYY-MM-DD', () => {
    expect(todayDigestDate(new Date(2026, 8, 9, 23, 59))).toBe('2026-09-09');
  });

  it('backfills provenance once, preserves raw strings and quarantines unparseable dates', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE information_items (id TEXT PRIMARY KEY, published_at TEXT, published_raw TEXT, published_precision TEXT, published_parse_status TEXT)');
    const ins = db.prepare('INSERT INTO information_items (id, published_at) VALUES (?, ?)');
    ins.run('iso-day', '2026-09-09');
    ins.run('rfc', 'Wed, 09 Sep 2026 01:00:00 GMT');
    ins.run('junk', 'definitely not a date');
    ins.run('absent', null);
    expect(backfillPublishedProvenance(db)).toEqual({ scanned: 4, ok: 2, unparseable: 1, missing: 1 });
    const junk = db.prepare('SELECT published_at, published_raw, published_precision, published_parse_status FROM information_items WHERE id = ?').get('junk');
    expect(junk).toEqual({ published_at: null, published_raw: 'definitely not a date', published_precision: 'unknown', published_parse_status: 'unparseable' });
    const absent = db.prepare('SELECT published_parse_status FROM information_items WHERE id = ?').get('absent');
    expect(absent).toEqual({ published_parse_status: 'missing' });
    expect(backfillPublishedProvenance(db).scanned).toBe(0);
    db.close();
  });
});
