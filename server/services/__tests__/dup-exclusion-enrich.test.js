// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */
/**
 * R3.0 评审 blocker B1 — enrich 积压选取谓词排除软标记重复行（实现工程师·迁移回填）
 *
 * 【背景】ask 方案：「drainer、enrich、kg 的积压选取谓词一律排除 duplicate_of IS NOT NULL」。
 * 本仓库的 enrich = ai_summaries LLM 摘要路径 server/services/llm.js enrichItems
 * （JOB_TYPES.ENRICH_ITEMS、FULL_PIPELINE 的 enrich 阶段、scheduler pipeline
 * ['collect','enrich','digest'] 均走它）。评审以 mode=ro 查证生产：32,446 dup 行中
 * 32,440 行各自带一条 ai_summaries —— 10-19 单日 3,880 dup 行中 3,878 行被 LLM 重新
 * 摘要，正是 CTO 指出的配额浪费主体。回填后若选取谓词不排除 dup，resetAttempts /
 * 无效摘要重算 / 毒化重试路径仍会对 dup 行花 LLM；且读模型 system-stats 的
 * enrichment_backlog 已按非 dup 口径报告，worker 不切换则面板说收敛、worker 仍选 dup。
 *
 * 【契约】
 *  1) enrichItems 选行谓词（llm.js:557 WHERE）排除 duplicate_of IS NOT NULL：dup 行即使
 *     无有效摘要、attempts=0、score 最高，也绝不被选中——不被 markAttempted、不产生
 *     ai_summaries、不进入任何 LLM prompt；
 *  2) resetAttempts 清零（llm.js:539）同口径：dup 行的 enrichment_attempts 不被清零，
 *     因而也不会被拉回重试。
 *
 * 【fixture】与 llm-output-contracts.test.js 同款隔离 SQLite + loadService：真实迁移
 * 001/002/032 + 043（duplicate_of 列），provider stub 解析 batch prompt 的 items JSON
 * 回卡片。RED 口径：llm.js 无 duplicate_of 排除 → dup 行被选中/被清零 → 断言 FAIL。
 */

const Database = require('better-sqlite3');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const shared = require('../llm-shared');

const MIGRATIONS = [
  '001_initial_schema.sql', '002_i18n_translations.sql', '032_llm_output_metadata.sql',
  '044_information_items_duplicate_of.sql',
];

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

describe('R3.0 — enrichItems excludes soft-marked duplicate rows (duplicate_of IS NOT NULL)', () => {
  let db;
  let provider;
  let mocks;
  let llm;
  let prompts;
  const previousScoring = process.env.ENABLE_SIGNAL_SCORING;

  beforeEach(() => {
    db = new Database(':memory:');
    for (const migration of MIGRATIONS) {
      db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations', migration), 'utf8'));
    }
    db.exec('ALTER TABLE information_items ADD COLUMN enrichment_attempts INTEGER DEFAULT 0; ALTER TABLE information_items ADD COLUMN last_enrich_attempt TEXT;');
    expect(db.pragma('table_info(information_items)').some(c => c.name === 'duplicate_of'), '守卫：043 必须提供 duplicate_of 列').toBe(true);
    prompts = [];
    provider = {
      isPool: true, name: 'pool', model: 'pool-model',
      callWithMetadata: vi.fn(async prompt => {
        prompts.push(prompt);
        const entries = JSON.parse(prompt.match(/items: (\[[^\n]+\])/)[1]);
        return response(entries.map(entry => card(entry.id)));
      }),
    };
    mocks = {
      '../db/connection': { getDB: () => db },
      './llm-provider': { getProvider: () => provider, getEnrichProvider: () => provider,
        getProviderInfo: () => ({ provider: 'pool', model: 'pool-model' }) },
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

  function addItem(id, { score = 0, attempts = 0, duplicateOf = null } = {}) {
    db.prepare(`INSERT INTO information_items
      (id, source_id, canonical_url, title, digest_date, score, enrichment_attempts, duplicate_of, original_summary)
      VALUES (?, 's001', ?, ?, '2026-10-19', ?, ?, ?, ?)`)
      .run(id, `https://example.com/${id}`, `Article ${id}`, score, attempts, duplicateOf,
        `Source excerpt describes the release for ${id}; performance claims require evaluation.`);
  }
  function addValidSummary(rowId, itemId) {
    db.prepare(`INSERT INTO ai_summaries (id, item_id, model_provider, model_name, prompt_version, short_summary)
      VALUES (?, ?, 'old-provider', 'old-model', 'old-prompt', 'already valid')`).run(rowId, itemId);
  }
  const attemptsOf = id => db.prepare('SELECT enrichment_attempts FROM information_items WHERE id = ?').get(id).enrichment_attempts;
  const summariesOf = id => db.prepare('SELECT COUNT(*) c FROM ai_summaries WHERE item_id = ?').get(id).c;

  it('never selects a dup row: no attempt mark, no summary, no prompt — even with no summary, attempts=0 and the top score', async () => {
    addItem('first', { score: 30 }); addValidSummary('first-row', 'first'); // 组首行已有有效摘要（隔离 dup 效应）
    addItem('dup-later', { score: 90, duplicateOf: 'first' });              // 回填后的跨天重插行：无摘要、attempts=0、score 最高
    addItem('fresh', { score: 50 });                                         // 真实新增

    const result = await llm.enrichItems(3, { batchItemSize: 4, batchConcurrency: 1 });

    expect(result, 'dup 行不在选取域：只有 fresh 被 enrich').toMatchObject({ total: 1, enriched: 1, successful_item_ids: ['fresh'] });
    expect(attemptsOf('dup-later'), 'dup 行不得被 markAttempted').toBe(0);
    expect(summariesOf('dup-later'), 'dup 行不得产生 ai_summaries').toBe(0);
    expect(prompts.join('\n'), 'dup 行不得进入任何 LLM prompt').not.toContain('Article dup-later');
    expect(prompts.join('\n')).toContain('Article fresh');
    expect(summariesOf('fresh')).toBe(1);
    expect(attemptsOf('fresh')).toBe(1);
  });

  it('resetAttempts keeps dup rows poisoned: their enrichment_attempts are not reset and they are not retried', async () => {
    addItem('first', { score: 30 }); addValidSummary('first-row', 'first');
    addItem('dup-poisoned', { score: 90, attempts: 3, duplicateOf: 'first' }); // dup 且已毒化（= MAX_ENRICH_ATTEMPTS 3）
    addItem('real-poisoned', { score: 50, attempts: 3 });                       // 非 dup 毒化行：应被清零并重试

    const result = await llm.enrichItems(3, { resetAttempts: true, batchItemSize: 4, batchConcurrency: 1 });

    expect(result, '只有非 dup 毒化行被清零后重试').toMatchObject({ total: 1, enriched: 1, successful_item_ids: ['real-poisoned'] });
    expect(attemptsOf('real-poisoned'), '非 dup：清零 → 选中 → markAttempted = 1').toBe(1);
    expect(attemptsOf('dup-poisoned'), 'dup 行的 enrichment_attempts 不被 resetAttempts 清零').toBe(3);
    expect(summariesOf('dup-poisoned')).toBe(0);
    expect(prompts.join('\n')).not.toContain('Article dup-poisoned');
  });

  it('dup rows do not leak into the enrich pool via NULL attempts either', async () => {
    addItem('first', { score: 30 }); addValidSummary('first-row', 'first');
    addItem('dup-null-attempts', { score: 90, duplicateOf: 'first' });
    db.prepare('UPDATE information_items SET enrichment_attempts = NULL WHERE id = ?').run('dup-null-attempts');
    addItem('fresh', { score: 50 });

    const result = await llm.enrichItems(3, { batchItemSize: 4, batchConcurrency: 1 });

    expect(result).toMatchObject({ total: 1, enriched: 1, successful_item_ids: ['fresh'] });
    expect(db.prepare('SELECT enrichment_attempts FROM information_items WHERE id = ?').get('dup-null-attempts').enrichment_attempts).toBeNull();
    expect(summariesOf('dup-null-attempts')).toBe(0);
  });
});
