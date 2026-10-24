/**
 * Eagleye — LLM Service
 *
 * AI enrichment pipeline using the LLM provider abstraction.
 * Implements architecture doc §8 (LLM Information Enrichment).
 *
 * Core functions:
 * - generateItemSummary(item)  — §8.1: Structured per-item AI summary
 * - generateDailyDigest(date)  — §8.2: Daily AI digest across all sources
 * - enrichItems()              — Batch enrichment of items without summaries
 */

const { getProvider, getEnrichProvider } = require('./llm-provider');
const { getDB } = require('../db/connection');
const { generateDailyDigest } = require('./llm-digest');
const { taskContext, abortableDelay, _isOverloadError, callWithMetadata, validCard, validateBatch, VALID_SUMMARY_SQL,
  estimateTokens, isOutputRepairable, taskAttempt, withTaskStats, ITEM_STATE, ITEM_REASON,
  repairCallBudget, createCoverage, markItem, finalizeCoverage, mergeFinalCoverage } = require('./llm-shared');
const { isTerminalLLMError } = require('./llm-error-class');
const { deepEnrichSkipReason } = require('./content-sufficiency');
const crypto = require('crypto');

function generateId() {
  return crypto.randomUUID();
}

function getPromptVersion() {
  return 'v3.1-knowledge-card-graph-zh';
}

const ENRICH_PRIORITY_SOURCES = [
  'x-following',
  'hacker-news',
  'github-trending',
  'hugging-face',
];

const ENRICH_PRIORITY_SQL = `
  CASE s.slug
    WHEN 'x-following' THEN 0
    WHEN 'hacker-news' THEN 1
    WHEN 'github-trending' THEN 2
    WHEN 'hugging-face' THEN 3
    WHEN 'product-hunt' THEN 4
    WHEN 'arxiv-ai' THEN 5
    WHEN 'physical-ai-arxiv' THEN 6
    WHEN 'reddit' THEN 7
    WHEN 'xiaohongshu' THEN 8
    ELSE 99
  END
`;

// Max enrichment attempts before an item is considered "poisoned" and skipped.
// Prevents the failure loop where items with unparseable LLM output are retried
// on every pipeline run forever. Override via env for forced re-enrichment.
const MAX_ENRICH_ATTEMPTS = parseInt(process.env.MAX_ENRICH_ATTEMPTS || '3', 10);

// ─── §8.1 Per-Item Summary ──────────────────────────────────────────────

const ITEM_SUMMARY_PROMPT = `/no_think
你是 Eagleye 的中文技术情报编辑和知识图谱标注员。请把原始信息加工成适合信息流展示的"中文知识卡片"，并完成分类、标签和实体抽取。

要求：
1. 不要编造原文没有的信息。
2. 信息不足时明确写"信息不足，需点开原文确认"。
3. 保留项目名、公司名、模型名、论文名、仓库名、产品名等专有名词。
4. 输出严格 JSON，不要 Markdown，不要解释。
5. title_zh 必须是"这条信息真正说了什么"的中文标题，不要复述抓取动作，不要写成"@xxx posted""某人发帖""某人说""转发了什么"。
6. title_zh 尽量控制在 22 到 36 个中文字符，让它通常能在卡片里 2 到 3 行读完。
7. 如果来源是 X、论坛、社区或 RSS，title_zh 仍然要提炼成具体事件、观点、发布、产品、论文、融资、趋势判断中的一种，而不是动作描述。
8. one_liner_zh 只有一句话，直接给核心判断。
9. short_summary_zh 为 1-2 句话，不超过 90 个中文字，写清"发生了什么 + 为什么值得看"。
10. 把每条信息当成知识卡片处理，不要写空话，不要写泛泛而谈的标题。
11. topic_slugs 只能从 allowed_topics 里选，最多 3 个，按相关性排序。
12. tags 非常重要，用于构建知识图谱！必须提供 4-6 个中文短标签，粒度要细。优先：具体技术名词（如"MoE架构""LoRA微调"）、具体产品名（如"Claude 4""GPT-5"）、具体公司名（如"Anthropic""DeepSeek"）、具体能力方向（如"代码生成""数学推理"）。严禁英文、拼音、混合语言。
13. entities 只保留原文明确出现的实体。
14. 如果原始标题很差、像占位符、像抓取动作，请根据正文和上下文重写出可读标题。
15. confidence 反映你对"标题和摘要是否被原文充分支持"的把握。

输入：
source: {{source_label}}
source_slug: {{source_slug}}
title: {{title}}
url: {{canonical_url}}
published_at: {{published_at}}
source_payload: {{source_payload}}
content_excerpt: {{content_excerpt}}
allowed_topics: {{allowed_topics}}

输出 JSON schema：
{
  "title_zh": "中文标题",
  "one_liner_zh": "一句话中文判断",
  "short_summary_zh": "1-2 句中文概要",
  "key_points_zh": ["2-4 条中文要点"],
  "why_it_matters_zh": "为什么值得关注",
  "topic_slugs": ["llms-generative-ai"],
  "suggested_tags": ["MoE架构", "混合专家模型", "推理加速", "开源权重", "DeepSeek"],
  "entities": [{"name": "实体名", "type": "company|repo|paper|model|person|product|technology|topic|other"}],
  "confidence": 0.0
}`;

function getAllowedTopicsForPrompt() {
  const db = getDB();
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT slug, name, COALESCE(name_zh, '') as name_zh, COALESCE(description, '') as description
      FROM topics
      WHERE status = 'active'
      ORDER BY auto_generated ASC, slug ASC
      LIMIT 40
    `).all();
  } catch {
    return [];
  }
}

function createSummaryResult(item, data, metadata) {
  const summaryRecord = {
    id: generateId(),
    item_id: item.id,
    model_provider: metadata.provider,
    model_name: metadata.model || '',
    llm_metadata: JSON.stringify(metadata),
    prompt_version: getPromptVersion(),
    ai_title: data.ai_title || item.title || '',
    ai_title_zh: data.ai_title_zh || data.title_zh || '',
    one_liner: data.one_liner || data.one_liner_zh || item.title || '',
    one_liner_zh: data.one_liner_zh || '',
    short_summary: data.short_summary || data.short_summary_zh || data.one_liner_zh || '',
    short_summary_zh: data.short_summary_zh || '',
    deep_summary: null,
    key_points: JSON.stringify(data.key_points || data.key_points_zh || []),
    key_points_zh: JSON.stringify(data.key_points_zh || []),
    why_it_matters: data.why_it_matters || data.why_it_matters_zh || '',
    why_it_matters_zh: data.why_it_matters_zh || '',
    audience: JSON.stringify(data.audience || []),
    risks: JSON.stringify(data.risks || []),
    opportunities: JSON.stringify(data.opportunities || []),
    action_items: JSON.stringify(data.action_items || []),
    confidence: data.confidence ?? null,
    translation_status: (data.ai_title_zh || data.title_zh || data.one_liner_zh) ? 'translated' : 'pending',
    source_grounding: JSON.stringify({
      item_id: item.id,
      source_label: item.source_label,
      canonical_url: item.canonical_url,
      prompt_version: getPromptVersion(),
    }),
  };

  const extractedTags = (data.suggested_tags || data.tags || []).slice(0, 10);
  const extractedEntities = (data.entities || []).slice(0, 15);
  const topicSlugs = (data.topic_slugs || [])
    .filter(s => typeof s === 'string')
    .slice(0, 3);

  return { summary: summaryRecord, tags: extractedTags, entities: extractedEntities, topicSlugs };
}

function evidenceExcerpt(item) {
  const title = String(item.title || '').replace(/\s+/g, ' ').trim();
  return [item.original_summary, item.content_text].find(text => {
    if (typeof text !== 'string') return false;
    const cleaned = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned.length > 0 && cleaned !== title;
  }) || '';
}

function createTitleOnlySummary(item) {
  if (evidenceExcerpt(item)) throw new Error('Title-only fallback requires missing source content');
  const title = String(item.title || '').trim() || '来源未提供标题';
  const notice = `仅据来源标题：“${title}”。未获取正文，细节及结论未核验。`;
  const result = createSummaryResult(item, {
    ai_title: title, ai_title_zh: title,
    one_liner: notice, one_liner_zh: notice,
    short_summary: notice, short_summary_zh: notice, confidence: 0,
  }, {
    generation_method: 'source_title_only', provider: 'deterministic', model: null,
    requested_model: null, endpoint_id: null, protocol: null, trace_id: null,
    attempts: 0, usage: null, latency_ms: 0,
  });
  result.summary.translation_status = 'n/a';
  result.summary.prompt_version = 'title-only-v1';
  result.summary.source_grounding = JSON.stringify({
    item_id: item.id, source_label: item.source_label, canonical_url: item.canonical_url,
    prompt_version: 'title-only-v1', evidence_level: 'title_only', body_available: false,
    title_origin: 'source_title_untranslated', verified: false,
  });
  return result;
}

/**
 * Generate an AI summary for a single item following §8.1.
 * Returns the summary record to be inserted into ai_summaries table,
 * plus extracted tags and entities.
 */
async function generateItemSummary(item, opts = {}) {
  const context = taskContext(opts, opts.jobId ? require('./jobs') : null);
  context.check();
  if (!evidenceExcerpt(item)) return createTitleOnlySummary(item);
  const skipReason = deepEnrichSkipReason(item);
  if (skipReason) {
    console.log(`  ⏭  Deep enrich skipped (${item.id?.slice(0, 8)}): ${skipReason}`);
    return null;
  }
  const provider = getEnrichProvider();
  if (!provider) return null;

  const prompt = ITEM_SUMMARY_PROMPT
    .replace('{{source_label}}', item.source_label || '')
    .replace('{{source_slug}}', item.source_slug || '')
    .replace('{{title}}', (item.title || '').slice(0, 500))
    .replace('{{canonical_url}}', item.canonical_url || '')
    .replace('{{published_at}}', item.published_at || '')
    .replace('{{source_payload}}', typeof item.source_payload === 'string' ? item.source_payload.slice(0, 400) : JSON.stringify(item.source_payload || {}).slice(0, 400))
    .replace('{{content_excerpt}}', evidenceExcerpt(item).slice(0, 700))
    .replace('{{allowed_topics}}', JSON.stringify(getAllowedTopicsForPrompt()).slice(0, 1600));

  const maxRetries = provider.isPool ? 1 : 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data, metadata } = await callWithMetadata(provider, prompt, {
        task: 'enrich', signal: context.signal, temperature: 0.1, maxTokens: 1800, json: true, validate: validCard,
      });
      context.check();
      return createSummaryResult(item, data, metadata);
    } catch (err) {
      context.check();
      // 1301 内容安全审核：不可恢复，立即跳过
      if (/1301|invalid_request_error.*安全|敏感内容/i.test(err.message)) {
        console.log(`  ⏭  Summary skipped (${item.id?.slice(0, 8)}): content filtered by safety check`);
        return null;
      }
      if (isTerminalLLMError(err)) {
        console.error(`  ❌ Summary aborted (${item.id?.slice(0, 8)}): terminal LLM error (${err.code || err.name || 'unknown'})`);
        return null;
      }
      if (attempt < maxRetries) {
        await _llmBackoff(attempt, err.message, context.signal);
      } else {
        console.error(`  ❌ Summary generation failed after ${maxRetries} attempts (${item.id?.slice(0, 8)}):`, err.message);
        return null;
      }
    }
  }
  return null;
}

const BATCH_ITEM_SUMMARY_PROMPT = `/no_think
你是 Eagleye 的中文技术情报编辑和知识图谱标注员。请批量处理信息流条目，把每条输入加工成适合首页/信息源页展示的中文知识卡片。

规则：
1. 只依据输入，不编造。
2. 保留专有名词。
3. title_zh 必须直接概括实质内容，不能写成"@xxx posted""某人发帖""某人分享了什么""有人讨论了什么"。
4. title_zh 尽量控制在 22 到 36 个中文字符，让它通常能在卡片里 2 到 3 行读完。
5. 对 X、论坛、社区、RSS 等来源，优先提炼成"产品/模型/论文/发布/观点/趋势/融资/项目进展"的知识标题。
6. 每条输出中文标题、一句话判断、1句短摘要、2个要点、topic_slugs、tags、entities。
7. short_summary_zh 不超过 60 个中文字，why_it_matters_zh 不超过 30 个中文字，每个要点不超过 20 个中文字。
8. topic_slugs 只能从 allowed_topics 选择，最多3个。
9. tags 非常重要，用于构建知识图谱！必须提供 4-5 个中文短标签，粒度要细。优先：具体技术名词、具体产品名、具体公司名、具体能力方向。严禁英文、拼音、混合语言。entities 最多 5 个。
10. 如果 item 是论文源（hugging-face、arxiv-ai、physical-ai-arxiv，或 payload 包含 paper/arxiv 字段），必须按论文理解：title_zh 概括论文贡献，one_liner_zh 说明方法或发现，tags 优先抽取方法、任务、模型、数据集、基准和应用场景，例如"VLA模型""机器人学习""扩散策略""多模态评测""参数高效微调"。严禁只给"论文""AI论文""机器学习""研究分享"。
11. 输出严格 JSON 数组，不要 Markdown，不要思考过程。

allowed_topics: {{allowed_topics}}
items: {{items}}

输出数组，每个元素：
{
  "id": "输入 item id",
  "title_zh": "中文标题",
  "one_liner_zh": "一句话判断",
  "short_summary_zh": "不超过60字",
  "key_points_zh": ["2-3条"],
  "why_it_matters_zh": "为什么值得关注",
  "topic_slugs": ["slug"],
  "suggested_tags": ["MoE架构", "混合专家模型", "推理加速", "开源权重", "DeepSeek"],
  "entities": [{"name":"实体名","type":"company|repo|paper|model|person|product|technology|topic|other"}],
  "confidence": 0.0
}`;

async function generateItemSummariesBatch(items, opts = {}) {
  const context = taskContext(opts, opts.jobId ? require('./jobs') : null);
  context.check();
  if (!items?.length) return [];
  const coverage = createCoverage(items.map(item => item.id));
  const titleOnly = [];
  const gateSkippedMessages = [];
  items = items.filter(item => {
    if (!evidenceExcerpt(item)) {
      titleOnly.push(createTitleOnlySummary(item));
      markItem(coverage, item.id, ITEM_STATE.SUCCESS, ITEM_REASON.TITLE_ONLY);
      return false;
    }
    const skipReason = deepEnrichSkipReason(item);
    if (skipReason) {
      gateSkippedMessages.push((item.id?.slice(0, 8) || 'unknown') + ': ' + skipReason);
      markItem(coverage, item.id, ITEM_STATE.DEFERRED, ITEM_REASON.GATE_SKIPPED);
      return false;
    }
    return true;
  });
  if (gateSkippedMessages.length) console.log('  ⏭  Sufficiency gate skipped ' + gateSkippedMessages.length + ' item(s): ' + gateSkippedMessages.join('; '));
  if (!items.length) return withTaskStats(titleOnly, [], coverage);
  const provider = getEnrichProvider();
  if (!provider) {
    for (const item of items) markItem(coverage, item.id, ITEM_STATE.DEFERRED, ITEM_REASON.NO_PROVIDER);
    return withTaskStats(titleOnly, [], coverage);
  }

  const compact = item => ({
    id: item.id,
    source: item.source_label || item.source_slug || '',
    title: String(item.title || '').slice(0, 240),
    url: String(item.canonical_url || '').slice(0, 260),
    summary: evidenceExcerpt(item).replace(/\s+/g, ' ').slice(0, 420),
    payload: String(item.source_payload || '').replace(/\s+/g, ' ').slice(0, 260),
  });
  const inputTokenBudget = parseInt(process.env.ENRICH_LLM_INPUT_TOKEN_BUDGET || '2400', 10);
  const averageInputTokens = Math.max(1, Math.ceil(estimateTokens(items.map(compact)) / items.length));
  const inputLimit = Math.max(1, Math.min(items.length, Math.floor(inputTokenBudget / averageInputTokens)));
  if (inputLimit < items.length) {
    const results = [];
    const splitAttempts = [];
    let splitCoverageComplete = true;
    for (let i = 0; i < items.length; i += inputLimit) {
      const part = await generateItemSummariesBatch(items.slice(i, i + inputLimit), opts);
      if (part.task_stats) splitAttempts.push(...part.task_stats.attempts);
      if (part.task_stats?.coverage) {
        mergeFinalCoverage(coverage, {
          item_states: part.task_stats.item_states,
          item_reasons: part.task_stats.item_reasons,
        });
      } else {
        splitCoverageComplete = false;
      }
      results.push(...part);
      if (context.isCancelled()) break;
    }
    const combined = [...titleOnly, ...results];
    if (!results.length && titleOnly.length) Object.assign(combined, { batch_failed: true });
    if (splitCoverageComplete && !context.isCancelled()) {
      return withTaskStats(combined, splitAttempts, coverage);
    }
    return combined;
  }

  let pending = items;
  const attempts = [];
  let callCount = 0;
  let sameSetRetries = 0;
  let kindForNextCall = 'initial';
  const repairDeferredGaps = new Set();
  const budget = repairCallBudget(items.length);
  while (pending.length && callCount < budget) {
    const requestItems = pending;
    const compactItems = requestItems.map(compact);
    const allowedIds = new Set(requestItems.map(item => item.id));
    const prompt = BATCH_ITEM_SUMMARY_PROMPT
      .replace('{{allowed_topics}}', JSON.stringify(getAllowedTopicsForPrompt()).slice(0, 1400))
      .replace('{{items}}', JSON.stringify(compactItems));
    const maxTokens = Math.min(provider.isPool ? 4096 : 8192, 500 + requestItems.length * 650);
    const started = Date.now();
    callCount++;
    try {
      const { data, metadata } = await callWithMetadata(provider, prompt, {
        task: 'enrich', signal: context.signal, temperature: 0.1, json: true,
        maxTokens,
        validate: rows => validateBatch(rows, allowedIds, validCard),
      });
      context.check();
      const byId = new Map(pending.map(item => [item.id, item]));
      const successRows = data.filter(validCard).map(row => createSummaryResult(byId.get(row.id), row, metadata));
      for (const row of successRows) markItem(coverage, row.summary.item_id, ITEM_STATE.SUCCESS, ITEM_REASON.SUCCEEDED);
      const uncovered = pending.filter(item => coverage.states.get(item.id) !== ITEM_STATE.SUCCESS);
      for (const item of uncovered) markItem(coverage, item.id, ITEM_STATE.DEFERRED, ITEM_REASON.UNCOVERED_IN_RESPONSE);
      for (const item of repairDeferredGaps) {
        if (coverage.states.get(item.id) !== ITEM_STATE.SUCCESS && coverage.states.get(item.id) !== ITEM_STATE.EXPLICIT_FAILED) {
          markItem(coverage, item.id, ITEM_STATE.DEFERRED, ITEM_REASON.UNCOVERED_IN_RESPONSE, true);
        }
      }
      attempts.push(taskAttempt(attempts.length + 1, requestItems, maxTokens, null, Date.now() - started, metadata, kindForNextCall));
      // A successful but incomplete response is already useful. Return it for
      // commit; the caller schedules a separate compensation call for gaps.
      return withTaskStats([...titleOnly, ...successRows], attempts, coverage);
    } catch (err) {
      context.check();
      attempts.push(taskAttempt(attempts.length + 1, requestItems, maxTokens, err, Date.now() - started, null, kindForNextCall));
      if (/1301|invalid_request_error.*安全|敏感内容/i.test(err.message)) {
        for (const item of pending) markItem(coverage, item.id, ITEM_STATE.EXPLICIT_FAILED, ITEM_REASON.CONTENT_FILTERED);
        break;
      }
      if (isTerminalLLMError(err)) {
        for (const item of pending) markItem(coverage, item.id, ITEM_STATE.EXPLICIT_FAILED, ITEM_REASON.TERMINAL_ERROR);
        break;
      }
      const repairable = isOutputRepairable(err);
      if (provider.isPool) {
        if (!repairable) {
          for (const item of pending) markItem(coverage, item.id, ITEM_STATE.DEFERRED, ITEM_REASON.TRANSPORT_DEFERRED);
          break;
        }
        if (pending.length === 1) {
          markItem(coverage, pending[0].id, ITEM_STATE.EXPLICIT_FAILED, ITEM_REASON.REPAIR_EXHAUSTED);
          break;
        }
        const keepCount = Math.ceil(pending.length / 2);
        for (const item of pending.slice(keepCount)) markItem(coverage, item.id, ITEM_STATE.DEFERRED, ITEM_REASON.REPAIR_DEFERRED);
        for (const item of pending.slice(keepCount)) repairDeferredGaps.add(item);
        pending = pending.slice(0, keepCount);
        kindForNextCall = 'output_repair';
        continue;
      }
      console.warn('  ⚠  Batch summary attempt ' + attempts.length + '/' + budget + ' for ' + requestItems.length + ' item(s) failed: ' + err.message);
      if (sameSetRetries < 2 && callCount < budget) {
        sameSetRetries++;
        kindForNextCall = repairable ? 'output_repair' : 'transport_retry';
        await _llmBackoff(attempts.length, err.message, context.signal);
        continue;
      }
      if (pending.length === 1) {
        markItem(coverage, pending[0].id, ITEM_STATE.EXPLICIT_FAILED, ITEM_REASON.REPAIR_EXHAUSTED);
      } else {
        for (const item of pending) markItem(coverage, item.id, ITEM_STATE.DEFERRED, repairable ? ITEM_REASON.REPAIR_DEFERRED : ITEM_REASON.TRANSPORT_DEFERRED);
      }
      break;
    }
  }
  for (const item of pending) {
    if (!coverage.states.has(item.id)) {
      markItem(coverage, item.id, ITEM_STATE.DEFERRED, ITEM_REASON.TRANSPORT_DEFERRED);
    }
  }
  const rows = [...titleOnly];
  Object.assign(rows, { batch_failed: true });
  return withTaskStats(rows, attempts, coverage);
}

/**
 * Backoff helper: model overload (529/1305) needs much longer waits than
 * generic errors — the model capacity has to recover. Returns the ms waited.
 */

async function _llmBackoff(attempt, errMsg, signal) {
  // 529 模型过载：需要长退避（10s/20s/30s），让它恢复容量
  const base = _isOverloadError(errMsg) ? 10000 : 2000;
  const ms = Math.min(30000, base * attempt);
  await abortableDelay(ms, signal);
  return ms;
}

// ─── Entity & Tag Extraction ────────────────────────────────────────────

/**
 * Save extracted tags to the tags DB table and link to the item.
 * Handles deduplication: looks up existing tags by slug before inserting.
 */
function saveItemTags(itemId, tagNames) {
  const db = getDB();
  if (!db || !tagNames?.length) return;

  const findTag = db.prepare('SELECT id FROM tags WHERE slug = ?');
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (id, slug, name, type) VALUES (?, ?, ?, 'llm-extracted')");
  const linkTag = db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence) VALUES (?, ?, ?)');
  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO graph_edges
      (id, from_type, from_id, to_type, to_id, edge_type, weight, evidence_item_ids, first_seen_at, last_seen_at)
    VALUES (?, 'item', ?, 'tag', ?, 'item_has_tag', ?, ?, datetime('now'), datetime('now'))
  `);

  for (const tagName of tagNames) {
    const cleanName = String(tagName || '').trim().slice(0, 80);
    if (!cleanName) continue;
    const slug = cleanName.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '') || generateId();
    
    // Look up existing tag by slug first to avoid orphaned references
    const existing = findTag.get(slug);
    const tagId = existing ? existing.id : generateId();
    
    if (!existing) {
      insertTag.run(tagId, slug, cleanName);
    }
    
    linkTag.run(itemId, tagId, 0.8);
    insertEdge.run(generateId(), itemId, tagId, 0.75, JSON.stringify([itemId]));
  }
}

function saveItemEntities(itemId, entities) {
  const db = getDB();
  if (!db || !entities?.length) return 0;

  const columns = db.prepare('PRAGMA table_info(entities)').all().map(c => c.name);
  const hasTextId = columns.includes('id') && String(db.prepare('PRAGMA table_info(entities)').all().find(c => c.name === 'id')?.type || '').toUpperCase() !== 'INTEGER';
  const hasMetadata = columns.includes('metadata');
  const hasDescription = columns.includes('description');
  const hasUpdatedAt = columns.includes('updated_at');
  const findEntity = db.prepare('SELECT id FROM entities WHERE LOWER(name) = LOWER(?) AND type = ? LIMIT 1');
  const insertEntity = (() => {
    const cols = [];
    const vals = [];
    if (hasTextId) { cols.push('id'); vals.push('@id'); }
    cols.push('name', 'type');
    vals.push('@name', '@type');
    if (hasDescription) { cols.push('description'); vals.push('@description'); }
    if (hasMetadata) { cols.push('metadata'); vals.push('@metadata'); }
    if (columns.includes('created_at')) { cols.push('created_at'); vals.push("datetime('now')"); }
    if (hasUpdatedAt) { cols.push('updated_at'); vals.push("datetime('now')"); }
    return db.prepare(`INSERT OR IGNORE INTO entities (${cols.join(', ')}) VALUES (${vals.join(', ')})`);
  })();
  const updateEntity = hasUpdatedAt
    ? db.prepare(`UPDATE entities SET updated_at = datetime('now') WHERE id = ?`)
    : null;
  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO graph_edges
      (id, from_type, from_id, to_type, to_id, edge_type, weight, evidence_item_ids, first_seen_at, last_seen_at)
    VALUES (?, 'item', ?, 'entity', ?, 'item_mentions_entity', ?, ?, datetime('now'), datetime('now'))
  `);

  const allowedTypes = new Set(['company', 'repo', 'paper', 'model', 'person', 'product', 'technology', 'topic', 'other']);
  let saved = 0;

  for (const entity of entities) {
    const name = String(entity?.name || '').trim().slice(0, 160);
    const type = allowedTypes.has(entity?.type) ? entity.type : 'other';
    if (!name || name.length < 2) continue;

    const existing = findEntity.get(name, type);
    let entityId = existing ? existing.id : (hasTextId ? generateId() : null);
    if (existing) {
      if (updateEntity) updateEntity.run(entityId);
    } else {
      const info = insertEntity.run({
        id: entityId,
        name,
        type,
        description: `Extracted from item ${itemId}`,
        metadata: JSON.stringify({ source: 'llm', prompt_version: getPromptVersion() }),
      });
      if (!entityId) entityId = String(info.lastInsertRowid);
    }
    insertEdge.run(generateId(), itemId, entityId, 0.85, JSON.stringify([itemId]));
    saved++;
  }

  return saved;
}

// ─── Topic Assignment ───────────────────────────────────────────────────

/**
 * Assign an item to relevant topics based on its extracted tags.
 * This is a simple keyword-based approach; Phase 4 will upgrade to embedding-based.
 */
function assignItemToTopics(itemId, tags, topicSlugs = []) {
  const db = getDB();
  if (!db) return 0;

  const allTopics = db.prepare('SELECT id, slug, name FROM topics').all();
  const insertTopic = db.prepare(`INSERT OR IGNORE INTO item_topics (item_id, topic_id, relevance, assigned_by) VALUES (?, ?, ?, 'llm')`);
  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO graph_edges (id, from_type, from_id, to_type, to_id, edge_type, weight, evidence_item_ids, first_seen_at, last_seen_at)
    VALUES (?, 'item', ?, 'topic', ?, 'item_belongs_topic', ?, ?, datetime('now'), datetime('now'))
  `);
  const updateTopicSeen = db.prepare(`UPDATE topics SET last_seen_at = datetime('now') WHERE id = ?`);

  let assigned = 0;
  const tagText = tags.join(' ').toLowerCase();
  const evidenceIds = JSON.stringify([itemId]);
  const exactSlugs = new Set((topicSlugs || []).map(s => String(s).toLowerCase()));

  for (const topic of allTopics) {
    if (exactSlugs.has(topic.slug)) {
      insertTopic.run(itemId, topic.id, 0.95);
      insertEdge.run(generateId(), itemId, topic.id, 0.95, evidenceIds);
      updateTopicSeen.run(topic.id);
      assigned++;
      continue;
    }

    if (!tags?.length) continue;
    const topicText = (topic.name + ' ' + topic.slug).toLowerCase();
    const words = topicText.split(/[-\s&]+/).filter(w => w.length > 2);

    let matches = 0;
    for (const word of words) {
      if (tagText.includes(word)) matches++;
    }

    if (matches >= 2) {
      const relevance = Math.min(matches / words.length, 1);
      insertTopic.run(itemId, topic.id, relevance);

      // Create graph edge: item → belongs_to → topic
      const edgeId = require('crypto').randomUUID();
      insertEdge.run(edgeId, itemId, topic.id, relevance, evidenceIds);

      updateTopicSeen.run(topic.id);
      assigned++;
    }
  }

  return assigned;
}

// ─── §8.2 Daily AI Digest ──────────────────────────────────────────────

/**
 * Enrich items that don't have AI summaries yet.
 * For each item: generate summary → extract tags → extract entities → assign topics.
 */
async function enrichItems(batchSize = 1600, opts = {}) {
  const {
    jobId,
    priorityOnly = false,
    resetAttempts = false,
    batchItemSize = Math.max(1, Math.min(parseInt(process.env.ENRICH_LLM_BATCH_ITEMS || (getEnrichProvider()?.isPool ? '4' : '20'), 10), 48)),
    batchConcurrency = Math.max(1, Math.min(parseInt(process.env.ENRICH_LLM_BATCH_CONCURRENCY || '8', 10), 32)),
  } = opts;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1600) throw new Error('Enrichment batchSize must be an integer from 1 to 1600');
  if (!Number.isInteger(batchItemSize) || batchItemSize < 1 || batchItemSize > 48) throw new Error('Invalid enrichment batchItemSize');
  if (!Number.isInteger(batchConcurrency) || batchConcurrency < 1 || batchConcurrency > 32) throw new Error('Invalid enrichment batchConcurrency');
  const context = taskContext(opts, jobId ? require('./jobs') : null);
  if (context.isCancelled()) return { enriched: 0, total: 0, cancelled: true, successful_item_ids: [] };
  const db = getDB();
  if (!db) {
    console.warn('  ⚠  No database available for enrichment.');
    return { enriched: 0, total: 0 };
  }
  if (!getProvider()) {
    console.warn('  ⚠  No LLM provider configured; enrichment skipped.');
    return { enriched: 0, total: 0, skipped: true, reason: 'no-llm-provider' };
  }

  // If resetAttempts is set (e.g. after a prompt upgrade), clear the poison-pill
  // counter so previously-failed items get another chance with the new prompt.
  if (resetAttempts) {
    const reset = db.prepare(`UPDATE information_items SET enrichment_attempts = 0 WHERE duplicate_of IS NULL AND NOT EXISTS (SELECT 1 FROM ai_summaries WHERE item_id = information_items.id AND ${VALID_SUMMARY_SQL})`);
    const info = reset.run();
    console.log(`  🔄 Reset enrichment_attempts for ${info.changes} unsummarized items`);
  }

  const updateProgress = (progress) => {
    if (!jobId) return;
    const { updateJobProgress } = require('./jobs');
    updateJobProgress(jobId, progress);
  };

  const priorityFilter = priorityOnly
    ? `AND s.slug IN (${ENRICH_PRIORITY_SOURCES.map(() => '?').join(', ')})`
    : '';
  const items = db.prepare(`
    SELECT i.*, s.label as source_label, s.slug as source_slug
    FROM information_items i
    JOIN sources s ON i.source_id = s.id
    WHERE i.duplicate_of IS NULL
      AND NOT EXISTS (SELECT 1 FROM ai_summaries WHERE item_id = i.id AND ${VALID_SUMMARY_SQL})
      AND COALESCE(i.enrichment_attempts, 0) < ?
      ${priorityFilter}
    ORDER BY ${ENRICH_PRIORITY_SQL} ASC,
             i.score DESC,
             COALESCE(i.published_at, i.created_at) DESC
    LIMIT ?
  `).all(MAX_ENRICH_ATTEMPTS, ...(priorityOnly ? ENRICH_PRIORITY_SOURCES : []), batchSize);

  if (items.length === 0) {
    console.log('  📡 No items to enrich.');
    return { enriched: 0, total: 0 };
  }

  // Mark these items as "attempted" so a failure doesn't retry forever.
  // Increment the attempt counter at selection time (not at failure time) so
  // even a crash mid-batch counts as an attempt.
  const markAttempted = db.prepare(`
    UPDATE information_items
    SET enrichment_attempts = COALESCE(enrichment_attempts, 0) + 1,
        last_enrich_attempt = datetime('now')
    WHERE id = ?
  `);
  const markTx = db.transaction(() => {
    for (const item of items) markAttempted.run(item.id);
  });
  markTx();

  console.log(`  📡 Enriching ${items.length} items with AI...`);
  updateProgress({
    phase: 'enriching',
    mode: 'llm-feed-card-graph',
    priority_sources: ENRICH_PRIORITY_SOURCES,
    priority_only: priorityOnly,
    processed: 0,
    enriched: 0,
    failed: 0,
    total: items.length,
  });

  const successfulItemIds = new Set();
  let enriched = 0;
  let failed = 0;
  let deferred = 0;
  let entitiesSaved = 0;
  let topicsAssigned = 0;
  const llmTaskAttempts = [];
  const aggregateCoverage = createCoverage(items.map(item => item.id));
  const updateItemTitleZh = db.prepare(`
    UPDATE information_items
    SET title_zh = ?, title_zh_status = ?
    WHERE id = ? AND (title_zh IS NULL OR title_zh = '' OR title_zh_status = 'pending')
  `);
  const insertSummary = db.prepare(`
    INSERT OR IGNORE INTO ai_summaries
      (id, item_id, model_provider, model_name, prompt_version, ai_title, ai_title_zh,
       one_liner, one_liner_zh, short_summary, short_summary_zh, deep_summary,
       key_points, key_points_zh, why_it_matters, why_it_matters_zh, audience, risks,
       opportunities, action_items, confidence, translation_status, source_grounding, llm_metadata)
    VALUES
      (@id, @item_id, @model_provider, @model_name, @prompt_version, @ai_title, @ai_title_zh,
       @one_liner, @one_liner_zh, @short_summary, @short_summary_zh, @deep_summary,
       @key_points, @key_points_zh, @why_it_matters, @why_it_matters_zh, @audience, @risks,
       @opportunities, @action_items, @confidence, @translation_status, @source_grounding, @llm_metadata)
  `);

  function writeResult(item, result) {
    context.check();
    if (!result?.summary) return { ok: false };
    let itemEntityCount = 0;
    let itemTopicCount = 0;
    const txn = db.transaction(() => {
      const validExisting = db.prepare(`SELECT 1 FROM ai_summaries WHERE item_id = ? AND ${VALID_SUMMARY_SQL} LIMIT 1`).get(item.id);
      if (validExisting) return;
      db.prepare(`DELETE FROM ai_summaries WHERE item_id = ? AND NOT (${VALID_SUMMARY_SQL})`).run(item.id);
      const inserted = insertSummary.run(result.summary);
      if (inserted.changes !== 1) throw new Error('Summary was not persisted');
      if (result.summary.ai_title_zh) {
        updateItemTitleZh.run(result.summary.ai_title_zh, result.summary.translation_status, item.id);
      }
      saveItemTags(item.id, result.tags);
      itemEntityCount = saveItemEntities(item.id, result.entities);
      itemTopicCount = assignItemToTopics(item.id, result.tags, result.topicSlugs);
    });
    txn();
    console.log(`  ✅ ${item.title?.slice(0, 60)}`);
    successfulItemIds.add(item.id);
    return { ok: true, item_id: item.id, entities: itemEntityCount, topics: itemTopicCount };
  }

  function absorbBatch(batchResults) {
    if (batchResults.task_stats) llmTaskAttempts.push(...batchResults.task_stats.attempts);
    if (batchResults.task_stats?.coverage) {
      mergeFinalCoverage(aggregateCoverage, {
        item_states: batchResults.task_stats.item_states,
        item_reasons: batchResults.task_stats.item_reasons,
      });
    }
  }

  function recordOutcome(result) {
    if (result?.cancelled) return;
    processed++;
    if (result?.ok) {
      enriched++;
      entitiesSaved += result.entities || 0;
      topicsAssigned += result.topics || 0;
    } else if (result?.deferred) {
      deferred++;
    } else {
      failed++;
    }
  }

  async function commitSuccesses(requestedItems, batchResults, results = []) {
    const byItemId = new Map(batchResults.map(result => [result.summary.item_id, result]));
    for (const item of requestedItems) {
      const result = byItemId.get(item.id);
      if (!result) continue;
      try {
        const outcome = await writeResult(item, result);
        results.push(outcome);
        markItem(aggregateCoverage, item.id, ITEM_STATE.SUCCESS, ITEM_REASON.SUCCEEDED);
        recordOutcome(outcome);
      } catch (err) {
        if (context.isCancelled()) {
          results.push({ cancelled: true });
          break;
        }
        console.error('  ❌ Failed to write enriched item ' + item.id?.slice(0, 8) + ':', err.message);
        markItem(aggregateCoverage, item.id, ITEM_STATE.EXPLICIT_FAILED, ITEM_REASON.PERSIST_FAILED, true);
        const outcome = { ok: false };
        results.push(outcome);
        recordOutcome(outcome);
      }
    }
    return results;
  }

  const chunks = [];
  for (let i = 0; i < items.length; i += batchItemSize) {
    chunks.push(items.slice(i, i + batchItemSize));
  }

  let chunkCursor = 0;
  let processed = 0;

  async function processChunk(chunk) {
    context.check();
    const batchResults = await generateItemSummariesBatch(chunk, context);
    absorbBatch(batchResults);
    const results = [];
    await commitSuccesses(chunk, batchResults, results);
    if (context.isCancelled()) return;

    const byItemId = new Map(batchResults.map(result => [result.summary.item_id, result]));
    const compensable = [];
    for (const item of chunk) {
      if (byItemId.has(item.id)) continue;
      const state = batchResults.task_stats?.item_states?.[item.id];
      const reason = batchResults.task_stats?.item_reasons?.[item.id];
      // These are deterministic skips, not model failures. Leave them out of
      // the failed counter so the stage result matches task coverage.
      if (state === ITEM_STATE.DEFERRED && (reason === ITEM_REASON.GATE_SKIPPED || reason === ITEM_REASON.NO_PROVIDER)) {
        processed++;
        deferred++;
        continue;
      }
      if (state === ITEM_STATE.EXPLICIT_FAILED) {
        const outcome = { ok: false };
        results.push(outcome);
        recordOutcome(outcome);
      } else if (
        getEnrichProvider()?.isPool &&
        state === ITEM_STATE.DEFERRED &&
        [ITEM_REASON.UNCOVERED_IN_RESPONSE, ITEM_REASON.REPAIR_DEFERRED].includes(reason)
      ) {
        compensable.push(item);
      } else if (!getEnrichProvider()?.isPool) {
        const fallbackResults = await generateItemSummariesBatch([item], context);
        absorbBatch(fallbackResults);
        if (context.isCancelled()) return;
        const fallbackOutcomes = [];
        await commitSuccesses([item], fallbackResults, fallbackOutcomes);
        if (!fallbackOutcomes.length) {
          const outcome = { ok: false };
          results.push(outcome);
          recordOutcome(outcome);
        }
      } else {
        const outcome = { ok: false, deferred: true, reason: reason || 'unknown' };
        results.push(outcome);
        recordOutcome(outcome);
      }
    }

    if (compensable.length) {
      const compensation = await generateItemSummariesBatch(compensable, context);
      absorbBatch(compensation);
      if (context.isCancelled()) return;
      await commitSuccesses(compensable, compensation, results);
      const compensatedIds = new Set(compensation.map(result => result.summary.item_id));
      for (let index = 0; index < compensable.length; index++) {
        if (compensatedIds.has(compensable[index].id)) continue;
        const compensationState = compensation.task_stats?.item_states?.[compensable[index].id];
        const compensationReason = compensation.task_stats?.item_reasons?.[compensable[index].id];
        const outcome = compensationState === ITEM_STATE.EXPLICIT_FAILED
          ? { ok: false }
          : { ok: false, deferred: true, reason: compensationReason || 'unknown' };
        results.push(outcome);
        recordOutcome(outcome);
      }
    }

    if (context.isCancelled()) return;

    updateProgress({
      phase: 'enriching',
      mode: 'llm-feed-card-graph-batch',
      priority_sources: ENRICH_PRIORITY_SOURCES,
      priority_only: priorityOnly,
      processed: Math.min(processed, items.length),
      enriched,
      failed,
      deferred,
      entities: entitiesSaved,
      topics: topicsAssigned,
      total: items.length,
      batch_items: batchItemSize,
      workers: Math.min(batchConcurrency, chunks.length),
      llm_attempts: llmTaskAttempts.length,
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
    Array.from({ length: Math.min(batchConcurrency, chunks.length) }, () => worker())
  );

  if (context.isCancelled()) {
    console.log(`  ⛔ enrichItems cancelled at ${processed}/${items.length}`);
    return { enriched, failed, deferred, successful_item_ids: [...successfulItemIds], entities: entitiesSaved, topics: topicsAssigned, total: items.length, cancelled: true };
  }

  const coverage = finalizeCoverage(aggregateCoverage, 'enrichItems');
  if (coverage.total !== items.length || coverage.success !== enriched) {
    throw new Error('LLM_COVERAGE_BROKEN(enrichItems): final coverage does not match persisted enrich results');
  }
  const taskStats = withTaskStats([], llmTaskAttempts, aggregateCoverage).task_stats;

  // Auto-trigger signal scoring after enrichment
  if (process.env.ENABLE_SIGNAL_SCORING !== 'false' && enriched > 0) {
    try {
      const { scoreSignals } = require('./signals');
      const enrichedItems = items.filter(item => successfulItemIds.has(item.id));
      if (enrichedItems.length > 0) {
        updateProgress({ phase: 'scoring', processed, enriched, failed, entities: entitiesSaved, topics: topicsAssigned, total: items.length });
        await scoreSignals(enrichedItems, { jobId, signal: context.signal });
        console.log(`  📡 Signal scoring complete for ${enrichedItems.length} items`);
      }
    } catch (err) {
      console.warn(`  ⚠  Signal scoring failed (non-fatal): ${err.message}`);
    }
  }

  if (context.isCancelled()) return { enriched, failed, deferred, successful_item_ids: [...successfulItemIds], total: items.length, cancelled: true };
  console.log(`  ✅ Enriched ${enriched}/${items.length} items. Entities: ${entitiesSaved}, topics: ${topicsAssigned}.`);
  return {
    enriched,
    failed,
    deferred,
    successful_item_ids: [...successfulItemIds],
    entities: entitiesSaved,
    topics: topicsAssigned,
    total: items.length,
    task_stats: taskStats,
    batch_items: batchItemSize,
    workers: Math.min(batchConcurrency, chunks.length),
    priority_sources: ENRICH_PRIORITY_SOURCES,
    priority_only: priorityOnly,
  };
}

module.exports = {
  generateDailyDigest,
  enrichItems,
  generateItemSummary,
  generateItemSummariesBatch,
  createTitleOnlySummary,
  saveItemTags,
  saveItemEntities,
  assignItemToTopics,
};
