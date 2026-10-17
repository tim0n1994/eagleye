/**
 * Eagleye — Alpha scoring
 *
 * Turns classified items into the six-dimension alpha score: novelty, velocity
 * (entity burst driven), cross-source confirmation, source quality, thesis match
 * and actionability. Writes signal_scores.
 */

const { getDB } = require('../db/connection');
const { taskContext, abortableDelay } = require('./llm-shared');
const { normalizeDigestDate } = require('./date-contract');
const { buildCrossSourceEvidence, describeEvidence } = require('./cross-source-evidence');
const {
  providerAvailable, preClassifyByTags, classifySignals, classifyUncategorizedRetry,
} = require('./signals-classify');

function loadSourceProfiles(db) {
  const profiles = {};
  const rows = db.prepare('SELECT * FROM source_profiles').all();
  for (const r of rows) profiles[r.source_slug] = r;
  return profiles;
}

function computeSourceScore(sourceSlug, profiles) {
  const p = profiles[sourceSlug];
  if (!p) return 0.5;
  return Math.max(0.1, 0.5 + p.early_signal_rate * 0.3 - p.noise_rate * 0.3);
}

/**
 * Subtract `days` from a digest_date string (canonical or legacy compact),
 * returning the canonical form.
 * Used for the entity-novelty trailing window (relative to the item's own date,
 * not "now", so backfilled historical items get a correct lookback).
 */
function digestMinusDays(digestDate, days) {
  const canonical = normalizeDigestDate(digestDate);
  if (!canonical) return null;
  const [y, m, d] = canonical.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

function computeNovelty(item, db) {
  // Base: time-decay over 90 days (preserved from the original heuristic).
  let base;
  if (!item.created_at && !item.published_at) {
    base = 0.5;
  } else {
    const ts = item.created_at || item.published_at;
    const daysSince = Math.max(0, (Date.now() - new Date(ts).getTime()) / 86400000);
    base = Math.max(0, 1 - (Math.min(daysSince, 90) / 90));
  }

  // Phase 1.3: entity-based content novelty (first-story detection).
  // Lift novelty when the item surfaces entities not mentioned in the trailing
  // 14 days. We use the KG entity graph instead of embedding cosine because the
  // dominant stored vectors are deterministic hashes (poor semantic signal at
  // ~4% real-embedding coverage) — entity co-occurrence novelty is both cheaper
  // and more meaningful here. See PROGRESS.md §6 Phase 1.3.
  try {
    const entIds = db.prepare(`
      SELECT DISTINCT el.entity_id
      FROM entity_mentions em JOIN entity_links el ON el.mention_id = em.id
      WHERE em.item_id = ?
    `).all(item.id).map(r => r.entity_id);
    if (entIds.length > 0 && item.digest_date) {
      const since = digestMinusDays(item.digest_date, 14);
      const ph = entIds.map(() => '?').join(',');
      const seenRows = db.prepare(`
        SELECT DISTINCT el.entity_id
        FROM entity_mentions em JOIN entity_links el ON el.mention_id = em.id
        JOIN information_items i ON i.id = em.item_id
        WHERE el.entity_id IN (${ph}) AND i.digest_date >= ? AND i.digest_date < ?
      `).all(...entIds, since, item.digest_date);
      const seen = new Set(seenRows.map(r => r.entity_id));
      const newFrac = 1 - seen.size / entIds.length; // 1 = all entities are new
      return Math.min(1, base + 0.3 * newFrac);
    }
  } catch { /* KG tables absent during early scoring — fall back to time-only */ }

  return base;
}

function computeVelocity(item, db) {
  // Phase 1.2 velocity reflects how hot THIS item's topic is, not how busy the
  // whole day was, nor how prolific its author is. Per-entity Kleinberg burst
  // is the primary signal, but we count burst only over CONTENT entities
  // (repo/paper/model/company/technology/domain) — excluding accounts/persons.
  // A tweet "@X posted Y" should register burst on Y (a spiking model/repo),
  // not on @X (a high-volume account that's always "bursting").
  const CONTENT_TYPES = new Set(['repo', 'paper', 'model', 'company', 'technology', 'domain', 'product']);
  let hasKgData = false;
  try {
    // Does this item have any content entity linked into the momentum table?
    const linked = db.prepare(`
      SELECT 1 FROM entity_mentions em
      JOIN entity_links el ON el.mention_id = em.id
      JOIN canonical_entities ce ON ce.id = el.entity_id
      JOIN entity_momentum emom ON emom.entity_id = el.entity_id AND emom.window = '7d'
      WHERE em.item_id = ? LIMIT 1
    `).get(item.id);
    if (linked) {
      hasKgData = true;
      const rows = db.prepare(`
        SELECT ce.entity_type as type, MAX(emom.burst_score) as max_burst
        FROM entity_mentions em
        JOIN entity_links el ON el.mention_id = em.id
        JOIN canonical_entities ce ON ce.id = el.entity_id
        JOIN entity_momentum emom ON emom.entity_id = el.entity_id AND emom.window = '7d'
        WHERE em.item_id = ?
        GROUP BY ce.entity_type
      `).all(item.id);
      // Take the strongest burst among content entities only.
      let best = 0;
      for (const r of rows) {
        if (CONTENT_TYPES.has(r.type) && (r.max_burst || 0) > best) best = r.max_burst;
      }
      return best > 0 ? (1 - Math.exp(-best / 3)) : 0;
    }
  } catch { /* KG tables absent — fall through to day-volume fallback */ }

  // Fallback: no KG entity data for this item at all. Same-day volume is the
  // only available proxy; squash it and cap at ~0.5 so a baseline item never
  // outranks a genuine burst.
  if (hasKgData) return 0;
  try {
    const row = db.prepare(`SELECT COUNT(*) as cnt FROM information_items
      WHERE digest_date = ? AND id != ?`).get(item.digest_date, item.id);
    return Math.min(0.5, 0.5 * (1 - Math.exp(-(row?.cnt || 0) / 60)));
  } catch { return 0; }
}

async function scoreSignals(items, opts = {}) {
  const context = taskContext(opts, opts.jobId ? require('./jobs') : null);
  if (context.isCancelled()) return { scored: 0, cancelled: true };
  const db = getDB();
  if (!db || !items?.length) return { scored: 0 };

  const profiles = loadSourceProfiles(db);
  const crossSourceEvidence = buildCrossSourceEvidence(db, items);

  // Hydrate ai_summary from DB — callers (enrichItems, SCORE_SIGNALS job) pass
  // item objects without joining ai_summaries, so item.ai_summary is undefined.
  // Load summaries here so the LLM classifier and ruleClassify see real content.
  const itemIds = items.map(i => i.id).filter(Boolean);
  if (itemIds.length > 0) {
    const placeholders = itemIds.map(() => '?').join(',');
    const summaryRows = db.prepare(
      `SELECT item_id, ai_title, one_liner, short_summary FROM ai_summaries WHERE item_id IN (${placeholders})`
    ).all(...itemIds);
    const summaryMap = new Map(summaryRows.map(r => [r.item_id, r]));
    for (const item of items) {
      if (!item.ai_summary) item.ai_summary = summaryMap.get(item.id) || null;
    }
  }

  // 预加载 items 的 LLM-extracted tags，用于噪音预分类
  const tagMap = new Map();
  if (itemIds.length > 0) {
    const placeholders = itemIds.map(() => '?').join(',');
    const tagRows = db.prepare(
      `SELECT itag.item_id, t.name FROM item_tags itag JOIN tags t ON t.id = itag.tag_id WHERE t.type = 'llm-extracted' AND itag.item_id IN (${placeholders})`
    ).all(...itemIds);
    for (const row of tagRows) {
      if (!tagMap.has(row.item_id)) tagMap.set(row.item_id, []);
      tagMap.get(row.item_id).push(row.name);
    }
  }

  const classifierItems = [];

  const insertScore = db.prepare(`
    INSERT OR REPLACE INTO signal_scores
      (item_id, signal_type, novelty_score, velocity_score, cross_source_score,
       source_quality_score, thesis_match_score, actionability_score, alpha_score,
       consensus_penalty, evidence_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    let scored = 0;

    for (const item of items) {
      const sourceScore = computeSourceScore(item.source_slug, profiles);
      const novelty = computeNovelty(item, db);
      const velocity = computeVelocity(item, db);
      const crossSource = crossSourceEvidence.get(item.id).score;

      classifierItems.push({
        id: item.id,
        title: item.title,
        ai_summary: item.ai_summary,
        source_slug: item.source_slug,
        sourceScore,
        novelty,
        velocity,
        crossSource,
      });
      scored++;
    }
  });

  tx();

  function ruleClassify(item) {
    const text = `${item.title || ''} ${item.ai_summary?.short_summary || item.ai_summary?.one_liner || ''}`.toLowerCase();
    const title = (item.title || '').toLowerCase();
    const source = (item.source_slug || '').toLowerCase();

    // Order matters: first match wins. origin_signal and contradiction are
    // placed early so high-specificity signals aren't shadowed by generic
    // keywords (e.g. a founder "launch" used to be swallowed by model_release).
    const patterns = [
      { type: 'origin_signal', kw: ['first time', 'just released', 'announcing', 'introducing', 'announces', 'unveils', 'debut', 'launch', 'roadmap', '路线图', '新方向', '首次', '首次公布', '首次透露', '发布', '宣布', '推出', '上线', 'now open', 'generally available', 'ga ', 'shipped', 'rolled out', 'rolled-out'] },
      { type: 'contradiction', kw: ['not true', 'actually wrong', 'actually false', 'debunk', 'misunderstanding', 'contrary', 'myth', 'overhyped', 'overrated', '误区', '误解', '打脸', '翻车', '被高估', '并不', '并非', '真正', 'fails to', 'doesn\'t work', 'broken', 'leak', '曝光'] },
      { type: 'funding_signal', kw: ['funding', 'raise', 'series', 'seed', 'investment', 'investor', 's-1', 'ipo', 'merger', 'buy', 'valuation', '融资', '估值', '上市', '招股', '合并', '并购', '被收购', '收购', '投资', '美元', 'million', 'billion', '亿', 'round', 'led by', 'secures', 'closes'] },
      { type: 'hiring_signal', kw: ['hiring', 'join', 'team is growing', 'we are looking', 'depart', 'resign', 'steps down', 'appoint', '招聘', '招人', '离职', '任命', '裁员', 'laid off', 'joins', 'recruiting', 'cuts'] },
      { type: 'new_repo', kw: ['github.com/', 'github repo', 'open source', 'open-source', '开源', 'repository', '仓库', ' git ', 'github', '新项目', 'star us', 'star this'] },
      { type: 'new_paper', kw: ['arxiv', 'paper', '论文', 'research paper', 'preprint', 'academic', 'arxiv.org', 'survey', 'study', '研究', 'replicate', 'reproduce', '复现', '复刻', 'we show', 'we propose', 'in this work', 'ablation', 'embedding'] },
      { type: 'model_release', kw: ['release', 'new model', 'publish', 'checkpoint', 'weights', 'drops', 'distill', 'finetune', 'fine-tune', 'lora', 'quantiz', '发布模型', '开源模型', '蒸馏', '微调', '权重', 'model', 'models', 'llm', 'gpt', '7b', '13b', '70b', 'inference', 'gguf', 'safetensors'] },
      { type: 'benchmark_claim', kw: ['benchmark', 'sota', 'state-of-the-art', 'outperform', 'accuracy', 'beats', 'performance', 'leaps', 'ties', 'leaderboard', '基准', '评测', '超越', '超过', '领先', '第一', '排名', '榜单', '碾压', '秒杀', '#1', '#2', 'score', 'mmlu', 'humaneval', 'gpqa'] },
      { type: 'architecture_shift', kw: ['architecture', 'paradigm', 'shift', 'rethinking', 'from scratch', 'rl is the new', 'reinforcement learning', 'scaling law', 'rewrite', '架构', '重新设计', '范式', '强化学习', '预训练', '重写', 'mamba', 'transformer', 'attention', 'diffusion', 'ssm'] },
      { type: 'narrative_shift', kw: ['is dead', 'no longer', 'everyone is', 'the end of', 'trend', 'shift', 'moving from', 'is over', 'era of', 'consensus', '趋势', '转变', '改变', '共识', '叙事', '拐点', 'unpopular opinion', 'hot take', 'game changer'] },
      { type: 'velocity_spike', kw: ['trending', 'viral', 'exploding', '火', '热门', '爆火', 'surging', 'blowing up', 'gaining traction'] },
      { type: 'novel_combination', kw: ['combined with', 'integrated', 'together with', 'meets', 'hybrid', '融合', '结合', '混合', '嫁接', ' x ', 'cross-modal', 'multi-modal', 'multimodal'] },
      { type: 'agent_signal', kw: ['agent', '智能体', 'mcp', 'tool use', '工具调用', 'autonomous', '自主', 'agentic', 'function calling', 'computer use', 'operator'] },
      { type: 'supply_chain', kw: ['supply chain', '供应链', '产能', 'capacity', '出货', '晶圆', 'wafer', 'photonics', '光子', 'fabrication', 'tesla', 'robotaxi', 'optimus', 'humanoid', '人形机器人'] },
    ];

    // Source-specific signals — applied before keyword matching so that
    // structurally-predictable sources (arXiv, app store, photonics feed,
    // discussion forums) don't depend on lucky keyword hits in terse titles.
    if (source === 'github-trending') return { signal_type: 'new_repo', thesis_match: 0.65, reason_zh: '来源：GitHub Trending' };
    if (source === 'hugging-face') return { signal_type: 'new_paper', thesis_match: 0.6, reason_zh: '来源：Hugging Face' };
    if (source === 'product-hunt') return { signal_type: 'origin_signal', thesis_match: 0.55, reason_zh: '来源：Product Hunt' };
    if (source === 'arxiv-ai' || source === 'physical-ai-arxiv') return { signal_type: 'new_paper', thesis_match: 0.6, reason_zh: '来源：arXiv' };
    if (source === 'physical-ai-cn-photonics') return { signal_type: 'supply_chain', thesis_match: 0.45, reason_zh: '来源：光电子产业链' };
    if (source === 'physical-ai-humanoid') return { signal_type: 'supply_chain', thesis_match: 0.5, reason_zh: '来源：人形机器人产业链' };
    if (source === 'app-store-rank') return { signal_type: 'velocity_spike', thesis_match: 0.4, reason_zh: '来源：App Store 排名变动' };
    // Discussion/community sources (X, Reddit, XiaoHongShu, HN, forums): these
    // are conversational, so the title alone rarely carries a clean signal —
    // leave them for keyword + LLM classification rather than forcing a guess.

    for (const p of patterns) {
      if (p.kw.some(k => text.includes(k) || title.includes(k))) {
        return { signal_type: p.type, thesis_match: 0.55, reason_zh: `规则匹配：${p.type}` };
      }
    }

    return { signal_type: 'uncategorized', thesis_match: 0.3, reason_zh: '' };
  }

  const ruleById = new Map();
  for (const item of classifierItems) ruleById.set(item.id, ruleClassify(item));

  // 噪音预分类：用 LLM-extracted tags 快速识别非技术内容，
  // 跳过 LLM 信号分类（省 token + 避免噪音落进 uncategorized）
  let preNoiseCount = 0;
  let preLowSignalCount = 0;
  for (const item of classifierItems) {
    const tags = tagMap.get(item.id) || [];
    const pre = preClassifyByTags(tags);
    if (pre === 'non_tech') {
      ruleById.set(item.id, { signal_type: 'non_tech', thesis_match: 0.1, reason_zh: '预分类：非技术噪音' });
      preNoiseCount++;
    } else if (pre === 'low_signal') {
      ruleById.set(item.id, { signal_type: 'uncategorized', thesis_match: 0.1, reason_zh: '预分类：内容信息不足' });
      preLowSignalCount++;
    }
  }
  if (preNoiseCount > 0 || preLowSignalCount > 0) {
    console.log(`  🔇 预分类: ${preNoiseCount} non_tech + ${preLowSignalCount} low_signal (跳过 LLM 分类)`);
  }

  const llmClassified = opts.llmSkipRuleMatched
    ? await classifySignals(classifierItems.filter(it => ruleById.get(it.id).signal_type === 'uncategorized'), context).catch(() => [])
    : await classifySignals(classifierItems, context).catch(() => []);
  if (context.isCancelled()) return { scored: 0, cancelled: true };
  const llmById = new Map(llmClassified.map(c => [c.id, c]));

  const classById = new Map();
  for (const item of classifierItems) {
    const rule = ruleById.get(item.id);
    if (opts.llmSkipRuleMatched && rule.signal_type !== 'uncategorized') {
      classById.set(item.id, rule);
      continue;
    }
    const llm = llmById.get(item.id);
    if (llm && llm.signal_type !== 'uncategorized') {
      classById.set(item.id, llm);
    } else {
      classById.set(item.id, rule);
    }
  }

  // Second pass: re-classify items still uncategorized after the first LLM pass.
  // Recovers a share of the ~31% tail that hedges on larger batches. Only runs
  // when an LLM provider is configured; opts.noRetry disables it (e.g. for
  // ultra-fast bulk passes where latency matters more than tail coverage).
  if (!opts.noRetry && providerAvailable()) {
    const stillUnc = classifierItems.filter(it => (classById.get(it.id)?.signal_type) === 'uncategorized');
    if (stillUnc.length > 0) {
      const retried = await classifyUncategorizedRetry(stillUnc, context).catch(() => []);
      for (const r of retried) {
        if (r.signal_type && r.signal_type !== 'uncategorized') classById.set(r.id, r);
      }
    }
  }

  const highAlphaItems = [];

  const writeTx = db.transaction(() => {
    for (const item of classifierItems) {
      const cls = classById.get(item.id) || { signal_type: 'uncategorized', thesis_match: 0.3 };
      const signalType = cls.signal_type || 'uncategorized';
      const thesisMatch = Number(cls.thesis_match) || 0.3;

      const actionability = Math.min(1,
        (signalType === 'contradiction' ? 0.9 : 0) +
        (signalType === 'narrative_shift' ? 0.85 : 0) +
        (signalType === 'architecture_shift' ? 0.8 : 0) +
        (signalType === 'origin_signal' ? 0.75 : 0) +
        (signalType === 'velocity_spike' ? 0.7 : 0) +
        (signalType === 'novel_combination' ? 0.65 : 0) +
        (signalType === 'new_repo' || signalType === 'new_paper' ? 0.5 : 0) +
        (signalType === 'funding_signal' ? 0.55 : 0) +
        (signalType === 'model_release' ? 0.4 : 0) +
        (signalType === 'benchmark_claim' ? 0.35 : 0) +
        (signalType === 'agent_signal' ? 0.6 : 0) +
        (signalType === 'supply_chain' ? 0.4 : 0) +
        (signalType === 'hiring_signal' ? 0.3 : 0.25)
      );

      // Base blend — multi-dimensional alpha. The weights are intentionally
      // thesis- and novelty-led: the radar should surface novel, on-thesis
      // content first, then weigh actionability and corroboration.
      const alpha = (
        0.25 * thesisMatch +
        0.20 * item.novelty +
        0.15 * actionability +
        0.15 * item.crossSource +
        0.10 * item.sourceScore +
        0.10 * item.velocity +
        0.05 * (item.novelty > 0.8 ? 1 : 0)
      );

      // Alpha calibration (Phase 1.4): the base blend alone saturates around
      // 0.83 because typical inputs (novelty ~0.7, crossSource ~0.3) cap the
      // weighted sum well under 1.0 — so the top tier (≥0.85) was always empty
      // and the leaderboard lost resolution. A transparent strength bonus
      // rewards items that are simultaneously novel AND on-thesis AND highly
      // actionable, lifting genuine standouts into the top tier without
      // inflating baseline items. Tiered so only true standouts reach ≥0.85.
      const strongThesis = thesisMatch >= 0.8;
      const veryStrongThesis = thesisMatch >= 0.9;
      const strongNovelty = item.novelty >= 0.9;
      const highAction = actionability >= 0.8;
      const corroborated = item.crossSource >= 0.5 || item.velocity >= 0.6;
      let strengthBonus = 0;
      if (veryStrongThesis && strongNovelty && highAction) {
        // Tier 1 — the clearest, most actionable, novel standouts.
        strengthBonus = corroborated ? 0.10 : 0.08;
      } else if (strongThesis && strongNovelty && highAction) {
        // Tier 2 — strong on all three primary axes.
        strengthBonus = corroborated ? 0.07 : 0.05;
      } else if (strongThesis && strongNovelty) {
        strengthBonus = 0.04;
      } else if (veryStrongThesis && highAction) {
        strengthBonus = 0.03;
      }

      // Consensus penalty nudges down items that are widely repeated (high
      // cross-source) or peaking (high velocity) — these are often "everyone is
      // talking about this" noise rather than alpha. BUT a genuine standout
      // (Tier-1/2 strength bonus) should NOT be penalised for being corroborated
      // across sources — corroboration is evidence, not staleness, when the item
      // is itself novel and on-thesis. So the bonus waives the penalty.
      const consensusPenalty = strengthBonus >= 0.05 ? 0 : Math.min(0.3,
        (item.crossSource > 0.8 ? 0.15 : 0) +
        (item.velocity > 0.7 ? 0.1 : 0)
      );

      const finalAlpha = Math.max(0, Math.min(1, alpha + strengthBonus - consensusPenalty));

      insertScore.run(
        item.id, signalType, item.novelty, item.velocity, item.crossSource,
        item.sourceScore, thesisMatch, actionability, finalAlpha,
        consensusPenalty, [cls.reason_zh, describeEvidence(crossSourceEvidence.get(item.id))].filter(Boolean).join('；')
      );
      // Collect high-alpha items for the post-commit auto-research hook.
      if (opts.autoResearch && finalAlpha >= (opts.alphaResearchThreshold || 0.75)) {
        highAlphaItems.push(item.id);
      }
    }
  });

  if (context.isCancelled()) return { scored: 0, cancelled: true };
  writeTx();

  // Phase 3.B: auto-queue deep research for genuinely high-alpha signals so the
  // radar's strongest hits get an evidence report without a manual click.
  // Guarded by opts.autoResearch so bulk rescore runs don't fan out LLM calls.
  if (opts.autoResearch && highAlphaItems.length > 0) {
    try {
      // Lazy-require to avoid the jobs ↔ signals require cycle (jobs.js already
      // lazy-requires this module inside its executeJob switch).
      const { runJob, JOB_TYPES } = require('./jobs');
      // 限流排队：runJob 是 fire-and-forget，N 个同时启动会打爆智谱账户级限流(429)。
      // 每个之间隔 2s，给上游喘息空间。research 是后台任务，不要求实时。
      let queued = 0;
      for (const itemId of highAlphaItems) {
        if (context.isCancelled()) break;
        const id = await runJob(JOB_TYPES.ITEM_RESEARCH, { itemId });
        if (id) queued++;
        await abortableDelay(2000, context.signal);
      }
      console.log(`  🔬 Auto-queued ${queued} deep-research jobs for high-alpha items (>= ${(opts.alphaResearchThreshold || 0.75)})`);
    } catch (err) {
      console.warn(`  ⚠  Auto-research queueing failed (non-fatal): ${err.message}`);
    }
  }

  return { scored: classifierItems.length, ...(context.isCancelled() ? { cancelled: true } : {}) };
}

// ─── Audience reweighting (Phase 2) ─────────────────────────────────────
// The base alpha_score is audience-agnostic. Each audience lens multiplies
// the base score by a per-signal-type weight so the SAME corpus re-ranks for
// different readers. Weights are intentionally gentle ([0.85, 1.30]) and the
// base score is preserved (alpha_score_base) so the reweight is transparent
// and reversible. Default for an unlisted type is 1.0 (neutral).

module.exports = { scoreSignals };
