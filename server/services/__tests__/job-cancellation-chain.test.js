// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */
const Database = require('better-sqlite3');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

describe('actual job and enrichment cancellation chain', () => {
  let db;
  let jobs;
  let provider;
  const scoring = process.env.ENABLE_SIGNAL_SCORING;

  beforeEach(() => {
    db = new Database(':memory:');
    for (const migration of ['001_initial_schema.sql', '002_i18n_translations.sql', '032_llm_output_metadata.sql']) {
      db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations', migration), 'utf8'));
    }
    db.exec(`ALTER TABLE information_items ADD COLUMN enrichment_attempts INTEGER DEFAULT 0;
      ALTER TABLE information_items ADD COLUMN last_enrich_attempt TEXT;
      INSERT INTO information_items (id, source_id, canonical_url, title, digest_date)
        VALUES ('pending', 's001', 'https://example.com/pending', 'Pending article', '20260909'),
               ('done', 's001', 'https://example.com/done', 'Completed article', '20260909');
      UPDATE information_items SET original_summary = 'The release includes reproducible evaluation scripts and documents the measurement procedure.' WHERE id = 'pending';
      INSERT INTO ai_summaries (id, item_id, model_provider, model_name, prompt_version, short_summary)
        VALUES ('preserved', 'done', 'old', 'old', 'old', 'Already completed output');`);
    provider = { isPool: true, name: 'test-pool', callWithMetadata: vi.fn() };
    const jobExports = {};
    const mocks = {
      '../db/connection': { getDB: () => db },
      './jobs': jobExports,
      './content-sufficiency': { deepEnrichSkipReason: () => null },
      './llm-provider': { getProvider: () => provider, getEnrichProvider: () => provider },
      './llm-shared': require('../llm-shared'),
      './llm-digest': { generateDailyDigest: vi.fn() },
      './topic-graph': { buildTopicGraph: vi.fn() },
      './sync': { syncAllSources: vi.fn(async () => ({ fetched: 1, inserted: 1 })) },
      './kg-worker': { runKGFullPipeline: vi.fn() },
      './translate': { translateItems: vi.fn() },
    };
    const load = name => {
      const filename = path.resolve(__dirname, `../${name}.js`);
      const subject = new Module(filename, module);
      subject.filename = filename;
      subject.require = id => {
        if (mocks[id]) return mocks[id];
        if (id === './llm-error-class') return require('../llm-error-class');
        if (id === './date-contract') return require('../date-contract');
        if (id === 'crypto') return require('node:crypto');
        throw new Error(`Unmocked cancellation dependency: ${id}`);
      };
      subject._compile(fs.readFileSync(filename, 'utf8'), filename);
      return subject.exports;
    };
    mocks['./llm'] = load('llm');
    jobs = Object.assign(jobExports, load('jobs'));
    process.env.ENABLE_SIGNAL_SCORING = 'false';
    for (const method of ['log', 'warn', 'error']) vi.spyOn(console, method).mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    if (scoring === undefined) delete process.env.ENABLE_SIGNAL_SCORING;
    else process.env.ENABLE_SIGNAL_SCORING = scoring;
  });

  it.each([
    ['ENRICH_ITEMS', 'reject'], ['ENRICH_ITEMS', 'late-response'],
    ['FULL_PIPELINE', 'reject'], ['FULL_PIPELINE', 'late-response'],
  ])('cancels %s through the actual service and blocks %s from writing', async (type, behavior) => {
    let signal;
    let release;
    let abortEvents = 0;
    provider.callWithMetadata.mockImplementation((_prompt, options) => new Promise((resolve, reject) => {
      signal = options.signal;
      release = () => resolve({ text: JSON.stringify([{ id: 'pending', title_zh: '迟到的标题',
        one_liner_zh: '迟到的一句话', short_summary_zh: '取消以后不应提交的摘要', suggested_tags: [],
        entities: [], topic_slugs: [], key_points_zh: [], confidence: 0.5 }]),
      metadata: { provider: 'test', model: 'test' } });
      signal.addEventListener('abort', () => {
        abortEvents++;
        if (behavior === 'reject') reject(signal.reason);
      }, { once: true });
    }));
    const id = await jobs.runJob(jobs.JOB_TYPES[type], { batchSize: 1, enrichBatchSize: 1 });
    for (let i = 0; i < 100 && !signal; i++) await new Promise(resolve => setImmediate(resolve));
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal).toBe(jobs.getJobSignal(id));
    const summariesBefore = db.prepare('SELECT * FROM ai_summaries ORDER BY id').all();
    const itemBefore = db.prepare('SELECT * FROM information_items WHERE id = ?').get('pending');
    expect(itemBefore.enrichment_attempts).toBe(1);
    expect(jobs.cancelJob(id)).toBe(true);
    const receipt = jobs.getJob(id).result;
    if (behavior === 'late-response') release();
    for (let i = 0; i < 100 && jobs.getJobSignal(id) === signal; i++) await new Promise(resolve => setImmediate(resolve));
    expect(abortEvents).toBe(1);
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
    expect(jobs.getJob(id)).toMatchObject({ status: 'cancelled', result: receipt });
    expect(jobs.getJobSignal(id)).not.toBe(signal);
    expect(db.prepare('SELECT * FROM ai_summaries ORDER BY id').all()).toEqual(summariesBefore);
    expect(db.prepare('SELECT * FROM information_items WHERE id = ?').get('pending')).toEqual(itemBefore);
    if (type === 'FULL_PIPELINE') {
      const result = JSON.parse(receipt);
      expect(result.summary.fetch).toEqual({ fetched: 1, inserted: 1 });
      expect(result.stages.find(stage => stage.key === 'enrich').status).toBe('cancelled');
      expect(result.stages.find(stage => stage.key === 'translate').status).toBe('skipped');
    }
  });
});
