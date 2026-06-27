#!/usr/bin/env node
/**
 * Turbo Enrichment — concurrent LLM calls for local model
 * Processes items in batches of N with concurrent LLM calls
 */

require('dotenv').config();
const crypto = require('crypto');
const { getDB } = require('../server/db/connection');
const { runMigrations } = require('../server/db/migrate');
const { getProvider, getProviderInfo, extractJSON } = require('../server/services/llm-provider');

runMigrations();

const CONCURRENCY = 3;
const MAX_ROUNDS = 100;

function generateId() { return crypto.randomUUID(); }

async function summarizeItem(item, provider) {
  const prompt = `你是 Eagleye 的技术情报分析员。请基于以下原始信息，生成可信、克制、可追溯的中文信息卡。

要求：
1. 不要编造原文没有的信息。
2. 如果信息不足，明确写"不确定"。
3. 保留技术名词、公司名、模型名、项目名。
4. 输出 JSON，不要输出 Markdown。
5. 总结要帮助开发者判断是否值得点开、收藏、研究或部署。

输入：
source: ${item.source_label || ''}
title: ${(item.title || '').slice(0, 500)}
url: ${item.canonical_url || ''}
content_excerpt: ${(item.original_summary || item.content_text || '').slice(0, 600)}

输出JSON:
{"ai_title":"","one_liner":"","short_summary":"","key_points":[],"why_it_matters":"","audience":[],"risks":[],"opportunities":[],"suggested_tags":[],"entities":[],"confidence":0.0}`;

  try {
    const text = await provider.call(prompt, { temperature: 0.2, maxTokens: 2048 });
    if (!text) return null;
    return extractJSON(text);
  } catch (err) {
    console.error(`  LLM error for ${item.id?.slice(0, 8)}:`, err.message);
    return null;
  }
}

async function enrichBatch(db, items, provider) {
  // Launch all LLM calls concurrently
  const promises = items.map(item => summarizeItem(item, provider));
  const results = await Promise.all(promises);
  
  const info = getProviderInfo();
  const insertSummary = db.prepare(`
    INSERT OR IGNORE INTO ai_summaries
      (id, item_id, model_provider, model_name, prompt_version, ai_title, one_liner,
       short_summary, deep_summary, key_points, why_it_matters, audience, risks,
       opportunities, action_items, confidence, source_grounding)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (id, slug, name, type) VALUES (?, ?, ?, 'llm-extracted')");
  const linkTag = db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence) VALUES (?, ?, ?)');
  const findTag = db.prepare('SELECT id FROM tags WHERE slug = ?');

  let enriched = 0;
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const data = results[i];
    if (!data) continue;
    
    try {
      const summaryId = generateId();
      insertSummary.run(
        summaryId, item.id, info.provider, info.model, 'v3.0-turbo',
        data.ai_title || '', data.one_liner || '', data.short_summary || '',
        null, JSON.stringify(data.key_points || []), data.why_it_matters || '',
        JSON.stringify(data.audience || []), JSON.stringify(data.risks || []),
        JSON.stringify(data.opportunities || []), '[]',
        data.confidence ?? null,
        JSON.stringify({ item_id: item.id, source: item.source_label })
      );
      
      // Save tags
      for (const tagName of (data.suggested_tags || []).slice(0, 5)) {
        const slug = tagName.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '') || generateId();
        const existing = findTag.get(slug);
        const tagId = existing ? existing.id : generateId();
        if (!existing) insertTag.run(tagId, slug, tagName);
        linkTag.run(item.id, tagId, 0.8);
      }
      
      enriched++;
    } catch (err) {
      console.error(`  DB error for ${item.id?.slice(0, 8)}:`, err.message);
    }
  }
  
  return enriched;
}

async function main() {
  const db = getDB();
  const provider = getProvider();
  
  if (!db) { console.error('No DB'); process.exit(1); }
  if (!provider) { console.error('No LLM provider'); process.exit(1); }
  
  let total = db.prepare("SELECT COUNT(*) as c FROM information_items WHERE id NOT IN (SELECT item_id FROM ai_summaries)").get().c;
  let totalEnriched = 0;
  const startTime = Date.now();
  
  console.log(`Turbo enrichment started: ${total} items remaining, concurrency=${CONCURRENCY}`);
  
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const remaining = db.prepare("SELECT COUNT(*) as c FROM information_items WHERE id NOT IN (SELECT item_id FROM ai_summaries)").get().c;
    if (remaining === 0) break;
    
    const items = db.prepare(`
      SELECT i.*, s.label as source_label, s.slug as source_slug
      FROM information_items i
      JOIN sources s ON i.source_id = s.id
      WHERE i.id NOT IN (SELECT item_id FROM ai_summaries)
      ORDER BY i.score DESC
      LIMIT ?
    `).all(CONCURRENCY);
    
    if (items.length === 0) break;
    
    const enriched = await enrichBatch(db, items, provider);
    totalEnriched += enriched;
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = (totalEnriched / ((Date.now() - startTime) / 1000) * 60).toFixed(1);
    const stillRemaining = db.prepare("SELECT COUNT(*) as c FROM information_items WHERE id NOT IN (SELECT item_id FROM ai_summaries)").get().c;
    const eta = stillRemaining > 0 ? Math.round(stillRemaining / (totalEnriched / ((Date.now() - startTime) / 1000) * 60)) : 0;
    
    console.log(`[R${round+1}] enriched ${enriched}/${items.length} | total ${totalEnriched} | remaining ${stillRemaining} | ${rate} items/min | ETA ${eta}min`);
  }
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`Done. Total enriched: ${totalEnriched} in ${elapsed}s`);
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
