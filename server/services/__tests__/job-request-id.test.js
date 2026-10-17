// @vitest-environment node
/* global describe, it, expect, afterEach */
const Database = require('better-sqlite3');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

describe('bounded-job request identities', () => {
  let db;
  let executions;
  afterEach(() => db?.close());
  function setup() {
    executions = 0;
    db = new Database(':memory:');
    db.exec(`CREATE TABLE background_jobs (id TEXT PRIMARY KEY, job_type TEXT,
      status TEXT, params TEXT, result TEXT, error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT, completed_at TEXT)`);
    const filename = path.resolve(__dirname, '../jobs.js');
    const subject = new Module(filename, module);
    subject.filename = filename;
    subject.require = id => {
      if (id === '../db/connection') return { getDB: () => db };
      if (id === './date-contract') return require('../date-contract');
      if (id === './llm') {
        return { enrichItems: async () => {
          executions++;
          return { enriched: 0, total: 0, failed: 0 };
        } };
      }
      if (id === './topic-graph') return {};
      return require(id);
    };
    subject._compile(fs.readFileSync(filename, 'utf8'), filename);
    return subject.exports;
  }
  const requestId = '809c5b99-2136-4d90-9ad2-f6c543206801';

  it('creates the requested identity once when concurrent callers repeat a lost-response request', async () => {
    const jobs = setup();
    const params = { batchSize: 100, requestId };
    const ids = await Promise.all([jobs.runJob(jobs.JOB_TYPES.ENRICH_ITEMS, params),
      jobs.runJob(jobs.JOB_TYPES.ENRICH_ITEMS, params)]);
    for (let n = 0; n < 20 && jobs.getJob(requestId).status === 'running'; n++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(ids).toEqual([requestId, requestId]);
    expect(executions).toBe(1);
    expect(jobs.getJob(requestId).status).toBe('completed');
    expect(await jobs.runJob(jobs.JOB_TYPES.ENRICH_ITEMS, params)).toBe(requestId);
    expect(executions).toBe(1);
  });

  it.each(['completed', 'failed', 'running', 'queued'])('reuses a %s job without executing it again', async status => {
    const jobs = setup();
    const params = { batchSize: 100, requestId };
    db.prepare('INSERT INTO background_jobs(id,job_type,status,params) VALUES(?,?,?,?)')
      .run(requestId, jobs.JOB_TYPES.ENRICH_ITEMS, status, JSON.stringify(params));
    const result = await jobs.runJob(jobs.JOB_TYPES.ENRICH_ITEMS, params);
    expect(result).toBe(requestId);
    expect(jobs.getJob(requestId).status).toBe(status);
    expect(db.prepare('SELECT count(*) n FROM background_jobs').get().n).toBe(1);
  });
  it('rejects reuse for a changed batch and for another job type', async () => {
    const jobs = setup();
    db.prepare('INSERT INTO background_jobs(id,job_type,status,params) VALUES(?,?,?,?)')
      .run(requestId, jobs.JOB_TYPES.ENRICH_ITEMS, 'completed', JSON.stringify({ batchSize: 100, requestId }));
    await expect(jobs.runJob(jobs.JOB_TYPES.ENRICH_ITEMS, { batchSize: 50, requestId })).rejects.toThrow('different job parameters');
    await expect(jobs.runJob(jobs.JOB_TYPES.TRANSLATE_BACKFILL, { batchSize: 100, requestId })).rejects.toThrow('different job parameters');
  });
  it('rejects invalid IDs before creating or starting a job', async () => {
    const jobs = setup();
    await expect(jobs.runJob(jobs.JOB_TYPES.ENRICH_ITEMS, { requestId: '../unsafe' })).rejects.toThrow('Invalid bounded-job request ID');
    expect(db.prepare('SELECT count(*) n FROM background_jobs').get().n).toBe(0);
  });
});
