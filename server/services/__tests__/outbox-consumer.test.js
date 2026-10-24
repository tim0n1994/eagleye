// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach */
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { registerEvent } = require('../outbox');
const { consumeIndexEvent, drainIndexOutbox } = require('../outbox-consumer');

function migration(db, name) {
  db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations', name), 'utf8'));
}

function makeDb() {
  const db = new Database(':memory:');
  migration(db, '001_initial_schema.sql');
  migration(db, '002_i18n_translations.sql');
  migration(db, '022_fts5_search.sql');
  migration(db, '023_fts5_fix.sql');
  migration(db, '040_outbox.sql');
  db.prepare('INSERT INTO sources (id, slug, label) VALUES (?, ?, ?)').run('src', 'fixture', 'Fixture');
  db.prepare(`INSERT INTO information_items
    (id, source_id, canonical_url, title, original_summary, digest_date)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run('item-1', 'src', 'https://example.test/1', 'Hello', 'Summary', '2026-10-23');
  return db;
}

describe('transactional outbox index consumer', () => {
  let db;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => db.close());

  it('acknowledges an already indexed item without duplicating the FTS row', async () => {
    registerEvent(db, { type: 'item_index_pending', payload: { item_id: 'item-1' }, uniqueKey: 'index_item:item-1' });
    const before = db.prepare('SELECT COUNT(*) AS n FROM items_fts').get().n;
    const result = await drainIndexOutbox(db);
    expect(result.dispatched).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM items_fts').get().n).toBe(before);
  });

  it('repairs a missing FTS row before acknowledging the event', async () => {
    db.prepare("INSERT INTO items_fts(items_fts, rowid) VALUES ('delete', (SELECT rowid FROM information_items WHERE id = 'item-1'))").run();
    registerEvent(db, { type: 'item_index_pending', payload: { item_id: 'item-1' }, uniqueKey: 'index_item:item-1' });
    const result = await drainIndexOutbox(db);
    expect(result.dispatched).toHaveLength(1);
    expect(db.prepare("SELECT 1 FROM items_fts WHERE rowid = (SELECT rowid FROM information_items WHERE id = 'item-1')").get()).toBeTruthy();
  });

  it('keeps orphan events pending and records the failure', async () => {
    registerEvent(db, { type: 'item_index_pending', payload: { item_id: 'missing' }, uniqueKey: 'index_item:missing' });
    const result = await drainIndexOutbox(db, { maxAttempts: 2 });
    expect(result.dispatched).toEqual([]);
    expect(result.failed[0]).toMatchObject({ attempts: 1, dead: false });
    expect(db.prepare('SELECT dispatched_at FROM outbox').get().dispatched_at).toBeNull();
  });

  it('does not acknowledge unsupported event types', async () => {
    expect(() => consumeIndexEvent(db, { type: 'unknown', payload: {} })).toThrow('unsupported outbox event type');
  });
});
