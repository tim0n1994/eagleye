// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { Worker } = require('node:worker_threads');

const WORKER_SOURCE = `'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const Module = require('node:module');
const Database = require(workerData.databaseModulePath);

const writer = new Database(workerData.dbPath);
writer.pragma('foreign_keys = ON');
const db = Object.create(writer);
const dedupSql = /SELECT id, digest_date FROM information_items\\s+WHERE source_id = \\? AND canonical_url = \\?\\s+LIMIT 1/;

// Tell the orchestrator exactly when the old deferred transaction has taken
// its WAL snapshot. In immediate mode the message is only sent after the
// writer lock has been acquired and the competing transaction has committed.
db.prepare = (...args) => {
  const statement = writer.prepare(...args);
  if (!dedupSql.test(String(args[0]))) return statement;
  return Object.create(statement, {
    get: {
      value(...getArgs) {
        const row = statement.get(...getArgs);
        parentPort.postMessage({ type: 'snapshot-read' });
        return row;
      },
    },
  });
};

db.transaction = (...args) => {
  const transaction = writer.transaction(...args);
  const run = (...runArgs) => transaction(...runArgs);
  const runImmediate = (...runArgs) => {
    parentPort.postMessage({ type: 'begin-immediate' });
    return transaction.immediate(...runArgs);
  };
  Object.defineProperty(run, 'immediate', { value: runImmediate });
  Object.defineProperty(run, 'deferred', {
    value: (...runArgs) => transaction.deferred(...runArgs),
  });
  Object.defineProperty(run, 'exclusive', {
    value: (...runArgs) => transaction.exclusive(...runArgs),
  });
  return run;
};

const originalRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(name, ...rest) {
  if (name === '../db/connection') return { getDB: () => db, closeDB: () => {} };
  return originalRequire.call(this, name, ...rest);
};

let result;
try {
  const { BaseConnector } = require(workerData.baseModulePath);
  const connector = new BaseConnector(workerData.slug);
  const item = connector.normalize(workerData.raw);
  const startedAt = Date.now();
  parentPort.postMessage({ type: 'save-started' });
  result = {
    details: connector.saveItems([item], { returnDetails: true }),
    itemId: item.id,
    durationMs: Date.now() - startedAt,
  };
} finally {
  Module.prototype.require = originalRequire;
  writer.close();
}
parentPort.postMessage({ type: 'done', result });
`;

// A deliberately minimal, temporary WAL fixture. It contains only the tables
// and columns exercised by BaseConnector.saveItems; production databases are
// never copied or opened by this regression.
function makeWalFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-wal-snapshot-'));
  const dbPath = path.join(directory, 'fixture.sqlite');
  const setup = new Database(dbPath);
  setup.pragma('journal_mode = WAL');
  setup.exec(`
    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      item_count INTEGER NOT NULL DEFAULT 0,
      last_fetched_at TEXT,
      last_attempt_at TEXT,
      last_success_at TEXT,
      last_new_content_at TEXT,
      last_error_class TEXT,
      health_status TEXT NOT NULL DEFAULT 'unknown',
      consecutive_empty INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE information_items (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      external_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      original_summary TEXT NOT NULL DEFAULT '',
      content_text TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'en',
      author TEXT NOT NULL DEFAULT '',
      published_at TEXT,
      published_raw TEXT,
      published_precision TEXT,
      published_parse_status TEXT,
      digest_date TEXT NOT NULL,
      source_payload TEXT NOT NULL DEFAULT '{}',
      normalized_payload TEXT NOT NULL DEFAULT '{}',
      score INTEGER NOT NULL DEFAULT 0,
      popularity TEXT NOT NULL DEFAULT '{}',
      content_hash TEXT NOT NULL DEFAULT '',
      duplicate_group_id TEXT,
      UNIQUE(source_id, canonical_url, digest_date)
    );
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      unique_key TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      dispatched_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE TABLE regression_probe (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  setup.prepare(`INSERT INTO sources (id, slug, label) VALUES ('src-1', 'snapshot-source', 'Snapshot Source')`).run();
  setup.prepare(`INSERT INTO regression_probe (id, value) VALUES ('blocker-writer', 'armed')`).run();
  setup.close();

  return { directory, dbPath };
}

describe('BaseConnector.saveItems under a competing WAL writer', () => {
  let cleanup;

  afterEach(async () => {
    if (!cleanup) return;
    if (cleanup.worker) await cleanup.worker.terminate();
    cleanup.blocker.close();
    fs.rmSync(cleanup.directory, { recursive: true, force: true });
    cleanup = undefined;
  });

  it('waits behind the writer and commits item, outbox event, and source ledger atomically', async () => {
    const fixture = makeWalFixture();
    const workerPath = path.join(fixture.directory, 'save-worker.cjs');
    fs.writeFileSync(workerPath, WORKER_SOURCE);
    const blocker = new Database(fixture.dbPath);
    cleanup = { directory: fixture.directory, blocker };

    blocker.exec('BEGIN IMMEDIATE');
    blocker.prepare(`UPDATE regression_probe SET value = 'committed' WHERE id = 'blocker-writer'`).run();

    const race = {
      saveStarted: false,
      snapshotReadObserved: false,
      blockerCommitted: false,
    };
    const commitBlocker = () => {
      if (!blocker.inTransaction) return;
      blocker.prepare('COMMIT').run();
      race.blockerCommitted = true;
    };

    const worker = new Worker(workerPath, {
      workerData: {
        dbPath: fixture.dbPath,
        databaseModulePath: require.resolve('better-sqlite3'),
        baseModulePath: path.resolve(__dirname, '../../connectors/base.js'),
        slug: 'snapshot-source',
        raw: { title: 'WAL snapshot survivor', url: 'https://example.com/wal-snapshot' },
      },
    });
    cleanup.worker = worker;

    let commitTimer;
    const finished = new Promise((resolve, reject) => {
      worker.on('message', (message) => {
        if (message.type === 'save-started') {
          race.saveStarted = true;
        } else if (message.type === 'snapshot-read') {
          race.snapshotReadObserved = true;
          // The stale snapshot is now established; commit the competing writer
          // at the exact point that production's outbox drainer would.
          commitBlocker();
        } else if (message.type === 'begin-immediate') {
          // Keep the writer occupied while the immediate transaction is
          // already blocked on SQLite's default busy timeout.
          commitTimer = setTimeout(commitBlocker, 100);
        } else if (message.type === 'done') {
          clearTimeout(commitTimer);
          resolve(message.result);
        }
      });
      worker.on('error', (error) => {
        clearTimeout(commitTimer);
        reject(error);
      });
    });
    const result = await finished;
    await new Promise(resolve => worker.once('exit', resolve));

    expect(race.saveStarted, 'worker must reach saveItems').toBe(true);
    expect(result.details.error, 'the WAL writer race must not fail ingestion').toBeUndefined();
    expect(result.details).toMatchObject({ inserted: 1, existing: 0, duplicates: 0, failed: 0 });
    expect(race.blockerCommitted, 'competing writer must commit during the test').toBe(true);
    expect(race.snapshotReadObserved, 'worker must reach the connector dedup read').toBe(true);
    expect(blocker.prepare('SELECT id FROM information_items WHERE id = ?').get(result.itemId)).toBeTruthy();
    expect(blocker.prepare('SELECT event_type, dispatched_at FROM outbox WHERE unique_key = ?')
      .get(`index_item:${result.itemId}`)).toMatchObject({ event_type: 'item_index_pending', dispatched_at: null });
    expect(blocker.prepare(`SELECT value FROM regression_probe WHERE id = 'blocker-writer'`).get())
      .toMatchObject({ value: 'committed' });
    expect(blocker.prepare(`SELECT health_status, last_error_class, item_count,
      last_attempt_at IS NOT NULL AS attempted,
      last_success_at IS NOT NULL AS succeeded,
      last_new_content_at IS NOT NULL AS produced
      FROM sources WHERE id = 'src-1'`).get()).toMatchObject({
        health_status: 'healthy',
        last_error_class: null,
        item_count: 1,
        attempted: 1,
        succeeded: 1,
        produced: 1,
      });
  });
});
