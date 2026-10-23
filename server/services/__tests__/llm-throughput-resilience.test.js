// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */
const Database = require('better-sqlite3');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const shared = require('../llm-shared');

const card = (id, extra = {}) => ({
  id,
  title_zh: '开源模型公布评测与运行方法',
  one_liner_zh: '发布了模型与评测。',
  short_summary_zh: '模型发布了运行方法，效果仍需复核。',
  suggested_tags: [],
  entities: [],
  topic_slugs: [],
  key_points_zh: [],
  confidence: 0.6,
  ...extra,
});

const metadata = (id = 'a') => ({
  provider: 'pool',
  protocol: 'pool',
  endpoint_id: 'lane-' + id,
  requested_model: 'requested-' + id,
  model: 'actual-' + id,
  trace_id: 'trace-' + id,
  latency_ms: 10,
  usage: { output_tokens: 20 },
  attempts: 1,
});

const response = (data, id = 'a') => ({ text: JSON.stringify(data), metadata: metadata(id) });
const truncated = () => Object.assign(new Error('output reached max_tokens'), { code: 'TRUNCATED' });
const invalidJson = () => Object.assign(new Error('Unexpected token in JSON'), { code: 'INVALID_JSON' });

function loadService(name, mocks) {
  const filename = path.resolve(__dirname, '../' + name + '.js');
  const subject = new Module(filename, module);
  subject.filename = filename;
  subject.require = id => {
    if (mocks[id]) return mocks[id];
    if (id === './llm-shared') return shared;
    if (id === './llm-error-class') return require('../llm-error-class');
    if (id === './content-sufficiency') return require('../content-sufficiency');
    if (id === './date-contract') return require('../date-contract');
    if (id === 'crypto') return require('node:crypto');
    throw new Error('Unmocked service dependency: ' + id);
  };
  subject._compile(fs.readFileSync(filename, 'utf8'), filename);
  return subject.exports;
}

describe('hermetic LLM throughput resilience', () => {
  let db;
  let provider;
  let mocks;
  let classifier;
  let llm;

  beforeEach(() => {
    db = new Database(':memory:');
    for (const migration of ['001_initial_schema.sql', '002_i18n_translations.sql', '032_llm_output_metadata.sql', '044_information_items_duplicate_of.sql']) {
      db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations', migration), 'utf8'));
    }
    db.exec('ALTER TABLE information_items ADD COLUMN enrichment_attempts INTEGER DEFAULT 0; ALTER TABLE information_items ADD COLUMN last_enrich_attempt TEXT;');
    provider = { isPool: true, name: 'pool', model: 'wrong-global-model', callWithMetadata: vi.fn() };
    mocks = {
      '../db/connection': { getDB: () => db },
      './llm-provider': {
        getProvider: () => provider,
        getEnrichProvider: () => provider,
        getProviderInfo: () => ({ provider: 'pool', model: 'wrong-global-model' }),
      },
      './llm-digest': { generateDailyDigest: vi.fn() },
      './jobs': { isJobCancelled: () => false, updateJobProgress: vi.fn() },
      './signals': { scoreSignals: vi.fn(async items => ({ scored: items.length })) },
      './llm-shared': { ...shared, abortableDelay: async () => {} },
    };
    classifier = loadService('signals-classify', mocks);
    llm = loadService('llm', mocks);
    process.env.ENABLE_SIGNAL_SCORING = 'true';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete process.env.ENABLE_SIGNAL_SCORING;
    delete process.env.SIGNAL_CLASSIFY_INPUT_TOKEN_BUDGET;
    delete process.env.ENRICH_LLM_INPUT_TOKEN_BUDGET;
    delete process.env.SIGNAL_CLASSIFY_CONCURRENCY;
  });

  function addItem(id) {
    db.prepare("INSERT INTO information_items (id, source_id, canonical_url, title, digest_date, score, enrichment_attempts) VALUES (?, 's001', ?, ?, '2026-09-09', 10, 0)")
      .run(id, 'https://example.com/' + id, 'Article ' + id);
    db.prepare('UPDATE information_items SET original_summary = ? WHERE id = ?')
      .run('The source describes a new model release and its measured performance.', id);
    return db.prepare('SELECT i.*, s.label source_label, s.slug source_slug FROM information_items i JOIN sources s ON s.id = i.source_id WHERE i.id = ?').get(id);
  }

  it('repairs a truncated classify batch by narrowing the second request', async () => {
    const items = [{ id: 'a', title: 'Alpha release' }, { id: 'b', title: 'Beta paper' }];
    provider.callWithMetadata
      .mockRejectedValueOnce(truncated())
      .mockResolvedValueOnce(response([{ id: 'a', signal_type: 'model_release', thesis_match: 0.8 }]))
      .mockResolvedValueOnce(response([{ id: 'b', signal_type: 'new_paper', thesis_match: 0.7 }]));

    const result = await classifier.classifySignals(items);

    expect(result.map(row => row.id)).toEqual(['a', 'b']);
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(3);
    expect(provider.callWithMetadata.mock.calls[0][0]).toContain('"id":"a"');
    expect(provider.callWithMetadata.mock.calls[0][0]).toContain('"id":"b"');
    expect(provider.callWithMetadata.mock.calls[1][0]).toContain('"id":"a"');
    expect(provider.callWithMetadata.mock.calls[1][0]).not.toContain('"id":"b"');
    expect(provider.callWithMetadata.mock.calls[0][1].maxTokens).toBe(340);
    expect(provider.callWithMetadata.mock.calls[1][1].maxTokens).toBe(260);
    expect(result.task_stats.attempt_count).toBe(3);
    expect(result.task_stats.attempts[0]).toMatchObject({
      attempt: 1,
      batch_size: 2,
      max_tokens: 340,
      error_code: 'TRUNCATED',
      error_class: 'OUTPUT_INVALID',
    });
    expect(result.task_stats.final_status).toBe('succeeded');
    expect(result.task_stats.coverage).toEqual({ total: 2, success: 2, explicit_failed: 0, deferred: 0 });
    expect(result.task_stats.output_repair_calls).toBe(1);
  });

  it('stops invalid classify JSON after a finite non-pool retry budget', async () => {
    provider.isPool = false;
    provider.callWithMetadata.mockRejectedValue(invalidJson());
    const result = await classifier.classifySignals([{ id: 'a', title: 'Alpha release' }]);

    expect(result).toHaveLength(0);
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(3);
    expect(result.task_stats.attempt_count).toBe(3);
    expect(result.task_stats.attempts.map(row => row.error_code)).toEqual(['INVALID_JSON', 'INVALID_JSON', 'INVALID_JSON']);
    expect(result.task_stats.final_status).toBe('degraded');
    expect(result.task_stats.final_error_code).toBe('INVALID_JSON');
    expect(result.task_stats.total_elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it('repairs a truncated enrich batch by halving it and records both attempts', async () => {
    const items = [];
    for (const id of ['a', 'b', 'c', 'd']) items.push(addItem(id));
    provider.callWithMetadata
      .mockRejectedValueOnce(truncated())
      .mockResolvedValueOnce(response([card('a'), card('b')], 'a'));

    const result = await llm.generateItemSummariesBatch(items);

    expect(result.map(row => row.summary.item_id)).toEqual(['a', 'b']);
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(2);
    expect(provider.callWithMetadata.mock.calls[0][1].maxTokens).toBe(3100);
    expect(provider.callWithMetadata.mock.calls[1][1].maxTokens).toBe(1800);
    expect(result.task_stats.attempt_count).toBe(2);
    expect(result.task_stats.attempts[0]).toMatchObject({
      attempt: 1,
      batch_size: 4,
      max_tokens: 3100,
      error_code: 'TRUNCATED',
      error_class: 'OUTPUT_INVALID',
    });
    expect(result.task_stats.attempts[1]).toMatchObject({ attempt: 2, batch_size: 2, error_code: null });
    expect(result.task_stats.attempts[1].kind).toBe('output_repair');
    expect(result.task_stats.final_status).toBe('partial');
    expect(result.task_stats.coverage).toEqual({ total: 4, success: 2, explicit_failed: 0, deferred: 2 });
    expect(result.task_stats.item_states).toEqual({ a: 'success', b: 'success', c: 'deferred', d: 'deferred' });
  });

  it('degrades invalid enrich JSON after at most one narrowing attempt on a pool', async () => {
    const items = ['a', 'b'].map(addItem);
    provider.callWithMetadata.mockRejectedValue(invalidJson());

    const result = await llm.generateItemSummariesBatch(items);

    expect(result).toHaveLength(0);
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(2);
    expect(result.task_stats.attempt_count).toBe(2);
    expect(result.task_stats.attempts.map(row => row.batch_size)).toEqual([2, 1]);
    expect(result.task_stats.final_status).toBe('degraded');
    expect(result.task_stats.final_error_code).toBe('INVALID_JSON');
    expect(result.task_stats.final_error_class).toBe('OUTPUT_INVALID');
    expect(result.task_stats.coverage).toEqual({ total: 2, success: 0, explicit_failed: 1, deferred: 1 });
    expect(result.task_stats.item_states).toEqual({ a: 'explicit_failed', b: 'deferred' });
  });

  it('persists each successful enrich row once and reports successful task statistics', async () => {
    addItem('a');
    addItem('b');
    provider.callWithMetadata.mockResolvedValue(response([card('a'), card('b')], 'a'));

    const result = await llm.enrichItems(2, { batchItemSize: 2, batchConcurrency: 1 });

    expect(result).toMatchObject({ total: 2, enriched: 2, failed: 0, successful_item_ids: ['a', 'b'] });
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) count FROM ai_summaries').get().count).toBe(2);
    expect(result.task_stats).toMatchObject({ attempt_count: 1, final_status: 'succeeded', final_error_code: null });
  });

  it('splits oversized inputs into bounded requests without dropping the tail', async () => {
    process.env.SIGNAL_CLASSIFY_INPUT_TOKEN_BUDGET = '1';
    process.env.ENRICH_LLM_INPUT_TOKEN_BUDGET = '1';
    process.env.SIGNAL_CLASSIFY_CONCURRENCY = '1';
    const narrowClassifier = loadService('signals-classify', mocks);
    const narrowLlm = loadService('llm', mocks);
    const classifyItems = [{ id: 'a', title: 'Alpha release' }, { id: 'b', title: 'Beta paper' }];
    const enrichItems = ['a', 'b'].map(addItem);
    provider.callWithMetadata
      .mockResolvedValueOnce(response([{ id: 'a', signal_type: 'model_release', thesis_match: 0.8 }]))
      .mockResolvedValueOnce(response([{ id: 'b', signal_type: 'new_paper', thesis_match: 0.7 }]))
      .mockResolvedValueOnce(response([card('a')], 'a'))
      .mockResolvedValueOnce(response([card('b')], 'b'));

    const classified = await narrowClassifier.classifySignals(classifyItems);
    const enriched = await narrowLlm.generateItemSummariesBatch(enrichItems);

    expect(classified.map(row => row.id)).toEqual(['a', 'b']);
    expect(enriched.map(row => row.summary.item_id)).toEqual(['a', 'b']);
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(4);
    expect(classified.task_stats.attempt_count).toBe(2);
    expect(enriched.task_stats.attempt_count).toBe(2);
  });

  it('recovers all repairable enrich gaps so every input reaches a final state', async () => {
    for (const id of ['a', 'b', 'c', 'd']) addItem(id);
    provider.callWithMetadata
      .mockRejectedValueOnce(truncated())
      .mockResolvedValueOnce(response([card('a'), card('b')], 'a'))
      .mockResolvedValueOnce(response([card('c'), card('d')], 'c'));

    const result = await llm.enrichItems(4, { batchItemSize: 4, batchConcurrency: 1 });

    expect(result).toMatchObject({ total: 4, enriched: 4, failed: 0, successful_item_ids: ['a', 'b', 'c', 'd'] });
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(3);
    expect(provider.callWithMetadata.mock.calls[2][0]).toContain('"id":"c"');
    expect(provider.callWithMetadata.mock.calls[2][0]).toContain('"id":"d"');
    expect(provider.callWithMetadata.mock.calls[2][0]).not.toContain('"id":"a"');
    expect(result.task_stats).toMatchObject({
      final_status: 'succeeded',
      output_repair_calls: 1,
      transport_retry_calls: 0,
      coverage: { total: 4, success: 4, explicit_failed: 0, deferred: 0 },
    });
    expect(result.task_stats.item_states).toEqual({ a: 'success', b: 'success', c: 'success', d: 'success' });
  });

  it('stops after one explicit repair failure instead of retrying a poisoned pool item', async () => {
    provider.callWithMetadata.mockRejectedValue(invalidJson());

    const result = await classifier.classifySignals([{ id: 'a', title: 'Alpha release' }]);

    expect(result).toHaveLength(0);
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
    expect(result.task_stats.final_status).toBe('degraded');
    expect(result.task_stats.coverage).toEqual({ total: 1, success: 0, explicit_failed: 1, deferred: 0 });
    expect(result.task_stats.item_states).toEqual({ a: 'explicit_failed' });
    expect(result.task_stats.item_reasons.a).toBe('repair_exhausted');
  });

  it('keeps transport-deferred enrich items unsuccessful until they recover in another run', async () => {
    for (const id of ['a', 'b']) addItem(id);
    provider.callWithMetadata
      .mockRejectedValueOnce(Object.assign(new Error('all endpoints failed'), { code: 'NETWORK_ERROR' }))
      .mockResolvedValueOnce(response([card('a'), card('b')], 'a'));

    const failedRun = await llm.enrichItems(2, { batchItemSize: 2, batchConcurrency: 1 });
    expect(failedRun).toMatchObject({ total: 2, enriched: 0, failed: 0, deferred: 2 });
    expect(failedRun.task_stats.final_status).toBe('degraded');
    expect(failedRun.task_stats.coverage).toEqual({ total: 2, success: 0, explicit_failed: 0, deferred: 2 });
    expect(db.prepare('SELECT COUNT(*) count FROM ai_summaries').get().count).toBe(0);

    const recoveredRun = await llm.enrichItems(2, { batchItemSize: 2, batchConcurrency: 1 });
    expect(recoveredRun).toMatchObject({ total: 2, enriched: 2, failed: 0, deferred: 0 });
    expect(recoveredRun.task_stats.final_status).toBe('succeeded');
    expect(recoveredRun.task_stats.coverage).toEqual({ total: 2, success: 2, explicit_failed: 0, deferred: 0 });
    expect(db.prepare('SELECT COUNT(*) count FROM ai_summaries').get().count).toBe(2);
  });

  it('reports persistent transport deferrals separately from explicit failures', async () => {
    for (const id of ['a', 'b']) addItem(id);
    provider.callWithMetadata.mockRejectedValue(Object.assign(new Error('all endpoints failed'), { code: 'NETWORK_ERROR' }));

    const result = await llm.enrichItems(2, { batchItemSize: 2, batchConcurrency: 1 });

    expect(result).toMatchObject({ total: 2, enriched: 0, failed: 0, deferred: 2 });
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
    expect(result.task_stats.coverage).toEqual({ total: 2, success: 0, explicit_failed: 0, deferred: 2 });
    expect(db.prepare('SELECT COUNT(*) count FROM ai_summaries').get().count).toBe(0);
  });

  it('reports sufficiency-gate skips as deferred rather than explicit failures', async () => {
    addItem('wall');
    db.prepare("UPDATE information_items SET original_summary = 'please log in to continue reading this article' WHERE id = 'wall'").run();
    provider.callWithMetadata.mockRejectedValue(new Error('model must not be called'));

    const result = await llm.enrichItems(1, { batchItemSize: 1, batchConcurrency: 1 });

    expect(result).toMatchObject({ total: 1, enriched: 0, failed: 0, deferred: 1 });
    expect(provider.callWithMetadata).not.toHaveBeenCalled();
    expect(result.task_stats.coverage).toEqual({ total: 1, success: 0, explicit_failed: 0, deferred: 1 });
    expect(result.task_stats.item_reasons.wall).toBe('gate_skipped');
  });

  it('counts non-pool transport retries separately from output repairs', async () => {
    provider.isPool = false;
    provider.callWithMetadata
      .mockRejectedValueOnce(Object.assign(new Error('request timed out'), { code: 'TIMEOUT' }))
      .mockRejectedValueOnce(Object.assign(new Error('network unavailable'), { code: 'NETWORK_ERROR' }))
      .mockResolvedValueOnce(response([{ id: 'a', signal_type: 'new_paper', thesis_match: 0.8 }]));

    const result = await classifier.classifySignals([{ id: 'a', title: 'Alpha release' }]);

    expect(result.map(row => row.id)).toEqual(['a']);
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(3);
    expect(result.task_stats.attempt_count).toBe(3);
    expect(result.task_stats.attempts.map(row => row.kind)).toEqual(['initial', 'transport_retry', 'transport_retry']);
    expect(result.task_stats.transport_retry_calls).toBe(2);
    expect(result.task_stats.output_repair_calls).toBe(0);
    expect('pool_attempts' in result.task_stats.attempts[0]).toBe(false);
    expect(result.task_stats.attempts[2].pool_attempts).toBe(1);
    expect(result.task_stats.coverage).toEqual({ total: 1, success: 1, explicit_failed: 0, deferred: 0 });
  });

  it('recovers non-pool enrich gaps through instrumented per-item fallback', async () => {
    provider.isPool = false;
    for (const id of ['a', 'b']) addItem(id);
    provider.callWithMetadata
      .mockRejectedValueOnce(Object.assign(new Error('request timed out'), { code: 'TIMEOUT' }))
      .mockResolvedValueOnce(response([card('a')], 'a'))
      .mockResolvedValueOnce(response([card('b')], 'b'));

    const result = await llm.enrichItems(2, { batchItemSize: 2, batchConcurrency: 1 });

    expect(result).toMatchObject({ total: 2, enriched: 2, failed: 0, successful_item_ids: ['a', 'b'] });
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(3);
    expect(result.task_stats.attempts.map(row => [row.batch_size, row.kind])).toEqual([[2, 'initial'], [2, 'transport_retry'], [1, 'initial']]);
    expect(result.task_stats.transport_retry_calls).toBe(1);
    expect(result.task_stats.output_repair_calls).toBe(0);
    expect(result.task_stats.coverage).toEqual({ total: 2, success: 2, explicit_failed: 0, deferred: 0 });
  });
});
