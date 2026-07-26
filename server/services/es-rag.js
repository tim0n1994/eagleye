/**
 * Eagleye — ES-powered RAG (Retrieval-Augmented Generation) Service
 *
 * Combines ES kNN semantic search with the project's LLM provider (glm-5.2)
 * to answer questions grounded in the eagleye intelligence corpus.
 *
 * Flow:
 *   user question → ES kNN search (top-N) → assemble context → LLM → answer + sources
 */

const { getProvider } = require('./llm-provider');
const { esAvailable, esRequest, getQueryEmbedding, ES_HOST, ES_INDEX } = require('./elasticsearch');

const RAG_PROMPT = `/no_think
你是 Eagleye 情报助手。请基于以下检索到的科技情报回答用户的问题。

回答要求：
1. 用中文回答
2. 只基于下方提供的情报内容，不要编造或添加情报中没有的信息
3. 引用来源时标注 [1]、[2] 等序号，对应下方情报编号
4. 如果情报不足以回答问题，明确说明"当前情报库中没有足够信息"
5. 保持简洁、有信息密度，不要泛泛而谈

检索到的情报：
{context}

用户问题：{question}`;

const FOLLOWUP_PROMPT = `/no_think
基于以下用户问题和检索到的情报，生成 3 个相关的追问。每个追问一行，用中文，简短（15字以内）。

用户问题：{question}
情报主题：{topics}

输出格式（每行一个问题，不要编号）：`;

const MAX_CONTEXT_DOCS = 10;
const MAX_CONTEXT_CHARS = 8000;

/**
 * Run a RAG query: search ES → rerank → build context → call LLM → generate follow-ups.
 * @param {string} question — user's question
 * @param {object} opts — { mode, source, language, dateFrom }
 * @returns {Promise<{answer, sources, followUpQuestions, total_found, mode, degraded}>}
 */
async function ragChat(question, opts = {}) {
  const mode = opts.mode || 'auto';
  const sources = [];
  let degraded = false;

  // Step 1: Retrieve from ES (with rerank if available)
  if (ES_HOST && await esAvailable().catch(() => false)) {
    try {
      const hits = await retrieveDocs(question, mode, opts);
      sources.push(...hits);
    } catch (e) {
      console.warn('[es-rag] retrieval failed, falling back to pure LLM:', e.message);
      degraded = true;
    }
  } else {
    degraded = true;
  }

  // Step 2: Build context from retrieved docs
  const context = buildContext(sources);

  // Step 3: Generate answer via LLM
  const prompt = RAG_PROMPT
    .replace('{context}', context)
    .replace('{question}', question);

  const provider = getProvider();
  const answer = await provider.call(prompt, { temperature: 0.3 });

  // Step 4: Generate follow-up questions from source topics
  let followUpQuestions = [];
  if (sources.length > 0 && !degraded) {
    try {
      const topics = sources.slice(0, 5).map(s => s.title.slice(0, 40)).join('; ');
      const fp = FOLLOWUP_PROMPT.replace('{question}', question).replace('{topics}', topics);
      const raw = await provider.call(fp, { temperature: 0.5 });
      if (raw) {
        followUpQuestions = raw.split('\n').map(l => l.trim()).filter(l => l.length > 2 && l.length < 50).slice(0, 3);
      }
    } catch { /* follow-ups are optional */ }
  }

  return {
    answer: answer || '(LLM 未返回结果)',
    sources,
    followUpQuestions,
    total_found: sources.length,
    mode: degraded ? 'pure-llm' : mode,
    degraded,
  };
}

/**
 * Retrieve relevant documents from ES using retrievers API (auto = RRF + rerank).
 */
async function retrieveDocs(question, mode, opts) {
  const queryVector = await getQueryEmbedding(question);

  const filterClauses = [];
  if (opts.source) filterClauses.push({ term: { source_label: opts.source } });
  if (opts.language) filterClauses.push({ term: { language: opts.language } });
  if (opts.dateFrom) filterClauses.push({ range: { published_at: { gte: opts.dateFrom } } });

  const body = {
    size: MAX_CONTEXT_DOCS,
    _source: ['title', 'title_zh', 'short_summary_zh', 'one_liner',
              'source_label', 'url', 'published_at', 'sig_alpha', 'language'],
    collapse: { field: 'title.keyword' },
  };

  const mmQuery = { multi_match: { query: question, fields: ['title^3', 'title_zh^3', 'ai_title^2', 'short_summary_zh^2', 'content'], type: 'best_fields' } };

  if (filterClauses.length) {
    body.post_filter = { bool: { filter: filterClauses } };
  }

  // Build retriever (auto → RRF + rerank; semantic → kNN; keyword → BM25; hybrid → RRF)
  const knnR = { knn: { field: 'embedding', query_vector: queryVector, k: 15, num_candidates: 300 } };
  const bm25R = { standard: { query: mmQuery } };

  if (mode === 'semantic') {
    body.retriever = knnR;
  } else if (mode === 'keyword') {
    body.retriever = bm25R;
  } else {
    // auto / hybrid → RRF
    const rrfR = { rrf: { retrievers: [bm25R, knnR], rank_window_size: 100, rank_constant: 20 } };
    if (mode === 'hybrid') {
      body.retriever = rrfR;
    } else {
      // auto → try rerank on top of RRF
      try {
        const rerankId = (require('./es-ai-setup').AI_INFERENCE_IDS || {}).rerank || 'eagleye-rerank';
        body.retriever = {
          text_similarity_reranker: {
            retriever: rrfR,
            field: 'title',
            inference_id: rerankId,
            inference_text: question,
            rank_window_size: 50,
          },
        };
      } catch {
        body.retriever = rrfR;
      }
    }
  }

  const result = await esRequest('POST', `/${ES_INDEX}/_search`, body);
  return (result.hits?.hits || []).map(h => ({
    title: h._source.title_zh || h._source.title || '',
    summary: h._source.short_summary_zh || h._source.one_liner || '',
    source: h._source.source_label || '',
    url: h._source.url || '',
    date: h._source.published_at || '',
    alpha: h._source.sig_alpha,
    score: h._score,
    language: h._source.language,
  }));
}

/**
 * Assemble retrieved docs into a numbered context string for the LLM prompt.
 */
function buildContext(sources) {
  if (!sources.length) return '(未检索到相关情报)';

  const lines = [];
  let totalChars = 0;
  for (let i = 0; i < sources.length && totalChars < MAX_CONTEXT_CHARS; i++) {
    const s = sources[i];
    const title = s.title.slice(0, 120);
    const summary = (s.summary || '').slice(0, 300);
    const line = `[${i + 1}] [${s.source}] ${title}${summary ? ' — ' + summary : ''}`;
    lines.push(line);
    totalChars += line.length;
  }
  return lines.join('\n');
}

module.exports = { ragChat };
