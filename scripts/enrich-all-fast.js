#!/usr/bin/env node
/**
 * Eagleye — Fast Mass AI Summary Generation
 *
 * Uses batched parallel LLM calls via the LLM provider.
 * Processes up to 5 items concurrently per batch.
 */

require('dotenv').config();
const { getDB } = require('../server/db/connection');
const { getProvider, getProviderInfo, extractJSON } = require('../server/services/llm-provider');

const BATCH_SIZE = 5;       // concurrent items per wave
const MAX_WAVES = 500;      // max iterations before stopping
const ITEM_SUMMARY_PROMPT = `你是 Eagleye 的技术情报分析员。请基于以下原始信息，生成可信、克制、可追溯的中文信息卡。

要求：
1. 不要编造原文没有的信息。
2. 如果信息不足，明确写"不确定"。
3. 保留技术名词、公司名、模型名、项目名。
4. 输出 JSON，不要输出 Markdown。
5. 总结要帮助开发者判断是否值得点开、收藏、研究或部署。

输入：
source: {{source_label}}
title: {{title}}
url: {{canonical_url}}
published_at: {{published_at}}
source_payload: {{source_payload}}
content_excerpt: {{content_excerpt}}

输出 JSON schema：
{
  "ai_title": "更清晰但不夸张的中文标题",
  "one_liner": "一句话判断",
  "short_summary": "80-160 字中文摘要",
  "key_points": ["3-5 条要点"],
  "why_it_matters": "为什么重要",
  "audience": ["适合哪些人"],
  "risks": ["风险或不确定性"],
  "opportunities": ["可行动机会"],
  "suggested_tags": ["标签"],
  "entities": [{"name": "实体名", "type": "company|repo|paper|model|person|product|technology|other"}],
  "confidence": 0.0
}`;

const db = getDB();
if (!db) { console.error('DB unavailable!'); process.exit(1); }

const provider = getProvider();
if (!provider) { console.error('No LLM provider configured!'); process.exit(1); }

const info = getProviderInfo();
console.log(`Provider: ${info.provider} | Model: ${info.model}`);

const getPromptVersion = () => 'v2.0-phase2';

async function generateSummary(item) {
  const prompt = ITEM_SUMMARY_PROMPT
    .replace('{{source_label}}', item.source_label || '')
    .replace('{{title}}', (item.title || '').slice(0, 500))
    .replace('{{canonical_url}}', item.canonical_url || '')
    .replace('{{published_at}}', item.published_at || '')
    .replace('{{source_payload}}', JSON.stringify(item.source_payload || {}).slice(0, 500))
    .replace('{{content_excerpt}}', (item.original_summary || item.content_text || '').slice(0, 800));

  try {
    const text = await provider.call(prompt, { temperature: 0.2, maxTokens: 1024 });
    if (!text) return null;
    const data = extractJSON(text);
    if (!data) return null;
    return {
      summary: {
        id: require('crypto').randomUUID(),
        item_id: item.id,
        model_provider: info.provider,
        model_name: info.model,
        prompt_version: getPromptVersion(),
        ai_title: data.ai_title || '',
        one_liner: data.one_liner || '',
        short_summary: data.short_summary || '',
        deep_summary: null,
        key_points: JSON.stringify(data.key_points || []),
        why_it_matters: data.why_it_matters || '',
        audience: JSON.stringify(data.audience || []),
        risks: JSON.stringify(data.risks || []),
        opportunities: JSON.stringify(data.opportunities || []),
        action_items: JSON.stringify(data.action_items || []),
        confidence: data.confidence ?? null,
        source_grounding: JSON.stringify({
          item_id: item.id, source_label: item.source_label,
          canonical_url: item.canonical_url, prompt_version: getPromptVersion(),
        }),
      },
      tags: data.suggested_tags || [],
    };
  } catch (err) {
    console.error(`  ❌ Failed for item ${item.id?.slice(0,8)}:`, err.message);
    return null;
  }
}

async function enrichWave() {
  const items = db.prepare(`
    SELECT i.*, s.label as source_label, s.slug as source_slug
    FROM information_items i JOIN sources s ON i.source_id = s.id
    WHERE i.id NOT IN (SELECT item_id FROM ai_summaries)
    ORDER BY i.score DESC LIMIT ?
  `).all(BATCH_SIZE);

  if (items.length === 0) return 0;

  const results = await Promise.allSettled(items.map(item => generateSummary(item)));
  
  let enriched = 0;
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value) return;
    const { summary, tags } = r.value;
    
    // Save summary
    db.prepare(`INSERT OR IGNORE INTO ai_summaries
      (id, item_id, model_provider, model_name, prompt_version, ai_title, one_liner,
       short_summary, deep_summary, key_points, why_it_matters, audience, risks,
       opportunities, action_items, confidence, source_grounding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      summary.id, summary.item_id, summary.model_provider, summary.model_name, summary.prompt_version,
      summary.ai_title, summary.one_liner, summary.short_summary, summary.deep_summary,
      summary.key_points, summary.why_it_matters, summary.audience, summary.risks,
      summary.opportunities, summary.action_items, summary.confidence, summary.source_grounding
    );

    // Save tags (simplified)
    tags.forEach(tagName => {
      const slug = tagName.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');
      if (!slug) return;
      const existing = db.prepare('SELECT id FROM tags WHERE slug = ?').get(slug);
      const tagId = existing?.id || require('crypto').randomUUID();
      if (!existing) db.prepare(`INSERT OR IGNORE INTO tags (id, slug, name, type) VALUES (?, ?, ?, 'llm-extracted')`).run(tagId, slug, tagName);
      db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence) VALUES (?, ?, 0.8)').run(items[i].id, tagId);
    });

    enriched++;
    console.log(`  ✅ ${items[i].title?.slice(0, 60)}`);
  });

  return enriched;
}

async function run() {
  const startTime = Date.now();
  let totalEnriched = 0;
  let wave = 0;

  while (wave < MAX_WAVES) {
    const remaining = db.prepare(`SELECT COUNT(*) as c FROM information_items WHERE id NOT IN (SELECT item_id FROM ai_summaries)`).get().c;
    if (remaining === 0) { console.log(`🎉 All items enriched!`); break; }

    const total = db.prepare('SELECT COUNT(*) as c FROM information_items').get().c;
    const pct = (((total - remaining) / total) * 100).toFixed(1);
    console.log(`\n[Wave ${wave + 1}] Remaining: ${remaining}/${total} (${pct}%)`);

    try {
      const enriched = await enrichWave();
      totalEnriched += enriched;
    } catch (err) {
      console.error(`Wave ${wave + 1} error:`, err.message);
    }

    wave++;
    if (wave % 20 === 0) {
      const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
      console.log(`\n📊 Progress: ${totalEnriched} enriched, ${elapsed} min, ${wave} waves`);
    }

    // Small pause between waves to respect API
    await new Promise(r => setTimeout(r, 500));
  }

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  const finalRemaining = db.prepare(`SELECT COUNT(*) as c FROM information_items WHERE id NOT IN (SELECT item_id FROM ai_summaries)`).get().c;
  const finalTotal = db.prepare('SELECT COUNT(*) as c FROM information_items').get().c;
  
  console.log(`\n══════════════════════════════════════════════`);
  console.log(`✅ Enrichment complete in ${elapsed} min`);
  console.log(`📊 ${finalTotal - finalRemaining}/${finalTotal} enriched`);
  console.log(`⚠  Remaining: ${finalRemaining}`);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
