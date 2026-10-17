/* global describe, it, expect, beforeEach, afterEach */
// @vitest-environment node
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildCrossSourceEvidence, resourceKey } = require('../cross-source-evidence');
const { getDB, closeDB } = require('../../db/connection');
const { scoreSignals } = require('../signals-score');

function createItems(db) {
  db.exec(`CREATE TABLE information_items (
    id TEXT PRIMARY KEY, source_id TEXT, canonical_url TEXT, digest_date TEXT,
    title TEXT DEFAULT 'Introducing a model', created_at TEXT
  ); CREATE INDEX date_idx ON information_items(digest_date);`);
}

function add(db, id, source = 'a', url = 'https://example.com/article', date = '2026-01-10') {
  db.prepare('INSERT INTO information_items (id, source_id, canonical_url, digest_date) VALUES (?, ?, ?, ?)')
    .run(id, source, url, date);
  return { id, digest_date: date, title: 'Introducing a model', source_slug: 'test' };
}

describe('conservative resource identity', () => {
  it('removes only recognized tracking parameters', () => {
    expect(resourceKey('https://example.com/read?id=17&utm_source=feed&fbclid=abc'))
      .toBe(resourceKey('https://example.com/read?id=17'));
    expect(resourceKey('https://news.ycombinator.com/item?id=1'))
      .not.toBe(resourceKey('https://news.ycombinator.com/item?id=2'));
  });

  it('preserves identity in subdomains, fragments, paths and version suffixes', () => {
    for (const [a, b] of [
      ['https://news.example.com/post', 'https://example.com/post'],
      ['https://example.com/#/article/1', 'https://example.com/#/article/2'],
      ['https://example.com/model-v1', 'https://example.com/model-v2'],
      ['https://example.com/read?article=1', 'https://example.com/read?article=2'],
    ]) expect(resourceKey(a)).not.toBe(resourceKey(b));
  });

  it('rejects missing, invalid, non-web and homepage-only resources', () => {
    for (const raw of [null, '', 'bad url', 'javascript:alert(1)', 'https://example.com/?utm_source=x']) {
      expect(resourceKey(raw)).toBe('');
    }
  });
});

describe('cross-source batch evidence on SQLite', () => {
  let db;
  beforeEach(() => { db = new Database(':memory:'); createItems(db); });
  afterEach(() => db.close());

  it('gives no boost for unrelated daily sources, generic identical titles, or missing identity', () => {
    const subject = add(db, 'subject');
    for (let i = 0; i < 20; i++) add(db, `other${i}`, `source${i}`, `https://example.com/unrelated/${i}`);
    add(db, 'missing', 'missing-source', null);
    const evidence = buildCrossSourceEvidence(db, [subject, { id: 'missing' }]);
    expect(evidence.get('subject').score).toBe(0);
    expect(evidence.get('missing').score).toBe(0);
  });

  it('counts distinct OTHER sources once and retains a matching item reference', () => {
    const subject = add(db, 'subject');
    add(db, 'same-source');
    add(db, 'matching', 'b', 'https://example.com/article?utm_source=x');
    add(db, 'repeated', 'b');
    const result = buildCrossSourceEvidence(db, [subject]).get(subject.id);
    expect(result.score).toBe(0.1);
    expect(result.sources).toEqual([{ source_id: 'b', item_id: 'matching', digest_date: '2026-01-10' }]);
  });

  it('anchors the inclusive seven-day window to historical items and excludes future evidence', () => {
    const subject = add(db, 'subject');
    add(db, 'boundary', 'b', 'https://example.com/article', '2026-01-04');
    add(db, 'expired', 'c', 'https://example.com/article', '2026-01-03');
    add(db, 'future', 'd', 'https://example.com/article', '2026-01-11');
    const futureSubject = add(db, 'later', 'e', 'https://example.com/article', '2026-03-01');
    const result = buildCrossSourceEvidence(db, [subject, futureSubject]);
    expect(result.get(subject.id).sources.map(s => s.item_id)).toEqual(['boundary']);
    expect(result.get(subject.id).since).toBe('2026-01-04');
    expect(result.get(futureSubject.id).score).toBe(0);
  });

  it('does not merge different HN item IDs or invalid dates', () => {
    const a = add(db, 'a', 'a', 'https://news.ycombinator.com/item?id=1');
    const b = add(db, 'b', 'b', 'https://news.ycombinator.com/item?id=2');
    const c = add(db, 'c', 'c', 'https://news.ycombinator.com/item?id=1', '20260230');
    for (const result of buildCrossSourceEvidence(db, [a, b, c]).values()) expect(result.score).toBe(0);
  });

  it('caps the evidence and SQL query count even for a large repeated resource bucket', () => {
    const subjects = [];
    for (let i = 0; i < 1000; i++) subjects.push(add(db, `row${i}`, `source${i}`));
    let queries = 0;
    const instrumented = { prepare(sql) { queries++; return db.prepare(sql); } };
    const results = buildCrossSourceEvidence(instrumented, subjects);
    expect(queries).toBe(3); // Two ID chunks and one date-range statement.
    for (const [id, result] of results) {
      expect(result.score).toBe(1);
      expect(result.capped).toBe(true);
      expect(result.sources).toHaveLength(10);
      expect(result.sources.some(source => source.item_id === id)).toBe(false);
    }
  });
});

describe('scoreSignals isolated SQLite integration', () => {
  const previousPath = process.env.EAGLEYE_DB_PATH;
  afterEach(() => {
    closeDB();
    if (previousPath === undefined) delete process.env.EAGLEYE_DB_PATH;
    else process.env.EAGLEYE_DB_PATH = previousPath;
  });

  it('persists recomputable evidence and leaves unrequested historic scores intact without LLM calls', async () => {
    closeDB();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-cross-source-'));
    process.env.EAGLEYE_DB_PATH = path.join(directory, 'scores.sqlite');
    const db = getDB();
    expect(db.name).toBe(process.env.EAGLEYE_DB_PATH);
    createItems(db);
    db.exec(`CREATE TABLE source_profiles (source_slug TEXT);
      CREATE TABLE ai_summaries (item_id TEXT, ai_title TEXT, one_liner TEXT, short_summary TEXT);
      CREATE TABLE item_tags (item_id TEXT, tag_id TEXT);
      CREATE TABLE tags (id TEXT, name TEXT, type TEXT);
      CREATE TABLE signal_scores (item_id TEXT PRIMARY KEY, signal_type TEXT,
        novelty_score REAL, velocity_score REAL, cross_source_score REAL,
        source_quality_score REAL, thesis_match_score REAL, actionability_score REAL,
        alpha_score REAL, consensus_penalty REAL, evidence_summary TEXT);`);
    const subject = add(db, 'subject');
    add(db, 'duplicate', 'b');
    add(db, 'unrelated', 'c', 'https://example.com/other');
    db.prepare('INSERT INTO signal_scores (item_id, cross_source_score) VALUES (?, ?)').run('unrelated', 1);
    // Every title matches rules; the existing skip option supplies an empty LLM batch.
    expect(await scoreSignals([subject], { llmSkipRuleMatched: true, noRetry: true })).toEqual({ scored: 1 });
    const score = db.prepare('SELECT * FROM signal_scores WHERE item_id = ?').get(subject.id);
    expect(score.cross_source_score).toBe(0.1);
    expect(score.evidence_summary).toContain('b:duplicate@2026-01-10');
    expect(score.evidence_summary).toContain('2026-01-04–2026-01-10');
    expect(score.evidence_summary).toContain('不证明来源独立或内容真实');
    expect(score.alpha_score).toBeGreaterThan(0);
    expect(score.alpha_score).toBeLessThanOrEqual(1);
    expect(db.prepare('SELECT cross_source_score FROM signal_scores WHERE item_id = ?').get('unrelated').cross_source_score).toBe(1);
    db.prepare('UPDATE information_items SET canonical_url = ? WHERE id = ?').run('https://example.com/unrelated', 'duplicate');
    await scoreSignals([subject], { llmSkipRuleMatched: true, noRetry: true });
    const rescored = db.prepare('SELECT * FROM signal_scores WHERE item_id = ?').get(subject.id);
    expect(rescored.cross_source_score).toBe(0);
    expect(rescored.evidence_summary).toContain('0 个其他来源');
    expect(score.alpha_score - rescored.alpha_score).toBeCloseTo(0.015);
  });
});
