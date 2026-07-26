/**
 * Alpha Radar — Signal Scoring Engine
 *
 * Computes multi-dimensional signal scores for information items and
 * classifies them into investment/research signal types.
 */

const { getDB } = require('../db/connection');
const { getProvider, getLLMConfig } = require('./llm-provider');

// Whether a usable LLM provider is configured (env or runtime override). Avoids
// burning a full provider.call() round-trip just to detect absence — used to
// gate the second-pass retry so an offline endpoint degrades gracefully.
function providerAvailable() {
  try { return !!getProvider(); } catch { return false; }
}
void getLLMConfig; // imported for completeness; getProvider encapsulates config

const SIGNAL_TYPES = [
  'origin_signal', 'new_repo', 'new_paper', 'model_release',
  'benchmark_claim', 'architecture_shift', 'narrative_shift',
  'velocity_spike', 'novel_combination', 'contradiction',
  'funding_signal', 'hiring_signal',
  'supply_chain', 'agent_signal',
  'non_tech',  // 明确标记的非技术噪音（电竞/体育/梗等），区别于模糊的 uncategorized
];

// ── 噪音/低信号预分类正则（基于 LLM 已打的 tags）──────────────────────
// 在 LLM 信号分类之前，用 item 的 llm-extracted tags 快速识别噪音，
// 避免把非技术内容送进信号分类器浪费 token 且必然落进 uncategorized。
const NOISE_TAG_RE = /体育|足球|篮球|电竞|游戏|使命召唤|赛事|社交媒体|非技术|无关内容|娱乐|明星|政治|军事|战争|情绪|搞笑|美食|旅游|时尚|宠物|健身|音乐|影视|彩票|赌博|黑色幽默|网络热梗|日常观察|个人生活|网红|段子/i;
const LOW_SIGNAL_TAG_RE = /信息缺失|信息不足|待核实|数据缺失|数据不完整|内容空白|内容缺失|无法分类|抓取失败|X平台|待确认|无实质内容/i;
const TECH_TAG_RE = /大模型|AI|LLM|开源|机器学习|深度学习|编程|代码|推理|训练|微调|向量|嵌入|agent|智能体|具身|机器人|云计算|数据库|前端|后端|API|芯片|GPU|量子|区块链|航天|SpaceX|半导体|Transformer|MoE|扩散模型|强化学习|神经网络|算法|框架|SDK|编译|分布式|微服务|容器|Kubernetes|Docker/i;

/**
 * 用 item 的 LLM-extracted tags 预分类：
 * - 'non_tech'：明确噪音（电竞/体育/梗等）→ 跳过信号分类
 * - 'low_signal'：内容抓取失败/信息不足 → 保留 uncategorized 但降权
 * - null：无法判断，走正常 LLM 分类
 */
function preClassifyByTags(itemTags) {
  if (!itemTags || itemTags.length === 0) return null;
  const tagText = itemTags.join(' ');
  if (NOISE_TAG_RE.test(tagText)) return 'non_tech';
  if (LOW_SIGNAL_TAG_RE.test(tagText) && !TECH_TAG_RE.test(tagText)) return 'low_signal';
  return null;
}

// Batch size per LLM classify call — keeps output well under token limits
// so the JSON array is never truncated mid-stream.
// Batch size for the LLM signal classifier. glm-5.2 (and similar reasoning
// routers via /v1/messages) reliably classify ≤10 items per call; larger
// batches get dropped as empty responses, so we keep this conservative.
const CLASSIFY_BATCH_SIZE = parseInt(process.env.SIGNAL_CLASSIFY_BATCH || '10', 10);

const SIGNAL_CLASSIFIER_PROMPT = `/no_think
You are a strict JSON signal classifier for tech/AI investment intelligence. Output ONLY a JSON array. NO markdown, NO explanation, NO thinking.

For each item, choose EXACTLY ONE value for "signal_type" from this CLOSED set — no other value is permitted:
- origin_signal: founder/dev first reveals a new direction, product launch, roadmap, announcement
- new_repo: a newly-discovered high-value open-source repo
- new_paper: a new academic paper, research, replication
- model_release: new model/weights/checkpoint/distill/finetune release
- benchmark_claim: performance claim, benchmark change, SOTA, ranking comparison
- architecture_shift: fundamental technical paradigm change, new architecture discussion
- narrative_shift: community consensus narrative is migrating, trend turning
- velocity_spike: a topic/entity suddenly surging in discussion
- novel_combination: previously-rarely-linked concepts/entities now co-occurring
- contradiction: evidence contradicting mainstream narrative, debunk, overrated
- funding_signal: funding, acquisition, investment, IPO, M&A
- hiring_signal: key hiring, team change, departure, layoff
- supply_chain: hardware/supply-chain/industry-capacity dynamics
- agent_signal: AI agent / 智能体 / MCP / tool-use / autonomous-agent progress
- uncategorized: ONLY if truly unrelated to AI/tech investment signals

Rules:
1. Prefer a specific type over uncategorized — most tech content fits one type.
2. When multiple fit, choose the most specific, most actionable for investment.
3. thesis_match = investment-research value: 0.9=extreme, 0.7=strong, 0.5=moderate, 0.3=weak.

Output schema (every field required, EXACTLY these keys, valid JSON array):
[{"id":"<the id>","signal_type":"<one value from the closed set>","thesis_match":<0.0-1.0 number>}]

Examples:
Input: [{"id":"a1","title":"@karpathy: announcing Eureka Labs","summary":"education AI startup launch","source":"x-following"}]
Output: [{"id":"a1","signal_type":"origin_signal","thesis_match":0.8}]

Input: [{"id":"a2","title":"DeepSeek-R1 replication on 7B","summary":"pure RL replication","source":"hugging-face"}]
Output: [{"id":"a2","signal_type":"new_paper","thesis_match":0.75}]

Input: [{"id":"a3","title":"Anthropic confidentially submits S-1","summary":"IPO filing","source":"hacker-news"}]
Output: [{"id":"a3","signal_type":"funding_signal","thesis_match":0.85}]

Input is a JSON array, each item {id, title, summary, source}.
Respond with the JSON array now.`;

// Tighter second-pass prompt for items the first pass left as uncategorized.
// The first pass tends to hedge on genuinely-classifiable content (large batch,
// terse title); this pass insists on a concrete type and forbids uncategorized
// unless the content is truly off-topic. Smaller batches + this directive tone
// recover a meaningful share of the ~31% uncategorized tail.
const SIGNAL_CLASSIFIER_RETRY_PROMPT = `/no_think
You are re-classifying tech/AI items that a previous pass could not place. Decide the single best type. Do NOT default to uncategorized — almost all AI/tech content fits one type.

Choose EXACTLY ONE value for "signal_type" from this CLOSED set:
- origin_signal: launch, announcement, roadmap, new product/direction reveal
- new_repo: open-source repo discovery
- new_paper: paper, research, replication, study
- model_release: model/weights/checkpoint/finetune/distill release
- benchmark_claim: benchmark, SOTA, performance comparison, ranking
- architecture_shift: paradigm/architecture change discussion
- narrative_shift: community narrative/trend turning
- velocity_spike: a topic/entity suddenly surging
- novel_combination: rarely-linked concepts now co-occurring
- contradiction: debunk, overrated, contradicts mainstream
- funding_signal: funding, M&A, IPO, investment
- hiring_signal: key hire/departure/layoff
- supply_chain: hardware/supply-chain/capacity
- agent_signal: AI agent / tool-use / autonomous progress
- uncategorized: ONLY if truly unrelated to any tech/AI signal

thesis_match = research value: 0.9=extreme, 0.7=strong, 0.5=moderate, 0.3=weak.
Output ONLY a JSON array, EXACT keys: [{"id":"...","signal_type":"...","thesis_match":0.0-1.0}]
Be decisive. Respond with the JSON array now.`;

// Map LLM-returned type strings to our canonical SIGNAL_TYPES slugs.
// Models (especially mock routers) sometimes return synonyms or invented
// names like "corporate_finance" or "technology_release". This normalizes
// them so valid classifications aren't silently dropped to uncategorized.
const TYPE_ALIASES = {
  corporate_finance: 'funding_signal', finance: 'funding_signal', funding: 'funding_signal',
  ipo: 'funding_signal', acquisition: 'funding_signal', m_and_a: 'funding_signal',
  technology_release: 'model_release', release: 'model_release', product_launch: 'origin_signal',
  repo: 'new_repo', open_source: 'new_repo', github: 'new_repo',
  paper: 'new_paper', research: 'new_paper', academic: 'new_paper', study: 'new_paper',
  benchmark: 'benchmark_claim', sota: 'benchmark_claim', performance: 'benchmark_claim',
  paradigm_shift: 'architecture_shift', architecture: 'architecture_shift',
  trend: 'narrative_shift', narrative: 'narrative_shift', sentiment: 'narrative_shift',
  viral: 'velocity_spike', trending: 'velocity_spike', breakout: 'velocity_spike',
  combination: 'novel_combination', integration: 'novel_combination',
  debunk: 'contradiction', correction: 'contradiction', myth: 'contradiction',
  hiring: 'hiring_signal', recruitment: 'hiring_signal', departure: 'hiring_signal',
  supply_chain: 'supply_chain', industry: 'supply_chain', manufacturing: 'supply_chain',
  agent: 'agent_signal', autonomous: 'agent_signal', mcp: 'agent_signal',
  origin: 'origin_signal', announcement: 'origin_signal',
  launch: 'origin_signal', release_event: 'origin_signal',
};

// Free-form Chinese category labels some routers/models emit instead of the
// requested signal_type slug (observed: glm-5.2 returns 自有 taxonomy like
// "创业与管理哲学", "科技人物轶事"). Map the recurring ones to the nearest
// canonical signal so they aren't all dropped to uncategorized. Keys are
// matched as substrings, lowercased.
const ZH_CATEGORY_MAP = {
  '创业': 'origin_signal', '管理哲学': 'narrative_shift', '哲学': 'narrative_shift',
  '企业战略': 'narrative_shift', '战略': 'narrative_shift', '商业': 'funding_signal',
  '产品与市场': 'origin_signal', '产品': 'origin_signal', '市场': 'velocity_spike',
  '融资': 'funding_signal', '投资': 'funding_signal', '估值': 'funding_signal', 'ipo': 'funding_signal', '上市': 'funding_signal',
  '招聘': 'hiring_signal', '离职': 'hiring_signal', '团队': 'hiring_signal', '裁员': 'hiring_signal',
  '论文': 'new_paper', '研究': 'new_paper', '学术': 'new_paper', '复现': 'new_paper',
  '开源': 'new_repo', '仓库': 'new_repo', '项目': 'new_repo',
  '模型': 'model_release', '微调': 'model_release', '蒸馏': 'model_release', '权重': 'model_release',
  '基准': 'benchmark_claim', '评测': 'benchmark_claim', 'sota': 'benchmark_claim', '性能': 'benchmark_claim', '超越': 'benchmark_claim',
  '架构': 'architecture_shift', '范式': 'architecture_shift', '重新设计': 'architecture_shift',
  '趋势': 'narrative_shift', '叙事': 'narrative_shift', '共识': 'narrative_shift', '转变': 'narrative_shift',
  '热门': 'velocity_spike', '爆发': 'velocity_spike', '病毒': 'velocity_spike',
  '矛盾': 'contradiction', '打脸': 'contradiction', '翻车': 'contradiction', '误解': 'contradiction', '高估': 'contradiction',
  '供应链': 'supply_chain', '产业链': 'supply_chain', '产能': 'supply_chain', '硬件': 'supply_chain', '芯片': 'supply_chain', '光子': 'supply_chain',
  '智能体': 'agent_signal', 'agent': 'agent_signal', '工具调用': 'agent_signal', '自主': 'agent_signal',
  '人物轶事': 'origin_signal', '人物': 'origin_signal', '动态': 'velocity_spike', '新闻': 'velocity_spike',
  '工具': 'new_repo', '应用': 'origin_signal', '发布': 'origin_signal',
};

function normalizeSignalType(raw) {
  if (!raw || typeof raw !== 'string') return 'uncategorized';
  const t = raw.trim().toLowerCase();
  if (SIGNAL_TYPES.includes(t)) return t;
  if (TYPE_ALIASES[t]) return TYPE_ALIASES[t];
  // Partial-match: look for a canonical slug as substring (e.g. "funding_news" → funding_signal)
  for (const slug of SIGNAL_TYPES) {
    if (t.includes(slug) || slug.includes(t)) return slug;
  }
  // Try alias keys as substring
  for (const [alias, slug] of Object.entries(TYPE_ALIASES)) {
    if (t.includes(alias)) return slug;
  }
  // Free-form Chinese category (e.g. glm-5.2's "创业与管理哲学"): match on
  // the raw (un-lowercased, since toLowerCase mangles CJK harmlessly but the
  // original may carry diacritics we want). Substring-match the longest keys.
  const zh = raw.trim();
  const keys = Object.keys(ZH_CATEGORY_MAP).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (zh.includes(k)) return ZH_CATEGORY_MAP[k];
  }
  return 'uncategorized';
}

// Coerce a thesis_match value that may be a number, boolean, or string into 0-1.
function normalizeThesisMatch(raw) {
  if (typeof raw === 'boolean') return raw ? 0.7 : 0.3;
  const n = Number(raw);
  if (!Number.isNaN(n)) return Math.max(0, Math.min(1, n));
  return 0.5;
}

async function classifyChunk(chunk, { retry = false } = {}) {
  const provider = getProvider();
  if (!provider || !chunk?.length) return [];

  const batch = chunk.map(item => ({
    id: item.id,
    title: String(item.title || '').slice(0, 200),
    summary: String(item.ai_summary?.short_summary || item.ai_summary?.one_liner || item.ai_summary?.ai_title || '').slice(0, 300),
    source: String(item.source_slug || '').slice(0, 60),
  }));

  // Retry pass: use a tighter, more directive prompt so ambiguous items that
  // the first pass left unclassified get a second, firmer look. The first pass
  // frequently returns uncategorized for genuinely-classifiable content when
  // the batch is large or the model hedges; a single-purpose retry reduces the
  // 31% uncategorized tail without re-classifying already-good items.
  const basePrompt = retry ? SIGNAL_CLASSIFIER_RETRY_PROMPT : SIGNAL_CLASSIFIER_PROMPT;
  const prompt = basePrompt + '\n\n输入：' + JSON.stringify(batch);
  // 20 items × ~120 tokens each for output; cap at a safe ceiling.
  const maxTokens = Math.min(4096, 300 + batch.length * 130);

  // 重试撑过 glm-5.2 间歇性过载(529/1305) 和账户限流(429/1302)
  const maxAttempts = retry ? 2 : 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const text = await provider.call(prompt, { temperature: 0.1, maxTokens, json: true });
      if (!text) {
        if (!retry && attempt < maxAttempts) { await _signalBackoff(attempt, 'empty'); continue; }
        if (!retry) console.warn('  ⚠  Signal classifier returned empty response for chunk of', batch.length);
        return [];
      }
      // Strip markdown fences and <think> tags (reasoning models may emit them)
      const clean = text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .trim();
      const match = clean.match(/\[[\s\S]*\]/);
      if (!match) {
        if (!retry && attempt < maxAttempts) { await _signalBackoff(attempt, 'no-json'); continue; }
        if (!retry) console.warn('  ⚠  Signal classifier: no JSON array found in response:', clean.slice(0, 200));
        return [];
      }
      const data = JSON.parse(match[0]);
      const byId = new Map(chunk.map(i => [i.id, i]));
      return data.filter(r => r && byId.has(r.id)).map(r => ({
        ...r,
        // Models vary in field naming: some return `category` / `type` instead of
        // `signal_type` (observed with glm-5.2 routing free-form labels). Accept
        // any of them so a valid classification isn't silently dropped.
        signal_type: normalizeSignalType(r.signal_type || r.category || r.type || r.classification || ''),
        thesis_match: normalizeThesisMatch(r.thesis_match ?? r.confidence ?? r.score),
      }));
    } catch (err) {
      // 1301 内容安全审核：不可恢复，跳过不重试
      if (/1301|invalid_request_error.*安全|敏感内容/i.test(err.message)) {
        if (!retry) console.log(`  ⏭  Signal classification skipped: content filtered by safety check`);
        return [];
      }
      if (!retry) console.warn(`  ⚠  Signal classification attempt ${attempt}/${maxAttempts} failed for chunk:`, err.message.slice(0, 100));
      if (attempt < maxAttempts) {
        await _signalBackoff(attempt, err.message);
      } else {
        return [];
      }
    }
  }
  return [];
}

// 529/429 长退避（共享逻辑，与 enrich 一致）
async function _signalBackoff(attempt, errMsg) {
  const isOverload = /429|529|1302|1305|rate.limit|overload|速率限制|访问量过大/i.test(String(errMsg || ''));
  const ms = Math.min(30000, (isOverload ? 8000 : 2000) * attempt);
  await new Promise(r => setTimeout(r, ms));
}

function classifySignals(items) {
  // Chunk items to keep each LLM call's output within token limits.
  const chunks = [];
  for (let i = 0; i < items.length; i += CLASSIFY_BATCH_SIZE) {
    chunks.push(items.slice(i, i + CLASSIFY_BATCH_SIZE));
  }
  // Run chunks with LIMITED concurrency: glm-5.2 (and similar local routers)
  // drop requests as empty when too many fire at once. A small pool keeps the
  // router saturated without overwhelming it.
  const CONCURRENCY = parseInt(process.env.SIGNAL_CLASSIFY_CONCURRENCY || '3', 10);
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < chunks.length) {
      const i = idx++;
      const out = await classifyChunk(chunks[i]).catch(() => []);
      results[i] = out;
    }
  }
  return Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker))
    .then(() => results.flat());
}

/**
 * Second-pass classifier for items the first pass left uncategorized.
 *
 * Retries only the still-uncategorized subset in HALF-size batches with a
 * firmer prompt. Returns only NEW (non-uncategorized) classifications so the
 * caller can merge them on top of the first pass without clobbering good hits.
 * Failures degrade gracefully: an unreachable LLM endpoint yields [] and the
 * items keep their first-pass uncategorized label.
 */
async function classifyUncategorizedRetry(items) {
  if (!items?.length) return [];
  const provider = getProvider();
  if (!provider) return [];
  const retryBatch = Math.max(1, Math.floor(CLASSIFY_BATCH_SIZE / 2));
  const chunks = [];
  for (let i = 0; i < items.length; i += retryBatch) {
    chunks.push(items.slice(i, i + retryBatch));
  }
  const CONCURRENCY = parseInt(process.env.SIGNAL_CLASSIFY_CONCURRENCY || '3', 10);
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < chunks.length) {
      const i = idx++;
      const out = await classifyChunk(chunks[i], { retry: true }).catch(() => []);
      results[i] = out;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  // Keep only rows where the retry produced a real (non-uncategorized) type.
  return results.flat().filter(r => r.signal_type && r.signal_type !== 'uncategorized');
}

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
 * Subtract `days` from a YYYYMMDD digest_date string, returning YYYYMMDD.
 * Used for the entity-novelty trailing window (relative to the item's own date,
 * not "now", so backfilled historical items get a correct lookback).
 */
function digestMinusDays(digestDate, days) {
  const y = Number(digestDate.slice(0, 4));
  const m = Number(digestDate.slice(4, 6)) - 1;
  const d = Number(digestDate.slice(6, 8));
  const dt = new Date(Date.UTC(y, m, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10).replace(/-/g, '');
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

function computeCrossSource(item, db) {
  try {
    const src = db.prepare(`SELECT COUNT(DISTINCT source_id) as cnt FROM information_items
      WHERE digest_date = ?`).get(item.digest_date);
    const totalSources = src?.cnt || 1;
    return Math.min(1, totalSources / 10);
  } catch { return 0; }
}

async function scoreSignals(items, opts = {}) {
  const db = getDB();
  if (!db || !items?.length) return { scored: 0 };

  const profiles = loadSourceProfiles(db);

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
      const crossSource = computeCrossSource(item, db);

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
    ? await classifySignals(classifierItems.filter(it => ruleById.get(it.id).signal_type === 'uncategorized')).catch(() => [])
    : await classifySignals(classifierItems).catch(() => []);
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
      const retried = await classifyUncategorizedRetry(stillUnc).catch(() => []);
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
        consensusPenalty, cls.reason_zh || null
      );
      // Collect high-alpha items for the post-commit auto-research hook.
      if (opts.autoResearch && finalAlpha >= (opts.alphaResearchThreshold || 0.75)) {
        highAlphaItems.push(item.id);
      }
    }
  });

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
        const id = await runJob(JOB_TYPES.ITEM_RESEARCH, { itemId });
        if (id) queued++;
        await new Promise(r => setTimeout(r, 2000));
      }
      console.log(`  🔬 Auto-queued ${queued} deep-research jobs for high-alpha items (>= ${(opts.alphaResearchThreshold || 0.75)})`);
    } catch (err) {
      console.warn(`  ⚠  Auto-research queueing failed (non-fatal): ${err.message}`);
    }
  }

  return { scored: classifierItems.length };
}

// ─── Audience reweighting (Phase 2) ─────────────────────────────────────
// The base alpha_score is audience-agnostic. Each audience lens multiplies
// the base score by a per-signal-type weight so the SAME corpus re-ranks for
// different readers. Weights are intentionally gentle ([0.85, 1.30]) and the
// base score is preserved (alpha_score_base) so the reweight is transparent
// and reversible. Default for an unlisted type is 1.0 (neutral).

const AUDIENCE_DEFS = [
  {
    key: 'developer',
    label: 'Developer',
    label_zh: '开发者',
    description: 'New repos, model releases, agents, launches — what to build with.',
    description_zh: '新仓库、模型发布、智能体、产品发布 —— 值得上手做的。',
    weights: {
      new_repo: 1.30, model_release: 1.20, agent_signal: 1.25,
      origin_signal: 1.15, velocity_spike: 1.10, new_paper: 1.05,
      funding_signal: 0.85, hiring_signal: 0.85, supply_chain: 0.85,
    },
  },
  {
    key: 'researcher',
    label: 'Researcher',
    label_zh: '研究者',
    description: 'Papers, benchmarks, architecture shifts, contradictions — the frontier.',
    description_zh: '论文、基准、架构迁移、矛盾信号 —— 前沿进展。',
    weights: {
      new_paper: 1.30, benchmark_claim: 1.25, architecture_shift: 1.20,
      contradiction: 1.20, model_release: 1.10, novel_combination: 1.10,
      funding_signal: 0.85, hiring_signal: 0.85, supply_chain: 0.85,
      velocity_spike: 0.90,
    },
  },
  {
    key: 'investor',
    label: 'Investor',
    label_zh: '投资人',
    description: 'Funding, hiring, supply chain, narrative shifts — alpha & momentum.',
    description_zh: '融资、招聘、供应链、叙事迁移 —— alpha 与动量。',
    weights: {
      funding_signal: 1.30, hiring_signal: 1.20, supply_chain: 1.20,
      narrative_shift: 1.15, contradiction: 1.15, origin_signal: 1.10,
      new_repo: 0.85, new_paper: 0.90, benchmark_claim: 0.90,
      velocity_spike: 0.90,
    },
  },
];

const AUDIENCE_WEIGHTS = Object.fromEntries(
  AUDIENCE_DEFS.map(a => [a.key, a.weights])
);

function getRadarAudiences() {
  // Destructure to drop the internal `weights` map from the public payload.
  return AUDIENCE_DEFS.map(({ weights: _weights, ...meta }) => meta);
}

/**
 * Build a SQL CASE expression multiplying alpha_score by the audience's
 * per-type weight, or null when no audience is selected (use raw alpha_score).
 * SQLite MIN(a,b) is the scalar 2-arg form here, not the aggregate.
 */
function audienceReweightSQL(audience) {
  const weights = AUDIENCE_WEIGHTS[audience];
  if (!weights) return null;
  const cases = Object.entries(weights)
    .map(([type, w]) => `WHEN '${type}' THEN ${w}`)
    .join(' ');
  return `MIN(1.0, ss.alpha_score * (CASE ss.signal_type ${cases} ELSE 1.0 END))`;
}

/**
 * Build a reweight SQL fragment from a user's personal lens (PRD-5).
 * A lens is { types: { <signal_type>: <multiplier 0.5..1.5> } }. Multipliers are
 * clamped to [0.5, 1.5] (gentle, same envelope as the audience lenses) and the
 * signal_type values are validated against the canonical SIGNAL_TYPES set so a
 * crafted lens can't inject SQL. Returns null for an empty/invalid lens.
 */
function personalLensSQL(lens) {
  if (!lens || typeof lens !== 'object') return null;
  const types = lens.types || lens;
  if (!types || typeof types !== 'object') return null;
  const valid = new Set(SIGNAL_TYPES);
  const entries = Object.entries(types)
    .filter(([t, w]) => valid.has(t) && Number.isFinite(Number(w)))
    .map(([t, w]) => [t, Math.max(0.5, Math.min(1.5, Number(w)))]);
  if (entries.length === 0) return null;
  const cases = entries.map(([t, w]) => `WHEN '${t}' THEN ${w}`).join(' ');
  return `MIN(1.0, ss.alpha_score * (CASE ss.signal_type ${cases} ELSE 1.0 END))`;
}

function getSignals(opts = {}) {
  const db = getDB();
  if (!db) return [];

  const { signalType, date, sortBy = 'alpha_score', limit = 50, offset = 0, sinceDays, audience, lens, excludeUncategorized } = opts;

  // When an audience OR personal lens is active, compute a reweighted score and
  // rank by it; the base alpha_score is preserved on the row as alpha_score_base.
  // The personal lens (PRD-5) takes precedence over the preset audience lenses
  // when both are supplied — the user's explicit choice should win.
  const reweight = personalLensSQL(lens) || audienceReweightSQL(audience);
  const audienceCol = reweight
    ? `, ${reweight} as alpha_score_audience`
    : '';
  // Determine the ORDER BY column: audience/lens reweight wins over an explicit
  // alpha sort; novelty/velocity sorts are dimension-specific and left intact.
  let orderCol = 'ss.alpha_score';
  if (reweight && (sortBy === 'alpha_score' || sortBy === 'alpha')) {
    orderCol = 'alpha_score_audience';
  } else if (sortBy === 'novelty') {
    orderCol = 'ss.novelty_score';
  } else if (sortBy === 'velocity') {
    orderCol = 'ss.velocity_score';
  }

  let sql = `
    SELECT ss.*, i.title, i.canonical_url, i.published_at, i.score,
           s.label as source_label, s.slug as source_slug,
           a.one_liner, a.short_summary, a.ai_title,
           sp.source_type, sp.noise_rate, sp.early_signal_rate${audienceCol}
    FROM signal_scores ss
    JOIN information_items i ON ss.item_id = i.id
    JOIN sources s ON i.source_id = s.id
    LEFT JOIN ai_summaries a ON a.item_id = i.id
    LEFT JOIN source_profiles sp ON sp.source_slug = s.slug
    WHERE 1=1
  `;
  const params = [];

  if (signalType && signalType !== 'all') {
    sql += ' AND ss.signal_type = ?';
    params.push(signalType);
  }

  if (excludeUncategorized) {
    sql += " AND ss.signal_type != 'uncategorized' AND ss.signal_type != 'non_tech'";
  }

  if (date) {
    sql += ' AND i.digest_date = ?';
    params.push(date);
  } else if (sinceDays && Number(sinceDays) > 0) {
    // ISO yyyymmdd → lexicographic compare works because the column is stored
    // as a zero-padded 8-char string.
    const cutoff = new Date(Date.now() - Number(sinceDays) * 86400000)
      .toISOString().slice(0, 10).replace(/-/g, '');
    sql += ' AND i.digest_date >= ?';
    params.push(cutoff);
  }

  sql += ` ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

function getTodaySignals(limit = 100) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  // Try today first; if empty for 7+ days, show from the most recent scored date
  let signals = getSignals({ date: today, limit, sortBy: 'alpha_score', excludeUncategorized: true });
  if (signals.length > 0) return { signals, date: today, total: signals.length, fallback: false };

  // No signals today — find the most recent date with scored signals
  const db = getDB();
  if (db) {
    const recent = db.prepare(`
      SELECT i.digest_date FROM signal_scores ss
      JOIN information_items i ON ss.item_id = i.id
      WHERE ss.signal_type != 'uncategorized'
      ORDER BY i.digest_date DESC LIMIT 1
    `).get();
    if (recent && recent.digest_date) {
      signals = getSignals({ date: recent.digest_date, limit, sortBy: 'alpha_score', excludeUncategorized: true });
      return { signals, date: recent.digest_date, total: signals.length, fallback: true };
    }
  }
  return { signals: [], date: today, total: 0, fallback: false };
}

function getSignalById(itemId) {
  const db = getDB();
  if (!db) return null;

  const signal = db.prepare(`
    SELECT ss.*, i.title, i.canonical_url, i.published_at, i.score,
           i.original_summary, i.content_text,
           s.label as source_label, s.slug as source_slug,
           a.one_liner, a.short_summary, a.key_points, a.why_it_matters,
           a.ai_title, a.ai_title_zh,
           sp.source_type, sp.noise_rate, sp.early_signal_rate
    FROM signal_scores ss
    JOIN information_items i ON ss.item_id = i.id
    JOIN sources s ON i.source_id = s.id
    LEFT JOIN ai_summaries a ON a.item_id = i.id
    LEFT JOIN source_profiles sp ON sp.source_slug = s.slug
    WHERE ss.item_id = ?
  `).get(itemId);

  if (signal) {
    signal.topics = db.prepare(`
      SELECT t.slug, t.name FROM item_topics it
      JOIN topics t ON it.topic_id = t.id WHERE it.item_id = ?
    `).all(itemId);
    // Entities via KG v2 (canonical_entities), with 7d momentum if available.
    signal.entities = db.prepare(`
      SELECT ce.canonical_name as name, ce.canonical_slug as slug, ce.entity_type as type,
             em2.velocity_zscore as zscore, em2.mention_count,
             em2.growth_rate, em2.acceleration, em2.burst_score
      FROM entity_mentions ement
      JOIN entity_links el ON el.mention_id = ement.id
      JOIN canonical_entities ce ON ce.id = el.entity_id
      LEFT JOIN entity_momentum em2 ON em2.entity_id = ce.id AND em2.window = '7d'
      WHERE ement.item_id = ?
      GROUP BY ce.id
      ORDER BY (em2.velocity_zscore IS NOT NULL) DESC, COALESCE(em2.velocity_zscore, 0) DESC
      LIMIT 10
    `).all(itemId);
  }

  return signal;
}

function getSignalTypes() {
  const db = getDB();
  if (!db) return [];

  const types = db.prepare('SELECT * FROM signal_types ORDER BY sort_order').all();
  const counts = db.prepare(`
    SELECT signal_type, COUNT(*) as cnt FROM signal_scores
    WHERE datetime(scored_at) > datetime('now', '-24 hours')
    GROUP BY signal_type
  `).all();
  const countMap = {};
  for (const c of counts) countMap[c.signal_type] = c.cnt;

  return types.map(t => ({ ...t, today_count: countMap[t.slug] || 0 }));
}

/**
 * Trending entities ranked by a chosen metric for a given time window.
 * Used by the intelligence/momentum leaderboard and the /signals "Rising
 * Entities" panel.
 *
 * sort options:
 *   'zscore' (default) — cross-entity velocity z-score (most-mentioned cohort)
 *   'acceleration'     — today vs week-average (who is spiking right now)
 *   'growth'           — week-over-week growth rate
 *   'burst'            — Kleinberg burst weight (0 unless currently bursting)
 *
 * Phase 1 enrichment: growth_rate/acceleration/burst_score columns come from
 * updateEntityMomentum's Phase 1 pass.
 */
function getEntityMomentum(window = '7d', limit = 20, sort = 'zscore') {
  const db = getDB();
  if (!db) return [];

  const sortCol = {
    acceleration: 'em.acceleration',
    growth: 'em.growth_rate',
    burst: 'em.burst_score',
    zscore: 'em.velocity_zscore',
  }[sort] || 'em.velocity_zscore';

  return db.prepare(`
    SELECT ce.canonical_name as name, ce.canonical_slug as slug, ce.entity_type as type,
           em.mention_count, em.unique_sources, em.high_quality_mentions,
           em.velocity_zscore as zscore,
           em.growth_rate, em.acceleration, em.burst_score, em.prev_window_count
    FROM entity_momentum em
    JOIN canonical_entities ce ON ce.id = em.entity_id
    WHERE em.window = ? AND em.mention_count >= 2
    ORDER BY ${sortCol} DESC, em.mention_count DESC
    LIMIT ?
  `).all(window, limit);
}

/**
 * Resolve a canonical entity by slug and return its recent items + momentum,
 * for the entity detail view and the per-entity Atom feed (Phase 3.C).
 *
 * Item path: canonical_entities ← entity_links → entity_mentions → information_items,
 * the inverse of getSignalById's entity query. Returns { entity, items } or null.
 */
function getEntityItems(slug, limit = 20) {
  const db = getDB();
  if (!db) return null;

  const entity = db.prepare(`
    SELECT id, canonical_name, canonical_slug, entity_type, description, homepage_url
    FROM canonical_entities WHERE canonical_slug = ?
  `).get(slug);
  if (!entity) return null;

  const items = db.prepare(`
    SELECT i.id, i.title, i.canonical_url, i.published_at, i.digest_date,
           s.label as source_label, s.slug as source_slug,
           a.one_liner, a.short_summary, a.ai_title,
           ss.alpha_score, ss.signal_type
    FROM entity_links el
    JOIN entity_mentions em ON em.id = el.mention_id
    JOIN information_items i ON i.id = em.item_id
    JOIN sources s ON i.source_id = s.id
    LEFT JOIN ai_summaries a ON a.item_id = i.id
    LEFT JOIN signal_scores ss ON ss.item_id = i.id
    WHERE el.entity_id = ?
    ORDER BY i.published_at DESC
    LIMIT ?
  `).all(entity.id, limit);

  // Momentum across windows, if computed.
  const momentum = db.prepare(`
    SELECT window, mention_count, velocity_zscore, growth_rate, acceleration, burst_score
    FROM entity_momentum WHERE entity_id = ?
  `).all(entity.id);

  return { entity, items, momentum };
}

/**
 * 30-day daily mention series for an entity, for the Trend Trajectory view
 * (PRD-1). Re-derives the zero-filled series at query time (same windowing the
 * Phase-1 metrics use) and annotates which days fall inside the Kleinberg
 * burst segment so the frontend sparkline can highlight the spike region.
 *
 * Returns { entity, series: [{date, count, burst}], stats } or null.
 */
function getEntitySeries(slug) {
  const db = getDB();
  if (!db) return null;

  const entity = db.prepare(`
    SELECT id, canonical_name, canonical_slug, entity_type
    FROM canonical_entities WHERE canonical_slug = ?
  `).get(slug);
  if (!entity) return null;

  // Anchor on the data's latest digest_date (NOT wall-clock now) so backfilled
  // data still lines up — identical reasoning to computeEntityPhase1Metrics.
  const latestRow = db.prepare(`SELECT MAX(digest_date) AS latest FROM information_items`).get();
  const latest = latestRow?.latest;
  if (!latest) return { entity, series: [], stats: {} };

  const since30 = (() => {
    const y = Number(latest.slice(0, 4));
    const m = Number(latest.slice(4, 6)) - 1;
    const d = Number(latest.slice(6, 8));
    const dt = new Date(Date.UTC(y, m, d));
    dt.setUTCDate(dt.getUTCDate() - 30);
    return dt.toISOString().slice(0, 10).replace(/-/g, '');
  })();

  const rows = db.prepare(`
    SELECT i.digest_date, COUNT(*) AS c
    FROM entity_links el
    JOIN entity_mentions em ON em.id = el.mention_id
    JOIN information_items i ON i.id = em.item_id
    WHERE el.entity_id = ? AND i.digest_date >= ?
    GROUP BY i.digest_date
  `).all(entity.id, since30);

  const dayMap = new Map(rows.map(r => [r.digest_date, r.c]));
  const dateIndex = [];
  for (let d = 30; d >= 0; d--) {
    const y = Number(latest.slice(0, 4));
    const m = Number(latest.slice(4, 6)) - 1;
    const dd = Number(latest.slice(6, 8));
    const dt = new Date(Date.UTC(y, m, dd));
    dt.setUTCDate(dt.getUTCDate() - d);
    dateIndex.push(dt.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  const series30 = dateIndex.map(d => dayMap.get(d) || 0);

  // Find burst days: run viterbi over the series and mark the contiguous final
  // burst run (adaptive so sparse entities still register).
  let burstMask = series30.map(() => false);
  try {
    const { viterbiPath } = require('./kleinberg');
    const total = series30.reduce((a, b) => a + b, 0);
    const mean = total / series30.length;
    const maxC = series30.length ? Math.max(...series30) : 0;
    const opts = { adaptive: true };
    if (mean > 0 && maxC > mean) {
      const ratio = maxC / mean;
      opts.s = Math.min(2.0, Math.max(1.3, ratio - 0.05));
    }
    if (mean > 0) opts.entryCost = Math.max(0.5, 2.0 * Math.min(1, total / 30));
    const path = viterbiPath(series30, opts);
    burstMask = path.map(p => p === 1);
  } catch { /* kleinberg unavailable → no burst highlight */ }

  const series = dateIndex.map((date, i) => ({
    date,
    count: series30[i],
    burst: burstMask[i],
  }));

  // Trend stats over the 7d window for the headline chips.
  const last7 = series30.slice(-7);
  const prev7 = series30.slice(-14, -7);
  const c7 = last7.reduce((a, b) => a + b, 0);
  const cPrev7 = prev7.reduce((a, b) => a + b, 0);
  const stats = {
    total_30d: series30.reduce((a, b) => a + b, 0),
    count_7d: c7,
    growth_rate: c7 > 0 || cPrev7 > 0 ? Number((c7 / Math.max(cPrev7, 1) - 1).toFixed(3)) : 0,
    peak_day: series30.indexOf(Math.max(...series30)) >= 0 ? dateIndex[series30.indexOf(Math.max(...series30))] : null,
    burst_days: burstMask.filter(Boolean).length,
  };

  return { entity, series, stats };
}

/**
 * Entity co-occurrence matrix: find entity pairs that frequently appear in the
 * same items. Returns top pairs with co-occurrence counts for the intelligence
 * page's relationship visualization.
 */
function getEntityCoOccurrence(limit = 20) {
  const db = getDB();
  if (!db) return [];
  // Find pairs of entities that co-occur in the same item, ranked by frequency.
  try {
    return db.prepare(`
      SELECT
        ce1.canonical_name AS name_a, ce1.canonical_slug AS slug_a, ce1.entity_type AS type_a,
        ce2.canonical_name AS name_b, ce2.canonical_slug AS slug_b, ce2.entity_type AS type_b,
        COUNT(DISTINCT em1.item_id) AS co_count
      FROM entity_links el1
      JOIN entity_mentions em1 ON em1.id = el1.mention_id
      JOIN canonical_entities ce1 ON ce1.id = el1.entity_id
      JOIN entity_mentions em2 ON em2.item_id = em1.item_id AND em2.id > em1.id
      JOIN entity_links el2 ON el2.mention_id = em2.id
      JOIN canonical_entities ce2 ON ce2.id = el2.entity_id
      WHERE ce1.id < ce2.id
      GROUP BY ce1.id, ce2.id
      ORDER BY co_count DESC
      LIMIT ?
    `).all(limit);
  } catch {
    return [];
  }
}

/**
 * Compare multiple entities' 30-day trajectories on one chart.
 * Returns { entities: [{slug, name, type, series, stats}], dates } for overlay.
 * Each series is normalized to 0-100 relative to that entity's own peak so
 * entities of different scales (100 mentions vs 5) are comparable.
 */
function compareEntitySeries(slugs) {
  const db = getDB();
  if (!db || !Array.isArray(slugs) || slugs.length === 0) return { entities: [], dates: [] };

  const entities = [];
  let sharedDates = null;

  for (const slug of slugs.slice(0, 5)) { // cap at 5 for readability
    const data = getEntitySeries(slug);
    if (!data || !data.entity) continue;
    // Normalize counts to 0-100 relative to peak (so small entities are visible).
    const maxCount = Math.max(1, ...data.series.map(p => p.count || 0));
    const normSeries = data.series.map(p => ({
      date: p.date,
      count: p.count,
      norm: Math.round((p.count / maxCount) * 100),
      burst: p.burst,
    }));
    entities.push({
      slug,
      name: data.entity.canonical_name || slug,
      type: data.entity.entity_type || '',
      series: normSeries,
      stats: data.stats,
    });
    if (!sharedDates) sharedDates = data.series.map(p => p.date);
  }

  return { entities, dates: sharedDates || [] };
}

module.exports = {
  scoreSignals,
  getSignals,
  getTodaySignals,
  getSignalById,
  getSignalTypes,
  getEntityMomentum,
  getEntityItems,
  getEntitySeries,
  compareEntitySeries,
  getEntityCoOccurrence,
  getRadarAudiences,
  personalLensSQL,
  SIGNAL_TYPES,
};
