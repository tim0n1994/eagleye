/**
 * D7 WAL governance (Round 1 decisions, ops scope).
 *
 * Contract under test — implementation MUST (Round 1 / D7):
 *   1. The shared write connection (server/db/connection.js getDB) initializes
 *      SQLite with `PRAGMA journal_size_limit = 64MB` (67108864 bytes) right
 *      next to the existing `journal_mode = WAL` / `foreign_keys` pragmas.
 *   2. When the daily FULL_PIPELINE background job finishes
 *      (server/services/jobs.js, after the last stage 'hierarchy'), the job
 *      runs `wal_checkpoint(TRUNCATE)` on the shared connection.
 *   3. When a background ENRICH_ITEMS job finishes (the 2h drainer posts
 *      /api/enrich?background=true which lands in the same case), the job
 *      also runs `wal_checkpoint(TRUNCATE)`.
 *
 * Acceptable implementations for (2)/(3): db.pragma('wal_checkpoint(TRUNCATE)')
 * or db.exec('PRAGMA wal_checkpoint(TRUNCATE)') on the connection returned by
 * getDB(). The assertion spies Database.prototype.pragma/exec and accepts
 * either spelling, so it asserts the behavior (the PRAGMA is issued when the
 * job completes) rather than the exact call shape.
 *
 * These tests are expected to FAIL on the unfixed code (assertion failures):
 * journal_size_limit currently stays at SQLite's default (-1) and no
 * checkpoint PRAGMA is issued by any job completion path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const Database = require('better-sqlite3');

const JOBS_PATH = path.resolve(import.meta.dirname, '../../services/jobs.js');

function loadThrough(baseDir, id) {
  return require(id.startsWith('.') ? path.resolve(baseDir, id) : id);
}

/**
 * Compile server/services/jobs.js as an isolated CommonJS module with its
 * service dependencies replaced by no-op mocks and its DB dependency pointed
 * at the caller's temp database (same technique as migrations-fresh.test.js).
 */
function compileJobs(db) {
  const overrides = {
    llm: {
      enrichItems: vi.fn(async () => ({ processed: 0 })),
      generateDailyDigest: vi.fn(async () => ({ id: 'digest-fixture' })),
    },
    topicGraph: { buildTopicGraph: vi.fn(async () => ({})) },
    sync: {
      syncAllSources: vi.fn(async () => ({ fetch: [] })),
      syncSource: vi.fn(async () => ({})),
    },
    kgWorker: { runKGFullPipeline: vi.fn(async () => ({})) },
    translate: { translateItems: vi.fn(async () => ({})) },
    sourceProfiles: {
      updateSourceProfiles: vi.fn(() => ({})),
      updateEntityMomentum: vi.fn(() => ({})),
    },
    signals: { scoreSignals: vi.fn(async () => ({ scored: 0 })) },
    tagHierarchy: { buildTagHierarchy: vi.fn(async () => ({})) },
  };
  const subject = new Module(JOBS_PATH, module);
  subject.filename = JOBS_PATH;
  subject.require = (id) => {
    if (id === '../db/connection') return { getDB: () => db };
    if (id === './llm') return overrides.llm;
    if (id === './topic-graph') return overrides.topicGraph;
    if (id === './sync') return overrides.sync;
    if (id === './kg-worker') return overrides.kgWorker;
    if (id === './translate') return overrides.translate;
    if (id === './source-profiles') return overrides.sourceProfiles;
    if (id === './signals') return overrides.signals;
    if (id === './tag-hierarchy') return overrides.tagHierarchy;
    return loadThrough(path.dirname(JOBS_PATH), id);
  };
  subject._compile(fs.readFileSync(JOBS_PATH, 'utf8'), JOBS_PATH);
  return { jobs: subject.exports, overrides };
}

function createJobDatabase(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE background_jobs (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      params TEXT,
      result TEXT,
      error TEXT,
      created_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_epoch INTEGER NOT NULL DEFAULT 0,
      lease_expiry TEXT
    );
    CREATE TABLE sources (id INTEGER PRIMARY KEY, slug TEXT, label TEXT);
    CREATE TABLE information_items (id INTEGER PRIMARY KEY, source_id INTEGER, digest_date TEXT);
    INSERT INTO sources (slug, label) VALUES ('fixture-source', 'Fixture Source');
  `);
  // Leave un-checkpointed frames in the WAL so a TRUNCATE checkpoint has
  // observable effect and so a stale -wal file cannot mask a missing checkpoint.
  db.prepare('INSERT INTO information_items (source_id, digest_date) VALUES (?, ?)')
    .run(1, new Date().toISOString().slice(0, 10));
  return db;
}

function checkpointCalls(pragmaSpy, execSpy) {
  return [...pragmaSpy.mock.calls, ...execSpy.mock.calls]
    .map(args => JSON.stringify(args));
}

describe('D7 WAL governance', () => {
  describe('journal_size_limit on the shared write connection', () => {
    it('initializes getDB() with journal_size_limit = 64MB (67108864)', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-wal-limit-'));
      process.env.EAGLEYE_DB_PATH = path.join(tmp, 'limit.db');
      try {
        const { getDB, closeDB } = require('../../db/connection');
        const db = getDB();
        expect(db).toBeTruthy();
        // D7: the production WAL file is 172MB because no size cap is set.
        // The shared connection must cap it at 64MB.
        expect(db.pragma('journal_size_limit', { simple: true })).toBe(67108864);
        closeDB();
      } finally {
        delete process.env.EAGLEYE_DB_PATH;
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('wal_checkpoint(TRUNCATE) at job completion points', () => {
    let tmp;
    let db;
    let pragmaSpy;
    let execSpy;

    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-wal-job-'));
      db = createJobDatabase(path.join(tmp, 'jobs.db'));
      // Spy on the prototype so both pragma() and exec() spellings of the
      // checkpoint are observed; the original implementations keep running.
      const proto = Object.getPrototypeOf(db);
      pragmaSpy = vi.spyOn(proto, 'pragma');
      execSpy = vi.spyOn(proto, 'exec');
    });

    afterEach(() => {
      vi.restoreAllMocks();
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('runs wal_checkpoint(TRUNCATE) when the daily full-pipeline job finishes', async () => {
      const { jobs } = compileJobs(db);
      db.prepare("INSERT INTO background_jobs (id, job_type, status, params) VALUES (?, 'full-pipeline', 'queued', '{}')")
        .run('job-full-pipeline-fixture');

      await jobs.executeJob('job-full-pipeline-fixture');

      const calls = checkpointCalls(pragmaSpy, execSpy);
      expect(
        calls.some(entry => entry.includes('wal_checkpoint') && entry.includes('TRUNCATE')),
      ).toBe(true);
    });

    it('runs wal_checkpoint(TRUNCATE) when a background enrich-items (drain) job finishes', async () => {
      const { jobs } = compileJobs(db);
      db.prepare("INSERT INTO background_jobs (id, job_type, status, params) VALUES (?, 'enrich-items', 'queued', '{\"batchSize\":50}')")
        .run('job-enrich-items-fixture');

      await jobs.executeJob('job-enrich-items-fixture');

      const calls = checkpointCalls(pragmaSpy, execSpy);
      expect(
        calls.some(entry => entry.includes('wal_checkpoint') && entry.includes('TRUNCATE')),
      ).toBe(true);
    });
  });
});
