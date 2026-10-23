// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */
const Database = require('better-sqlite3');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

describe('durable full-pipeline outcomes', () => {
  let db;
  let jobs;
  let mocks;
  let calls;

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
    calls = [];
    const stage = (name, result) => vi.fn(async () => { calls.push(name); return result; });
    mocks = {
      '../db/connection': { getDB: () => db },
      './sync': { syncAllSources: stage('fetch', { fetch: [{ source: 'test-source', items: 1 }] }) },
      './llm': { enrichItems: stage('enrich', { enriched: 1, total: 1, failed: 0 }), generateDailyDigest: stage('digest', { id: 'digest-1' }) },
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

  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  async function terminal(id) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = jobs.getJob(id);
      if (!['queued', 'running'].includes(row.status)) return { ...row, parsed: JSON.parse(row.result) };
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error('Mock pipeline did not reach a terminal state');
  }

  function progressOf(stages, { date = '2026-10-23', fetchResults = [] } = {}) {
    const next = stages.map(stage => stage.key === 'fetch' ? {
      ...stage,
      detail: {
        ...(stage.detail || {}),
        date,
        ...(Array.isArray(fetchResults) ? { results: fetchResults } : {}),
      },
    } : stage);
    return { pipeline: true, completed: false, current_stage: 'fetch', stages: next };
  }

  function insertInterrupted(id, jobType, progress) {
    db.prepare("INSERT INTO background_jobs (id,job_type,status,result) VALUES (?,?,'running',?)")
      .run(id, jobType, JSON.stringify(progress));
  }

  const run = async () => terminal(await jobs.runJob(jobs.JOB_TYPES.FULL_PIPELINE));

  it('persists successful results, covers all active sources, and rescores after KG and momentum', async () => {
    const row = await run();
    expect(row.status).toBe('completed');
    expect(row.parsed).toMatchObject({ completed: true, outcome: 'completed', partial: false, failed_stages: [] });
    expect(row.parsed.stages.every(stage => stage.status === 'completed' && stage.completed_at)).toBe(true);
    expect(row.parsed.summary.digest).toEqual({ generated: true, id: 'digest-1' });
    expect(mocks['./kg-worker'].runKGFullPipeline).toHaveBeenCalledWith(null);
    expect(calls).toEqual(['fetch', 'enrich', 'translate', 'topic_graph', 'kg_worker', 'entity_momentum', 'source_profiles', 'rescore', 'digest', 'hierarchy']);
    expect(mocks['./signals'].scoreSignals).toHaveBeenCalledTimes(1);
  });

  it('keeps partial outputs and fails the job when a stage throws', async () => {
    mocks['./kg-worker'].runKGFullPipeline.mockRejectedValue(new Error('worker unavailable'));
    const row = await run();
    expect(row.status).toBe('failed');
    expect(row.error).toContain('kg_worker');
    expect(row.parsed).toMatchObject({ completed: false, partial: true, failed_stages: ['kg_worker'] });
    expect(row.parsed.stages.find(stage => stage.key === 'kg_worker').detail.error).toBe('worker unavailable');
    expect(row.parsed.summary.enrich.enriched).toBe(1);
    expect(row.parsed.summary.hierarchy.domains).toBe(1);
  });

  it('degrades partial fetch failure, continues downstream, and reports later stage failures', async () => {
    mocks['./sync'].syncAllSources.mockResolvedValue({
      fetch: [
        { source: 'available', items: 2 },
        { source: 'broken', error: 'timeout' },
      ],
    });
    // R3 partial-failure semantics (EAGLEYE_R3_PARTIAL_FAIL, default-on): an
    // enrich batch where items succeeded is a partial success, so pin the
    // per-item clause with a fully dead batch instead (partial batches are
    // covered by enrich-partial-failure.test.js / job-enrich-partial-fail.test.js).
    mocks['./llm'].enrichItems.mockResolvedValue({ enriched: 0, failed: 2, total: 2 });
    mocks['./translate'].translateItems.mockResolvedValue({ translated: 0, failed: 1, total: 1 });
    mocks['./topic-graph'].buildTopicGraph.mockResolvedValue({ status: 'error', message: 'graph failed' });
    mocks['./kg-worker'].runKGFullPipeline.mockResolvedValue({ extract: { failed: 1 } });
    mocks['./llm'].generateDailyDigest.mockResolvedValue(null);
    const row = await run();
    expect(row.status).toBe('failed');
    expect(row.parsed.failed_stages).toEqual(['enrich', 'translate', 'topic_graph', 'kg_worker', 'digest']);
    expect(row.parsed.degraded_stages).toEqual(['fetch']);
    expect(row.parsed.stages.find(stage => stage.key === 'fetch').status).toBe('degraded');
    expect(row.parsed.stages.find(stage => stage.key === 'fetch').detail).toMatchObject({
      warning: '1 source(s) failed; continuing downstream with 1 available source(s)',
      failed_sources: ['broken'],
    });
    expect(row.parsed.summary.digest).toMatchObject({ generated: false });
  });

  it('fails the whole pipeline when every fetched source errors', async () => {
    mocks['./sync'].syncAllSources.mockResolvedValue({
      fetch: [
        { source: 'first', error: 'upstream 503' },
        { source: 'second', error: 'timeout' },
      ],
    });
    const row = await run();
    expect(row.status).toBe('failed');
    expect(row.error).toContain('first: upstream 503');
    expect(row.error).toContain('second: timeout');
    expect(row.parsed.failed_stages).toEqual(['fetch']);
    expect(row.parsed.degraded_stages).toEqual([]);
    expect(row.parsed.stages.filter(stage => stage.key !== 'fetch').every(stage => stage.status === 'skipped')).toBe(true);
    expect(row.parsed.stages.find(stage => stage.key === 'fetch').detail.error).toBe('first: upstream 503; second: timeout');
    // The stage helper records completed work; fetch deliberately throws after
    // persisting the all-source failure, so no downstream stage may complete.
    expect(mocks['./sync'].syncAllSources).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(mocks['./llm'].enrichItems).not.toHaveBeenCalled();
  });

  it('marks a requested embedding backend fallback as failed while retaining hash outputs', async () => {
    const kg = {
      extract: { total: 200 },
      embed: { vectors: 500, backend: 'hash', fallback_reason: 'FastEmbed model unavailable' },
      topics: { dynamic_topics: 30 },
    };
    mocks['./kg-worker'].runKGFullPipeline.mockResolvedValue(kg);
    const row = await run();
    expect(row.status).toBe('failed');
    expect(row.parsed).toMatchObject({ completed: false, partial: true, failed_stages: ['kg_worker'] });
    expect(row.parsed.summary.kg_worker).toEqual(kg);
    expect(row.parsed.stages.find(stage => stage.key === 'kg_worker').detail.error).toContain('Requested backend degraded: FastEmbed model unavailable');
  });

  it('accepts an explicitly requested hash backend without fallback as successful', async () => {
    mocks['./kg-worker'].runKGFullPipeline.mockResolvedValue({
      extract: { total: 200 }, embed: { vectors: 500, backend: 'hash' }, topics: { dynamic_topics: 30 },
    });
    const row = await run();
    expect(row.status).toBe('completed');
    expect(row.parsed.completed).toBe(true);
  });

  it('aborts when fetch work throws and skips every downstream stage', async () => {
    for (const dependency of Object.values(mocks)) {
      for (const fn of Object.values(dependency)) {
        if (vi.isMockFunction(fn)) fn.mockImplementation(() => { throw new Error('unavailable'); });
      }
    }
    const row = await run();
    expect(row.status).toBe('failed');
    expect(row.parsed).toMatchObject({ completed: false, partial: false });
    // fetch is the pipeline gate: a synchronous fetch throw aborts before any
    // downstream work, so only fetch is reached and later stages are skipped.
    expect(row.parsed.failed_stages).toEqual(['fetch']);
    expect(row.parsed.stages.find(stage => stage.key === 'fetch').status).toBe('failed');
    expect(row.parsed.stages.filter(stage => stage.key !== 'fetch').every(stage => stage.status === 'skipped')).toBe(true);
    expect(mocks['./sync'].syncAllSources).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it('records unavailable enrichment as failure but an empty-date digest as an intentional skip', async () => {
    mocks['./llm'].enrichItems.mockResolvedValue({ skipped: true, reason: 'no-llm-provider', enriched: 0, total: 0 });
    mocks['./llm'].generateDailyDigest.mockResolvedValue({ __skipped: true, reason: 'No items today' });
    const row = await run();
    expect(row.parsed.failed_stages).toEqual(['enrich']);
    expect(row.parsed.summary.digest).toEqual({ generated: false, skipped: true, reason: 'No items today' });
    expect(row.parsed.stages.find(stage => stage.key === 'digest').status).toBe('skipped');
  });

  it('allows a successful run with a legitimate empty-date digest skip', async () => {
    mocks['./llm'].generateDailyDigest.mockResolvedValue({ __skipped: true, reason: 'No items today' });
    const row = await run();
    expect(row.status).toBe('completed');
    expect(row.parsed.completed).toBe(true);
    expect(row.parsed.summary.digest.generated).toBe(false);
  });

  it('preserves source profile outputs when rescoring fails', async () => {
    mocks['./signals'].scoreSignals.mockRejectedValue(new Error('scoring unavailable'));
    const row = await run();
    expect(row.status).toBe('failed');
    expect(row.parsed.failed_stages).toEqual(['source_profiles']);
    expect(row.parsed.summary.source_profiles).toMatchObject({ sources: 1, rescore: { error: 'scoring unavailable' } });
  });

  it('does not overwrite enrichment progress when later rescoring reports progress', async () => {
    mocks['./signals'].scoreSignals.mockImplementation(async (_items, { jobId }) => {
      jobs.updateJobProgress(jobId, { phase: 'scoring', processed: 1 });
      return { scored: 1 };
    });
    const row = await run();
    expect(row.parsed.stages.find(stage => stage.key === 'enrich')).toMatchObject({ status: 'completed', result: { enriched: 1 } });
    expect(row.parsed.completed).toBe(true);
  });

  it.each(['resolve', 'reject'])('keeps cancellation structured after an in-flight stage %s', async mode => {
    let settle;
    mocks['./kg-worker'].runKGFullPipeline.mockImplementation(() => new Promise((resolve, reject) => {
      settle = () => mode === 'resolve' ? resolve({ extract: { total: 1 } }) : reject(new Error('worker stopped'));
    }));
    const id = await jobs.runJob(jobs.JOB_TYPES.FULL_PIPELINE);
    while (!settle) await new Promise(resolve => setImmediate(resolve));
    expect(jobs.cancelJob(id)).toBe(true);
    const before = jobs.getJob(id).result;
    settle();
    await new Promise(resolve => setImmediate(resolve));
    const row = await terminal(id);
    expect(row.status).toBe('cancelled');
    expect(row.result).toBe(before);
    expect(row.parsed).toMatchObject({ cancelled: true, completed: false, outcome: 'cancelled', partial: true });
    expect(row.parsed.stages.find(stage => stage.key === 'kg_worker').status).toBe('cancelled');
    expect(row.parsed.stages.find(stage => stage.key === 'hierarchy').status).toBe('skipped');
    expect(mocks['./source-profiles'].updateEntityMomentum).not.toHaveBeenCalled();
    expect(jobs.cancelJob(id)).toBe(false);
  });

  it('cancels queued jobs and preserves legacy non-JSON results as structured data', () => {
    db.prepare("INSERT INTO background_jobs (id, job_type, status, result) VALUES (?, ?, 'queued', ?)").run('legacy', 'fetch-all', 'old progress text');
    expect(jobs.cancelJob('legacy')).toBe(true);
    expect(JSON.parse(jobs.getJob('legacy').result)).toMatchObject({ previous_result: 'old progress text', cancelled: true });
  });

  it('reconciles interrupted stages without deleting completed outputs', () => {
    const progress = { pipeline: true, completed: false, summary: { fetch: { items: 3 } }, stages: [
      { key: 'fetch', status: 'completed', result: { items: 3 }, completed_at: '2026-09-08T00:00:00Z' },
      { key: 'enrich', status: 'running', detail: { processed: 2 } },
      { key: 'digest', status: 'pending' },
    ] };
    db.prepare("INSERT INTO background_jobs (id,job_type,status,result) VALUES ('interrupted','full-pipeline','running',?)").run(JSON.stringify(progress));
    db.exec("INSERT INTO background_jobs (id,job_type,status,result) VALUES ('legacy','fetch-all','queued','plain progress'), ('done','fetch-all','completed','kept')");
    expect(jobs.markInterruptedJobs()).toBe(2);
    const row = jobs.getJob('interrupted');
    const result = JSON.parse(row.result);
    expect(row.status).toBe('failed');
    expect(result).toMatchObject({ completed: false, interrupted: true, outcome: 'failed', partial: true, summary: progress.summary, failed_stages: ['enrich'] });
    expect(result.stages[0]).toEqual(progress.stages[0]);
    expect(result.stages[1]).toMatchObject({ status: 'failed', detail: { processed: 2 } });
    expect(result.stages[2].status).toBe('skipped');
    expect(JSON.parse(jobs.getJob('legacy').result)).toMatchObject({ previous_result: 'plain progress', interrupted: true });
    expect(jobs.getJob('done').result).toBe('kept');
    expect(jobs.markInterruptedJobs()).toBe(0);
    expect(calls).toEqual([]);
  });

  it('persists the recovery date and resumes from the first unfinished stage', async () => {
    insertInterrupted('resume-me', 'full-pipeline', progressOf([
      { key: 'fetch', status: 'completed', result: { fetched: 4 } },
      { key: 'enrich', status: 'completed', result: { enriched: 4 } },
      { key: 'translate', status: 'running' },
      { key: 'topic_graph', status: 'pending' },
      { key: 'kg_worker', status: 'pending' },
      { key: 'entity_momentum', status: 'pending' },
      { key: 'source_profiles', status: 'pending' },
      { key: 'digest', status: 'pending' },
      { key: 'hierarchy', status: 'pending' },
    ]));
    await expect(jobs.markInterruptedJobs({ recover: true })).resolves.toBe(1);
    let compensation = null;
    for (let i = 0; i < 100 && !compensation; i++) {
      compensation = db.prepare("SELECT * FROM background_jobs WHERE id != 'resume-me'").get() || null;
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(compensation).toBeTruthy();
    expect(JSON.parse(compensation.params)).toMatchObject({
      date: '2026-10-23',
      resume_of: 'resume-me',
      resume_from_stage: 'translate',
    });
    const row = await terminal(compensation.id);
    expect(calls).not.toContain('fetch');
    expect(calls).not.toContain('enrich');
    expect(row.parsed.stages.find(stage => stage.key === 'fetch')).toMatchObject({ status: 'completed', result: { fetched: 4 } });
    expect(row.parsed.resumed_from_stage).toBe('translate');
    expect(row.parsed.resume_of).toBe('resume-me');
  });

  it('resumes a failed stage from itself when its completed prefix is checkpointed', async () => {
    insertInterrupted('failed-prefix', 'full-pipeline', progressOf([
      { key: 'fetch', status: 'completed', result: { fetched: 4 } },
      { key: 'enrich', status: 'failed', detail: { error: 'provider unavailable' }, result: { enriched: 0 } },
      { key: 'translate', status: 'skipped' },
      { key: 'topic_graph', status: 'skipped' },
      { key: 'kg_worker', status: 'skipped' },
      { key: 'entity_momentum', status: 'skipped' },
      { key: 'source_profiles', status: 'skipped' },
      { key: 'digest', status: 'skipped' },
      { key: 'hierarchy', status: 'skipped' },
    ]));
    await expect(jobs.markInterruptedJobs({ recover: true })).resolves.toBe(1);
    const compensation = db.prepare("SELECT * FROM background_jobs WHERE id != 'failed-prefix'").get();
    expect(JSON.parse(compensation.params)).toMatchObject({
      date: '2026-10-23',
      resume_of: 'failed-prefix',
      resume_from_stage: 'enrich',
    });
    const row = await terminal(compensation.id);
    expect(row.status).toBe('completed');
    expect(calls[0]).toBe('enrich');
    expect(calls).not.toContain('fetch');
    expect(row.parsed.stages.find(stage => stage.key === 'fetch')).toMatchObject({
      status: 'completed',
      result: { fetched: 4 },
    });
    expect(row.parsed.resumed_from_stage).toBe('enrich');
  });

  it('refuses fetch recovery when the running stage has no per-source checkpoint', async () => {
    insertInterrupted('mid-fetch', 'full-pipeline', progressOf([
      { key: 'fetch', status: 'running' },
      { key: 'enrich', status: 'pending' },
    ], { fetchResults: null }));
    expect(jobs.markInterruptedJobs({ recover: true })).toBe(1);
    const result = JSON.parse(jobs.getJob('mid-fetch').result);
    expect(result.recovery).toMatchObject({ action: 'resume_refused', reason: 'fetch-checkpoint-missing' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM background_jobs WHERE id != 'mid-fetch' AND job_type = 'full-pipeline'").get().n).toBe(0);
  });

  it('finalizes an interrupted job whose stages were all persisted', () => {
    insertInterrupted('all-done', 'full-pipeline', progressOf([
      { key: 'fetch', status: 'completed', result: {} },
      { key: 'enrich', status: 'completed', result: {} },
      { key: 'translate', status: 'completed', result: {} },
      { key: 'topic_graph', status: 'completed', result: {} },
      { key: 'kg_worker', status: 'completed', result: {} },
      { key: 'entity_momentum', status: 'completed', result: {} },
      { key: 'source_profiles', status: 'completed', result: {} },
      { key: 'digest', status: 'completed', result: {} },
      { key: 'hierarchy', status: 'completed', result: {} },
    ]));
    expect(jobs.markInterruptedJobs({ recover: true })).toBe(1);
    const row = jobs.getJob('all-done');
    expect(row.status).toBe('completed');
    expect(row.error).toBeNull();
    expect(JSON.parse(row.result).recovery).toMatchObject({ action: 'finalized' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM background_jobs').get().n).toBe(1);
  });

  it('records a failed non-paused enqueue instead of claiming recovery was scheduled', async () => {
    insertInterrupted('cannot-enqueue', 'full-pipeline', progressOf([
      { key: 'fetch', status: 'completed', result: {} },
      { key: 'enrich', status: 'running' },
      { key: 'translate', status: 'skipped' },
      { key: 'topic_graph', status: 'skipped' },
      { key: 'kg_worker', status: 'skipped' },
      { key: 'entity_momentum', status: 'skipped' },
      { key: 'source_profiles', status: 'skipped' },
      { key: 'digest', status: 'skipped' },
      { key: 'hierarchy', status: 'skipped' },
    ]));
    db.exec("CREATE TRIGGER refuse_recovery_insert BEFORE INSERT ON background_jobs WHEN NEW.id != 'cannot-enqueue' BEGIN SELECT RAISE(ABORT, 'intake unavailable'); END");
    await expect(jobs.markInterruptedJobs({ recover: true })).resolves.toBe(1);
    for (let i = 0; i < 100; i++) {
      const progress = JSON.parse(jobs.getJob('cannot-enqueue').result);
      if (progress.recovery?.action === 'resume_enqueue_failed') break;
      await new Promise(resolve => setImmediate(resolve));
    }
    const progress = JSON.parse(jobs.getJob('cannot-enqueue').result);
    expect(progress.recovery).toMatchObject({ action: 'resume_enqueue_failed', error: expect.stringContaining('intake unavailable') });
  });

  it('caps automatic work independently of fetched volume and does not fan out research', async () => {
    mocks['./sync'].syncAllSources.mockResolvedValue({ fetch: [{ source: 'test-source', items: 99999 }] });
    const row = await terminal(await jobs.runJob(jobs.JOB_TYPES.FULL_PIPELINE, { enrichBatchSize: 7 }));
    expect(row.status).toBe('completed');
    expect(mocks['./llm'].enrichItems).toHaveBeenCalledWith(7, { jobId: row.id, signal: expect.any(AbortSignal) });
    expect(mocks['./translate'].translateItems).toHaveBeenCalledWith({ jobId: row.id, signal: expect.any(AbortSignal), batchSize: 7 });
    expect(mocks['./signals'].scoreSignals.mock.calls[0][1]).not.toHaveProperty('autoResearch');
  });

  it('rejects unbounded programmatic jobs before creating records', async () => {
    for (const [type, params] of [
      [jobs.JOB_TYPES.ENRICH_ITEMS, { batchSize: 0 }],
      [jobs.JOB_TYPES.FULL_PIPELINE, { enrichBatchSize: 1601 }],
      [jobs.JOB_TYPES.FETCH_SOURCE, { limit: 101 }],
      [jobs.JOB_TYPES.SCORE_SIGNALS, { limit: -1 }],
      [jobs.JOB_TYPES.TRANSLATE_BACKFILL, { all: true }],
    ]) await expect(jobs.runJob(type, params)).rejects.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM background_jobs').get().n).toBe(0);
    expect(calls).toEqual([]);
  });

  it('marks returned single-source failures as failed and forwards bounded fetch options', async () => {
    mocks['./sync'].syncSource = vi.fn(async () => ({ failed: 1, items: [] }));
    const row = await terminal(await jobs.runJob(jobs.JOB_TYPES.FETCH_SOURCE, { slug: 'test-source', date: '20260909', limit: 5 }));
    expect(row.status).toBe('failed');
    expect(mocks['./sync'].syncSource).toHaveBeenCalledWith('test-source', '20260909', { jobId: row.id, signal: expect.any(AbortSignal), limit: 5, skipEnrich: true });
    expect(row.error).toContain('1 item(s) failed');
  });

  it.each([
    ['ENRICH_ITEMS', './llm', 'enrichItems', 1],
    ['TRANSLATE_BACKFILL', './translate', 'translateItems', 0],
    ['BUILD_DIGEST', './llm', 'generateDailyDigest', 1],
    ['FULL_PIPELINE', './llm', 'enrichItems', 1],
  ])('aborts the in-flight %s operation and preserves its cancellation receipt', async (type, dependency, method, optionIndex) => {
    let requestSignal;
    let observedStatus;
    let aborted = 0;
    const provider = vi.fn(options => new Promise((_resolve, reject) => {
      requestSignal = options.signal;
      requestSignal.addEventListener('abort', () => {
        aborted++;
        observedStatus = jobs.getJob(options.jobId).status;
        reject(requestSignal.reason);
      }, { once: true });
    }));
    mocks[dependency][method].mockImplementation((...args) => provider(args[optionIndex]));
    const id = await jobs.runJob(jobs.JOB_TYPES[type]);
    while (!requestSignal) await new Promise(resolve => setImmediate(resolve));
    expect(requestSignal).toBe(jobs.getJobSignal(id));
    expect(requestSignal.aborted).toBe(false);
    expect(jobs.cancelJob(id)).toBe(true);
    const receipt = jobs.getJob(id).result;
    await new Promise(resolve => setImmediate(resolve));
    expect(aborted).toBe(1);
    expect(observedStatus).toBe('cancelled');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(requestSignal.aborted).toBe(true);
    expect(jobs.getJob(id).result).toBe(receipt);
    expect(jobs.getJobSignal(id)).not.toBe(requestSignal);
    expect(jobs.getJobSignal(id).aborted).toBe(true);
    if (type === 'FULL_PIPELINE') {
      const result = JSON.parse(receipt);
      expect(result.summary.fetch).toEqual({ fetch: [{ source: 'test-source', items: 1 }] });
      expect(result.stages.find(stage => stage.key === 'fetch').status).toBe('completed');
      expect(mocks['./translate'].translateItems).not.toHaveBeenCalled();
    }
  });

  it.each(['completed', 'failed'])('cleans the controller when execution is %s without cancelling completed output', async status => {
    if (status === 'failed') mocks['./llm'].enrichItems.mockRejectedValue(new Error('provider failure'));
    const id = await jobs.runJob(jobs.JOB_TYPES.ENRICH_ITEMS);
    const row = await terminal(id);
    await new Promise(resolve => setImmediate(resolve));
    const signal = mocks['./llm'].enrichItems.mock.calls[0][1].signal;
    expect(row.status).toBe(status);
    expect(jobs.getJobSignal(id)).toBeUndefined();
    expect(jobs.cancelJob(id)).toBe(false);
    expect(signal.aborted).toBe(false);
    expect(jobs.getJob(id).result).toBe(row.result);
  });
});
