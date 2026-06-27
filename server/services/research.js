/**
 * Eagleye — Deep Research Service
 *
 * Implements architecture doc §9: Deep Research Button Specification.
 *
 * - §9.1: Per-item deep research with full prompt template
 * - §9.2: Topic-level deep research
 *
 * Each research run creates a research_reports record, collects context
 * (item, AI summary, related items, entities, topics), then calls the LLM.
 * Results are persisted as Markdown in the DB.
 */

const { getProvider, getProviderInfo } = require('./llm-provider');
const { getDB } = require('../db/connection');
const crypto = require('crypto');

function generateId() {
  return crypto.randomUUID();
}

// ─── §9.1 Per-Item Deep Research Prompt ─────────────────────────────────

const ITEM_RESEARCH_PROMPT = `/no_think
你是 Eagleye 的中文深度研究员。请围绕下面这条信息流做一次严谨、克制、可追溯的背景研究。你的任务不是复述标题，而是解释这条信号在“当前信息源上下文”和“更大技术/产业背景”里的真实含义。

研究对象：
- 卡片标题：{{title}}
- 来源：{{source_label}}
- 来源 slug：{{source_slug}}
- URL：{{canonical_url}}
- 发布时间：{{published_at}}
- LLM 一句话判断：{{one_liner}}
- LLM 短摘要：{{short_summary}}
- LLM 要点：{{key_points}}
- LLM 为什么值得关注：{{why_it_matters}}
- 原始信息：{{content_text_or_excerpt}}
- 相关 topic：{{topics}}
- 相关实体：{{entities}}
- 当前信息源近期相关条目：{{same_source_items}}
- 相关 topic 近期条目：{{same_topic_items}}

研究目标：
1. 先解释这条信息到底在说什么，不要停留在标题层面。
2. 结合“当前信息源近期相关条目”，判断它是孤立噪音还是连续信号。
3. 追溯背景：这个方向此前发生过什么，为什么现在出现。
4. 判断影响：对开发者、产品经理、创业者、研究者、投资/产业链分别意味着什么。
5. 给出反面观点、噪音来源和不确定性。
6. 列出接下来应该继续跟踪的关键词、项目、论文、公司、指标或事件。
7. 给出可执行行动建议。

输出 Markdown：
# 研究结论
## 卡片速读
## 一句话结论
## 这件事到底是什么
## 当前信息源里的连续信号
## 背景脉络
## 关键影响
## 反面观点与不确定性
## 后续观察清单
## 行动建议
## 证据与推理边界

规则：
- 每一节都尽量区分：[原文] [同源条目] [相关条目] [推理]。
- 不要编造引用、融资额、时间线或公司动作。
- 如果证据不足，要写明证据不足。
- 语言保持中文、克制、信息密度高，避免空泛行业黑话。`;

const ITEM_RESEARCH_CHAT_PROMPT = `/no_think
你是 Eagleye 研究工作台中的中文研究助手。用户正在围绕一条具体信息流继续追问，你必须严格基于已有研究报告、原始信号、AI 卡片和最近对话来回答。

你收到的上下文包括：
1. 当前信号原文与元数据
2. 这条信号的中文知识卡片
3. 已生成的深度研究报告
4. 当前信息源近期相关条目
5. 同 topic 近期相关条目
6. 最近几轮用户追问

回答要求：
1. 只用中文。
2. 直接回答用户问题，不要复述整份报告。
3. 如果问题需要背景，先给结论，再补 2-4 条关键依据。
4. 明确区分哪些是 [原文]、[研究报告]、[同源条目]、[相关条目]、[推理]。
5. 不要编造外部事实、引用、融资、时间线或数据。
6. 如果现有上下文不足，直接说“现有上下文不足，需要补抓原文或外部证据”。
7. 回答控制在高信息密度的 Markdown 内，优先使用短段落和简短列表。

上下文：
{{context}}

最近对话：
{{history}}

用户问题：
{{question}}
`;

function stringifyList(items, formatter) {
  if (!items?.length) return '无';
  return items.map(formatter).join('\n');
}

function parseKeyPoints(summary) {
  try {
    const parsed = JSON.parse(summary?.key_points_zh || summary?.key_points || '[]');
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.slice(0, 5).join('；');
    }
  } catch {}
  return '无';
}

function getDisplayTitle(item, summary) {
  return (summary?.ai_title_zh || item?.title_zh || summary?.one_liner_zh || item?.title || '').slice(0, 500);
}

function loadResearchContext(itemId) {
  const db = getDB();
  if (!db) return null;

  const item = db.prepare(`
    SELECT i.*, s.label as source_label, s.slug as source_slug
    FROM information_items i
    JOIN sources s ON i.source_id = s.id
    WHERE i.id = ?
  `).get(itemId);
  if (!item) return null;

  const summary = db.prepare('SELECT * FROM ai_summaries WHERE item_id = ?').get(itemId) || null;
  const topics = db.prepare(`
    SELECT t.id, t.name, t.slug, it.relevance
    FROM item_topics it
    JOIN topics t ON it.topic_id = t.id
    WHERE it.item_id = ?
    ORDER BY it.relevance DESC
  `).all(itemId);
  const entities = db.prepare(`
    SELECT e.name, e.type
    FROM graph_edges ge
    JOIN entities e ON ge.to_id = e.id
    WHERE ge.from_id = ? AND ge.edge_type = 'item_mentions_entity'
  `).all(itemId);
  const tags = db.prepare(`
    SELECT t.name
    FROM item_tags it
    JOIN tags t ON t.id = it.tag_id
    WHERE it.item_id = ?
    ORDER BY it.confidence DESC, t.name ASC
    LIMIT 12
  `).all(itemId);
  const sameSourceItems = db.prepare(`
    SELECT i.id, i.title, i.title_zh, i.published_at, s.label as source_label
    FROM information_items i
    JOIN sources s ON i.source_id = s.id
    WHERE i.id != ? AND i.source_id = ?
      AND (i.published_at >= date('now', '-90 days') OR i.created_at >= date('now', '-90 days'))
    ORDER BY i.published_at DESC, i.score DESC
    LIMIT 12
  `).all(itemId, item.source_id);

  const topicIds = topics.map(t => t.id).filter(Boolean).slice(0, 4);
  let sameTopicItems = [];
  if (topicIds.length > 0) {
    const placeholders = topicIds.map(() => '?').join(', ');
    sameTopicItems = db.prepare(`
      SELECT DISTINCT i.id, i.title, i.title_zh, i.published_at, s.label as source_label
      FROM item_topics it
      JOIN information_items i ON i.id = it.item_id
      JOIN sources s ON s.id = i.source_id
      WHERE it.topic_id IN (${placeholders}) AND i.id != ?
      ORDER BY i.published_at DESC, i.score DESC
      LIMIT 10
    `).all(...topicIds, itemId);
  }

  const existingReport = db.prepare(`
    SELECT *
    FROM research_reports
    WHERE item_id = ? AND status = 'completed'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(itemId) || null;

  return { item, summary, topics, entities, tags, sameSourceItems, sameTopicItems, existingReport };
}

function buildResearchPromptContext(context) {
  const { item, summary, topics, entities, sameSourceItems, sameTopicItems } = context;
  return {
    contentExcerpt: (item.original_summary || item.content_text || '').slice(0, 2000),
    displayTitle: getDisplayTitle(item, summary),
    shortSummary: (summary?.short_summary_zh || summary?.short_summary || summary?.one_liner_zh || summary?.one_liner || '').slice(0, 500),
    oneLiner: (summary?.one_liner_zh || summary?.one_liner || '').slice(0, 240),
    keyPoints: parseKeyPoints(summary),
    whyItMatters: (summary?.why_it_matters_zh || summary?.why_it_matters || '').slice(0, 500),
    topicNames: topics.map(t => `${t.name} (${(t.relevance || 0).toFixed(2)})`).join(', ') || '无',
    entityNames: entities.map(e => `${e.name} (${e.type})`).join(', ') || '无',
    sameSourceText: stringifyList(sameSourceItems, r => `- ${(r.title_zh || r.title || '').slice(0, 120)} (${r.source_label}, ${r.published_at || ''})`),
    sameTopicText: stringifyList(sameTopicItems, r => `- ${(r.title_zh || r.title || '').slice(0, 120)} (${r.source_label}, ${r.published_at || ''})`),
  };
}

// ─── Research Functions ─────────────────────────────────────────────────

/**
 * Generate a deep research report for a single item (§9.1).
 * Collects context: item, AI summary, topics, entities, related items.
 */
async function generateItemResearch(itemId) {
  const db = getDB();
  if (!db) return { error: 'Database not available' };

  const provider = getProvider();
  if (!provider) return { error: 'No LLM provider configured' };
  const context = loadResearchContext(itemId);
  if (!context?.item) return { error: 'Item not found' };
  const { item } = context;
  const promptContext = buildResearchPromptContext(context);

  const prompt = ITEM_RESEARCH_PROMPT
    .replace('{{title}}', promptContext.displayTitle)
    .replace('{{source_label}}', item.source_label || '')
    .replace('{{source_slug}}', item.source_slug || '')
    .replace('{{canonical_url}}', item.canonical_url || '')
    .replace('{{published_at}}', item.published_at || item.created_at || '')
    .replace('{{one_liner}}', promptContext.oneLiner)
    .replace('{{short_summary}}', promptContext.shortSummary)
    .replace('{{key_points}}', promptContext.keyPoints)
    .replace('{{why_it_matters}}', promptContext.whyItMatters)
    .replace('{{content_text_or_excerpt}}', promptContext.contentExcerpt)
    .replace('{{topics}}', promptContext.topicNames)
    .replace('{{entities}}', promptContext.entityNames)
    .replace('{{same_source_items}}', promptContext.sameSourceText)
    .replace('{{same_topic_items}}', promptContext.sameTopicText);

  // Create research report record
  const reportId = generateId();
  db.prepare(`
    INSERT INTO research_reports (id, item_id, status, prompt, model_provider)
    VALUES (?, ?, 'running', ?, ?)
  `).run(reportId, itemId, prompt, provider.name);

  try {
    const text = await provider.call(prompt, { temperature: 0.2, maxTokens: 8192 });
    if (!text) throw new Error('LLM returned empty response');

    const info = getProviderInfo();

    db.prepare(`
      UPDATE research_reports
      SET status = 'completed', report_markdown = ?, model_name = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(text, info.model, reportId);

    return { id: reportId, report: text };
  } catch (err) {
    db.prepare(`
      UPDATE research_reports SET status = 'failed', error = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(err.message, reportId);

    return { id: reportId, error: err.message };
  }
}

async function answerItemResearchChat(itemId, message, history = []) {
  const provider = getProvider();
  if (!provider) return { error: 'No LLM provider configured' };
  const context = loadResearchContext(itemId);
  if (!context?.item) return { error: 'Item not found' };

  const question = String(message || '').trim();
  if (!question) return { error: 'message required' };

  const promptContext = buildResearchPromptContext(context);
  const historyText = (Array.isArray(history) ? history : [])
    .filter(turn => turn && typeof turn.role === 'string' && typeof turn.content === 'string')
    .slice(-8)
    .map(turn => `${turn.role === 'assistant' ? '助手' : '用户'}: ${turn.content.trim().slice(0, 800)}`)
    .join('\n') || '无';

  const contextBlock = [
    `标题: ${promptContext.displayTitle}`,
    `来源: ${context.item.source_label} (${context.item.source_slug})`,
    `URL: ${context.item.canonical_url || ''}`,
    `发布时间: ${context.item.published_at || context.item.created_at || ''}`,
    `LLM 一句话判断: ${promptContext.oneLiner}`,
    `LLM 短摘要: ${promptContext.shortSummary}`,
    `LLM 要点: ${promptContext.keyPoints}`,
    `LLM 为什么值得关注: ${promptContext.whyItMatters}`,
    `标签: ${context.tags.map(t => t.name).join(', ') || '无'}`,
    `Topics: ${promptContext.topicNames}`,
    `实体: ${promptContext.entityNames}`,
    `原始信息: ${promptContext.contentExcerpt}`,
    `当前信息源近期相关条目:\n${promptContext.sameSourceText}`,
    `相关 topic 近期条目:\n${promptContext.sameTopicText}`,
    `已生成研究报告:\n${(context.existingReport?.report_markdown || '无').slice(0, 9000)}`,
  ].join('\n\n');

  const prompt = ITEM_RESEARCH_CHAT_PROMPT
    .replace('{{context}}', contextBlock)
    .replace('{{history}}', historyText)
    .replace('{{question}}', question.slice(0, 2000));

  try {
    const answer = await provider.call(prompt, { temperature: 0.2, maxTokens: 2400 });
    if (!answer) throw new Error('LLM returned empty response');
    const info = getProviderInfo();
    return {
      answer,
      model_provider: info.provider,
      model_name: info.model,
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Get a research report by ID.
 */
function getResearchReport(reportId) {
  const db = getDB();
  if (!db) return null;
  return db.prepare('SELECT * FROM research_reports WHERE id = ?').get(reportId);
}

module.exports = {
  generateItemResearch,
  getResearchReport,
  loadResearchContext,
  answerItemResearchChat,
};
