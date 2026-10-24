// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */
/**
 * R3 enrich partial-failure semantics — switch reconciliation note + spec.
 *
 * CTO fact ④ and the stage-2 direction: today jobs.js:390 treats
 * `Number(result.failed) > 0` as a stage failure, so an enrich batch where
 * 1,196/1,200 items succeeded is marked failed as a whole (10 consecutive
 * failed jobs since 10-19, each with only 2-34 failed items). The fix is
 * gated behind a rollback switch. CROSS-LANE NOTE: a sibling lane already
 * specified this judgment under EAGLEYE_R3_PARTIAL_FAIL with DEFAULT-ON
 * semantics (job-enrich-partial-fail.test.js, merged into this worktree
 * first — first-merger priority per discipline). The two specs are
 * reconciled here: this file's ON cases set EAGLEYE_R3_DRAINER='1' (the
 * umbrella switch for the whole R3 lane) with EAGLEYE_R3_PARTIAL_FAIL
 * unset, and its OFF cases pin the legacy behavior with
 * EAGLEYE_R3_PARTIAL_FAIL='0'. One implementation — "new semantics unless
 * EAGLEYE_R3_PARTIAL_FAIL is explicitly falsy" — satisfies both files.
 *
 * Semantics under test:
 *
 *   ON:  an enrich-SHAPED result (has an `enriched` field) is only a
 *        failure when the WHOLE batch died (enriched === 0 && failed > 0).
 *        Partial failures (enriched > 0, failed > 0) are not failures:
 *        the ENRICH_ITEMS job completes, the nightly pipeline's enrich
 *        stage completes, and every later stage still runs — per-item
 *        failure visibility stays in the stored result (failed count,
 *        successful_item_ids; item-level enrichment_attempts is the
 *        retry/poison-pill mechanism).
 *   OFF: byte-identical to today — `failed > 0` fails the job and the
 *        pipeline stage with the legacy `${failed} item(s) failed` text.
 *
 * The narrowing is shape-based (only results carrying `enriched`), so the
 * judgment for translate ({translated, failed}), fetch rows, nested KG
 * results and fallback_reason stays exactly as today — asserted below.
 *
 * Both env switches must be read at CALL time (like isJobIntakePaused,
 * jobs.js:82-85), which is how these tests flip them per-case.
 */

const Database = require('better-sqlite3');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

describe('enrich partial-failure semantics (R3 switches)', () => {
  let db;
  let jobs;
  let mocks;
  let calls;

  beforeEach(() => {
    delete process.env.EAGLEYE_R3_DRAINER;
    delete process.env.EAGLEYE_R3_PARTIAL_FAIL;
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
      './kg-worker': { runKGFullPipeline: stage('kg_worker', { extract: { total: 1 }, embed: { vectors: 1 }, topics: { dynamic_topics: 1 } }) },
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
    jobs = subject.exports;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    delete process.env.EAGLEYE_R3_DRAINER;
    delete process.env.EAGLEYE_R3_PARTIAL_FAIL;
    vi.restoreAllMocks();
  });

  async function terminal(id) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = jobs.getJob(id);
      if (!['queued', 'running'].includes(row.status)) return { ...row, parsed: JSON.parse(row.result) };
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error('Mock job did not reach a terminal state');
  }

  // Production shape from 10-19 06:44Z: 1,196 succeeded, 4 dead-batch items.
  const PARTIAL = { enriched: 1196, failed: 4, total: 1200, successful_item_ids: ['item-1'], batch_items: 4, workers: 4 };

  describe('switch ON (EAGLEYE_R3_DRAINER=1, EAGLEYE_R3_PARTIAL_FAIL default)', () => {
    it('partial enrich failure completes the ENRICH_ITEMS job and keeps per-item counts visible', async () => {
      process.env.EAGLEYE_R3_DRAINER = '1';
      mocks['./llm'].enrichItems.mockResolvedValue(PARTIAL);
      const row = await terminal(await jobs.runJob(jobs.JOB_TYPES.ENRICH_ITEMS, { batchSize: 1200 }));
      expect(row.status).toBe('completed');
      expect(row.error).toBeNull();
      expect(row.parsed.enriched).toBe(1196);
      expect(row.parsed.failed).toBe(4);
    });

    it('a fully dead batch (enriched=0) still fails the job', async () => {
      process.env.EAGLEYE_R3_DRAINER = '1';
      mocks['./llm'].enrichItems.mockResolvedValue({ enriched: 0, failed: 10, total: 10, successful_item_ids: [] });
      const row = await terminal(await jobs.runJob(jobs.JOB_TYPES.ENRICH_ITEMS, { batchSize: 10 }));
      expect(row.status).toBe('failed');
      expect(row.error).toBe('10 item(s) failed');
    });

    it('partial enrich failure no longer fails the nightly pipeline; every later stage still runs', async () => {
      process.env.EAGLEYE_R3_DRAINER = '1';
      // mockResolvedValue would clobber the stage() wrapper (which records the
      // call), so keep the recording implementation and return PARTIAL from it.
      mocks['./llm'].enrichItems.mockImplementation(async () => { calls.push('enrich'); return PARTIAL; });
      const row = await terminal(await jobs.runJob(jobs.JOB_TYPES.FULL_PIPELINE, {}));
      expect(row.status).toBe('completed');
      expect(row.parsed).toMatchObject({ completed: true, outcome: 'completed', partial: false, failed_stages: [] });
      const enrichStage = row.parsed.stages.find(stage => stage.key === 'enrich');
      expect(enrichStage.status).toBe('completed');
      expect(row.parsed.summary.enrich.failed).toBe(4);
      expect(calls).toEqual(['fetch', 'enrich', 'translate', 'topic_graph', 'kg_worker', 'entity_momentum', 'source_profiles', 'rescore', 'digest', 'hierarchy']);
    });

    it('non-enrich shapes keep today\'s judgment: a partial translate batch still fails its stage', async () => {
      process.env.EAGLEYE_R3_DRAINER = '1';
      mocks['./translate'].translateItems.mockResolvedValue({ translated: 5, failed: 1, total: 6 });
      const row = await terminal(await jobs.runJob(jobs.JOB_TYPES.FULL_PIPELINE, {}));
      expect(row.status).toBe('failed');
      expect(row.parsed).toMatchObject({ outcome: 'failed', failed_stages: ['translate'] });
      expect(row.error).toContain('Pipeline stages failed: translate');
    });
  });

  describe('switch OFF (EAGLEYE_R3_PARTIAL_FAIL=0 → byte-identical to today)', () => {
    it('partial enrich failure still fails the ENRICH_ITEMS job with the same error text', async () => {
      process.env.EAGLEYE_R3_PARTIAL_FAIL = '0';
      mocks['./llm'].enrichItems.mockResolvedValue(PARTIAL);
      const row = await terminal(await jobs.runJob(jobs.JOB_TYPES.ENRICH_ITEMS, { batchSize: 1200 }));
      expect(row.status).toBe('failed');
      expect(row.error).toBe('4 item(s) failed');
    });

    it('partial enrich failure still fails the nightly pipeline enrich stage', async () => {
      process.env.EAGLEYE_R3_PARTIAL_FAIL = '0';
      mocks['./llm'].enrichItems.mockResolvedValue(PARTIAL);
      const row = await terminal(await jobs.runJob(jobs.JOB_TYPES.FULL_PIPELINE, {}));
      expect(row.status).toBe('failed');
      expect(row.parsed).toMatchObject({ completed: false, outcome: 'failed', partial: true, failed_stages: ['enrich'] });
      expect(row.parsed.stages.find(stage => stage.key === 'enrich').status).toBe('failed');
    });
  });
});
