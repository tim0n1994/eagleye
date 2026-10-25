// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */
/**
 * R3.0 评审 blocker B2 — digest 生成路径默认排除软标记重复行（实现工程师·迁移回填）
 *
 * 【背景】ask 方案：「digest、搜索、计数默认排除」。读路由 server/routes/digest.js:31/:78
 * 与搜索/计数（discovery.js、system-stats.js）已按非 dup 口径（其他 lane）；而 digest 内容
 * 生成 server/services/llm-digest.js generateDailyDigest（jobs.js DAILY_DIGEST、FULL_PIPELINE
 * 的 digest 阶段、routes/jobs 均在用）按 digest_date 取 top-N by score，未排除 dup ——
 * 评审以 mode=ro 查证生产：10-19 当日 4,475 行中 3,880 行（87%）是跨天重插，生成的日报
 * 会被重贴旧闻主导，且与已排除 dup 的路由列表口径互相矛盾。
 *
 * 【契约】
 *  1) generateDailyDigest 候选集（llm-digest.js:58 WHERE i.digest_date = ?）排除
 *     duplicate_of IS NOT NULL 的行：dup 行即使 score 最高也不进 prompt / allowedIds，
 *     daily_digests.item_count 按非 dup 条数落库；
 *  2) 当日 items 全为 dup → 不调用 LLM、不写 daily_digests、返回 __skipped，且
 *     totalCount 提示同口径（reason = 'no items for this date'，而非误导性的
 *     'N items but none joined'）。
 *
 * 【fixture】与 llm-output-contracts.test.js 同款隔离 SQLite + loadService：真实迁移
 * 001/002/032 + 043（duplicate_of 列），provider stub 捕获 prompt 并返回合法 digest JSON。
 * RED 口径：llm-digest.js 无 duplicate_of 排除 → dup 行进入候选/全 dup 日照常调用 LLM。
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

const metadata = id => ({ provider: 'anthropic', protocol: 'anthropic', endpoint_id: `lane-${id}`,
  requested_model: `requested-${id}`, model: `actual-${id}`, trace_id: `trace-${id}`,
  latency_ms: 10, usage: { output_tokens: 20 }, attempts: 1 });
const response = (data, id = 'digest') => ({ text: JSON.stringify(data), metadata: metadata(id) });
const digestOf = ids => ({
  headline: '今日发布', executive_summary: '发布信息待复核。',
  top_signals: [{ title: '发布', reason: '有新信息', item_ids: ids }],
  emerging_topics: [], repo_watch: [], paper_watch: [], product_watch: [], risk_watch: [],
});

function loadService(name, mocks) {
  const filename = path.resolve(__dirname, `../${name}.js`);
  const subject = new Module(filename, module);
  subject.filename = filename;
  subject.require = id => {
    if (mocks[id]) return mocks[id];
    if (id === './llm-shared') return shared;
    if (id === './content-sufficiency') return require('../content-sufficiency');
    if (id === './date-contract') return require('../date-contract');
    throw new Error(`Unmocked service dependency: ${id}`);
  };
  subject._compile(fs.readFileSync(filename, 'utf8'), filename);
  return subject.exports;
}

describe('R3.0 — generateDailyDigest excludes soft-marked duplicate rows', () => {
  let db;
  let provider;
  let prompts;
  let digest;

  beforeEach(() => {
    db = new Database(':memory:');
    for (const migration of MIGRATIONS) {
      db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations', migration), 'utf8'));
    }
    expect(db.pragma('table_info(information_items)').some(c => c.name === 'duplicate_of'), '守卫：043 必须提供 duplicate_of 列').toBe(true);
    prompts = [];
    provider = { isPool: true, name: 'pool', model: 'pool-model', callWithMetadata: vi.fn(async prompt => {
      prompts.push(prompt);
      return response(digestOf(['fresh']));
    }) };
    digest = loadService('llm-digest', {
      '../db/connection': { getDB: () => db },
      './llm-provider': { getProvider: () => provider },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function addItem(id, { score = 0, duplicateOf = null, date = '2026-10-19' } = {}) {
    db.prepare(`INSERT INTO information_items
      (id, source_id, canonical_url, title, digest_date, score, duplicate_of, original_summary)
      VALUES (?, 's001', ?, ?, ?, ?, ?, ?)`)
      .run(id, `https://example.com/${id}`, `Article ${id}`, date, score, duplicateOf,
        `Source excerpt describes the release for ${id}; performance claims require evaluation.`);
  }

  it('excludes dup rows from digest candidates even when they out-score every real item', async () => {
    addItem('first', { score: 10 });                                  // 组首行（保留行）
    addItem('dup-hot', { score: 100, duplicateOf: 'first' });         // 重插行 score 最高
    addItem('dup-warm', { score: 90, duplicateOf: 'first' });
    addItem('fresh', { score: 50 });                                   // 真实新增

    const result = await digest.generateDailyDigest('2026-10-19');

    expect(result).toMatchObject({ headline: '今日发布' });
    const joined = prompts.join('\n');
    expect(joined, '真实条目进入 prompt').toContain('item_id=fresh');
    expect(joined, '组首行进入 prompt').toContain('item_id=first');
    expect(joined, 'dup 行即使 score 最高也不得进入 prompt').not.toContain('item_id=dup-hot');
    expect(joined).not.toContain('item_id=dup-warm');
    expect(joined, '候选数按非 dup 口径').toContain('今日重要新闻（2条）');
    expect(db.prepare('SELECT item_count FROM daily_digests').get().item_count, 'item_count 按非 dup 条数落库').toBe(2);
  });

  it('keeps routed digest prompts within the verified 25-item budget', async () => {
    const previousLimit = process.env.DIGEST_ITEM_LIMIT;
    try {
      process.env.DIGEST_ITEM_LIMIT = '200';
      addItem('first', { score: 100 });
      for (let index = 0; index < 30; index++) addItem(`item-${index}`, { score: 30 - index });
      provider.callWithMetadata.mockImplementationOnce(async prompt => {
        prompts.push(prompt);
        return response(digestOf(['first']));
      });

      await digest.generateDailyDigest('2026-10-19');

      expect(prompts[0]).toContain('今日重要新闻（25条）');
      expect(prompts[0]).toContain('item_id=item-23');
      expect(prompts[0]).not.toContain('item_id=item-24');
      expect(db.prepare('SELECT item_count FROM daily_digests').get().item_count).toBe(25);
    } finally {
      if (previousLimit === undefined) delete process.env.DIGEST_ITEM_LIMIT;
      else process.env.DIGEST_ITEM_LIMIT = previousLimit;
    }
  });

  it('a date whose rows are all dups is skipped: no LLM call, no daily_digests row, non-dup caliber reason', async () => {
    addItem('first', { score: 10, date: '2026-10-18' });          // 组首行落在前一天
    addItem('dup-a', { score: 100, duplicateOf: 'first' });        // 10-19 全是重插行
    addItem('dup-b', { score: 90, duplicateOf: 'first' });

    const result = await digest.generateDailyDigest('2026-10-19');

    expect(result).toMatchObject({ __skipped: true, reason: 'no items for this date' });
    expect(provider.callWithMetadata, '全 dup 日不得调用 LLM').not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) c FROM daily_digests').get().c).toBe(0);
  });
});
