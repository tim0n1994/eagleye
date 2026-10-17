/**
 * Eagleye — Signal classification
 *
 * Assigns a signal_type to each item: cheap tag/keyword rules first, then a
 * closed-set LLM pass, then a narrower retry for whatever came back
 * uncategorized. Degrades to rules alone when no LLM provider is reachable.
 */

const { getProvider, getLLMConfig } = require('./llm-provider');
const { taskContext, abortableDelay, callWithMetadata, nonEmpty, validateBatch } = require('./llm-shared');

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

async function classifyChunk(chunk, opts = {}) {
  const { retry = false } = opts;
  const context = taskContext(opts, opts.jobId ? require('./jobs') : null);
  context.check();
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
  const maxTokens = Math.min(4096, Math.max(2048, 300 + batch.length * 130));

  // 重试撑过 glm-5.2 间歇性过载(529/1305) 和账户限流(429/1302)
  const maxAttempts = provider.isPool ? 1 : retry ? 2 : 3;
  const allowedIds = new Set(chunk.map(item => item.id));
  const validClassification = row => nonEmpty(row.signal_type || row.category || row.type || row.classification)
    && (normalizeSignalType(row.signal_type || row.category || row.type || row.classification) !== 'uncategorized'
      || (row.signal_type || row.category || row.type || row.classification) === 'uncategorized')
    && typeof (row.thesis_match ?? row.confidence ?? row.score) === 'number'
    && Number.isFinite(row.thesis_match ?? row.confidence ?? row.score)
    && (row.thesis_match ?? row.confidence ?? row.score) >= 0
    && (row.thesis_match ?? row.confidence ?? row.score) <= 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data } = await callWithMetadata(provider, prompt, {
        task: 'classify', signal: context.signal, temperature: 0.1, maxTokens, json: true,
        validate: rows => validateBatch(rows, allowedIds, validClassification),
      });
      context.check();
      return data.filter(validClassification).map(row => ({
        ...row,
        signal_type: normalizeSignalType(row.signal_type || row.category || row.type || row.classification),
        thesis_match: normalizeThesisMatch(row.thesis_match ?? row.confidence ?? row.score),
      }));
    } catch (err) {
      context.check();
      // 1301 内容安全审核：不可恢复，跳过不重试
      if (/1301|invalid_request_error.*安全|敏感内容/i.test(err.message)) {
        if (!retry) console.log(`  ⏭  Signal classification skipped: content filtered by safety check`);
        return [];
      }
      if (!retry) console.warn(`  ⚠  Signal classification attempt ${attempt}/${maxAttempts} failed for chunk:`, err.message.slice(0, 100));
      if (attempt < maxAttempts) {
        await _signalBackoff(attempt, err.message, context.signal);
      } else {
        return [];
      }
    }
  }
  return [];
}

// 529/429 长退避（共享逻辑，与 enrich 一致）
async function _signalBackoff(attempt, errMsg, signal) {
  const isOverload = /429|529|1302|1305|rate.limit|overload|速率限制|访问量过大/i.test(String(errMsg || ''));
  const ms = Math.min(30000, (isOverload ? 8000 : 2000) * attempt);
  await abortableDelay(ms, signal);
}

function classifySignals(items, opts = {}) {
  const context = taskContext(opts, opts.jobId ? require('./jobs') : null);
  if (context.isCancelled()) return Promise.resolve([]);
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
    while (idx < chunks.length && !context.isCancelled()) {
      const i = idx++;
      const out = await classifyChunk(chunks[i], context).catch(() => []);
      if (context.isCancelled()) { results[i] = []; return; }
      const found = new Set(out.map(row => row.id));
      const missing = chunks[i].filter(item => !found.has(item.id));
      const recovered = out.length && missing.length ? await classifyChunk(missing, { ...context, retry: true }).catch(() => []) : [];
      results[i] = [...out, ...recovered];
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
async function classifyUncategorizedRetry(items, opts = {}) {
  const context = taskContext(opts, opts.jobId ? require('./jobs') : null);
  if (context.isCancelled()) return [];
  if (!items?.length) return [];
  const provider = getProvider();
  if (!provider || provider.isPool) return [];
  const retryBatch = Math.max(1, Math.floor(CLASSIFY_BATCH_SIZE / 2));
  const chunks = [];
  for (let i = 0; i < items.length; i += retryBatch) {
    chunks.push(items.slice(i, i + retryBatch));
  }
  const CONCURRENCY = parseInt(process.env.SIGNAL_CLASSIFY_CONCURRENCY || '3', 10);
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < chunks.length && !context.isCancelled()) {
      const i = idx++;
      const out = await classifyChunk(chunks[i], { ...context, retry: true }).catch(() => []);
      results[i] = out;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  // Keep only rows where the retry produced a real (non-uncategorized) type.
  return results.flat().filter(r => r.signal_type && r.signal_type !== 'uncategorized');
}

module.exports = {
  providerAvailable, preClassifyByTags,
  classifySignals, classifyUncategorizedRetry, SIGNAL_TYPES,
};
