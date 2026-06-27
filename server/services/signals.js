/**
 * Alpha Radar — Signal Scoring Engine
 *
 * Computes multi-dimensional signal scores for information items and
 * classifies them into investment/research signal types.
 */

const { getDB } = require('../db/connection');
const { getProvider } = require('./llm-provider');

const SIGNAL_TYPES = [
  'origin_signal', 'new_repo', 'new_paper', 'model_release',
  'benchmark_claim', 'architecture_shift', 'narrative_shift',
  'velocity_spike', 'novel_combination', 'contradiction',
  'funding_signal', 'hiring_signal',
  'supply_chain', 'agent_signal',
];

// Batch size per LLM classify call — keeps output well under token limits
// so the JSON array is never truncated mid-stream.
const CLASSIFY_BATCH_SIZE = 20;

const SIGNAL_CLASSIFIER_PROMPT = `/no_think
你是投研信号分类员。根据每条信息的标题、摘要和来源，判断它属于哪种投研信号类型。

信号类型定义（必须从这 14 类中选一个）：
- origin_signal: 核心开发者/创始人首次透露新方向、新架构、roadmap、产品发布、宣布推出
- new_repo: 新发现的高价值开源仓库
- new_paper: 新发布的学术论文、研究、复现工作
- model_release: 新模型/权重/checkpoint/蒸馏/微调版本发布
- benchmark_claim: 性能声明、benchmark 变化、SOTA 更新、排名对比
- architecture_shift: 技术架构范式发生根本变化、新范式讨论
- narrative_shift: 社区共识叙事正在迁移、趋势转变
- velocity_spike: 某个话题/实体突然爆发式讨论、热门
- novel_combination: 以前很少关联的概念/实体开始组合出现
- contradiction: 与主流叙事或普遍认知矛盾的证据、打脸、翻车、被高估
- funding_signal: 融资、收购、投资、IPO、上市、并购动态
- hiring_signal: 关键招聘、团队变动、离职、裁员
- supply_chain: 硬件/供应链/产业链/产能动态
- agent_signal: AI agent/智能体/MCP/工具调用/自主代理进展

关键规则：
1. 每条必须从上述 14 类中选一个最匹配的。只有完全无关 AI/科技投资信号时才用 "uncategorized"。
2. 宁可归类也不要 uncategorized —— 大多数技术内容都能归入上述某一类。
3. 如果一条同时像多类，选最具体、最具投资行动价值的那类（例如"新模型在 benchmark 超越 GPT"选 benchmark_claim 而非 model_release）。
4. thesis_match 反映这条信号的投资研究价值：0.9=极强，0.7=较强，0.5=一般，0.3=弱。

示例：
输入 {"id":"a1","title":"@karpathy: announcing Eureka Labs","summary":"教育AI初创公司正式推出","source":"x-following"}
输出 {"id":"a1","signal_type":"origin_signal","thesis_match":0.8,"reason_zh":"创始人宣布新方向"}

输入 {"id":"a2","title":"DeepSeek-R1 复现报告","summary":"7B模型纯强化学习复现DeepSeek-R1","source":"hugging-face"}
输出 {"id":"a2","signal_type":"new_paper","thesis_match":0.75,"reason_zh":"论文复现工作"}

输入 {"id":"a3","title":"Anthropic 提交 S-1","summary":" confidentially submits draft S-1 to SEC","source":"hacker-news"}
输出 {"id":"a3","signal_type":"funding_signal","thesis_match":0.85,"reason_zh":"IPO 上市进程"}

输入为 JSON 数组，每项 {id, title, summary, source}。
输出严格 JSON 数组，每项 {id, signal_type, thesis_match(0-1的数字), reason_zh(一句话中文)}。不要输出 Markdown 或思考过程。`;

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
  return 'uncategorized';
}

// Coerce a thesis_match value that may be a number, boolean, or string into 0-1.
function normalizeThesisMatch(raw) {
  if (typeof raw === 'boolean') return raw ? 0.7 : 0.3;
  const n = Number(raw);
  if (!Number.isNaN(n)) return Math.max(0, Math.min(1, n));
  return 0.5;
}

async function classifyChunk(chunk) {
  const provider = getProvider();
  if (!provider || !chunk?.length) return [];

  const batch = chunk.map(item => ({
    id: item.id,
    title: String(item.title || '').slice(0, 200),
    summary: String(item.ai_summary?.short_summary || item.ai_summary?.one_liner || item.ai_summary?.ai_title || '').slice(0, 300),
    source: String(item.source_slug || '').slice(0, 60),
  }));

  const prompt = SIGNAL_CLASSIFIER_PROMPT + '\n\n输入：' + JSON.stringify(batch);
  // 20 items × ~120 tokens each for output; cap at a safe ceiling.
  const maxTokens = Math.min(4096, 300 + batch.length * 130);

  try {
    const text = await provider.call(prompt, { temperature: 0.1, maxTokens, json: true });
    if (!text) {
      console.warn('  ⚠  Signal classifier returned empty response for chunk of', batch.length);
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
      console.warn('  ⚠  Signal classifier: no JSON array found in response:', clean.slice(0, 200));
      return [];
    }
    const data = JSON.parse(match[0]);
    const byId = new Map(chunk.map(i => [i.id, i]));
    return data.filter(r => r && byId.has(r.id)).map(r => ({
      ...r,
      signal_type: normalizeSignalType(r.signal_type),
      thesis_match: normalizeThesisMatch(r.thesis_match),
    }));
  } catch (err) {
    console.warn('  ⚠  Signal classification failed for chunk:', err.message);
    return [];
  }
}

function classifySignals(items) {
  // Chunk items to keep each LLM call's output within token limits.
  const chunks = [];
  for (let i = 0; i < items.length; i += CLASSIFY_BATCH_SIZE) {
    chunks.push(items.slice(i, i + CLASSIFY_BATCH_SIZE));
  }
  return Promise.all(chunks.map(c => classifyChunk(c).catch(() => [])))
    .then(results => results.flat());
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

function computeNovelty(item, db) {
  if (!item.created_at && !item.published_at) return 0.5;
  const ts = item.created_at || item.published_at;
  const daysSince = Math.max(0, (Date.now() - new Date(ts).getTime()) / 86400000);
  return Math.max(0, 1 - (Math.min(daysSince, 90) / 90));
}

function computeVelocity(item, db) {
  try {
    const row = db.prepare(`SELECT COUNT(*) as cnt FROM information_items
      WHERE digest_date = ? AND id != ?`).get(item.digest_date, item.id);
    const sameDay = row?.cnt || 0;
    return Math.min(1, sameDay / 15);
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
      { type: 'origin_signal', kw: ['first time', 'just released', 'announcing', 'introducing', 'announces', 'unveils', 'debut', 'launch', 'roadmap', '路线图', '新方向', '首次', '首次公布', '首次透露', '发布', '宣布', '推出', '上线'] },
      { type: 'contradiction', kw: ['not true', 'actually wrong', 'actually false', 'debunk', 'misunderstanding', 'contrary', 'myth', 'overhyped', 'overrated', '误区', '误解', '打脸', '翻车', '被高估', '并不', '并非', '真正'] },
      { type: 'funding_signal', kw: ['funding', 'raise', 'series', 'seed', 'investment', 'investor', 's-1', 'ipo', 'merger', 'buy', 'valuation', '融资', '估值', '上市', '招股', '合并', '并购', '被收购', '收购', '投资', '美元', 'million', 'billion', '亿'] },
      { type: 'hiring_signal', kw: ['hiring', 'join', 'team is growing', 'we are looking', 'depart', 'resign', 'steps down', 'appoint', '招聘', '招人', '离职', '任命', '裁员', 'laid off'] },
      { type: 'new_repo', kw: ['github.com/', 'github repo', 'open source', 'open-source', '开源', 'repository', '仓库', ' git ', 'github', '新项目'] },
      { type: 'new_paper', kw: ['arxiv', 'paper', '论文', 'research paper', 'preprint', 'academic', 'arxiv.org', 'survey', 'study', '研究', 'replicate', 'reproduce', '复现', '复刻'] },
      { type: 'model_release', kw: ['release', 'new model', 'publish', 'checkpoint', 'weights', 'drops', 'distill', 'finetune', 'fine-tune', 'lora', 'quantiz', '发布模型', '开源模型', '蒸馏', '微调', '权重', 'model', 'models', 'llm', 'gpt'] },
      { type: 'benchmark_claim', kw: ['benchmark', 'sota', 'state-of-the-art', 'outperform', 'accuracy', 'beats', 'performance', 'leaps', 'ties', 'leaderboard', '基准', '评测', '超越', '超过', '领先', '第一', '排名', '榜单', '碾压', '秒杀', '#1', '#2', 'score'] },
      { type: 'architecture_shift', kw: ['architecture', 'paradigm', 'shift', 'rethinking', 'from scratch', 'rl is the new', 'reinforcement learning', 'scaling law', 'rewrite', '架构', '重新设计', '范式', '强化学习', '预训练', '重写'] },
      { type: 'narrative_shift', kw: ['is dead', 'no longer', 'everyone is', 'the end of', 'trend', 'shift', 'moving from', 'is over', 'era of', 'consensus', '趋势', '转变', '改变', '共识', '叙事', '拐点'] },
      { type: 'velocity_spike', kw: ['trending', 'viral', 'exploding', '火', '热门', '爆火'] },
      { type: 'novel_combination', kw: ['combined with', 'integrated', 'together with', 'meets', 'hybrid', '融合', '结合', '混合', '嫁接'] },
      { type: 'agent_signal', kw: ['agent', '智能体', 'mcp', 'tool use', '工具调用', 'autonomous', '自主'] },
      { type: 'supply_chain', kw: ['supply chain', '供应链', '产能', 'capacity', '出货', '晶圆', 'wafer', 'photonics', '光子'] },
    ];

    // Source-specific signals — applied before keyword matching so that
    // structurally-predictable sources (arXiv, app store, photonics feed)
    // don't depend on lucky keyword hits in terse titles.
    if (source === 'github-trending') return { signal_type: 'new_repo', thesis_match: 0.65, reason_zh: '来源：GitHub Trending' };
    if (source === 'hugging-face') return { signal_type: 'new_paper', thesis_match: 0.6, reason_zh: '来源：Hugging Face' };
    if (source === 'product-hunt') return { signal_type: 'origin_signal', thesis_match: 0.55, reason_zh: '来源：Product Hunt' };
    if (source === 'arxiv-ai' || source === 'physical-ai-arxiv') return { signal_type: 'new_paper', thesis_match: 0.6, reason_zh: '来源：arXiv' };
    if (source === 'physical-ai-cn-photonics') return { signal_type: 'supply_chain', thesis_match: 0.45, reason_zh: '来源：光电子产业链' };
    if (source === 'app-store-rank') return { signal_type: 'velocity_spike', thesis_match: 0.4, reason_zh: '来源：App Store 排名变动' };

    for (const p of patterns) {
      if (p.kw.some(k => text.includes(k) || title.includes(k))) {
        return { signal_type: p.type, thesis_match: 0.55, reason_zh: `规则匹配：${p.type}` };
      }
    }

    return { signal_type: 'uncategorized', thesis_match: 0.3, reason_zh: '' };
  }

  const ruleById = new Map();
  for (const item of classifierItems) ruleById.set(item.id, ruleClassify(item));

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

      const alpha = (
        0.25 * thesisMatch +
        0.20 * item.novelty +
        0.15 * actionability +
        0.15 * item.crossSource +
        0.10 * item.sourceScore +
        0.10 * item.velocity +
        0.05 * (item.novelty > 0.8 ? 1 : 0)
      );

      const consensusPenalty = Math.min(0.3,
        (item.crossSource > 0.8 ? 0.15 : 0) +
        (item.velocity > 0.7 ? 0.1 : 0)
      );

      const finalAlpha = Math.max(0, Math.min(1, alpha - consensusPenalty));

      insertScore.run(
        item.id, signalType, item.novelty, item.velocity, item.crossSource,
        item.sourceScore, thesisMatch, actionability, finalAlpha,
        consensusPenalty, cls.reason_zh || null
      );
    }
  });

  writeTx();
  return { scored: classifierItems.length };
}

function getSignals(opts = {}) {
  const db = getDB();
  if (!db) return [];

  const { signalType, date, sortBy = 'alpha_score', limit = 50, offset = 0, sinceDays } = opts;

  let sql = `
    SELECT ss.*, i.title, i.canonical_url, i.published_at, i.score,
           s.label as source_label, s.slug as source_slug,
           a.one_liner, a.short_summary, a.ai_title
    FROM signal_scores ss
    JOIN information_items i ON ss.item_id = i.id
    JOIN sources s ON i.source_id = s.id
    LEFT JOIN ai_summaries a ON a.item_id = i.id
    WHERE 1=1
  `;
  const params = [];

  if (signalType && signalType !== 'all') {
    sql += ' AND ss.signal_type = ?';
    params.push(signalType);
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

  sql += ` ORDER BY ss.${sortBy === 'novelty' ? 'novelty_score' : sortBy === 'velocity' ? 'velocity_score' : 'alpha_score'} DESC LIMIT ? OFFSET ?`;
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
           a.ai_title, a.ai_title_zh
    FROM signal_scores ss
    JOIN information_items i ON ss.item_id = i.id
    JOIN sources s ON i.source_id = s.id
    LEFT JOIN ai_summaries a ON a.item_id = i.id
    WHERE ss.item_id = ?
  `).get(itemId);

  if (signal) {
    signal.topics = db.prepare(`
      SELECT t.slug, t.name FROM item_topics it
      JOIN topics t ON it.topic_id = t.id WHERE it.item_id = ?
    `).all(itemId);
    // Entities via KG v2 (canonical_entities), with 7d momentum if available.
    signal.entities = db.prepare(`
      SELECT ce.canonical_name as name, ce.entity_type as type,
             em.velocity_zscore as zscore, em.mention_count
      FROM entity_mentions em
      JOIN entity_links el ON el.mention_id = em.id
      JOIN canonical_entities ce ON ce.id = el.entity_id
      LEFT JOIN entity_momentum em2 ON em2.entity_id = ce.id AND em2.window = '7d'
      WHERE em.item_id = ?
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
 * Trending entities ranked by velocity_zscore for a given time window.
 * Used by the intelligence/momentum leaderboard on the home page.
 */
function getEntityMomentum(window = '7d', limit = 20) {
  const db = getDB();
  if (!db) return [];

  return db.prepare(`
    SELECT ce.canonical_name as name, ce.canonical_slug as slug, ce.entity_type as type,
           em.mention_count, em.unique_sources, em.high_quality_mentions,
           em.velocity_zscore as zscore
    FROM entity_momentum em
    JOIN canonical_entities ce ON ce.id = em.entity_id
    WHERE em.window = ? AND em.mention_count >= 2
    ORDER BY em.velocity_zscore DESC, em.mention_count DESC
    LIMIT ?
  `).all(window, limit);
}

module.exports = {
  scoreSignals,
  getSignals,
  getTodaySignals,
  getSignalById,
  getSignalTypes,
  getEntityMomentum,
  SIGNAL_TYPES,
};
