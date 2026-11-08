/**
 * Eagleye — AI Education feed
 *
 * Derives an AI-education briefing from the existing information_items corpus.
 * An item is included only when BOTH gates hold:
 *   1. AI evidence — an explicit AI/ML term in title or summary text.
 *   2. Education evidence — an explicit education term AFTER stripping ML
 *      compounds, so "machine learning" never counts as "education".
 *
 * Two indexed date walks first select education-related titles, then join
 * the smaller candidate set to summaries and paper metadata. A generous cap
 * protects the synchronous SQLite server; if reached, the UI must say counts
 * are partial. Title-based recall intentionally trades completeness for
 * relevance and supports Chinese terms shorter than FTS5 trigram tokens.
 *
 * Categories use a fixed priority: research > policy > teaching_practice >
 * learning_product. Items passing both gates but matching no category signal
 * are dropped (no forced bucketing). paper_metadata is optional at query time
 * so the feed works on DBs predating migration 013.
 */

const CATEGORY_KEYS = ['teaching_practice', 'learning_product', 'research', 'policy'];

// Sources whose items are arXiv papers by construction. Only consulted AFTER
// an item passes the AI+education gates — never a relevance bypass.
const PAPER_SOURCE_SLUGS = ['hugging-face', 'arxiv-ai', 'education-arxiv', 'physical-ai-arxiv'];

// --- AI evidence (run on the ORIGINAL text) ---
const AI_PATTERNS = [
  { re: /\bAI\b/, label: 'AI' },
  { re: /\bGPT[-\s]?\d(?:\.\d)?\b|\bGPTs?\b/i, label: 'GPT' },
  { re: /\bChatGPT\b/i, label: 'ChatGPT' },
  { re: /\bClaude\b/, label: 'Claude' },
  { re: /\bGemini\b/, label: 'Gemini' },
  { re: /\bLLMs?\b/i, label: 'LLM' },
  { re: /\bOpenAI\b/, label: 'OpenAI' },
  { re: /\bAnthropic\b/, label: 'Anthropic' },
  { re: /\bCopilot\b/i, label: 'Copilot' },
  { re: /\bDeepSeek\b/i, label: 'DeepSeek' },
  { re: /\bQwen\b/i, label: 'Qwen' },
  { re: /\bLlama\b/i, label: 'Llama' },
  { re: /\bHugging Face\b/i, label: 'Hugging Face' },
  { re: /\bmachine learning\b/i, label: 'machine learning' },
  { re: /\bdeep learning\b/i, label: 'deep learning' },
  { re: /\bneural networks?\b/i, label: 'neural network' },
  { re: /\bgenerative AI\b/i, label: 'generative AI' },
  { re: /\bartificial intelligence\b/i, label: 'artificial intelligence' },
  { re: /\bmultimodal\b|\bmulti-modal\b/i, label: 'multimodal' },
  { re: /\bRAG\b/, label: 'RAG' },
  { re: /\bprompt engineering\b/i, label: 'prompt engineering' },
  { re: /\bchatbots?\b/i, label: 'chatbot' },
  { re: /\bAI[- ](?:agent|assistant|tutor|tutoring|chatbot|companion|grading|feedback|tool|feature|model)\b/i, label: 'AI tool' },
  { re: /人工智能/, label: '人工智能' },
  { re: /大(?:语言)?模型/, label: '大模型' },
  { re: /生成式/, label: '生成式' },
  { re: /智能体/, label: '智能体' },
  { re: /机器学习/, label: '机器学习' },
  { re: /深度学习/, label: '深度学习' },
  { re: /神经网络/, label: '神经网络' },
  { re: /多模态/, label: '多模态' },
];

// ML compounds stripped BEFORE education/category matching. Without this,
// every "machine learning" headline would read as "learning" = education, and
// RL "policy" terms would fire the policy category.
const ML_COMPOUNDS = [
  'machine learning', 'deep learning', 'reinforcement learning', 'supervised learning',
  'unsupervised learning', 'semi-supervised learning', 'self-supervised learning',
  'federated learning', 'contrastive learning', 'meta-learning', 'transfer learning',
  'active learning', 'curriculum learning', 'representation learning', 'continual learning',
  'lifelong learning', 'incremental learning', 'online learning',
  'learning rate', 'learning algorithms?', 'learning models?', 'learning-based',
  'policy gradients?', 'policy networks?', 'policy iteration', 'policy optimization', 'policy evaluation',
  'white paper', 'white-paper', 'whitepaper', 'newspaper', 'paperwork',
  '机器学习', '深度学习', '强化学习', '迁移学习', '联邦学习', '元学习', '自监督学习',
  '监督学习', '无监督学习', '半监督学习', '对比学习', '课程学习', '持续学习',
  '终身学习', '增量学习', '表示学习', '学习率', '学习算法', '学习模型',
];
const STRIP_RE = new RegExp(ML_COMPOUNDS.join('|'), 'gi');

// --- Education evidence (run on the STRIPPED text; no bare "learning") ---
const EDU_PATTERNS = [
  { re: /\beducation(?:al)?\b|\beducators?\b|\beducate\b/i, label: 'education' },
  { re: /\bclassrooms?\b/i, label: 'classroom' },
  { re: /\bteachers?\b|\bteaching\b|\bteaches\b/i, label: 'teacher' },
  { re: /\bstudents?\b|\bpupils?\b/i, label: 'student' },
  { re: /\bschools?\b|\bpreschool\b|\bkindergarten\b/i, label: 'school' },
  { re: /\bK[-\u2010-\u2015]?12\b/i, label: 'K-12' },
  { re: /\buniversity|\buniversities\b|\bcolleges?\b|\bcampus\b|\bhigher[- ]education\b|\bundergraduate|\bgrad students\b/i, label: 'university' },
  { re: /\bcurricula\b|\bcurriculum\b|\bsyllab(?:us|i)\b/i, label: 'curriculum' },
  { re: /\bhomework\b|\bassignments?\b/i, label: 'homework' },
  { re: /\btutoring\b|\btutors?\b|\btutor(?!ial)/i, label: 'tutor' },
  { re: /\bexams?\b|\bexaminations?\b|\btest prep\b/i, label: 'exam' },
  { re: /\bpedagog(?:y|ical)\b|\bandragogy\b/i, label: 'pedagogy' },
  { re: /\bMOOCs?\b|\bEdTech\b|\bE-?learning\b/i, label: 'e-learning' },
  { re: /\blesson plans?\b/i, label: 'lesson plan' },
  { re: /\blearners?\b|\bself-study\b/i, label: 'learner' },
  { re: /教育/, label: '教育' },
  { re: /课堂/, label: '课堂' },
  { re: /教师|老师|师资/, label: '教师' },
  { re: /教学/, label: '教学' },
  { re: /学生|学员/, label: '学生' },
  { re: /学校|校园|高校|大学|中学|小学|幼儿园|学前/, label: '学校' },
  { re: /课程|课纲|教材|课件|教案/, label: '课程' },
  { re: /辅导|补习|家教|培训/, label: '培训' },
  { re: /考试|应试|备考/, label: '考试' },
  { re: /教研|教培|在线教育|网课|慕课|双师|智慧课堂|双减/, label: '教培' },
  { re: /学习者/, label: '学习者' },
];

// --- Category signals (run on the STRIPPED text; fixed priority order) ---
const RESEARCH_PATTERNS = [
  { re: /\barxiv\b/i, label: 'arXiv' },
  { re: /\bpreprints?\b/i, label: 'preprint' },
  { re: /\bpapers?\b/i, label: 'paper' },
  { re: /\bpeer[- ]review|\bproceedings\b|\bconference paper|\baccepted at|\bjournal\b/i, label: 'venue' },
  { re: /\bbenchmarks?\b/i, label: 'benchmark' },
  { re: /\bdatasets?\b/i, label: 'dataset' },
  { re: /论文|预印本|文献|综述/, label: '论文' },
  { re: /基准|数据集/, label: '基准' },
];
const POLICY_PATTERNS = [
  { re: /\bpolic(?:y|ies)\b/i, label: 'policy' },
  { re: /\bregulations?\b|\bregulators?\b|\bministry\b|\bdepartment of education\b/i, label: 'regulation' },
  { re: /\bexecutive order\b|\bwhite house\b|\bEU AI Act\b/i, label: 'government' },
  { re: /\bbann?(?:s|ed|ning)?\b|\bbills?\b|\blegislation\b|\bstatute\b|\bguidelines?\b/i, label: 'ban' },
  { re: /教育部|政策|监管|禁令|条例|法规|立法|指导意见|纲要/, label: '政策' },
];
const TEACHING_PATTERNS = [
  { re: /\bclassrooms?\b|\bpedagog(?:y|ical)\b|\blesson plans?\b|\bsyllab(?:us|i)\b/i, label: 'classroom' },
  { re: /\bhow (?:i|we) teach\b|\bteaching (?:methods?|practice|workflow|strateg)/i, label: 'teaching' },
  { re: /备课|教研|教学法|课堂|教案|教学(?:方法|实践|设计)|智慧课堂|双师/, label: '课堂' },
];
const PRODUCT_PATTERNS = [
  { re: /\blaunch(?:es|ed|ing)?\b|\breleas(?:e|es|ed|ing)\b|\brollout\b|\broll out\b/i, label: 'launch' },
  { re: /\bapps?\b|\bplatforms?\b|\btoolkits?\b|\btools?\b|\bpricing\b|\bsubscriptions?\b|\bfreemium\b|\bbeta\b/i, label: 'product' },
  { re: /\bfund(?:ing|ed|raise[ds]?)\b/i, label: 'funding' },
  { re: /上线|发布|推出|产品|平台|工具|订阅|收费|融资|公测/, label: '产品' },
];

function collectMatches(text, patterns, cap = 8) {
  const labels = [];
  for (const entry of patterns) {
    if (entry.re.test(text) && !labels.includes(entry.label)) labels.push(entry.label);
    if (labels.length >= cap) break;
  }
  return labels;
}

function isPaperProvenance(row) {
  return Boolean(row.arxiv_id || row.venue || row.doi) || PAPER_SOURCE_SLUGS.includes(row.source_slug);
}

function classifyItem(row, text, stripped) {
  const aiTerms = collectMatches(text, AI_PATTERNS);
  if (aiTerms.length === 0) return null;
  // A university affiliation, benchmark exam or "student" model mentioned
  // in a long abstract is not evidence that the story is about education.
  // Require instructional context in the headline itself.
  const headline = [row.title, row.title_zh].filter(Boolean).join(' ').replace(STRIP_RE, ' ');
  const strongEducation = /\beducat(?:ion|ional|ors?)\b|\bclassrooms?\b|\btutors?\b|\btutoring\b|\bschools?\b|\bkindergarten\b|\bcurricul(?:um|a)\b|\bsyllab(?:us|i)\b|\bhomework\b|\bpedagog(?:y|ical)\b|\blesson\b|\bEdTech\b|\bK[-\u2010-\u2015]?12\b|教育|课堂|教学|教师|老师|课程|教案|教材|教培|辅导|补习|家教|网课|慕课|学校|小学|中学|幼儿园|学习者/i.test(headline)
    || /\b(?:student|learner|teacher)s?\b/i.test(headline) && /\b(?:learning|class|course|lesson|school|teach|tutor|education|university)\b/i.test(headline) && !/\b(?:distillation|student model|teacher model)\b/i.test(headline);
  if (!strongEducation) return null;
  const eduTerms = collectMatches(headline, EDU_PATTERNS);
  if (eduTerms.length === 0) return null;

  let category = null;
  let reason = null;
  if (isPaperProvenance(row) || collectMatches(stripped, RESEARCH_PATTERNS).length > 0) {
    category = 'research';
    reason = isPaperProvenance(row) ? 'paper' : 'paper-topic';
  } else if (collectMatches(stripped, POLICY_PATTERNS).length > 0) {
    category = 'policy';
    reason = 'policy';
  } else if (collectMatches(stripped, TEACHING_PATTERNS).length > 0) {
    category = 'teaching_practice';
    reason = 'classroom';
  } else if (collectMatches(stripped, PRODUCT_PATTERNS).length > 0) {
    category = 'learning_product';
    reason = 'product';
  }
  if (!category) return null;

  return { aiTerms, eduTerms, category, reason };
}

function buildText(row) {
  return [
    row.title, row.title_zh, row.one_liner, row.one_liner_zh, row.short_summary_zh,
    (row.original_summary || '').slice(0, 400),
    (row.abstract || '').slice(0, 400),
  ].filter(Boolean).join(' ');
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const PRIMARY_SCAN_CAP = 10000;
const NULL_DATE_SCAN_CAP = 1000;
// One precompiled predicate is much cheaper than dozens of LIKE expressions
// for every title. Trigram FTS alone cannot recall two-character Chinese.
const TITLE_CANDIDATE_RE = /educat|classroom|tutor|school|kindergarten|curricul|syllab|homework|pedagog|lesson|edtech|k-12|student|learner|teacher|教育|课堂|教学|教师|老师|课程|教案|教材|教培|辅导|补习|家教|网课|慕课|学校|小学|中学|幼儿园|学习者|学生|学员/i;
const registeredDatabases = new WeakSet();
function registerTitlePredicate(db) {
  if (registeredDatabases.has(db)) return;
  db.function('education_title_candidate', { deterministic: true }, (title, titleZh) =>
    TITLE_CANDIDATE_RE.test(`${title || ''} ${titleZh || ''}`) ? 1 : 0);
  registeredDatabases.add(db);
}

function buildSelect(paperCols, paperJoin, sourceFilter, whereDate, orderDate, cap, indexName) {
  return [
    'WITH candidates AS MATERIALIZED (',
    // Without this hint SQLite can choose the low-selectivity duplicate_of
    // index and scan the entire corpus before sorting the requested window.
    `  SELECT i.* FROM information_items i INDEXED BY ${indexName}`,
    '  WHERE i.duplicate_of IS NULL', whereDate, sourceFilter,
    '    AND education_title_candidate(i.title, i.title_zh) = 1',
    '  ORDER BY ' + orderDate + ' DESC LIMIT ' + (cap + 1),
    ')',
    'SELECT i.id, i.title, i.title_zh, i.canonical_url, i.published_at, i.digest_date, i.created_at,',
    '       i.language, i.author, i.score, i.original_summary,',
    '       s.label AS source_label, s.slug AS source_slug,',
    '       a.one_liner, a.one_liner_zh, a.short_summary_zh',
    paperCols,
    '  FROM candidates i',
    '  JOIN sources s ON s.id = i.source_id',
    '  LEFT JOIN ai_summaries a ON a.item_id = i.id',
    paperJoin,
    '  ORDER BY ' + orderDate + ' DESC',
  ].filter(Boolean).join('\n');
}

/**
 * Query the bounded window and classify candidates.
 * Returns { items, categories, stats } — pure data, no HTTP concerns.
 */
function getEducationFeed(db, opts = {}) {
  registerTitlePredicate(db);
  const days = clampInt(opts.days, 1, 180, 30);
  const limit = clampInt(opts.limit, 1, 120, 50);
  const offset = clampInt(opts.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const category = CATEGORY_KEYS.includes(opts.category) ? opts.category : null;
  const sourceSlug = typeof opts.source === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(opts.source) ? opts.source : null;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const sourceFilter = sourceSlug ? '    AND i.source_id = (SELECT id FROM sources WHERE slug = ?)' : '';

  const paperCols = ', pm.arxiv_id, pm.venue, pm.pdf_url, pm.doi, pm.abstract';
  const noPaperCols = ', NULL AS arxiv_id, NULL AS venue, NULL AS pdf_url, NULL AS doi, NULL AS abstract';
  const paperJoin = '  LEFT JOIN paper_metadata pm ON pm.item_id = i.id';
  const params = sourceSlug ? [cutoff, sourceSlug] : [cutoff];

  const primarySql = buildSelect(paperCols, paperJoin, sourceFilter,
    '    AND i.published_at >= ?', 'i.published_at', PRIMARY_SCAN_CAP, 'idx_items_published_at');
  const nullDateSql = buildSelect(noPaperCols, '', sourceFilter,
    '    AND i.published_at IS NULL AND i.created_at >= ?', 'i.created_at', NULL_DATE_SCAN_CAP, 'idx_items_created_at');

  let rows;
  let truncated;
  try {
    const primary = db.prepare(primarySql).all(...params);
    const missingDates = db.prepare(nullDateSql).all(...params);
    truncated = primary.length > PRIMARY_SCAN_CAP || missingDates.length > NULL_DATE_SCAN_CAP;
    rows = primary.slice(0, PRIMARY_SCAN_CAP).concat(missingDates.slice(0, NULL_DATE_SCAN_CAP));
  } catch (err) {
    if (!/no such table: paper_metadata/.test(err.message)) throw err;
    const fallbackPrimary = buildSelect(noPaperCols, '', sourceFilter,
      '    AND i.published_at >= ?', 'i.published_at', PRIMARY_SCAN_CAP, 'idx_items_published_at');
    const primary = db.prepare(fallbackPrimary).all(...params);
    const missingDates = db.prepare(nullDateSql).all(...params);
    truncated = primary.length > PRIMARY_SCAN_CAP || missingDates.length > NULL_DATE_SCAN_CAP;
    rows = primary.slice(0, PRIMARY_SCAN_CAP).concat(missingDates.slice(0, NULL_DATE_SCAN_CAP));
  }
  rows.sort((a, b) => {
    const ta = a.published_at || a.created_at || '';
    const tb = b.published_at || b.created_at || '';
    if (ta === tb) return (b.score || 0) - (a.score || 0);
    return ta < tb ? 1 : -1;
  });

  const allMatched = [];
  const seen = new Set();
  const counts = {};
  for (const key of CATEGORY_KEYS) counts[key] = 0;
  for (const row of rows) {
    const text = buildText(row);
    if (!text) continue;
    const stripped = text.replace(STRIP_RE, ' ');
    const verdict = classifyItem(row, text, stripped);
    if (!verdict) continue;
    let dedupeKey = row.canonical_url || row.id;
    try {
      const url = new URL(dedupeKey);
      url.hash = '';
      if (url.hostname === 'arxiv.org' || url.hostname === 'www.arxiv.org') {
        dedupeKey = `arxiv:${url.pathname.replace(/v\d+$/, '')}`;
      } else dedupeKey = `${url.hostname}${url.pathname.replace(/\/$/, '')}${url.search}`;
    } catch { /* Keep the original key for malformed URLs. */ }
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    counts[verdict.category] += 1;
    allMatched.push({
      id: row.id,
      title: row.title,
      title_zh: row.title_zh || '',
      url: row.canonical_url,
      source_label: row.source_label,
      source_slug: row.source_slug,
      published_at: row.published_at,
      digest_date: row.digest_date,
      one_liner: row.one_liner || '',
      one_liner_zh: row.one_liner_zh || '',
      short_summary_zh: row.short_summary_zh || '',
      original_summary: (row.original_summary || '').slice(0, 400),
      language: row.language || '',
      author: row.author || '',
      score: row.score || 0,
      category: verdict.category,
      matched: { ai_terms: verdict.aiTerms, edu_terms: verdict.eduTerms, category_reason: verdict.reason },
      paper: (row.arxiv_id || row.venue) ? { arxiv_id: row.arxiv_id || '', venue: row.venue || '', pdf_url: row.pdf_url || '', doi: row.doi || '' } : null,
    });
  }

  const filtered = category ? allMatched.filter((item) => item.category === category) : allMatched;
  return {
    items: filtered.slice(offset, offset + limit),
    allItems: allMatched,
    categories: CATEGORY_KEYS.map((key) => ({ key, count: counts[key] })),
    stats: { total: filtered.length, window_days: days, scanned: rows.length, matched: allMatched.length, truncated },
  };
}

module.exports = { getEducationFeed, CATEGORY_KEYS };
