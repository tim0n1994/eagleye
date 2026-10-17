// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */
const Database = require('better-sqlite3');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const shared = require('../llm-shared');

const card = (id, extra = {}) => ({
  ...(id ? { id } : {}), title_zh: '开源模型公布评测与运行方法',
  one_liner_zh: '发布了模型与评测。', short_summary_zh: '模型发布了运行方法，效果仍需复核。',
  suggested_tags: [], entities: [], topic_slugs: [], key_points_zh: [], confidence: 0.6, ...extra,
});
const metadata = id => ({ provider: 'anthropic', protocol: 'anthropic', endpoint_id: `lane-${id}`,
  requested_model: `requested-${id}`, model: `actual-${id}`, trace_id: `trace-${id}`,
  latency_ms: 10, usage: { output_tokens: 20 }, attempts: 1 });
const response = (data, id = 'a') => ({ text: JSON.stringify(data), metadata: metadata(id) });

function loadService(name, mocks) {
  const filename = path.resolve(__dirname, `../${name}.js`);
  const subject = new Module(filename, module);
  subject.filename = filename;
  subject.require = id => {
    if (mocks[id]) return mocks[id];
    if (id === './llm-shared') return shared;
    if (id === './llm-error-class') return require('../llm-error-class');
    if (id === './content-sufficiency') return require('../content-sufficiency');
    if (id === './date-contract') return require('../date-contract');
    if (id === 'crypto') return require('node:crypto');
    throw new Error(`Unmocked service dependency: ${id}`);
  };
  subject._compile(fs.readFileSync(filename, 'utf8'), filename);
  return subject.exports;
}

describe('LLM business output contracts with isolated SQLite', () => {
  let db;
  let provider;
  let mocks;
  let llm;
  const previousScoring = process.env.ENABLE_SIGNAL_SCORING;

  beforeEach(() => {
    db = new Database(':memory:');
    for (const migration of ['001_initial_schema.sql', '002_i18n_translations.sql', '032_llm_output_metadata.sql']) {
      db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations', migration), 'utf8'));
    }
    db.exec('ALTER TABLE information_items ADD COLUMN enrichment_attempts INTEGER DEFAULT 0; ALTER TABLE information_items ADD COLUMN last_enrich_attempt TEXT;');
    provider = { isPool: true, name: 'pool', model: 'wrong-global-model', callWithMetadata: vi.fn() };
    mocks = {
      '../db/connection': { getDB: () => db },
      './llm-provider': { getProvider: () => provider, getEnrichProvider: () => provider,
        getProviderInfo: () => ({ provider: 'wrong-global', model: 'wrong-global-model' }) },
      './llm-digest': { generateDailyDigest: vi.fn() },
      './jobs': { isJobCancelled: () => false, updateJobProgress: vi.fn() },
      './signals': { scoreSignals: vi.fn(async items => ({ scored: items.length })) },
    };
    llm = loadService('llm', mocks);
    process.env.ENABLE_SIGNAL_SCORING = 'true';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    if (previousScoring === undefined) delete process.env.ENABLE_SIGNAL_SCORING;
    else process.env.ENABLE_SIGNAL_SCORING = previousScoring;
  });

  function addItem(id, score = 0, attempts = 0) {
    db.prepare(`INSERT INTO information_items (id, source_id, canonical_url, title, digest_date, score, enrichment_attempts)
      VALUES (?, 's001', ?, ?, '2026-09-09', ?, ?)`).run(id, `https://example.com/${id}`, `Article ${id}`, score, attempts);
    db.prepare('UPDATE information_items SET original_summary = ? WHERE id = ?').run(`Source excerpt describes the release for ${id}; performance claims require evaluation.`, id);
    return db.prepare(`SELECT i.*, s.label source_label, s.slug source_slug FROM information_items i
      JOIN sources s ON s.id = i.source_id WHERE i.id = ?`).get(id);
  }

  function addSummary(id, itemId, text) {
    db.prepare(`INSERT INTO ai_summaries (id, item_id, model_provider, model_name, prompt_version, short_summary)
      VALUES (?, ?, 'old-provider', 'old-model', 'old-prompt', ?)`).run(id, itemId, text);
  }

  it('keeps per-call actual model and trace isolated across concurrent enrichment callbacks', async () => {
    const a = addItem('a'); const b = addItem('b');
    let releaseA;
    provider.callWithMetadata.mockImplementation((prompt, options) => {
      expect(options.task).toBe('enrich');
      if (prompt.includes('title: Article a')) return new Promise(resolve => { releaseA = () => resolve(response(card(), 'a')); });
      return Promise.resolve(response(card(), 'b'));
    });
    const first = llm.generateItemSummary(a);
    const second = await llm.generateItemSummary(b);
    releaseA();
    const result = await first;
    expect(result.summary.model_name).toBe('actual-a');
    expect(second.summary.model_name).toBe('actual-b');
    expect(JSON.parse(result.summary.llm_metadata).trace_id).toBe('trace-a');
    expect(JSON.parse(second.summary.llm_metadata).trace_id).toBe('trace-b');
  });

  it('supports legacy call-only providers without reading a global model', async () => {
    provider = { name: 'legacy', model: 'actual-legacy', call: vi.fn(async () => JSON.stringify(card())) };
    const result = await llm.generateItemSummary(addItem('legacy'));
    expect(result.summary.model_provider).toBe('legacy');
    expect(result.summary.model_name).toBe('actual-legacy');
    expect(JSON.parse(result.summary.llm_metadata).trace_id).toBe(null);
    expect(provider.call.mock.calls[0][1].task).toBe('enrich');
  });

  it.each(['', '{}', '[]', '{"title_zh":"truncated"', JSON.stringify(card(undefined, { short_summary_zh: '  ' })), JSON.stringify(card(undefined, { suggested_tags: 'bad shape' }))])(
    'rejects empty, malformed or invalid required summary fields without multiplying pool retries: %s', async text => {
      provider.callWithMetadata.mockResolvedValue({ text, metadata: metadata('a') });
      expect(await llm.generateItemSummary(addItem('a'))).toBe(null);
      expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
      expect(db.prepare('SELECT COUNT(*) c FROM ai_summaries').get().c).toBe(0);
    });

  it.each([{ rows: [card('foreign')] }, { rows: [card('a'), card('a')] }])('rejects foreign or duplicate IDs instead of attributing a batch output to the wrong item', async ({ rows }) => {
    provider.callWithMetadata.mockResolvedValue(response(rows));
    expect(await llm.generateItemSummariesBatch([addItem('a')])).toEqual([]);
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
  });

  it('persists valid partial batches, retries only missing items, and scores the actual successful ID', async () => {
    addItem('a', 20); addItem('b', 10); addItem('valid-old', 100);
    addSummary('old-row', 'valid-old', 'Preserved valid summary');
    provider.callWithMetadata.mockResolvedValueOnce(response([card('b')], 'b')).mockRejectedValueOnce(new Error('all endpoints failed'));
    const result = await llm.enrichItems(2, { batchItemSize: 2, batchConcurrency: 1 });
    expect(result).toMatchObject({ enriched: 1, failed: 1, total: 2, successful_item_ids: ['b'] });
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(2);
    expect(provider.callWithMetadata.mock.calls[1][0]).toContain('title: Article a');
    expect(provider.callWithMetadata.mock.calls[1][0]).not.toContain('Article b');
    expect(mocks['./signals'].scoreSignals.mock.calls[0][0].map(item => item.id)).toEqual(['b']);
    const saved = db.prepare('SELECT * FROM ai_summaries WHERE item_id = ?').get('b');
    expect(saved.model_name).toBe('actual-b');
    expect(JSON.parse(saved.llm_metadata).trace_id).toBe('trace-b');
    expect(db.prepare('SELECT short_summary FROM ai_summaries WHERE id = ?').get('old-row').short_summary).toBe('Preserved valid summary');
  });

  it('retries NULL attempts and invalid summaries, ignores NULL item_id, and preserves valid summaries', async () => {
    addItem('empty', 50, null); addItem('good', 100, 0); addItem('poisoned', 10, 3);
    addSummary('empty-row', 'empty', '\t\n '); addSummary('good-row', 'good', 'already valid');
    addSummary('orphan-null', null, 'orphan');
    provider.callWithMetadata.mockResolvedValue(response([card('empty')]));
    const result = await llm.enrichItems(10, { batchConcurrency: 1 });
    expect(result).toMatchObject({ total: 1, enriched: 1, successful_item_ids: ['empty'] });
    expect(db.prepare('SELECT enrichment_attempts FROM information_items WHERE id = ?').get('empty').enrichment_attempts).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM ai_summaries WHERE item_id = ?').get('empty').c).toBe(1);
    expect(db.prepare('SELECT model_name FROM ai_summaries WHERE id = ?').get('good-row').model_name).toBe('old-model');
  });

  it('does not fan out single-item retries after a pool batch exhausts its own budget', async () => {
    addItem('a'); addItem('b');
    provider.callWithMetadata.mockRejectedValue(new Error('pool exhausted'));
    expect(await llm.enrichItems(2, { batchItemSize: 2 })).toMatchObject({ enriched: 0, failed: 2 });
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
    expect(mocks['./signals'].scoreSignals).not.toHaveBeenCalled();
  });

  it('rejects invalid limits and zero worker/chunk steps before selecting or calling a model', async () => {
    for (const limit of [0, -1, 1601, NaN]) await expect(llm.enrichItems(limit)).rejects.toThrow('batchSize');
    await expect(llm.enrichItems(1, { batchItemSize: 0 })).rejects.toThrow('batchItemSize');
    await expect(llm.enrichItems(1, { batchConcurrency: 0 })).rejects.toThrow('batchConcurrency');
    const translate = loadService('translate', mocks);
    await expect(translate.translateItems({ batchItemSize: 0 })).rejects.toThrow('batchItemSize');
    expect(provider.callWithMetadata).not.toHaveBeenCalled();
  });

  it('bounds pool enrichment to four items per batch and honors the requested item count', async () => {
    for (let i = 0; i < 7; i++) addItem(`i${i}`, 10 - i);
    provider.callWithMetadata.mockImplementation(async (prompt, options) => {
      const entries = JSON.parse(prompt.match(/items: (\[[^\n]+\])/)[1]);
      expect(entries.length).toBeLessThanOrEqual(4);
      expect(options.maxTokens).toBe(8192);
      return response(entries.map(entry => card(entry.id)));
    });
    expect(await llm.enrichItems(5, { batchConcurrency: 1 })).toMatchObject({ total: 5, enriched: 5, batch_items: 4 });
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT COUNT(*) c FROM information_items WHERE enrichment_attempts = 0').get().c).toBe(2);
  });

  it('supplies real item IDs to digest generation and persists its actual endpoint metadata', async () => {
    addItem('source-item');
    const digest = loadService('llm-digest', mocks);
    provider.callWithMetadata.mockImplementation(async (prompt, options) => {
      expect(prompt).toContain('item_id=source-item'); expect(options.task).toBe('digest');
      return response({ headline: '今日发布', executive_summary: '发布信息待复核。',
        top_signals: [{ title: '发布', reason: '有新信息', item_ids: ['source-item'] }],
        emerging_topics: [], repo_watch: [], paper_watch: [], product_watch: [], risk_watch: [] }, 'digest');
    });
    expect(await digest.generateDailyDigest('20260909')).toMatchObject({ headline: '今日发布' });
    const saved = db.prepare('SELECT * FROM daily_digests').get();
    expect(saved.model_name).toBe('actual-digest');
    expect(JSON.parse(saved.llm_metadata).endpoint_id).toBe('lane-digest');
  });

  it('does not overwrite an existing digest when output references an unrequested item', async () => {
    addItem('source-item');
    db.prepare('INSERT INTO daily_digests (id, digest_date, headline) VALUES (?, ?, ?)').run('old', '2026-09-09', 'preserve');
    provider.callWithMetadata.mockResolvedValue(response({ headline: 'bad', executive_summary: 'bad',
      top_signals: [{ title: 'bad', reason: 'bad', item_ids: ['foreign'] }],
      emerging_topics: [], repo_watch: [], paper_watch: [], product_watch: [], risk_watch: [] }));
    expect(await loadService('llm-digest', mocks).generateDailyDigest('20260909')).toBe(null);
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT headline FROM daily_digests').get().headline).toBe('preserve');
  });

  it('preserves an existing digest after a bounded pool rejection without an outer retry', async () => {
    addItem('source-item');
    db.prepare('INSERT INTO daily_digests (id, digest_date, headline) VALUES (?, ?, ?)').run('old', '2026-09-09', 'preserve');
    provider.callWithMetadata.mockRejectedValue(Object.assign(new Error('LLM request failed (TIMEOUT)'), { code: 'TIMEOUT', isPoolError: true }));
    expect(await loadService('llm-digest', mocks).generateDailyDigest('20260909')).toBe(null);
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT headline FROM daily_digests').get().headline).toBe('preserve');
  });

  it('saves the translation call actual model and rejects empty generations despite existing text', async () => {
    addItem('a'); addSummary('old-a', 'a', 'Existing English summary');
    const translate = loadService('translate', mocks);
    provider.callWithMetadata.mockResolvedValueOnce(response(card(), 'translation'));
    expect(await translate.translateItem('a')).toMatchObject({ itemId: 'a' });
    let saved = db.prepare('SELECT * FROM ai_summaries WHERE item_id = ?').get('a');
    expect(saved.model_name).toBe('actual-translation');
    expect(JSON.parse(saved.llm_metadata).trace_id).toBe('trace-translation');
    expect(provider.callWithMetadata.mock.calls[0][1].task).toBe('translate');
    provider.callWithMetadata.mockResolvedValue(response({}));
    await expect(translate.translateItem('a')).rejects.toThrow('LLM_INVALID_OUTPUT');
    saved = db.prepare('SELECT * FROM ai_summaries WHERE item_id = ?').get('a');
    expect(saved.model_name).toBe('actual-translation');
    expect(saved.one_liner_zh).toBe(card().one_liner_zh);
  });

  it('retries an explicitly requested blocked card while preserving completed Chinese cards', async () => {
    addItem('blocked'); addSummary('old-blocked', 'blocked', 'Existing English summary');
    db.prepare("UPDATE ai_summaries SET translation_status='blocked' WHERE item_id='blocked'").run();
    addItem('complete'); addSummary('old-complete', 'complete', 'Keep English summary');
    db.prepare(`UPDATE ai_summaries SET ai_title_zh='已有中文标题',one_liner_zh='已有中文判断',
      short_summary_zh='已有中文摘要',translation_status='translated' WHERE item_id='complete'`).run();
    db.prepare("UPDATE information_items SET title_zh='已有中文标题',title_zh_status='translated' WHERE id='complete'").run();
    const before = db.prepare("SELECT * FROM ai_summaries WHERE item_id='complete'").get();
    const translate = loadService('translate', mocks);
    expect(await translate.translateItems({ batchSize: 10 })).toMatchObject({ total: 0, translated: 0 });
    expect(provider.callWithMetadata).not.toHaveBeenCalled();
    provider.callWithMetadata.mockResolvedValue(response([card('blocked')], 'translation'));
    expect(await translate.translateItems({ batchSize: 10, retryBlocked: true, batchWorkers: 1 }))
      .toMatchObject({ total: 1, translated: 1, failed: 0 });
    expect(db.prepare("SELECT translation_status FROM ai_summaries WHERE item_id='blocked'").get().translation_status).toBe('translated');
    expect(db.prepare("SELECT * FROM ai_summaries WHERE item_id='complete'").get()).toEqual(before);
  });

  it('rejects foreign translation IDs and does not return cards by falling back to old text', async () => {
    const translate = loadService('translate', mocks);
    provider.callWithMetadata.mockResolvedValue(response([card('foreign')]));
    expect(await translate.generateChineseFeedCardsBatch([addItem('a')])).toEqual([]);
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
  });

  it('preserves valid translation batch rows and recovers only invalid or missing rows with their own metadata', async () => {
    addItem('a'); addItem('b');
    provider.callWithMetadata.mockResolvedValueOnce(response([card('b'), card('a', { short_summary_zh: '' })], 'b'))
      .mockResolvedValueOnce(response(card(), 'a'));
    const translate = loadService('translate', mocks);
    expect(await translate.translateItems({ batchSize: 2, batchItemSize: 2, batchWorkers: 1 }))
      .toMatchObject({ translated: 2, failed: 0 });
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(2);
    expect(provider.callWithMetadata.mock.calls[1][0]).toContain('title: Article a');
    expect(db.prepare('SELECT model_name FROM ai_summaries WHERE item_id = ?').get('a').model_name).toBe('actual-a');
    expect(db.prepare('SELECT model_name FROM ai_summaries WHERE item_id = ?').get('b').model_name).toBe('actual-b');
  });

  it('does not multiply exhausted pool translation batches into single-row calls', async () => {
    addItem('a'); addItem('b');
    provider.callWithMetadata.mockRejectedValue(new Error('pool exhausted'));
    expect(await loadService('translate', mocks).translateItems({ batchSize: 2, batchItemSize: 2 }))
      .toMatchObject({ translated: 0, failed: 2 });
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
  });

  it('classifies only whitelist IDs, recovers only missing rows, and avoids the old pool second pass', async () => {
    const classifier = loadService('signals-classify', mocks);
    provider.callWithMetadata.mockResolvedValueOnce(response([{ id: 'b', signal_type: 'new_repo', thesis_match: 0.7 }]))
      .mockResolvedValueOnce(response([{ id: 'a', signal_type: 'new_paper', thesis_match: 0.6 }]));
    const items = [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }];
    expect((await classifier.classifySignals(items)).map(row => row.id)).toEqual(['b', 'a']);
    expect(provider.callWithMetadata.mock.calls[1][0]).not.toContain('"id":"b"');
    expect(provider.callWithMetadata.mock.calls[0][1]).toMatchObject({ task: 'classify', maxTokens: 2048 });
    expect(await classifier.classifyUncategorizedRetry(items)).toEqual([]);
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(2);
  });

  it('does not accept invalid classifier schemas or foreign IDs as success', async () => {
    const classifier = loadService('signals-classify', mocks);
    for (const data of [[{ id: 'a' }], [{ id: 'a', signal_type: 'new_repo', thesis_match: null }],
      [{ id: 'foreign', signal_type: 'new_repo', thesis_match: 0.5 }]]) {
      provider.callWithMetadata.mockResolvedValue(response(data));
      expect(await classifier.classifySignals([{ id: 'a', title: 'a' }])).toEqual([]);
    }
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(3);
  });

  function cancellableJob() {
    const controller = new AbortController();
    let cancelled = false;
    mocks['./jobs'].getJobSignal = () => controller.signal;
    mocks['./jobs'].isJobCancelled = () => cancelled;
    return { signal: controller.signal, cancel: () => { cancelled = true; controller.abort(); } };
  }

  function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  }

  it('passes the job signal to in-flight enrichment, preserves completed rows, and discards late output without fallback or scoring', async () => {
    addItem('a', 30); addItem('b', 20); addItem('c', 10);
    const job = cancellableJob();
    const started = deferred(); const late = deferred();
    provider.callWithMetadata.mockResolvedValueOnce(response([card('a')], 'a'))
      .mockImplementationOnce((_prompt, options) => { started.resolve(options.signal); return late.promise; });
    const running = llm.enrichItems(3, { jobId: 'cancel-enrich', batchItemSize: 1, batchConcurrency: 1 });
    expect(await started.promise).toBe(job.signal);
    expect(db.prepare('SELECT model_name FROM ai_summaries WHERE item_id = ?').get('a').model_name).toBe('actual-a');
    job.cancel(); late.resolve(response([card('b')], 'b'));
    expect(await running).toMatchObject({ cancelled: true, enriched: 1, successful_item_ids: ['a'] });
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT item_id FROM ai_summaries ORDER BY item_id').all()).toEqual([{ item_id: 'a' }]);
    expect(db.prepare('SELECT title_zh FROM information_items WHERE id = ?').get('b').title_zh).toBe(null);
    expect(mocks['./signals'].scoreSignals).not.toHaveBeenCalled();
  });

  it('does not dispatch or reset attempts for an already-cancelled job even without a signal bridge', async () => {
    addItem('a', 0, 3);
    mocks['./jobs'].isJobCancelled = () => true;
    expect(await llm.enrichItems(1, { jobId: 'already-cancelled', resetAttempts: true })).toMatchObject({ cancelled: true });
    expect(provider.callWithMetadata).not.toHaveBeenCalled();
    expect(db.prepare('SELECT enrichment_attempts FROM information_items').get().enrichment_attempts).toBe(3);
  });

  it.each(['enrich', 'translate'])('commits valid %s batch rows before missing-item compensation and stops the remainder on cancellation', async service => {
    addItem('a', 30); addItem('b', 20); addItem('c', 10);
    const job = cancellableJob(); const started = deferred(); const late = deferred();
    provider.callWithMetadata.mockResolvedValueOnce(response([card('b')], 'b'))
      .mockImplementationOnce((_prompt, options) => { started.resolve(options.signal); return late.promise; });
    const running = service === 'enrich'
      ? llm.enrichItems(3, { jobId: 'partial-cancel', batchItemSize: 3, batchConcurrency: 1 })
      : loadService('translate', mocks).translateItems({ jobId: 'partial-cancel', batchSize: 3, batchItemSize: 3, batchWorkers: 1 });
    expect(await started.promise).toBe(job.signal);
    expect(db.prepare('SELECT item_id FROM ai_summaries').all()).toEqual([{ item_id: 'b' }]);
    job.cancel(); late.resolve(response(card(), 'a'));
    expect(await running).toMatchObject({ cancelled: true, [service === 'enrich' ? 'enriched' : 'translated']: 1, failed: 0 });
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT item_id FROM ai_summaries').all()).toEqual([{ item_id: 'b' }]);
  });

  it('cancels translation through the job signal and preserves previously committed Chinese cards', async () => {
    addItem('a', 30); addItem('b', 20); addItem('c', 10);
    const job = cancellableJob(); const started = deferred(); const late = deferred();
    const translate = loadService('translate', mocks);
    provider.callWithMetadata.mockResolvedValueOnce(response([card('a')], 'a'))
      .mockImplementationOnce((_prompt, options) => { started.resolve(options.signal); return late.promise; });
    const running = translate.translateItems({ jobId: 'cancel-translate', batchSize: 3, batchItemSize: 1, batchWorkers: 1 });
    expect(await started.promise).toBe(job.signal);
    job.cancel(); late.resolve(response([card('b')], 'b'));
    expect(await running).toMatchObject({ cancelled: true, translated: 1 });
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT item_id FROM ai_summaries ORDER BY item_id').all()).toEqual([{ item_id: 'a' }]);
    expect(db.prepare('SELECT title_zh FROM information_items WHERE id = ?').get('b').title_zh).toBe(null);
  });

  it('never replaces a digest after job cancellation, including a legacy provider that returns late', async () => {
    addItem('a');
    db.prepare('INSERT INTO daily_digests (id, digest_date, headline) VALUES (?, ?, ?)').run('old-digest', '2026-09-09', 'keep');
    const job = cancellableJob(); const started = deferred(); const late = deferred();
    provider.isPool = false;
    provider.callWithMetadata.mockImplementation((_prompt, options) => { started.resolve(options.signal); return late.promise; });
    const running = loadService('llm-digest', mocks).generateDailyDigest('20260909', { jobId: 'cancel-digest' });
    expect(await started.promise).toBe(job.signal);
    job.cancel();
    late.resolve(response({ headline: 'late', executive_summary: 'late valid output',
      top_signals: [{ title: 'signal', reason: 'reason', item_ids: ['a'] }], emerging_topics: [],
      repo_watch: [], paper_watch: [], product_watch: [], risk_watch: [] }));
    expect(await running).toEqual({ cancelled: true });
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT headline FROM daily_digests').get().headline).toBe('keep');
  });

  it('stops missing-item classification compensation after the task is cancelled', async () => {
    const job = cancellableJob(); const started = deferred(); const late = deferred();
    provider.callWithMetadata.mockImplementation((_prompt, options) => { started.resolve(options.signal); return late.promise; });
    const running = loadService('signals-classify', mocks).classifySignals([{ id: 'a' }, { id: 'b' }], { jobId: 'cancel-classify' });
    expect(await started.promise).toBe(job.signal);
    job.cancel(); late.resolve(response([{ id: 'b', signal_type: 'new_repo', thesis_match: 0.5 }]));
    expect(await running).toEqual([]);
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to rule-score writes after in-flight classification is cancelled', async () => {
    const item = addItem('a');
    db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/009_alpha_radar.sql'), 'utf8'));
    db.prepare('INSERT INTO signal_scores (item_id, signal_type, alpha_score) VALUES (?, ?, ?)').run('a', 'new_repo', 0.42);
    const job = cancellableJob(); const started = deferred(); const late = deferred();
    mocks['./signals-classify'] = loadService('signals-classify', mocks);
    mocks['./cross-source-evidence'] = require('../cross-source-evidence');
    const score = loadService('signals-score', mocks);
    provider.callWithMetadata.mockImplementation((_prompt, options) => { started.resolve(options.signal); return late.promise; });
    const running = score.scoreSignals([item], { jobId: 'cancel-score' });
    expect(await started.promise).toBe(job.signal);
    job.cancel(); late.resolve(response([{ id: 'a', signal_type: 'new_paper', thesis_match: 0.9 }]));
    expect(await running).toEqual({ scored: 0, cancelled: true });
    expect(db.prepare('SELECT alpha_score, signal_type FROM signal_scores').get()).toEqual({ alpha_score: 0.42, signal_type: 'new_repo' });
  });

  it('aborts a legacy retry delay instead of scheduling another paid call', async () => {
    const job = cancellableJob(); const called = deferred();
    provider.isPool = false;
    provider.callWithMetadata.mockImplementation(async () => { called.resolve(); throw new Error('retryable'); });
    const running = llm.generateItemSummary(addItem('a'), { jobId: 'cancel-backoff' });
    await called.promise;
    await new Promise(resolve => setImmediate(resolve));
    job.cancel();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
  });

  it('uses deterministic title-only cards for the three real HN samples without calling a model or inventing details', async () => {
    const evidence = [
      ['63b5b8eb-19e1-40c6-aeee-187912db160f', '27.5KB language-agnostic WebGPU syntax highlighter'],
      ['7f7a5e29-5310-4f7d-a523-6b934b1e349f', 'AI Responsibility – OpenAI and Anthropic'],
      ['98677b4a-b353-4bed-a8e1-d43c16f45e9b', 'Harvard study predicts most suicide attempts a week in advance'],
    ].map(([id, title]) => ({ id, title, original_summary: '', content_text: '' }));
    for (const item of evidence) {
      const result = await llm.generateItemSummary(item);
      expect(result.summary.ai_title).toBe(item.title);
      expect(result.summary.ai_title_zh).toBe(item.title);
      for (const field of ['one_liner', 'one_liner_zh', 'short_summary', 'short_summary_zh']) {
        expect(result.summary[field]).toContain(`仅据来源标题：“${item.title}”`);
        expect(result.summary[field]).toContain('未获取正文，细节及结论未核验');
        expect(result.summary[field]).not.toMatch(/高精度|对齐规范实践/);
      }
      expect(result.summary.model_name).toBe('');
      expect(result.summary.confidence).toBe(0);
      expect(JSON.parse(result.summary.llm_metadata)).toMatchObject({ model: null, provider: 'deterministic', attempts: 0 });
      expect(JSON.parse(result.summary.source_grounding)).toMatchObject({ evidence_level: 'title_only', body_available: false, verified: false });
      expect(result).toMatchObject({ tags: [], entities: [], topicSlugs: [] });
      expect(result.summary.key_points).toBe('[]');
      expect(result.summary.key_points_zh).toBe('[]');
      expect(result.summary.risks).toBe('[]');
      expect(result.summary.why_it_matters).toBe('');
    }
    expect(provider.callWithMetadata).not.toHaveBeenCalled();
  });

  it('persists title-only provenance, preserves valid historical summaries, and avoids automatic translation of copied source titles', async () => {
    addItem('empty'); addItem('history');
    db.exec("UPDATE information_items SET original_summary = '\t ', content_text = ''");
    addSummary('historical-summary', 'history', 'Valid historical summary is preserved');
    expect(await llm.enrichItems(2, { batchConcurrency: 1 })).toMatchObject({ enriched: 1, successful_item_ids: ['empty'] });
    const saved = db.prepare('SELECT * FROM ai_summaries WHERE item_id = ?').get('empty');
    expect(saved.model_name).toBe(''); expect(saved.translation_status).toBe('n/a');
    expect(db.prepare('SELECT title_zh, title_zh_status FROM information_items WHERE id = ?').get('empty'))
      .toEqual({ title_zh: 'Article empty', title_zh_status: 'n/a' });
    expect(db.prepare('SELECT model_name FROM ai_summaries WHERE id = ?').get('historical-summary').model_name).toBe('old-model');
    expect(provider.callWithMetadata).not.toHaveBeenCalled();
    db.prepare("UPDATE information_items SET title_zh = title, title_zh_status = 'n/a' WHERE id = 'history'").run();
    db.prepare("UPDATE ai_summaries SET ai_title_zh = 'history', one_liner_zh = 'history', short_summary_zh = 'history', translation_status = 'n/a' WHERE item_id = 'history'").run();
    expect(await loadService('translate', mocks).translateItems({ batchSize: 2 })).toMatchObject({ translated: 0, total: 0 });
  });

  it('only sends items with substantive excerpts to the model in a mixed batch', async () => {
    const titleOnly = addItem('title-only'); titleOnly.original_summary = ''; titleOnly.content_text = '';
    const withContent = addItem('body');
    provider.callWithMetadata.mockImplementation(async prompt => {
      expect(prompt).toContain('"id":"body"'); expect(prompt).not.toContain('"id":"title-only"');
      return response([card('body')]);
    });
    const results = await llm.generateItemSummariesBatch([titleOnly, withContent]);
    expect(results.map(result => result.summary.item_id)).toEqual(['title-only', 'body']);
    expect(results[0].summary.model_name).toBe(''); expect(results[1].summary.model_name).toBe('actual-a');
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
  });

  it('does not restart pool retries for failed content items just because deterministic title cards succeeded', async () => {
    addItem('title-only'); addItem('body');
    db.prepare("UPDATE information_items SET original_summary = '' WHERE id = 'title-only'").run();
    provider.callWithMetadata.mockRejectedValue(new Error('pool exhausted'));
    expect(await llm.enrichItems(2, { batchItemSize: 2 })).toMatchObject({ enriched: 1, failed: 1, successful_item_ids: ['title-only'] });
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
  });

  it('treats a repeated title or empty HTML as no excerpt but uses available body text after whitespace summary', async () => {
    const item = addItem('a');
    for (const original_summary of [item.title, '<p>  </p>', '\n\t ']) {
      expect((await llm.generateItemSummary({ ...item, original_summary, content_text: '' })).summary.confidence).toBe(0);
    }
    provider.callWithMetadata.mockResolvedValue(response(card()));
    expect((await llm.generateItemSummary({ ...item, original_summary: ' ', content_text: 'A substantive source body excerpt.' })).summary.model_name).toBe('actual-a');
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
  });
});
