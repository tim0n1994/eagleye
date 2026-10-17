/**
 * Eagleye — Daily digest generation
 *
 * The editorial pass: one Chinese-language briefing per day summarising every
 * source. Separate from llm.js, which does per-item enrichment — different
 * prompt, different cadence, different failure mode.
 */

const { getDB } = require('../db/connection');
const { getProvider } = require('./llm-provider');
const { generateId, getPromptVersion, _llmBackoff, callWithMetadata, nonEmpty, taskContext } = require('./llm-shared');
const { normalizeDigestDate } = require('./date-contract');
const { isDigestInclusionBlocked } = require('./content-sufficiency');

function validDigest(data, allowedIds) {
  if (!data || Array.isArray(data) || !nonEmpty(data.headline) || !nonEmpty(data.executive_summary)) return false;
  const groups = {
    top_signals: ['title', 'reason'], emerging_topics: ['topic', 'why_now'],
    repo_watch: ['repo', 'why'], paper_watch: ['paper', 'why'],
    product_watch: ['product', 'why'], risk_watch: ['risk', 'evidence'],
  };
  for (const [group, fields] of Object.entries(groups)) {
    if (!Array.isArray(data[group])) return false;
    for (const row of data[group]) {
      if (!row || fields.some(field => !nonEmpty(row[field]))) return false;
      const ids = ['repo_watch', 'paper_watch', 'product_watch'].includes(group) ? [row.item_id] : row.item_ids;
      if (!Array.isArray(ids) || !ids.length || ids.some(id => !allowedIds.has(id))) return false;
    }
  }
  return data.top_signals.length > 0;
}

/**
 * Generate a daily AI digest (§8.2) for a given date.
 * Collects all items + summaries for that date and calls the LLM.
 */
async function generateDailyDigest(date, opts = {}) {
  const canonicalDate = normalizeDigestDate(date);
  if (!canonicalDate) throw new Error('Invalid digest date: expected YYYY-MM-DD or YYYYMMDD');
  date = canonicalDate;
  const context = taskContext(opts, opts.jobId ? require('./jobs') : null);
  if (context.isCancelled()) return { cancelled: true };
  const db = getDB();
  if (!db) return null;

  const provider = getProvider();
  if (!provider) return null;

  const digestLimit = Math.max(10, Math.min(parseInt(process.env.DIGEST_ITEM_LIMIT || '50', 10), 200));

  // Prefer items with summaries; fall back to raw titles
  let items = db.prepare(`
    SELECT i.id, i.title, i.original_summary, i.content_text, s.label as source_label,
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

  const candidateCount = items.length;
  items = items.filter(item => !isDigestInclusionBlocked(item));
  if (items.length === 0 && candidateCount > 0) {
    console.log('  ⚠  ' + date + ': sufficiency gate excluded all ' + candidateCount + ' digest candidates, skipping digest');
    return { __skipped: true, reason: 'all ' + candidateCount + ' items excluded by content sufficiency gate' };
  }
  if (items.length < candidateCount) {
    console.log('  ⏭  Sufficiency gate excluded ' + (candidateCount - items.length) + '/' + candidateCount + ' digest candidates for ' + date);
  }

  // Compact item format to fit in prompt
  const itemsText = items.map((item, idx) => {
    return `${idx+1}. item_id=${item.id} [${item.source_label}] ${(item.title || '').slice(0, 80)}\n   ${item.one_liner || item.short_summary || ''}`;
  }).join('\n');

  // Build a shorter, Chinese-only digest prompt to prevent token exhaustion
  const prompt = `请为 ${date} 生成中文每日技术情报摘要。

要求：输出JSON，不要输出Markdown。按信号重要性排序，合并重复。每个判断必须引用输入中真实的 item_id，不得引用序号或编造ID；不确定时明确说明。

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

  const allowedIds = new Set(items.map(item => item.id));
  const maxAttempts = provider.isPool ? 1 : 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data, metadata } = await callWithMetadata(provider, prompt, {
        task: 'digest', signal: context.signal, temperature: 0.3, maxTokens: 16384, json: true,
        validate: output => validDigest(output, allowedIds),
      });
      context.check();
      const digestId = generateId();
      db.prepare(`
        INSERT OR REPLACE INTO daily_digests
          (id, digest_date, headline, executive_summary, top_signals,
           emerging_topics, repo_watch, paper_watch, product_watch, risk_watch,
           ai_generated, prompt_version, model_name, item_count, llm_metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        digestId, date, data.headline, data.executive_summary,
        JSON.stringify(data.top_signals), JSON.stringify(data.emerging_topics),
        JSON.stringify(data.repo_watch), JSON.stringify(data.paper_watch),
        JSON.stringify(data.product_watch), JSON.stringify(data.risk_watch),
        getPromptVersion(), metadata.model, items.length, JSON.stringify(metadata),
      );
      return { id: digestId, ...data, llm_metadata: metadata };
    } catch (err) {
      if (context.isCancelled()) return { cancelled: true };
      console.warn(`  ⚠  Digest attempt ${attempt}/${maxAttempts} failed for ${date}: ${err.message.slice(0, 120)}`);
      if (attempt < maxAttempts) {
        try { await _llmBackoff(attempt, err.message, context.signal); } catch (error) {
          if (context.isCancelled()) return { cancelled: true };
          throw error;
        }
      }
    }
  }
  return null;
}

// ─── Batch Enrichment ───────────────────────────────────────────────────

module.exports = { generateDailyDigest };
