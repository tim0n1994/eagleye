/**
 * Eagleye — Chinese Feed Card Backfill
 *
 * Backfills Chinese titles and card summaries through the locally configured
 * LLM provider. This deliberately avoids per-field machine translation: each
 * information item gets one compact model call that produces the Chinese card
 * title, one-line verdict, 1-2 sentence summary, key points, and why-it-matters.
 */

const crypto = require('crypto');
const { getDB } = require('../db/connection');
const { getEnrichProvider, getProviderInfo } = require('./llm-provider');

// Match the enrichment prompt version so rows aren't stamped with a different
// version by the translate backfill (which used to overwrite prompt_version,
// breaking cache invalidation). Translation only fills in *_zh fields; the
// prompt_version should reflect which enrichment prompt generated the row.
const { taskContext, callWithMetadata, validCard, validateBatch, nonEmpty, _llmBackoff } = require('./llm-shared');
const { isTerminalLLMError } = require('./llm-error-class');

const PROMPT_VERSION = 'v3.1-knowledge-card-graph-zh';
const DEFAULT_BATCH_ITEMS = Math.max(1, Math.min(parseInt(process.env.TRANSLATE_LLM_BATCH_ITEMS || '16', 10), 32));
const DEFAULT_BATCH_WORKERS = Math.max(1, Math.min(parseInt(process.env.TRANSLATE_LLM_BATCH_WORKERS || '8', 10), 16));

const FEED_CARD_ZH_PROMPT = `/no_think
你是 Eagleye 的中文技术情报编辑。你的任务不是逐字翻译，而是基于原始信息生成适合信息流卡片展示的中文知识卡片。

硬性规则：
1. 只依据输入内容，不要编造原文没有的信息。
2. 保留项目名、公司名、模型名、论文名、仓库名、产品名等专有名词，不要强行翻译。
3. 中文标题要短、自然、明确；避免机翻腔、营销腔、夸张语气。
4. 标题必须写“这条信息真正讲了什么”，不要写成“@xxx posted”“某人发帖”“某人说”“分享了一条链接”。
5. title_zh 尽量控制在 22 到 36 个中文字符，让它通常能在卡片里 2 到 3 行读完。
6. 如果来源是 X、论坛、社区或 RSS，优先把标题整理成具体观点、发布、产品、论文、融资、趋势或项目进展。
7. one_liner_zh 必须只有一句话，直接说明这条 feed 的核心判断。
8. short_summary_zh 必须 1-2 句话，说明“发生了什么 + 为什么值得关注”，不超过 90 个中文字。
9. 如果信息不足，用“信息不足，需点开原文确认”之类的克制表达。
10. 输出严格 JSON，不要 Markdown，不要解释。
11. 英文字段只作为兼容和检索兜底，中文字段是 UI 默认展示内容。

输入：
source: {{source_label}}
source_slug: {{source_slug}}
title: {{title}}
existing_title_zh: {{existing_title_zh}}
url: {{canonical_url}}
published_at: {{published_at}}
original_summary: {{original_summary}}
content_excerpt: {{content_excerpt}}
source_payload: {{source_payload}}
existing_ai_summary: {{existing_ai_summary}}

输出 JSON schema：
{
  "title_zh": "信息流卡片中文标题",
  "ai_title_zh": "更清晰但不夸张的中文标题",
  "ai_title": "Clear English title",
  "one_liner_zh": "一句话中文判断",
  "one_liner": "One-sentence English verdict",
  "short_summary_zh": "1-2 句中文概要",
  "short_summary": "1-2 sentence English summary",
  "key_points_zh": ["2-4 条中文要点"],
  "key_points": ["2-4 English points"],
  "why_it_matters_zh": "为什么值得关注",
  "why_it_matters": "Why it matters",
  "confidence": 0.0
}`;

const BATCH_FEED_CARD_ZH_PROMPT = `/no_think
你是 Eagleye 的中文技术情报编辑。你的任务是把一批原始信息流重写成适合卡片展示的中文知识卡片。

硬性规则：
1. 只依据输入内容，不要编造原文没有的信息。
2. 保留项目名、公司名、模型名、论文名、仓库名、产品名等专有名词，不要强行翻译。
3. 中文标题要短、自然、明确；避免机翻腔、营销腔、夸张语气。
4. 标题必须写“这条信息真正讲了什么”，不要写成“@xxx posted”“某人发帖”“某人说”“分享了一条链接”。
5. title_zh 尽量控制在 22 到 36 个中文字符，让它通常能在卡片里 2 到 3 行读完。
6. 如果来源是 X、论坛、社区或 RSS，优先把标题整理成具体观点、发布、产品、论文、融资、趋势或项目进展。
7. one_liner_zh 必须只有一句话，直接说明这条 feed 的核心判断。
8. short_summary_zh 必须 1-2 句话，说明“发生了什么 + 为什么值得关注”，不超过 90 个中文字。
9. 如果信息不足，用“信息不足，需点开原文确认”之类的克制表达。
10. 输出严格 JSON 数组，不要 Markdown，不要解释。
11. 数组中的每个对象都必须带输入 id，且不要漏项。
12. 英文字段只作为兼容和检索兜底，中文字段是 UI 默认展示内容。

输入 items:
{{items}}

输出 JSON 数组 schema：
[
  {
    "id": "输入 item id",
    "title_zh": "信息流卡片中文标题",
    "ai_title_zh": "更清晰但不夸张的中文标题",
    "ai_title": "Clear English title",
    "one_liner_zh": "一句话中文判断",
    "one_liner": "One-sentence English verdict",
    "short_summary_zh": "1-2 句中文概要",
    "short_summary": "1-2 sentence English summary",
    "key_points_zh": ["2-4 条中文要点"],
    "key_points": ["2-4 English points"],
    "why_it_matters_zh": "为什么值得关注",
    "why_it_matters": "Why it matters",
    "confidence": 0.0
  }
]`;

function generateId() {
  return crypto.randomUUID();
}

function containsChinese(text) {
  return /[\u3400-\u9fff]/.test(String(text || ''));
}

function safeJSONParse(value, fallback) {
  if (!value) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function clampText(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeString(value, fallback = '') {
  return clampText(value, 1000) || fallback;
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(v => clampText(v, 240))
    .filter(Boolean)
    .slice(0, 5);
}

function buildPrompt(row) {
  const existingSummary = {
    ai_title: row.ai_title || '',
    ai_title_zh: row.ai_title_zh || '',
    one_liner: row.one_liner || '',
    one_liner_zh: row.one_liner_zh || '',
    short_summary: row.short_summary || '',
    short_summary_zh: row.short_summary_zh || '',
    key_points: safeJSONParse(row.key_points, []),
    key_points_zh: safeJSONParse(row.key_points_zh, []),
    why_it_matters: row.why_it_matters || '',
    why_it_matters_zh: row.why_it_matters_zh || '',
  };

  return FEED_CARD_ZH_PROMPT
    .replace('{{source_label}}', clampText(row.source_label, 80))
    .replace('{{source_slug}}', clampText(row.source_slug, 80))
    .replace('{{title}}', clampText(row.title, 300))
    .replace('{{existing_title_zh}}', clampText(row.title_zh, 300))
    .replace('{{canonical_url}}', clampText(row.canonical_url, 400))
    .replace('{{published_at}}', clampText(row.published_at, 80))
    .replace('{{original_summary}}', clampText(row.original_summary, 800))
    .replace('{{content_excerpt}}', clampText(row.content_text, 1000))
    .replace('{{source_payload}}', clampText(row.source_payload, 1200))
    .replace('{{existing_ai_summary}}', JSON.stringify(existingSummary).slice(0, 1600));
}

function buildBatchPrompt(rows) {
  const items = rows.map((row) => {
    const existingSummary = {
      ai_title: row.ai_title || '',
      ai_title_zh: row.ai_title_zh || '',
      one_liner: row.one_liner || '',
      one_liner_zh: row.one_liner_zh || '',
      short_summary: row.short_summary || '',
      short_summary_zh: row.short_summary_zh || '',
      key_points: safeJSONParse(row.key_points, []),
      key_points_zh: safeJSONParse(row.key_points_zh, []),
      why_it_matters: row.why_it_matters || '',
      why_it_matters_zh: row.why_it_matters_zh || '',
    };

    return {
      id: row.id,
      source: clampText(row.source_label, 80),
      source_slug: clampText(row.source_slug, 80),
      title: clampText(row.title, 260),
      existing_title_zh: clampText(row.title_zh, 260),
      url: clampText(row.canonical_url, 300),
      published_at: clampText(row.published_at, 80),
      original_summary: clampText(row.original_summary, 600),
      content_excerpt: clampText(row.content_text, 700),
      source_payload: clampText(row.source_payload, 700),
      existing_ai_summary: JSON.stringify(existingSummary).slice(0, 900),
    };
  });

  return BATCH_FEED_CARD_ZH_PROMPT.replace('{{items}}', JSON.stringify(items));
}

function normalizeFeedCard(data, row) {
  const titleZh = normalizeString(data.title_zh || data.ai_title_zh || row.ai_title_zh || row.title_zh || '');
  const aiTitleZh = normalizeString(data.ai_title_zh || data.title_zh || row.ai_title_zh || titleZh);
  const oneLinerZh = normalizeString(data.one_liner_zh || row.one_liner_zh || '');
  const shortSummaryZh = normalizeString(data.short_summary_zh || row.short_summary_zh || oneLinerZh);
  const whyZh = normalizeString(data.why_it_matters_zh || row.why_it_matters_zh || '');
  const keyPointsZh = normalizeArray(data.key_points_zh);
  const keyPoints = normalizeArray(data.key_points);

  return {
    title_zh: titleZh,
    ai_title_zh: aiTitleZh,
    ai_title: normalizeString(data.ai_title || row.ai_title || row.title || ''),
    one_liner_zh: oneLinerZh,
    one_liner: normalizeString(data.one_liner || row.one_liner || data.one_liner_zh || row.title || ''),
    short_summary_zh: shortSummaryZh,
    short_summary: normalizeString(data.short_summary || row.short_summary || data.short_summary_zh || data.one_liner || ''),
    key_points_zh: keyPointsZh.length ? keyPointsZh : normalizeArray(safeJSONParse(row.key_points_zh, [])),
    key_points: keyPoints.length ? keyPoints : normalizeArray(safeJSONParse(row.key_points, [])),
    why_it_matters_zh: whyZh,
    why_it_matters: normalizeString(data.why_it_matters || row.why_it_matters || data.why_it_matters_zh || ''),
    confidence: typeof data.confidence === 'number' ? Math.max(0, Math.min(data.confidence, 1)) : null,
  };
}

async function generateChineseFeedCard(row, opts = {}) {
  const context = taskContext(opts, opts.jobId ? require('./jobs') : null);
  context.check();
  const provider = getEnrichProvider();
  if (!provider) throw new Error('No active LLM provider configured.');
  const maxAttempts = provider.isPool ? 1 : 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data, metadata } = await callWithMetadata(provider, buildPrompt(row), {
        task: 'translate', signal: context.signal, temperature: 0.1, maxTokens: 2000, json: true, validate: validCard,
      });
      context.check();
      return { ...normalizeFeedCard(data, row), llm_metadata: metadata };
    } catch (err) {
      context.check();
      if (/1301|invalid_request_error.*安全|敏感内容/i.test(err.message)) throw new Error('content_filtered', { cause: err });
      if (isTerminalLLMError(err)) throw err;
      if (attempt >= maxAttempts) throw err;
      await _llmBackoff(attempt, err.message, context.signal);
    }
  }
}

async function generateChineseFeedCardsBatch(rows, opts = {}) {
  const context = taskContext(opts, opts.jobId ? require('./jobs') : null);
  context.check();
  const provider = getEnrichProvider();
  if (!provider || !rows?.length) return [];
  const allowedIds = new Set(rows.map(row => row.id));
  const maxAttempts = provider.isPool ? 1 : 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data, metadata } = await callWithMetadata(provider, buildBatchPrompt(rows), {
        task: 'translate', signal: context.signal, temperature: 0.1, maxTokens: Math.min(8192, 600 + rows.length * 1000),
        json: true, validate: output => validateBatch(output, allowedIds, validCard),
      });
      context.check();
      const rowMap = new Map(rows.map(row => [row.id, row]));
      return data.filter(validCard).map(entry => ({
        id: entry.id, card: { ...normalizeFeedCard(entry, rowMap.get(entry.id)), llm_metadata: metadata },
      }));
    } catch (err) {
      context.check();
      if (/1301|invalid_request_error.*安全|敏感内容/i.test(err.message)) return [];
      if (isTerminalLLMError(err)) return [];
      if (attempt < maxAttempts) await _llmBackoff(attempt, err.message, context.signal);
    }
  }
  return [];
}

async function translateText(text, opts = {}) {
  const context = taskContext(opts, opts.jobId ? require('./jobs') : null);
  context.check();
  const trimmed = clampText(text, 1000);
  if (!trimmed) return '';
  if (containsChinese(trimmed)) return trimmed;

  const provider = getEnrichProvider();
  if (!provider) return null;
  const prompt = `/no_think\n请将下面文本改写为自然、简洁的中文。保留专有名词。只输出中文文本，不要解释。\n\n${trimmed}`;
  const { text: result } = await callWithMetadata(provider, prompt, { task: 'translate', signal: context.signal, temperature: 0.1, maxTokens: 300, validate: nonEmpty });
  return clampText(result, 1000) || null;
}

function fetchItemForBackfill(itemId) {
  const db = getDB();
  if (!db) return null;
  return db.prepare(`
    SELECT i.id, i.title, i.title_zh, i.canonical_url, i.original_summary, i.content_text,
           i.published_at, i.source_payload, src.slug AS source_slug, src.label AS source_label,
           s.id AS summary_id, s.ai_title, s.ai_title_zh, s.one_liner, s.one_liner_zh,
           s.short_summary, s.short_summary_zh, s.key_points, s.key_points_zh,
           s.why_it_matters, s.why_it_matters_zh
    FROM information_items i
    JOIN sources src ON src.id = i.source_id
    LEFT JOIN ai_summaries s ON s.item_id = i.id
    WHERE i.id = ?
  `).get(itemId);
}

function writeFeedCard(row, card, opts = {}) {
  const context = taskContext(opts, opts.jobId ? require('./jobs') : null);
  context.check();
  const db = getDB();
  const metadata = card.llm_metadata;
  if (!metadata || !validCard(card)) throw new Error('Invalid generated translation');
  const translated = !!(card.title_zh || card.one_liner_zh || card.short_summary_zh);

  const updateTitle = db.prepare(`
    UPDATE information_items
    SET title_zh = COALESCE(NULLIF(?, ''), title_zh),
        title_zh_status = ?
    WHERE id = ?
  `);

  const updateSummary = db.prepare(`
    UPDATE ai_summaries
    SET model_provider = ?,
        model_name = ?,
        prompt_version = COALESCE(NULLIF(prompt_version, ''), ?),
        ai_title = COALESCE(NULLIF(?, ''), ai_title),
        ai_title_zh = COALESCE(NULLIF(?, ''), ai_title_zh),
        one_liner = COALESCE(NULLIF(?, ''), one_liner),
        one_liner_zh = COALESCE(NULLIF(?, ''), one_liner_zh),
        short_summary = COALESCE(NULLIF(?, ''), short_summary),
        short_summary_zh = COALESCE(NULLIF(?, ''), short_summary_zh),
        key_points = COALESCE(NULLIF(?, ''), key_points),
        key_points_zh = COALESCE(NULLIF(?, ''), key_points_zh),
        why_it_matters = COALESCE(NULLIF(?, ''), why_it_matters),
        why_it_matters_zh = COALESCE(NULLIF(?, ''), why_it_matters_zh),
        confidence = COALESCE(?, confidence),
        translation_status = ?,
        source_grounding = ?,
        llm_metadata = ?
    WHERE item_id = ?
  `);

  const insertSummary = db.prepare(`
    INSERT INTO ai_summaries
      (id, item_id, model_provider, model_name, prompt_version, ai_title, ai_title_zh,
       one_liner, one_liner_zh, short_summary, short_summary_zh, deep_summary,
       key_points, key_points_zh, why_it_matters, why_it_matters_zh, audience, risks,
       opportunities, action_items, confidence, translation_status, source_grounding, llm_metadata)
    VALUES
      (@id, @item_id, @model_provider, @model_name, @prompt_version, @ai_title, @ai_title_zh,
       @one_liner, @one_liner_zh, @short_summary, @short_summary_zh, NULL,
       @key_points, @key_points_zh, @why_it_matters, @why_it_matters_zh, '[]', '[]',
       '[]', '[]', @confidence, @translation_status, @source_grounding, @llm_metadata)
  `);

  const sourceGrounding = JSON.stringify({
    item_id: row.id,
    source_label: row.source_label,
    source_slug: row.source_slug,
    canonical_url: row.canonical_url,
    prompt_version: PROMPT_VERSION,
    provider: metadata.provider,
    model: metadata.model,
    generated_at: new Date().toISOString(),
  });

  const summaryPayload = {
    id: row.summary_id || generateId(),
    item_id: row.id,
    model_provider: metadata.provider,
    model_name: metadata.model,
    llm_metadata: JSON.stringify(metadata),
    prompt_version: PROMPT_VERSION,
    ai_title: card.ai_title || row.title || '',
    ai_title_zh: card.ai_title_zh || card.title_zh || '',
    one_liner: card.one_liner || card.one_liner_zh || row.title || '',
    one_liner_zh: card.one_liner_zh || '',
    short_summary: card.short_summary || card.short_summary_zh || card.one_liner || row.original_summary || '',
    short_summary_zh: card.short_summary_zh || '',
    key_points: JSON.stringify(card.key_points || []),
    key_points_zh: JSON.stringify(card.key_points_zh || []),
    why_it_matters: card.why_it_matters || '',
    why_it_matters_zh: card.why_it_matters_zh || '',
    confidence: card.confidence,
    translation_status: translated ? 'translated' : 'failed',
    source_grounding: sourceGrounding,
  };

  const txn = db.transaction(() => {
    updateTitle.run(card.title_zh || card.ai_title_zh || '', translated ? 'translated' : 'failed', row.id);

    if (row.summary_id) {
      updateSummary.run(
        summaryPayload.model_provider,
        summaryPayload.model_name,
        PROMPT_VERSION,
        summaryPayload.ai_title,
        summaryPayload.ai_title_zh,
        summaryPayload.one_liner,
        summaryPayload.one_liner_zh,
        summaryPayload.short_summary,
        summaryPayload.short_summary_zh,
        summaryPayload.key_points,
        summaryPayload.key_points_zh,
        summaryPayload.why_it_matters,
        summaryPayload.why_it_matters_zh,
        summaryPayload.confidence,
        summaryPayload.translation_status,
        summaryPayload.source_grounding,
        summaryPayload.llm_metadata,
        row.id
      );
    } else {
      insertSummary.run(summaryPayload);
    }
  });

  txn();
}

async function translateItem(itemId, opts = {}) {
  const row = fetchItemForBackfill(itemId);
  if (!row) return null;

  const card = await generateChineseFeedCard(row, opts);
  writeFeedCard(row, card, opts);

  return {
    itemId,
    title_zh: card.title_zh,
    ai_title_zh: card.ai_title_zh,
    one_liner_zh: card.one_liner_zh,
    short_summary_zh: card.short_summary_zh,
  };
}

async function translateRow(row, opts = {}) {
  if (!row) return null;
  const card = await generateChineseFeedCard(row, opts);
  writeFeedCard(row, card, opts);
  return {
    itemId: row.id,
    title_zh: card.title_zh,
    ai_title_zh: card.ai_title_zh,
    one_liner_zh: card.one_liner_zh,
    short_summary_zh: card.short_summary_zh,
  };
}

/**
 * Batch-backfill items that have missing Chinese card content.
 *
 * @param {Object} opts
 * @param {number} opts.batchSize   how many items to process in this call
 * @param {number} opts.maxItems    cap total items processed
 * @param {boolean} opts.force      regenerate even if *_zh already populated
 * @param {string}  opts.jobId      if set, poll isJobCancelled(jobId)
 */
async function translateItems(opts = {}) {
  const {
    batchSize = 10,
    maxItems = Infinity,
    force = false,
    jobId,
    sourceSlug = '',
    retryBlocked = false,
    batchItemSize = getEnrichProvider()?.isPool ? 4 : DEFAULT_BATCH_ITEMS,
    batchWorkers = DEFAULT_BATCH_WORKERS,
  } = opts;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('Invalid translation batchSize');
  if (maxItems !== Infinity && (!Number.isInteger(maxItems) || maxItems < 1)) throw new Error('Invalid translation maxItems');
  if (!Number.isInteger(batchItemSize) || batchItemSize < 1 || batchItemSize > 48) throw new Error('Invalid translation batchItemSize');
  if (!Number.isInteger(batchWorkers) || batchWorkers < 1 || batchWorkers > 32) throw new Error('Invalid translation batchWorkers');
  const context = taskContext(opts, jobId ? require('./jobs') : null);
  if (context.isCancelled()) return { translated: 0, failed: 0, total: 0, cancelled: true };
  const db = getDB();
  if (!db) return { translated: 0, failed: 0, total: 0 };

  if (!getEnrichProvider()) {
    throw new Error('No active local LLM provider configured. Configure it in Settings -> LLM.');
  }

  const updateProgress = (progress) => {
    if (!jobId) return;
    const { updateJobProgress } = require('./jobs');
    updateJobProgress(jobId, progress);
  };

  const sourceFilter = sourceSlug ? ' AND src.slug = ? ' : '';
  const whereClause = force
    ? `1=1`
    : `(
        i.title_zh IS NULL OR i.title_zh = '' OR i.title_zh_status = 'pending'
        OR s.item_id IS NULL
        OR s.ai_title_zh IS NULL OR s.ai_title_zh = ''
        OR s.one_liner_zh IS NULL OR s.one_liner_zh = ''
        OR s.short_summary_zh IS NULL OR s.short_summary_zh = ''
        OR s.translation_status = 'pending'
      ) ${retryBlocked ? '' : "AND COALESCE(s.translation_status, '') != 'blocked'"}`;

  const total = db.prepare(`
    SELECT COUNT(DISTINCT i.id) as c
    FROM information_items i
    JOIN sources src ON src.id = i.source_id
    LEFT JOIN ai_summaries s ON s.item_id = i.id
    WHERE ${whereClause}
    ${sourceFilter}
  `).get(...(sourceSlug ? [sourceSlug] : [])).c;
  const limit = Math.min(batchSize, maxItems, total);

  if (total === 0) {
    return { translated: 0, failed: 0, total: 0, remaining: 0, prompt_version: PROMPT_VERSION };
  }

  const items = db.prepare(`
    SELECT DISTINCT i.id, i.title, i.title_zh, i.canonical_url, i.original_summary, i.content_text,
           i.published_at, i.score, i.source_payload, src.slug AS source_slug, src.label AS source_label,
           s.id AS summary_id, s.ai_title, s.ai_title_zh, s.one_liner, s.one_liner_zh,
           s.short_summary, s.short_summary_zh, s.key_points, s.key_points_zh,
           s.why_it_matters, s.why_it_matters_zh
    FROM information_items i
    JOIN sources src ON src.id = i.source_id
    LEFT JOIN ai_summaries s ON s.item_id = i.id
    WHERE ${whereClause}
    ${sourceFilter}
    ORDER BY CASE src.slug
      WHEN 'x-following' THEN 0
      WHEN 'hacker-news' THEN 1
      WHEN 'github-trending' THEN 2
      WHEN 'hugging-face' THEN 3
      WHEN 'product-hunt' THEN 4
      ELSE 99
    END, i.published_at DESC, i.score DESC
    LIMIT ?
  `).all(...(sourceSlug ? [sourceSlug, limit] : [limit]));

  const info = getProviderInfo();
  const enrichModel = getEnrichProvider()?.model || info.model;
  console.log(`  🧠 Generating Chinese feed cards ${items.length}/${total} with ${info.provider}:${enrichModel}...`);
  updateProgress({
    phase: 'translating',
    mode: 'local-llm-feed-card',
    provider: info.provider,
    model: enrichModel,
    processed: 0,
    translated: 0,
    failed: 0,
    total: items.length,
    remaining: total,
  });

  let translated = 0;
  let failed = 0;

  const chunks = [];
  for (let i = 0; i < items.length; i += batchItemSize) {
    chunks.push(items.slice(i, i + batchItemSize));
  }

  let processed = 0;
  let chunkCursor = 0;

  async function processChunk(chunk) {
    context.check();
    const batchResults = await generateChineseFeedCardsBatch(chunk, context);
    context.check();
    const byId = new Map(batchResults.map((entry) => [entry.id, entry.card]));
    const results = [];

    const writeDb = getDB();
    const tx = writeDb.transaction(() => {
      for (const row of chunk) {
        if (byId.has(row.id)) {
          try {
            writeFeedCard(row, byId.get(row.id), context);
            results.push({
              itemId: row.id,
              title_zh: byId.get(row.id).title_zh,
              one_liner_zh: byId.get(row.id).one_liner_zh,
              short_summary_zh: byId.get(row.id).short_summary_zh,
            });
          } catch (err) {
            console.warn(`  ⚠  Failed to write Chinese card ${String(row.id).slice(0, 8)}: ${err.message}`);
            results.push(null);
          }
        }
      }
    });
    tx();

    // Individual fallback for items not covered by the batch
    for (const row of chunk) {
      if (context.isCancelled()) break;
      if (!byId.has(row.id)) {
        if (getEnrichProvider()?.isPool && batchResults.length === 0) { results.push(null); continue; }
        try {
          results.push(await translateRow(row, context));
        } catch (err) {
          if (context.isCancelled()) break;
          if (err.message === 'content_filtered') {
            console.log(`  ⏭  Chinese card skipped (${String(row.id).slice(0, 8)}): content filtered by safety check`);
            // Mark as blocked so it won't re-enter the queue on future runs
            try { getDB().prepare('UPDATE ai_summaries SET translation_status = ? WHERE item_id = ?').run('blocked', row.id); } catch {}
          } else {
            console.warn(`  ⚠  Chinese card backfill failed for ${String(row.id).slice(0, 8)}: ${err.message.slice(0, 100)}`);
          }
          results.push(null);
        }
      }
    }

    for (const result of results) {
      if (result && (result.title_zh || result.one_liner_zh || result.short_summary_zh)) translated++;
      else failed++;
    }

    processed += results.length;
    if (context.isCancelled()) return;
    updateProgress({
      phase: 'translating',
      mode: 'local-llm-feed-card-batch',
      provider: info.provider,
      model: enrichModel,
      processed: Math.min(processed, items.length),
      translated,
      failed,
      total: items.length,
      remaining: Math.max(total - processed, 0),
      batch_items: batchItemSize,
      workers: Math.min(batchWorkers, chunks.length),
    });
  }

  async function worker() {
    while (true) {
      if (context.isCancelled()) return;
      const index = chunkCursor;
      if (index >= chunks.length) return;
      chunkCursor++;
      try { await processChunk(chunks[index]); } catch (error) {
        if (context.isCancelled()) return;
        throw error;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(batchWorkers, chunks.length) }, () => worker())
  );

  if (context.isCancelled()) {
    console.log(`  ⛔ translateItems cancelled at ${processed}/${items.length}`);
    return {
      translated,
      failed,
      total: items.length,
      remaining: Math.max(total - processed, 0),
      cancelled: true,
      prompt_version: PROMPT_VERSION,
      batch_items: batchItemSize,
      workers: Math.min(batchWorkers, chunks.length),
    };
  }

  console.log(`  ✅ Chinese feed cards ${translated}/${items.length} (${failed} failed). ${total - items.length} remaining.`);
  return {
    translated,
    failed,
    total: items.length,
    remaining: total - items.length,
    prompt_version: PROMPT_VERSION,
    provider: info.provider,
    model: enrichModel,
    source_slug: sourceSlug || null,
    batch_items: batchItemSize,
    workers: Math.min(batchWorkers, chunks.length),
  };
}

module.exports = {
  translateText,
  translateItem,
  translateItems,
  generateChineseFeedCard,
  generateChineseFeedCardsBatch,
};
