// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const Database = require('better-sqlite3');
const { registerEvent, drainOutbox } = require('../outbox');

function applyMigration(db, file) {
  db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations', file), 'utf8'));
}

function makeConsumerDb() {
  const db = new Database(':memory:');
  applyMigration(db, '040_outbox.sql');
  db.exec(`
    CREATE TABLE checkpoint_items (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE consumed_events (unique_key TEXT PRIMARY KEY);
    CREATE TABLE consumed_counts (name TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);
    INSERT INTO consumed_counts (name, n) VALUES ('index_items', 0);
  `);
  return db;
}

// Delivery is at-least-once, so the consumer dedups on unique_key and the
// counted business effect lands at most once.
function makeDedupCounterHandler(db) {
  const claim = db.prepare('INSERT OR IGNORE INTO consumed_events (unique_key) VALUES (?)');
  const bump = db.prepare("UPDATE consumed_counts SET n = n + 1 WHERE name = 'index_items'");
  /**
   * @param {{ uniqueKey: string|null }} event
   */
  return async (event) => {
    db.transaction(() => {
      if (claim.run(event.uniqueKey).changes === 0) return;
      bump.run();
    })();
  };
}

describe('R0-07 transactional outbox', () => {
  let db;
  beforeEach(() => { db = makeConsumerDb(); });
  afterEach(() => db.close());

  it('registers once per unique_key and absorbs duplicate registration', () => {
    expect(registerEvent(db, { type: 'item_index_pending', payload: { item_id: 'i1' }, uniqueKey: 'index_item:i1' })).toBe(true);
    expect(registerEvent(db, { type: 'item_index_pending', payload: { item_id: 'i1' }, uniqueKey: 'index_item:i1' })).toBe(false);
    expect(db.prepare('SELECT COUNT(*) c FROM outbox').get().c).toBe(1);
  });

  it('keeps committed-but-undelivered events dispatchable (crash simulation)', async () => {
    const commitBatch = db.transaction(() => {
      db.prepare("INSERT INTO checkpoint_items (id, title) VALUES ('i1', 'Hello')").run();
      registerEvent(db, { type: 'item_index_pending', payload: { item_id: 'i1' }, uniqueKey: 'index_item:i1' });
    });
    commitBatch();
    const row = db.prepare("SELECT * FROM outbox WHERE unique_key = 'index_item:i1'").get();
    expect(row.dispatched_at).toBeNull();
    expect(row.attempts).toBe(0);

    const delivered = [];
    const result = await drainOutbox(db, async (event) => { delivered.push(event); });
    expect(result.dispatched).toEqual([row.id]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ type: 'item_index_pending', uniqueKey: 'index_item:i1', payload: { item_id: 'i1' } });
    expect(db.prepare('SELECT dispatched_at FROM outbox WHERE id = ?').get(row.id).dispatched_at).toBeTruthy();
  });

  it('rolls back the outbox row together with a failed business write', () => {
    const failingBatch = db.transaction(() => {
      registerEvent(db, { type: 'item_index_pending', payload: { item_id: 'boom' }, uniqueKey: 'index_item:boom' });
      throw new Error('business write failed');
    });
    expect(() => failingBatch()).toThrow('business write failed');
    expect(db.prepare('SELECT COUNT(*) c FROM outbox').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM checkpoint_items').get().c).toBe(0);
  });

  it('redelivery of the same unique_key produces the business effect only once', async () => {
    registerEvent(db, { type: 'item_index_pending', payload: { item_id: 'i1' }, uniqueKey: 'index_item:i1' });
    const handler = makeDedupCounterHandler(db);

    await drainOutbox(db, handler);
    // Crash simulation: reset the dispatched marker after a successful run,
    // which makes the event eligible for redelivery on the next drain.
    db.prepare('UPDATE outbox SET dispatched_at = NULL').run();
    await drainOutbox(db, handler);

    expect(db.prepare("SELECT n FROM consumed_counts WHERE name = 'index_items'").get().n).toBe(1);
  });

  it('stops auto-redelivery past maxAttempts and keeps dead letters queryable', async () => {
    registerEvent(db, { type: 'item_index_pending', payload: { item_id: 'bad' }, uniqueKey: 'index_item:bad' });
    registerEvent(db, { type: 'item_index_pending', payload: { item_id: 'good' }, uniqueKey: 'index_item:good' });
    const handler = async (event) => {
      if (event.uniqueKey === 'index_item:bad') throw new Error('indexer offline');
    };

    const first = await drainOutbox(db, handler, { maxAttempts: 2 });
    expect(first.dispatched).toHaveLength(1);
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0]).toMatchObject({ attempts: 1, dead: false, error: 'indexer offline' });

    const second = await drainOutbox(db, handler, { maxAttempts: 2 });
    expect(second.failed[0]).toMatchObject({ attempts: 2, dead: true, error: 'indexer offline' });

    const third = await drainOutbox(db, handler, { maxAttempts: 2 });
    expect(third.dispatched).toEqual([]);
    expect(third.failed).toEqual([]);

    const dead = db.prepare(
      "SELECT dispatched_at, attempts, last_error FROM outbox WHERE dispatched_at IS NULL AND attempts >= 2"
    ).all();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ dispatched_at: null, attempts: 2, last_error: 'indexer offline' });
  });

  it('rejects invalid drain options', async () => {
    await expect(drainOutbox(db, async () => {}, { limit: 0 })).rejects.toThrow(RangeError);
    await expect(drainOutbox(db, async () => {}, { maxAttempts: 1.5 })).rejects.toThrow(RangeError);
  });
});

describe('saveItems registers item_index_pending in the insert transaction', () => {
  let db;
  let originalRequire;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigration(db, '001_initial_schema.sql');
    applyMigration(db, '033_item_time_contract.sql');
    applyMigration(db, '040_outbox.sql');
    db.prepare("INSERT INTO sources (id, slug, label) VALUES ('src-1', 'test-source', 'Test Source')").run();
    db.exec(`
      CREATE TABLE consumed_events (unique_key TEXT PRIMARY KEY);
      CREATE TABLE consumed_counts (name TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);
      INSERT INTO consumed_counts (name, n) VALUES ('index_items', 0);
    `);
    originalRequire = Module.prototype.require;
    Module.prototype.require = function patchedRequire(name, ...rest) {
      if (name === '../db/connection') return { getDB: () => db, closeDB: () => {} };
      return originalRequire.call(this, name, ...rest);
    };
  });
  afterEach(() => {
    Module.prototype.require = originalRequire;
    db.close();
  });

  function loadBaseConnector() {
    const { BaseConnector } = require('../../connectors/base');
    return new BaseConnector('test-source');
  }

  it('rolls back item rows and outbox rows together, then registers cleanly', () => {
    const connector = loadBaseConnector();
    const good = connector.normalize({ title: 'Hooked', url: 'https://example.com/hooked' });
    const bad = { ...connector.normalize({ title: 'Bad', url: 'https://example.com/bad' }), source_id: 'missing-source' };
    const details = /** @type {{ inserted: number, failed: number, error?: string }} */ (
      connector.saveItems([good, bad], { returnDetails: true })
    );
    expect(details).toMatchObject({ inserted: 0, failed: 2 });
    expect(details.error).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) c FROM information_items').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM outbox').get().c).toBe(0);

    const survivor = connector.normalize({ title: 'Committed', url: 'https://example.com/committed' });
    expect(connector.saveItems([survivor], { returnDetails: true })).toMatchObject({ inserted: 1 });
    expect(db.prepare('SELECT event_type, dispatched_at FROM outbox WHERE unique_key = ?')
      .get(`index_item:${survivor.id}`)).toMatchObject({ event_type: 'item_index_pending', dispatched_at: null });
  });

  it('drains the pending event created by saveItems with consumer-side dedup', async () => {
    const connector = loadBaseConnector();
    const item = connector.normalize({ title: 'Drain me', url: 'https://example.com/drain' });
    connector.saveItems([item]);
    await drainOutbox(db, makeDedupCounterHandler(db));
    db.prepare('UPDATE outbox SET dispatched_at = NULL').run();
    await drainOutbox(db, makeDedupCounterHandler(db));
    expect(db.prepare("SELECT n FROM consumed_counts WHERE name = 'index_items'").get().n).toBe(1);
  });
});
