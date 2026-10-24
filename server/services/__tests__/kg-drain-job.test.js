// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */
/**
 * R3 convergence drainer — jobs.js integration (EAGLEYE_R3_DRAINER).
 *
 * Contract under test — server/services/jobs.js gains ONE new job type,
 * exactly the "scheduler/jobs append-only" shape the R3 file boundary
 * allows:
 *
 *   1. JOB_TYPES.KG_DRAIN === 'kg-drain' — a drain entry that goes through
 *      the job system (never writes the DB directly), so it is visible in
 *      /api/jobs, cancellable and lease-protected like every other job.
 *   2. 'kg-drain' joins SINGLETON_JOB_TYPES: the enrich drainer's known gap
 *      (ENRICH_ITEMS is NOT a singleton, jobs.js:46-52) must not be copied —
 *      a second fire while one drain runs reuses the in-flight job instead
 *      of doubling load.
 *   3. executeJob dispatches to require('./kg-drainer').runKGDrain with
 *      { jobId, signal, ...params } (params pass through — the 2h timer
 *      script passes idleWindow) and stores its result; jobs.js itself does
 *      NOT gate on the switch (runKGDrain no-ops when disabled — tested in
 *      kg-drainer.test.js), so a manually fired job completes with the skip
 *      result instead of hanging.
 *   4. 'kg-drain' joins WAL_CHECKPOINT_JOB_TYPES: it is a bulk writer, and
 *      D7 exists precisely because failed drains used to leave WAL frames
 *      accumulating for days.
 */

const Database = require('better-sqlite3');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

describe('KG drain job type (EAGLEYE_R3_DRAINER)', () => {
  let db;
  let jobs;
  let mocks;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE background_jobs (
        id TEXT PRIMARY KEY, job_type TEXT, status TEXT CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        params TEXT, result TEXT, error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, started_at TEXT, completed_at TEXT
      );
      CREATE TABLE sources (id INTEGER PRIMARY KEY, label TEXT, slug TEXT);
      CREATE TABLE information_items (id TEXT PRIMARY KEY, source_id INTEGER, digest_date TEXT);
      INSERT INTO sources VALUES (1, 'Test source', 'test-source');
    `);
    db.prepare('INSERT INTO information_items VALUES (?, ?, ?)').run('item-1', 1, require('../date-contract').todayDigestDate());
    mocks = {
      '../db/connection': { getDB: () => db },
      './llm': {
        enrichItems: vi.fn(async () => ({ enriched: 1, total: 1, failed: 0 })),
        generateDailyDigest: vi.fn(async () => ({ id: 'digest-1' })),
      },
      './kg-drainer': { runKGDrain: vi.fn(async () => ({ mode: 'steady', skipped: false })) },
    };
    const filename = path.resolve(__dirname, '../jobs.js');
    const subject = new Module(filename, module);
    subject.filename = filename;
    subject.require = id => {
      if (id === 'crypto') return require('node:crypto');
      if (mocks[id]) return mocks[id];
      if (id === './date-contract') return require('../date-contract');
      throw new Error(`Unmocked dependency: ${id}`);
    };
    subject._compile(fs.readFileSync(filename, 'utf8'), filename);
    jobs = subject.exports;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  async function terminal(id) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = jobs.getJob(id);
      if (!['queued', 'running'].includes(row.status)) return { ...row, parsed: JSON.parse(row.result) };
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error('Mock job did not reach a terminal state');
  }

  it('registers the kg-drain job type', () => {
    expect(jobs.JOB_TYPES.KG_DRAIN).toBe('kg-drain');
  });

  it('is a singleton: a second fire while one drain runs reuses the in-flight job', async () => {
    db.prepare(`INSERT INTO background_jobs (id, job_type, status, params) VALUES ('kg-drain-running', 'kg-drain', 'running', '{}')`).run();
    const id = await jobs.runJob('kg-drain', {});
    expect(id).toBe('kg-drain-running');
    const rows = db.prepare(`SELECT id FROM background_jobs WHERE job_type = 'kg-drain'`).all();
    expect(rows).toEqual([{ id: 'kg-drain-running' }]);
  });

  it('dispatches to kg-drainer.runKGDrain with the job context and params, then completes', async () => {
    mocks['./kg-drainer'].runKGDrain.mockResolvedValue({ mode: 'catchup', caps: { extract: 1000 }, skipped: false });
    const id = await jobs.runJob('kg-drain', { idleWindow: true });
    const row = await terminal(id);
    expect(row.status).toBe('completed');
    expect(row.error).toBeNull();
    expect(mocks['./kg-drainer'].runKGDrain).toHaveBeenCalledTimes(1);
    expect(mocks['./kg-drainer'].runKGDrain).toHaveBeenCalledWith(expect.objectContaining({ jobId: id, idleWindow: true }));
    expect(row.parsed).toEqual({ mode: 'catchup', caps: { extract: 1000 }, skipped: false });
  });

  it('checkpoints the WAL once the drain job reaches a terminal state (D7)', async () => {
    const pragma = vi.spyOn(Database.prototype, 'pragma');
    const id = await jobs.runJob('kg-drain', {});
    await terminal(id);
    expect(pragma).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)');
  });

  it('a skipped drain (switch off) still completes the job instead of failing it', async () => {
    mocks['./kg-drainer'].runKGDrain.mockResolvedValue({ skipped: 'disabled' });
    const id = await jobs.runJob('kg-drain', {});
    const row = await terminal(id);
    expect(row.status).toBe('completed');
    expect(row.parsed).toEqual({ skipped: 'disabled' });
  });
});
