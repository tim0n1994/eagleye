// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */
const Database = require('better-sqlite3');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const STAGE_KEYS = ['fetch', 'enrich', 'translate', 'topic_graph', 'kg_worker', 'entity_momentum', 'source_profiles', 'digest', 'hierarchy'];

describe('restart recovery for interrupted background jobs', () => {
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

  function pipelineProgressJSON(states, summary = {}, { date = '2026-10-23', fetchResults } = {}) {
    const fetchDetail = { date };
    if (fetchResults !== null) {
      fetchDetail.results = Array.isArray(fetchResults) ? fetchResults : (summary.fetch || []);
    }
    const stages = STAGE_KEYS.map(key => ({
      key,
      status: states[key] || 'pending',
      detail: key === 'fetch' ? fetchDetail : null,
      result: summary[key] ?? null,
      started_at: states[key] ? '2026-10-23T00:00:00.000Z' : null,
      completed_at: ['completed', 'failed', 'skipped', 'degraded'].includes(states[key]) ? '2026-10-23T00:05:00.000Z' : null,
    }));
    return JSON.stringify({ pipeline: true, phase: 'pipeline', current_stage: 'fetch', stages, updated_at: '2026-10-23T00:05:00.000Z' });
  }

  const insertRow = (id, jobType, status, resultJson = null, params = {}) =>
    db.prepare('INSERT INTO background_jobs (id, job_type, status, params, result) VALUES (?, ?, ?, ?, ?)')
      .run(id, jobType, status, JSON.stringify(params), resultJson);

  const findResumeJob = resumeOf => db
    .prepare("SELECT id FROM background_jobs WHERE json_extract(params, '$.resume_of') = ?")
    .get(resumeOf)?.id;

  function setup() {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE background_jobs (
        id TEXT PRIMARY KEY, job_type TEXT, status TEXT CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        params TEXT, result TEXT, error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, started_at TEXT, completed_at TEXT,
        lease_owner TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, lease_expiry TEXT, attempt INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE sources (id INTEGER PRIMARY KEY, label TEXT, slug TEXT);
      CREATE TABLE information_items (id TEXT PRIMARY KEY, source_id INTEGER, digest_date TEXT);
      INSERT INTO sources VALUES (1, 'Test source', 'test-source');
    `);
    db.prepare('INSERT INTO information_items VALUES (?, ?, ?)').run('item-1', 1, require('../date-contract').todayDigestDate());
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
      throw new Error(`Unmocked recovery dependency: ${id}`);
    };
    subject._compile(fs.readFileSync(filename, 'utf8'), filename);
    jobs = subject.exports;
  }

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

  it('recovers the persisted fetch date without params.date and resumes without re-fetching', async () => {
    setup();
    const fetchStageResult = { fetch: [{ source: 'test-source', items: 3 }] };
    insertRow('orig', jobs.JOB_TYPES.FULL_PIPELINE, 'running',
      pipelineProgressJSON({ fetch: 'completed' }, { fetch: fetchStageResult }), { enrichBatchSize: 100 });

    await expect(jobs.markInterruptedJobs({ recover: true })).resolves.toBe(1);

    const orig = jobs.getJob('orig');
    expect(orig).toMatchObject({ status: 'failed', lease_epoch: 1 });
    expect(orig.lease_owner).toBeNull();
    expect(JSON.parse(orig.result).recovery)
      .toMatchObject({ action: 'resume_scheduled', resume_from_stage: 'enrich', resume_of: 'orig' });
    expect(orig.error).toContain("resume from 'enrich'");

    const compId = findResumeJob('orig');
    expect(compId).toBeTruthy();
    const comp = await waitForTerminal(compId);
    expect(comp).toMatchObject({ status: 'completed', lease_epoch: 1, attempt: 1 });
    expect(JSON.parse(comp.params)).toMatchObject({ resume_of: 'orig', resume_from_stage: 'enrich' });
    expect(JSON.parse(comp.params).date).toBe('2026-10-23');
    // fetch 不重跑；剩余阶段按序执行（source_profiles 内部还包含 rescore）。
    expect(calls).toEqual(['enrich', 'translate', 'topic_graph', 'kg_worker', 'entity_momentum', 'source_profiles', 'rescore', 'digest', 'hierarchy']);
    const compResult = JSON.parse(comp.result);
    expect(compResult).toMatchObject({ completed: true, outcome: 'completed', resumed_from_stage: 'enrich', resume_of: 'orig' });
    // 已持久化的 fetch 阶段输出被原样复用，避免重复写入。
    expect(compResult.summary.fetch).toEqual(fetchStageResult);
  });

  it('resumes an interrupted fetch from its persisted per-source checkpoint', async () => {
    setup();
    const checkpoint = [{ source: 'test-source', items: 1 }];
    insertRow('orig', jobs.JOB_TYPES.FULL_PIPELINE, 'running',
      pipelineProgressJSON({ fetch: 'running' }, { fetch: { fetch: checkpoint } },
        { fetchResults: checkpoint }), { enrichBatchSize: 100 });

    await jobs.markInterruptedJobs({ recover: true });
    const compId = findResumeJob('orig');
    expect(JSON.parse(jobs.getJob('orig').result).recovery).toMatchObject({
      action: 'resume_scheduled',
      resume_from_stage: 'fetch',
      date: '2026-10-23',
    });
    const comp = await waitForTerminal(compId);
    expect(mocks['./sync'].syncAllSources).toHaveBeenCalledWith({
      jobId: compId,
      signal: expect.any(AbortSignal),
      skipEnrich: true,
      date: '2026-10-23',
      fetchCheckpoint: checkpoint,
    });
    expect(comp).toMatchObject({ status: 'completed' });
    expect(calls[0]).toBe('fetch');
    expect(JSON.parse(comp.result).summary.fetch).toEqual({ fetch: checkpoint });
  });

  it('refuses fetch recovery when the running stage has no per-source checkpoint', async () => {
    setup();
    insertRow('orig', jobs.JOB_TYPES.FULL_PIPELINE, 'running',
      pipelineProgressJSON({ fetch: 'running' }, {}, { fetchResults: null }));

    expect(jobs.markInterruptedJobs({ recover: true })).toBe(1);

    const orig = jobs.getJob('orig');
    expect(orig.status).toBe('failed');
    expect(JSON.parse(orig.result).recovery)
      .toMatchObject({ action: 'resume_refused', reason: 'fetch-checkpoint-missing' });
    expect(orig.error).toContain('recovery refused (fetch-checkpoint-missing)');
    expect(db.prepare('SELECT COUNT(*) AS n FROM background_jobs').get().n).toBe(1);
  });

  it('refuses queued and non-pipeline jobs with explicit reasons', async () => {
    setup();
    insertRow('never-started', jobs.JOB_TYPES.FULL_PIPELINE, 'queued');
    insertRow('plain-enrich', jobs.JOB_TYPES.ENRICH_ITEMS, 'running');

    expect(jobs.markInterruptedJobs({ recover: true })).toBe(2);

    expect(JSON.parse(jobs.getJob('never-started').result).recovery)
      .toMatchObject({ action: 'resume_refused', reason: 'job-never-started' });
    expect(JSON.parse(jobs.getJob('plain-enrich').result).recovery)
      .toMatchObject({ action: 'resume_refused', reason: 'no-checkpoint-for-job-type' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM background_jobs').get().n).toBe(2);
  });

  it('finalizes in place when every stage was already persisted before the restart', async () => {
    setup();
    const allDone = Object.fromEntries(STAGE_KEYS.map(key => [key, 'completed']));
    insertRow('done-in-memory', jobs.JOB_TYPES.FULL_PIPELINE, 'running',
      pipelineProgressJSON(allDone, { digest: { id: 'digest-1' } }));

    expect(jobs.markInterruptedJobs({ recover: true })).toBe(1);

    const row = jobs.getJob('done-in-memory');
    expect(row).toMatchObject({ status: 'completed', lease_epoch: 1 });
    expect(row.error).toBeNull();
    const result = JSON.parse(row.result);
    expect(result).toMatchObject({ completed: true, outcome: 'completed', recovery: { action: 'finalized' } });
    expect(calls).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM background_jobs').get().n).toBe(1);
  });

  it('resumes the compensation chain idempotently across a second restart and converges', async () => {
    setup();
    mocks['./translate'].translateItems.mockImplementation(() => {
      calls.push('translate');
      return new Promise(resolve => translateResolvers.push(resolve));
    });
    const translateResolvers = [];
    insertRow('orig', jobs.JOB_TYPES.FULL_PIPELINE, 'running',
      pipelineProgressJSON({ fetch: 'completed' }, { fetch: { fetch: [{ source: 'test-source', items: 1 }] } }));

    // 第一次重启：恢复到 enrich → translate（挂起模拟重启打断）。
    await jobs.markInterruptedJobs({ recover: true });
    const comp1 = findResumeJob('orig');
    await waitFor(() => calls.includes('translate'), 'comp1 translate stage');
    expect(calls).not.toContain('fetch');

    // 第二次重启：comp1 也被打断；从它自己的检查点（translate）继续。
    await jobs.markInterruptedJobs({ recover: true });
    expect(jobs.getJob(comp1)).toMatchObject({ status: 'failed', lease_epoch: 2 });
    const comp2 = findResumeJob(comp1);
    expect(comp2).toBeTruthy();
    await waitFor(() => translateResolvers.length >= 2, 'comp2 translate stage');
    for (const resolve of translateResolvers) resolve({ translated: 1, total: 1, failed: 0 });
    await waitForTerminal(comp2);
    // comp1 的残留续跑（lease 已失效，写入被拒）也需要排空，避免跨用例噪音。
    await waitFor(() => calls.filter(name => name === 'hierarchy').length >= 2, 'comp1 drain');

    // fetch 全程未重跑，enrich 只执行一次（已完成前缀被复用），translate 从
    // 检查点重跑一次属预期语义。
    expect(calls.filter(name => name === 'fetch')).toHaveLength(0);
    expect(calls.filter(name => name === 'enrich')).toHaveLength(1);
    const comp2Result = JSON.parse(jobs.getJob(comp2).result);
    expect(comp2Result).toMatchObject({ completed: true, outcome: 'completed', resumed_from_stage: 'translate' });
    expect(comp2Result.summary.fetch).toEqual({ fetch: [{ source: 'test-source', items: 1 }] });
    expect(JSON.parse(jobs.getJob(comp2).params).date).toBe('2026-10-23');
    expect(db.prepare('SELECT COUNT(*) AS n FROM background_jobs').get().n).toBe(3);

    // 第三次重启：全部终态，无事可做。
    expect(jobs.markInterruptedJobs({ recover: true })).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM background_jobs').get().n).toBe(3);
  });

  it('keeps cancellation semantics: a cancelled recovery job stays cancelled and blocks further recovery', async () => {
    setup();
    let releaseEnrich;
    mocks['./llm'].enrichItems.mockImplementation(() => {
      calls.push('enrich');
      return new Promise(resolve => { releaseEnrich = () => resolve({ enriched: 1, total: 1, failed: 0 }); });
    });
    insertRow('orig', jobs.JOB_TYPES.FULL_PIPELINE, 'running', pipelineProgressJSON({ fetch: 'completed' }));
    await jobs.markInterruptedJobs({ recover: true });
    const compId = findResumeJob('orig');
    await waitFor(() => calls.includes('enrich'), 'comp enrich stage');

    expect(jobs.cancelJob(compId)).toBe(true);
    releaseEnrich();
    await waitForTerminal(compId);
    expect(jobs.getJob(compId).status).toBe('cancelled');

    // 取消后的 job 不在恢复候选里（cancelled 不属于 interrupted 集合）。
    expect(jobs.markInterruptedJobs({ recover: true })).toBe(0);
  });

  it('marks the source failed but blocks compensation intake while jobs are paused', async () => {
    setup();
    process.env.EAGLEYE_JOBS_PAUSED = '1';
    insertRow('orig', jobs.JOB_TYPES.FULL_PIPELINE, 'running', pipelineProgressJSON({ fetch: 'completed' }));

    await expect(jobs.markInterruptedJobs({ recover: true })).resolves.toBe(1);

    // 补偿入队是事务外的异步步骤，等待“未入队”事实如实写回。
    let recoveryAction = null;
    for (let i = 0; i < 100 && recoveryAction !== 'resume_blocked_jobs_paused'; i++) {
      recoveryAction = JSON.parse(jobs.getJob('orig').result).recovery?.action;
      await tick();
    }
    const orig = jobs.getJob('orig');
    expect(orig.status).toBe('failed');
    expect(recoveryAction).toBe('resume_blocked_jobs_paused');
    expect(db.prepare('SELECT COUNT(*) AS n FROM background_jobs').get().n).toBe(1);
  });

  it('keeps the legacy failure-only behavior when recover is not requested', async () => {
    setup();
    insertRow('orig', jobs.JOB_TYPES.FULL_PIPELINE, 'running', pipelineProgressJSON({ fetch: 'completed' }));

    expect(jobs.markInterruptedJobs()).toBe(1);

    const orig = jobs.getJob('orig');
    expect(orig).toMatchObject({ status: 'failed', lease_epoch: 1 });
    expect(orig.error).toBe('Server restarted before this background job completed');
    expect(JSON.parse(orig.result).recovery).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM background_jobs').get().n).toBe(1);
  });
});
