// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */
//
// EAGLEYE_R3_PARTIAL_FAIL — enrich batch partial-failure semantics (R3 stage 2).
//
// Production evidence (CTO fact ④ + R3 stage-1 diagnosis, 2026-10-19/20):
// the 2h enrich drainer runs batch=1200 and, on every run since 10-19, 2-34
// items fail while ~1196 succeed; server/services/jobs.js:390
// (`Number(result.failed) > 0` inside stageFailure) turns that into a
// whole-batch `failed` job status via jobs.js:674-678 (ENRICH_ITEMS) and
// jobs.js:407 (full-pipeline enrich stage), even though the successful items
// already flow downstream at the data layer (downstream selectors never read
// background_jobs).
//
// Contract under test (scope: "批内 2-34 条失败只标失败条目，job 状态不再整批
// failed；成功条目照常被下游消费；开关 EAGLEYE_R3_PARTIAL_FAIL 默认开，关=旧行为"):
//
//   1. Partial batch failure (enriched > 0 && failed > 0):
//        - ENRICH_ITEMS job terminal status is 'completed' (not 'failed'),
//          error stays null;
//        - the persisted result keeps `failed`, `enriched` and
//          `successful_item_ids` so the failure count stays observable and
//          downstream consumers (drainer/observability) keep receiving the
//          successful-item list;
//        - inside FULL_PIPELINE the enrich stage itself is 'completed', the
//          pipeline outcome is 'completed' with no failed stages, and every
//          downstream stage still runs (they consume per-item state, not the
//          job status — see stage-1 DAG: kg extract pending = missing
//          item_features, kg embed pending = missing item_vectors, translate
//          reads ai_summaries, signal scoring runs on successfulItemIds).
//   2. All-failed batch (enriched === 0 && failed > 0) still fails the job /
//      the enrich stage (the narrowing must not swallow genuine failures).
//   3. Switch semantics, parsed like the existing EAGLEYE_JOBS_PAUSED gate
//      (jobs.js:79-86: String(env ?? '').trim().toLowerCase()):
//        - unset (default) or explicitly truthy ('1', 'true') → new semantics;
//        - explicitly falsy ('0', 'false') → legacy whole-batch 'failed'
//          behaviour with the legacy `${failed} item(s) failed` error text.
//
// Expected on the UNIMPLEMENTED code (this file is the RED spec):
//   RED   (assertion failures): the two default/switch-on ENRICH_ITEMS cases
//         and the full-pipeline case receive 'failed' where 'completed' is
//         asserted.
//   GUARD (pass today and must keep passing): explicit switch-off cases, the
//         all-failed ENRICH_ITEMS case and the all-failed pipeline case.

const Database = require('better-sqlite3');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const PARTIAL_FAIL_ENV = 'EAGLEYE_R3_PARTIAL_FAIL';
const previousSwitch = process.env[PARTIAL_FAIL_ENV];

// Shape taken from production job 10-19 06:44Z: 1196/1200 succeeded, 4 failed.
const PARTIAL_BATCH = { enriched: 1196, failed: 4, total: 1200, successful_item_ids: ['item-1'] };
const ALL_FAILED_BATCH = { enriched: 0, failed: 4, total: 4, successful_item_ids: [] };

function loadJobsWithEnrichResult(enrichResult) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE background_jobs (
      id TEXT PRIMARY KEY, job_type TEXT, status TEXT CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      params TEXT, result TEXT, error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, started_at TEXT, completed_at TEXT
    );
    CREATE TABLE sources (id INTEGER PRIMARY KEY, label TEXT, slug TEXT);
    CREATE TABLE information_items (id TEXT PRIMARY KEY, source_id INTEGER, digest_date TEXT);
    INSERT INTO sources VALUES (1, 'Test source', 'test-source');
  `);
  db.prepare('INSERT INTO information_items VALUES (?, ?, ?)')
    .run('item-1', 1, require('../date-contract').todayDigestDate());

  const calls = [];
  const stage = (name, result) => vi.fn(async () => { calls.push(name); return result; });
  const mocks = {
    '../db/connection': { getDB: () => db },
    './sync': { syncAllSources: stage('fetch', { fetch: [{ source: 'test-source', items: 1 }] }) },
    './llm': {
      enrichItems: stage('enrich', enrichResult),
      generateDailyDigest: stage('digest', { id: 'digest-1' }),
    },
    './translate': { translateItems: stage('translate', { translated: 1, total: 1, failed: 0 }) },
    './topic-graph': { buildTopicGraph: stage('topic_graph', { edges_updated: 1 }) },
    './kg-worker': {
      runKGFullPipeline: stage('kg_worker',
        { extract: { total: 200 }, embed: { vectors: 500, backend: 'hash' }, topics: { dynamic_topics: 30 } }),
    },
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
    throw new Error(`Unmocked pipeline dependency: ${id}`);
  };
  subject._compile(fs.readFileSync(filename, 'utf8'), filename);
  const jobs = subject.exports;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return { db, jobs, mocks, calls };
}

async function terminal(jobs, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = jobs.getJob(id);
    if (!['queued', 'running'].includes(row.status)) return { ...row, parsed: JSON.parse(row.result) };
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Mock job did not reach a terminal state');
}

describe('EAGLEYE_R3_PARTIAL_FAIL: enrich partial-failure batch semantics', () => {
  let db;

  beforeEach(() => { delete process.env[PARTIAL_FAIL_ENV]; });

  afterEach(() => {
    if (db) { db.close(); db = null; }
    vi.restoreAllMocks();
    if (previousSwitch === undefined) delete process.env[PARTIAL_FAIL_ENV];
    else process.env[PARTIAL_FAIL_ENV] = previousSwitch;
  });

  it('RED: partial batch failure (enriched>0, failed>0) completes the job and keeps failure accounting in the result', async () => {
    const ctx = loadJobsWithEnrichResult(PARTIAL_BATCH); db = ctx.db;
    const row = await terminal(ctx.jobs, await ctx.jobs.runJob(ctx.jobs.JOB_TYPES.ENRICH_ITEMS));
    expect(row.status).toBe('completed');
    expect(row.error).toBeNull();
    // The result must stay observable: failure count and successful-item list
    // are what the drainer and downstream consumers read.
    expect(row.parsed).toMatchObject({ enriched: 1196, failed: 4, successful_item_ids: ['item-1'] });
  });

  it.each(['1', 'true'])('RED: explicit switch-on value %s keeps the partial-failure semantics', async value => {
    process.env[PARTIAL_FAIL_ENV] = value;
    const ctx = loadJobsWithEnrichResult(PARTIAL_BATCH); db = ctx.db;
    const row = await terminal(ctx.jobs, await ctx.jobs.runJob(ctx.jobs.JOB_TYPES.ENRICH_ITEMS));
    expect(row.status).toBe('completed');
    expect(row.error).toBeNull();
  });

  it.each(['0', 'false'])('GUARD: explicit switch-off value %s restores the legacy whole-batch failure', async value => {
    process.env[PARTIAL_FAIL_ENV] = value;
    const ctx = loadJobsWithEnrichResult(PARTIAL_BATCH); db = ctx.db;
    const row = await terminal(ctx.jobs, await ctx.jobs.runJob(ctx.jobs.JOB_TYPES.ENRICH_ITEMS));
    expect(row.status).toBe('failed');
    expect(row.error).toContain('item(s) failed');
  });

  it('GUARD: an all-failed batch (enriched===0) still fails the job', async () => {
    const ctx = loadJobsWithEnrichResult(ALL_FAILED_BATCH); db = ctx.db;
    const row = await terminal(ctx.jobs, await ctx.jobs.runJob(ctx.jobs.JOB_TYPES.ENRICH_ITEMS));
    expect(row.status).toBe('failed');
    expect(row.error).toBeTruthy();
  });

  it('RED: full pipeline marks a partial enrich failure as a completed stage and downstream stages still consume the outputs', async () => {
    const ctx = loadJobsWithEnrichResult(PARTIAL_BATCH); db = ctx.db;
    const row = await terminal(ctx.jobs, await ctx.jobs.runJob(ctx.jobs.JOB_TYPES.FULL_PIPELINE));
    expect(row.status).toBe('completed');
    expect(row.parsed).toMatchObject({ completed: true, outcome: 'completed', partial: false, failed_stages: [] });
    const enrichStage = row.parsed.stages.find(stage => stage.key === 'enrich');
    expect(enrichStage.status).toBe('completed');
    expect(enrichStage.result).toMatchObject({ enriched: 1196, failed: 4 });
    // Downstream stages select on per-item state (features/vectors/summaries),
    // never on the job status — they must all still run.
    expect(ctx.calls).toEqual([
      'fetch', 'enrich', 'translate', 'topic_graph', 'kg_worker',
      'entity_momentum', 'source_profiles', 'rescore', 'digest', 'hierarchy',
    ]);
  });

  it('GUARD: full pipeline still fails when the whole enrich batch failed', async () => {
    const ctx = loadJobsWithEnrichResult(ALL_FAILED_BATCH); db = ctx.db;
    const row = await terminal(ctx.jobs, await ctx.jobs.runJob(ctx.jobs.JOB_TYPES.FULL_PIPELINE));
    expect(row.status).toBe('failed');
    expect(row.parsed.failed_stages).toEqual(['enrich']);
    expect(row.parsed.stages.find(stage => stage.key === 'enrich').status).toBe('failed');
  });
});
