/**
 * Eagleye — Daily digest generation
 *
 * The editorial pass: one Chinese-language briefing per day summarising every
 * source. Separate from llm.js, which does per-item enrichment — different
 * prompt, different cadence, different failure mode.
 */

const { getDB } = require('../db/connection');
const { getProvider, getProviderInfo } = require('./llm-provider');
const { generateId, getPromptVersion, _llmBackoff } = require('./llm-shared');
const { extractJSON } = require('./llm-provider');

const DAILY_DIGEST_PROMPT = `你是 Eagleye 的每日技术情报主编。请基于今天所有信息源，生成一份中文 Daily AI Digest。

要求：
1. 按信号强度排序，不要按来源机械罗列。
2. 合并重复信息。
3. 标出新兴主题、异常增长、值得研究的 GitHub 项目、值得读的论文、值得试的产品、风险和噪声。
4. 每个判断都引用 item_id。
5. 输出 JSON。

输入：
date: {{digest_date}}
items: {{items_with_ai_summaries}}

输出：
{
  "headline": "今日最重要判断",
  "executive_summary": "300 字以内",
  "top_signals": [{"title": "", "reason": "", "item_ids": []}],
  "emerging_topics": [{"topic": "", "why_now": "", "item_ids": []}],
  "repo_watch": [{"repo": "", "why": "", "item_id": ""}],
  "paper_watch": [{"paper": "", "why": "", "item_id": ""}],
  "product_watch": [{"product": "", "why": "", "item_id": ""}],
  "risk_watch": [{"risk": "", "evidence": "", "item_ids": []}]
}`;

/**
 * Generate a daily AI digest (§8.2) for a given date.
 * Collects all items + summaries for that date and calls the LLM.
 */
async function generateDailyDigest(date) {
  const db = getDB();
  if (!db) return null;

  const provider = getProvider();
  if (!provider) return null;

  const digestLimit = Math.max(10, Math.min(parseInt(process.env.DIGEST_ITEM_LIMIT || '50', 10), 200));

  // Prefer items with summaries; fall back to raw titles
  const items = db.prepare(`
    SELECT i.id, i.title, s.label as source_label,
           a.one_liner, a.short_summary, a.key_points, a.why_it_matters
    FROM information_items i
    JOIN sources s ON i.source_id = s.id
    LEFT JOIN ai_summaries a ON i.id = a.item_id
    WHERE i.digest_date = ?
    ORDER BY i.score DESC
    LIMIT ${digestLimit}
  `).all(date);

  if (items.length === 0) {
    // 区分"这天完全没有 items"和"有 items 但全部无摘要"，便于定位
    const totalCount = db.prepare('SELECT COUNT(*) as c FROM information_items WHERE digest_date = ?').get(date).c;
    const reason = totalCount === 0 ? 'no items for this date' : `${totalCount} items but none joined (source/summary join dropped all)`;
    console.log(`  ⚠  ${date}: ${reason}, skipping digest`);
    return { __skipped: true, reason };
  }

  // Compact item format to fit in prompt
  const itemsText = items.map((item, idx) => {
    let keyPoints = [];
    try { keyPoints = JSON.parse(item.key_points || '[]'); } catch {}
    return `${idx+1}. [${item.source_label}] ${(item.title || '').slice(0, 80)}\n   ${item.one_liner || item.short_summary || ''}`;
  }).join('\n');

  // Build a shorter, Chinese-only digest prompt to prevent token exhaustion
  const prompt = `请为 ${date} 生成中文每日技术情报摘要。

要求：输出JSON，不要输出Markdown。按信号重要性排序，合并重复。

今日重要新闻（${items.length}条）：
${itemsText}

输出JSON: {
  "headline": "今日最重要判断（一句话）",
  "executive_summary": "100字以内中文摘要",
  "top_signals": [{"title": "", "reason": "", "item_ids": []}],
  "emerging_topics": [{"topic": "", "why_now": "", "item_ids": []}],
  "repo_watch": [{"repo": "", "why": "", "item_id": ""}],
  "paper_watch": [{"paper": "", "why": "", "item_id": ""}],
  "product_watch": [{"product": "", "why": "", "item_id": ""}],
  "risk_watch": [{"risk": "", "evidence": "", "item_ids": []}]
}`;

  // 每日简报只调一次 LLM，值得多等几轮撑过 glm-5.2 的间歇性过载(529)。
  let text = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      text = await provider.call(prompt, { temperature: 0.3, maxTokens: 4096 });
      break;
    } catch (err) {
      console.warn(`  ⚠  Digest attempt ${attempt}/5 failed for ${date}: ${err.message.slice(0, 120)}`);
      if (attempt < 5) {
        await _llmBackoff(attempt, err.message);
      } else {
        console.error(`  ❌ Digest generation failed for ${date} after 5 attempts: ${err.message.slice(0, 120)}`);
        return null;
      }
    }
  }
  if (!text) {
    console.warn(`  ⚠  Digest LLM returned empty/null for ${date} (items=${items.length})`);
    return null;
  }

    const data = extractJSON(text);
    if (!data) {
      const preview = (text || '').slice(0, 200).replace(/\s+/g, ' ');
      console.warn(`  ⚠  Digest LLM returned unparseable JSON for ${date}: ${preview}`);
      return null;
    }

    const info = getProviderInfo();
    const digestId = generateId();

    // Save to daily_digests table
    db.prepare(`
      INSERT OR REPLACE INTO daily_digests
        (id, digest_date, headline, executive_summary, top_signals,
         emerging_topics, repo_watch, paper_watch, product_watch, risk_watch,
         ai_generated, prompt_version, model_name, item_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      digestId, date,
      data.headline || '',
      data.executive_summary || '',
      JSON.stringify(data.top_signals || []),
      JSON.stringify(data.emerging_topics || []),
      JSON.stringify(data.repo_watch || []),
      JSON.stringify(data.paper_watch || []),
      JSON.stringify(data.product_watch || []),
      JSON.stringify(data.risk_watch || []),
      getPromptVersion(),
      info.model,
      items.length,
    );

    return { id: digestId, ...data };
}

// ─── Batch Enrichment ───────────────────────────────────────────────────

module.exports = { generateDailyDigest };
