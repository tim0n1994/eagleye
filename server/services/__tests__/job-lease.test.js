// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */
const Database = require('better-sqlite3');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const BASE_COLUMNS = `
    id TEXT PRIMARY KEY, job_type TEXT, status TEXT CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    params TEXT, result TEXT, error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, started_at TEXT, completed_at TEXT
`;
const LEASE_SCHEMA = `
  CREATE TABLE background_jobs (${BASE_COLUMNS},
    lease_owner TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, lease_expiry TEXT, attempt INTEGER NOT NULL DEFAULT 0
  );
`;
const LEGACY_SCHEMA = `CREATE TABLE background_jobs (${BASE_COLUMNS});`;

describe('job lease and late-commit protection', () => {
  let db;
  let jobs;
  let mocks;
  let calls;
  let prevPause;

  const tick = () => new Promise(resolve => setImmediate(resolve));

  async function waitFor(predicate, label = 'condition') {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (predicate()) return;
      await tick();
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async function waitForTerminal(id) {
    await waitFor(() => !['queued', 'running'].includes(jobs.getJob(id).status), `terminal state of ${id}`);
    return jobs.getJob(id);
  }

  function setup(schema) {
    db = new Database(':memory:');
    db.exec(schema);
    db.exec(`
      CREATE TABLE sources (id INTEGER PRIMARY KEY, label TEXT, slug TEXT);
      CREATE TABLE information_items (id TEXT PRIMARY KEY, source_id INTEGER, digest_date TEXT);
      INSERT INTO sources VALUES (1, 'Test source', 'test-source');
    `);
    calls = [];
    const stage = (name, result) => vi.fn(async () => { calls.push(name); return result; });
    mocks = {
      '../db/connection': { getDB: () => db },
      './sync': { syncAllSources: stage('fetch', { fetch: [{ source: 'test-source', items: 1 }] }) },
      './llm': {
        enrichItems: stage('enrich', { enriched: 1, total: 1, failed: 0 }),
        generateDailyDigest: stage('digest', { id: 'digest-1' }),
      },
      './translate': { translateItems: stage('translate', { translated: 1, total: 1, failed: 0 }) },
      './topic-graph': { buildTopicGraph: stage('topic_graph', { edges_updated: 1 }) },
      './kg-worker': { runKGFullPipeline: stage('kg_worker', { extract: { total: 1 } }) },
      './source-profiles': {
        updateEntityMomentum: vi.fn(() => { calls.push('entity_momentum'); return { updated: 1 }; }),
        updateSourceProfiles: vi.fn(() => { calls.push('source_profiles'); return { sources: 1 }; }),
      },
      './signals': { scoreSignals: stage('rescore', { scored: 1 }) },
      './tag-hierarchy': { buildTagHierarchy: stage('hierarchy', { domains: 1, topics: 1, tags: 1 }) },
    };
    const filename = path.resolve(__dirname, '../jobs.js');
    const subject = new Module(filename, module);
    subject.filename = filename;
    subject.require = id => {
      if (id === 'crypto') return require('node:crypto');
      if (mocks[id]) return mocks[id];
      if (id === './date-contract') return require('../date-contract');
      throw new Error(`Unmocked lease dependency: ${id}`);
    };
    subject._compile(fs.readFileSync(filename, 'utf8'), filename);
    jobs = subject.exports;
  }

  const insertQueued = (id, jobType) =>
    db.prepare("INSERT INTO background_jobs (id, job_type, status, params) VALUES (?, ?, 'queued', '{}')").run(id, jobType);

  beforeEach(() => {
    prevPause = process.env.EAGLEYE_JOBS_PAUSED;
    delete process.env.EAGLEYE_JOBS_PAUSED;
    for (const method of ['log', 'warn', 'error']) vi.spyOn(console, method).mockImplementation(() => {});
  });

  afterEach(() => {
    if (prevPause === undefined) delete process.env.EAGLEYE_JOBS_PAUSED;
    else process.env.EAGLEYE_JOBS_PAUSED = prevPause;
    db?.close();
    vi.restoreAllMocks();
  });

  it('writes owner, epoch, expiry and attempt when claiming a queued job', async () => {
    setup(LEASE_SCHEMA);
    const id = await jobs.runJob(jobs.JOB_TYPES.ENRICH_ITEMS);
    const row = await waitForTerminal(id);
    expect(row).toMatchObject({ status: 'completed', lease_epoch: 1, attempt: 1 });
    expect(row.lease_owner).toMatch(/^worker-\d+-/);
    expect(row.lease_expiry).not.toBeNull();
  });

  it('advances the epoch on interruption and rejects the stale worker late commit', async () => {
    setup(LEASE_SCHEMA);
    let release;
    mocks['./kg-worker'].runKGFullPipeline.mockImplementation(() => {
      calls.push('kg_worker');
      return new Promise(resolve => { release = () => resolve({ extract: { total: 1 } }); });
    });
    insertQueued('stale-worker', jobs.JOB_TYPES.FULL_PIPELINE);
    const done = jobs.executeJob('stale-worker');
    await waitFor(() => calls.includes('kg_worker'), 'kg_worker stage');
    expect(jobs.getJob('stale-worker')).toMatchObject({ status: 'running', lease_epoch: 1, attempt: 1 });

    expect(jobs.markInterruptedJobs()).toBe(1);
    const interrupted = jobs.getJob('stale-worker');
    expect(interrupted).toMatchObject({ status: 'failed', lease_epoch: 2 });
    expect(interrupted.lease_owner).toBeNull();

    release();
    expect(await done).toMatchObject({ stale: true, reason: 'lease-stale', jobId: 'stale-worker' });
    const row = jobs.getJob('stale-worker');
    expect(row).toMatchObject({ status: 'failed', lease_epoch: 2 });
    expect(row.result).toBe(interrupted.result);
    expect(JSON.parse(row.result)).toMatchObject({ interrupted: true, outcome: 'failed' });
  });

  it('rejects the stale failure commit without throwing when the executor later fails', async () => {
    setup(LEASE_SCHEMA);
    let crash;
    mocks['./llm'].enrichItems.mockImplementation(() => {
      calls.push('enrich');
      return new Promise((_resolve, reject) => { crash = () => reject(new Error('provider crashed late')); });
    });
    insertQueued('stale-failure', jobs.JOB_TYPES.ENRICH_ITEMS);
    const done = jobs.executeJob('stale-failure');
    await waitFor(() => calls.includes('enrich'), 'enrich stage');
    expect(jobs.markInterruptedJobs()).toBe(1);
    const interrupted = jobs.getJob('stale-failure');

    crash();
    expect(await done).toMatchObject({ stale: true, reason: 'lease-stale', jobId: 'stale-failure', error: 'provider crashed late' });
    expect(jobs.getJob('stale-failure')).toMatchObject({ status: 'failed', lease_epoch: 2 });
    expect(jobs.getJob('stale-failure').result).toBe(interrupted.result);
  });

  it('refuses new intake while paused and keeps the table untouched', async () => {
    setup(LEASE_SCHEMA);
    process.env.EAGLEYE_JOBS_PAUSED = '1';
    expect(jobs.isJobIntakePaused()).toBe(true);
    await expect(jobs.runJob(jobs.JOB_TYPES.ENRICH_ITEMS)).resolves.toBeNull();
    await expect(jobs.runJob(jobs.JOB_TYPES.FULL_PIPELINE)).resolves.toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM background_jobs').get().n).toBe(0);
  });

  it('leaves queued jobs unclaimed while paused', async () => {
    setup(LEASE_SCHEMA);
    process.env.EAGLEYE_JOBS_PAUSED = '1';
    insertQueued('held', jobs.JOB_TYPES.ENRICH_ITEMS);
    await jobs.executeJob('held');
    expect(jobs.getJob('held')).toMatchObject({ status: 'queued', lease_owner: null, lease_epoch: 0, attempt: 0 });
  });

  it('lets an in-flight job finish and commit normally while paused', async () => {
    setup(LEASE_SCHEMA);
    let release;
    mocks['./kg-worker'].runKGFullPipeline.mockImplementation(() => {
      calls.push('kg_worker');
      return new Promise(resolve => { release = () => resolve({ extract: { total: 1 } }); });
    });
    insertQueued('draining', jobs.JOB_TYPES.FULL_PIPELINE);
    const done = jobs.executeJob('draining');
    await waitFor(() => calls.includes('kg_worker'), 'kg_worker stage');

    process.env.EAGLEYE_JOBS_PAUSED = '1';
    release();
    await done;
    const row = await waitForTerminal('draining');
    expect(row.status).toBe('completed');
    expect(JSON.parse(row.result)).toMatchObject({ completed: true, outcome: 'completed' });
  });

  it('keeps claiming and committing on legacy schemas without lease columns', async () => {
    setup(LEGACY_SCHEMA);
    const id = await jobs.runJob(jobs.JOB_TYPES.ENRICH_ITEMS);
    const row = await waitForTerminal(id);
    expect(row.status).toBe('completed');
  });

  it('migration 039 adds lease columns with zero defaults to the initial schema', () => {
    const fresh = new Database(':memory:');
    try {
      fresh.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/001_initial_schema.sql'), 'utf8'));
      fresh.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/039_job_lease.sql'), 'utf8'));
      const columns = Object.fromEntries(
        fresh.prepare("PRAGMA table_info('background_jobs')").all().map(column => [column.name, column]));
      expect(columns.lease_owner).toMatchObject({ type: 'TEXT', notnull: 0 });
      expect(columns.lease_epoch).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
      expect(columns.lease_expiry).toMatchObject({ type: 'TEXT', notnull: 0 });
      expect(columns.attempt).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
      fresh.prepare("INSERT INTO background_jobs (id, job_type) VALUES ('migrated', 'fetch-source')").run();
      expect(fresh.prepare('SELECT lease_owner, lease_epoch, lease_expiry, attempt FROM background_jobs WHERE id = ?').get('migrated'))
        .toEqual({ lease_owner: null, lease_epoch: 0, lease_expiry: null, attempt: 0 });
    } finally {
      fresh.close();
    }
  });
});
