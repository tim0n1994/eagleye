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

const { getProvider, getProviderInfo, getEnrichProvider, extractJSON } = require('./llm-provider');
const { getDB } = require('../db/connection');
const { generateDailyDigest } = require('./llm-digest');
const { _isOverloadError } = require('./llm-shared');
// Circular dependency: jobs.js imports enrichItems/generateDailyDigest from here at top level.
// Keep isJobCancelled as a lazy require to avoid the cycle breaking exports.
const crypto = require('crypto');

function isJobCancelled(jobId) {
  // Lazy require to break the circular dependency with jobs.js
  const { isJobCancelled: _isJobCancelled } = require('./jobs');
  return _isJobCancelled(jobId);
}

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

function createSummaryResult(item, data) {
  const info = getProviderInfo();
  const summaryRecord = {
    id: generateId(),
    item_id: item.id,
    model_provider: info.provider,
    model_name: info.model,
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

/**
 * Generate an AI summary for a single item following §8.1.
 * Returns the summary record to be inserted into ai_summaries table,
 * plus extracted tags and entities.
 */
async function generateItemSummary(item) {
  const provider = getEnrichProvider();
  if (!provider) return null;

  const prompt = ITEM_SUMMARY_PROMPT
    .replace('{{source_label}}', item.source_label || '')
    .replace('{{source_slug}}', item.source_slug || '')
    .replace('{{title}}', (item.title || '').slice(0, 500))
    .replace('{{canonical_url}}', item.canonical_url || '')
    .replace('{{published_at}}', item.published_at || '')
    .replace('{{source_payload}}', typeof item.source_payload === 'string' ? item.source_payload.slice(0, 400) : JSON.stringify(item.source_payload || {}).slice(0, 400))
    .replace('{{content_excerpt}}', (item.original_summary || item.content_text || '').slice(0, 700))
    .replace('{{allowed_topics}}', JSON.stringify(getAllowedTopicsForPrompt()).slice(0, 1600));

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const text = await provider.call(prompt, { temperature: 0.1, maxTokens: 1100 });
      if (!text) {
        if (attempt < maxRetries) {
          await _llmBackoff(attempt, 'empty');
          continue;
        }
        return null;
      }

      const data = extractJSON(text);
      if (!data) {
        console.warn(`  ⚠  LLM returned unparseable JSON for item ${item.id?.slice(0, 8)}`);
        return null;
      }

      return createSummaryResult(item, data);
    } catch (err) {
      // 1301 内容安全审核：不可恢复，立即跳过
      if (/1301|invalid_request_error.*安全|敏感内容/i.test(err.message)) {
        console.log(`  ⏭  Summary skipped (${item.id?.slice(0, 8)}): content filtered by safety check`);
        return null;
      }
      if (attempt < maxRetries) {
        await _llmBackoff(attempt, err.message);
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
6. 每条输出中文标题、一句话判断、1句短摘要、2-3个要点、topic_slugs、tags、entities。
7. short_summary_zh 不超过 60 个中文字。
8. topic_slugs 只能从 allowed_topics 选择，最多3个。
9. tags 非常重要，用于构建知识图谱！必须提供 4-6 个中文短标签，粒度要细。优先：具体技术名词、具体产品名、具体公司名、具体能力方向。严禁英文、拼音、混合语言。
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

async function generateItemSummariesBatch(items) {
  const provider = getEnrichProvider();
  if (!provider || !items?.length) return [];

  const compactItems = items.map(item => ({
    id: item.id,
    source: item.source_label || item.source_slug || '',
    title: String(item.title || '').slice(0, 240),
    url: String(item.canonical_url || '').slice(0, 260),
    summary: String(item.original_summary || item.content_text || '').replace(/\s+/g, ' ').slice(0, 420),
    payload: String(item.source_payload || '').replace(/\s+/g, ' ').slice(0, 260),
  }));

  const prompt = BATCH_ITEM_SUMMARY_PROMPT
    .replace('{{allowed_topics}}', JSON.stringify(getAllowedTopicsForPrompt()).slice(0, 1400))
    .replace('{{items}}', JSON.stringify(compactItems));

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const text = await provider.call(prompt, { temperature: 0.1, maxTokens: Math.min(8192, 600 + items.length * 360) });
      const data = extractJSON(text);
      if (Array.isArray(data)) {
        const byId = new Map(items.map(item => [item.id, item]));
        return data
          .filter(row => row && byId.has(row.id))
          .map(row => createSummaryResult(byId.get(row.id), row));
      }
      console.warn(`  ⚠  Batch summary: LLM returned ${data ? typeof data : 'null'} (attempt ${attempt}/${3})`);
      if (attempt < 3) await _llmBackoff(attempt, 'unparseable');
    } catch (err) {
      // 1301 内容安全审核：不可恢复，跳过不重试
      if (/1301|invalid_request_error.*安全|敏感内容/i.test(err.message)) {
        console.warn(`  ⏭  Batch summary skipped (${items.length} items): content filtered by safety check`);
        return [];
      }
      console.warn(`  ⚠  Batch summary attempt ${attempt}/${3} failed (${items.length} items): ${err.message}`);
      if (attempt < 3) await _llmBackoff(attempt, err.message);
    }
  }
  console.warn(`  ⚠  Batch summary exhausted retries for ${items.length} items, falling back to single-item enrichment`);
  return [];
}

/**
 * Backoff helper: model overload (529/1305) needs much longer waits than
 * generic errors — the model capacity has to recover. Returns the ms waited.
 */

async function _llmBackoff(attempt, errMsg) {
  // 529 模型过载：需要长退避（10s/20s/30s），让它恢复容量
  const base = _isOverloadError(errMsg) ? 10000 : 2000;
  const ms = Math.min(30000, base * attempt);
  await new Promise(r => setTimeout(r, ms));
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
    batchItemSize = Math.max(1, Math.min(parseInt(process.env.ENRICH_LLM_BATCH_ITEMS || '20', 10), 48)),
    batchConcurrency = Math.max(1, Math.min(parseInt(process.env.ENRICH_LLM_BATCH_CONCURRENCY || '8', 10), 32)),
  } = opts;
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
    const reset = db.prepare(`UPDATE information_items SET enrichment_attempts = 0 WHERE id NOT IN (SELECT item_id FROM ai_summaries)`);
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
    WHERE i.id NOT IN (SELECT item_id FROM ai_summaries)
      AND i.enrichment_attempts < ?
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
    SET enrichment_attempts = enrichment_attempts + 1,
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

  let enriched = 0;
  let failed = 0;
  let entitiesSaved = 0;
  let topicsAssigned = 0;
  const updateItemTitleZh = db.prepare(`
    UPDATE information_items
    SET title_zh = ?, title_zh_status = 'translated'
    WHERE id = ? AND (title_zh IS NULL OR title_zh = '' OR title_zh_status = 'pending')
  `);
  const insertSummary = db.prepare(`
    INSERT OR IGNORE INTO ai_summaries
      (id, item_id, model_provider, model_name, prompt_version, ai_title, ai_title_zh,
       one_liner, one_liner_zh, short_summary, short_summary_zh, deep_summary,
       key_points, key_points_zh, why_it_matters, why_it_matters_zh, audience, risks,
       opportunities, action_items, confidence, translation_status, source_grounding)
    VALUES
      (@id, @item_id, @model_provider, @model_name, @prompt_version, @ai_title, @ai_title_zh,
       @one_liner, @one_liner_zh, @short_summary, @short_summary_zh, @deep_summary,
       @key_points, @key_points_zh, @why_it_matters, @why_it_matters_zh, @audience, @risks,
       @opportunities, @action_items, @confidence, @translation_status, @source_grounding)
  `);

  function writeResult(item, result) {
    if (!result?.summary) return { ok: false };
    let itemEntityCount = 0;
    let itemTopicCount = 0;
    const txn = db.transaction(() => {
      insertSummary.run(result.summary);
      if (result.summary.ai_title_zh) {
        updateItemTitleZh.run(result.summary.ai_title_zh, item.id);
      }
      saveItemTags(item.id, result.tags);
      itemEntityCount = saveItemEntities(item.id, result.entities);
      itemTopicCount = assignItemToTopics(item.id, result.tags, result.topicSlugs);
    });
    txn();
    console.log(`  ✅ ${item.title?.slice(0, 60)}`);
    return { ok: true, entities: itemEntityCount, topics: itemTopicCount };
  }

  async function processItemFallback(item) {
    try {
      const result = await generateItemSummary(item);
      return writeResult(item, result);
    } catch (err) {
      console.error(`  ❌ Failed to enrich ${item.id?.slice(0, 8)}:`, err.message);
      return { ok: false };
    }
  }

  const chunks = [];
  for (let i = 0; i < items.length; i += batchItemSize) {
    chunks.push(items.slice(i, i + batchItemSize));
  }

  let chunkCursor = 0;
  let processed = 0;

  async function processChunk(chunk) {
    const batchResults = await generateItemSummariesBatch(chunk);
    const byItemId = new Map(batchResults.map(result => [result.summary.item_id, result]));
    const results = [];

    for (const item of chunk) {
      if (byItemId.has(item.id)) {
        try {
          results.push(writeResult(item, byItemId.get(item.id)));
        } catch (err) {
          console.error(`  ❌ Failed to write enriched item ${item.id?.slice(0, 8)}:`, err.message);
          results.push({ ok: false });
        }
      } else {
        results.push(await processItemFallback(item));
      }
    }

    let chunkEnriched = 0;
    let chunkFailed = 0;
    let chunkEntities = 0;
    let chunkTopics = 0;

    for (const result of results) {
      if (result?.ok) {
        chunkEnriched++;
        chunkEntities += result.entities || 0;
        chunkTopics += result.topics || 0;
      } else {
        chunkFailed++;
      }
    }

    enriched += chunkEnriched;
    failed += chunkFailed;
    entitiesSaved += chunkEntities;
    topicsAssigned += chunkTopics;
    processed += chunk.length;

    updateProgress({
      phase: 'enriching',
      mode: 'llm-feed-card-graph-batch',
      priority_sources: ENRICH_PRIORITY_SOURCES,
      priority_only: priorityOnly,
      processed: Math.min(processed, items.length),
      enriched,
      failed,
      entities: entitiesSaved,
      topics: topicsAssigned,
      total: items.length,
      batch_items: batchItemSize,
      workers: Math.min(batchConcurrency, chunks.length),
    });
  }

  async function worker() {
    while (true) {
      if (jobId && isJobCancelled(jobId)) return;
      const index = chunkCursor;
      if (index >= chunks.length) return;
      chunkCursor++;
      await processChunk(chunks[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(batchConcurrency, chunks.length) }, () => worker())
  );

  if (jobId && isJobCancelled(jobId)) {
    console.log(`  ⛔ enrichItems cancelled at ${processed}/${items.length}`);
    return { enriched, failed, entities: entitiesSaved, topics: topicsAssigned, total: items.length, cancelled: true };
  }

  // Auto-trigger signal scoring after enrichment
  if (process.env.ENABLE_SIGNAL_SCORING !== 'false' && enriched > 0) {
    try {
      const { scoreSignals } = require('./signals');
      const enrichedItems = items.slice(0, processed).filter((_, i) => i < enriched);
      if (enrichedItems.length > 0) {
        updateProgress({ phase: 'scoring', processed, enriched, failed, entities: entitiesSaved, topics: topicsAssigned, total: items.length });
        await scoreSignals(enrichedItems, { jobId });
        console.log(`  📡 Signal scoring complete for ${enrichedItems.length} items`);
      }
    } catch (err) {
      console.warn(`  ⚠  Signal scoring failed (non-fatal): ${err.message}`);
    }
  }

  console.log(`  ✅ Enriched ${enriched}/${items.length} items. Entities: ${entitiesSaved}, topics: ${topicsAssigned}.`);
  return {
    enriched,
    failed,
    entities: entitiesSaved,
    topics: topicsAssigned,
    total: items.length,
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
  saveItemTags,
  saveItemEntities,
  assignItemToTopics,
};
