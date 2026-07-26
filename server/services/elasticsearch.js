/**
 * Eagleye — Elasticsearch Service
 *
 * Thin client over the Alibaba Cloud ES instance (or any ES 8.x+).
 * Uses Node's built-in fetch — zero npm dependencies.
 *
 * Env vars:
 *   ES_HOST  — e.g. http://es-cn-xxx.public.elasticsearch.aliyuncs.com:9200
 *   ES_USER  — default "elastic"
 *   ES_PASS  — password
 *   ES_INDEX — index name, default "eagleye"
 */

const { getDB } = require('../db/connection');

const ES_HOST = process.env.ES_HOST || '';
const ES_USER = process.env.ES_USER || 'elastic';
const ES_PASS = process.env.ES_PASS || '';
const ES_INDEX = process.env.ES_INDEX || 'eagleye';

// ─── Internal helpers ────────────────────────────────────

function authHeader() {
  if (!ES_USER && !ES_PASS) return {};
  const token = Buffer.from(`${ES_USER}:${ES_PASS}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

async function esRequest(method, path, body) {
  const url = `${ES_HOST}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    signal: AbortSignal.timeout(10000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw Object.assign(new Error(`ES ${res.status}: ${json.error?.type || text.slice(0, 200)}`), { status: res.status, body: json });
  return json;
}

// ─── Public API ──────────────────────────────────────────

/** Quick connectivity check (2s timeout). Returns boolean. */
async function esAvailable() {
  if (!ES_HOST) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${ES_HOST}/`, {
      headers: authHeader(),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/** Full cluster health for the status indicator. */
async function esHealth() {
  const [root, health] = await Promise.all([
    esRequest('GET', '/'),
    esRequest('GET', '/_cluster/health'),
  ]);
  return {
    connected: true,
    status: health.status,
    cluster: health.cluster_name,
    nodes: health.number_of_nodes,
    version: root.version?.number,
    index: ES_INDEX,
  };
}

/**
 * Execute a search against the eagleye index with aggregations always attached.
 * @param {object} opts
 *   q         — search query string
 *   mode      — 'auto' | 'keyword' | 'semantic' | 'hybrid' (default 'auto')
 *               auto = RRF hybrid + rerank精排 (recommended)
 *               keyword = pure BM25
 *               semantic = pure kNN vector
 *               hybrid = RRF without rerank
 *   source    — source_label filter (optional)
 *   language  — language filter (optional)
 *   dateFrom  — ISO date lower bound (optional)
 *   alphaRange — { gte, lte } alpha score filter (optional)
 *   size      — result count (default 20, max 50)
 * @returns {Promise<{hits, total, aggs, mode, engine, took}>}
 */
async function esSearch({ q, mode = 'auto', source, language, dateFrom, alphaRange, size = 20 }) {
  size = Math.min(parseInt(size, 10) || 20, 50);

  // Normalize old mode names for backward compat
  if (mode === 'bm25') mode = 'keyword';
  if (mode === 'knn') mode = 'semantic';
  if (mode === 'rrf') mode = 'hybrid';

  const filterClauses = [];
  if (source) filterClauses.push({ term: { source_label: source } });
  if (language) filterClauses.push({ term: { language } });
  if (dateFrom) filterClauses.push({ range: { published_at: { gte: dateFrom } } });
  if (alphaRange) {
    const r = {};
    if (alphaRange.gte != null) r.gte = parseFloat(alphaRange.gte);
    if (alphaRange.lte != null) r.lte = parseFloat(alphaRange.lte);
    if (Object.keys(r).length) filterClauses.push({ range: { sig_alpha: r } });
  }

  const fields = ['title^3', 'title_zh^3', 'ai_title^2', 'short_summary_zh^2', 'content', 'why_it_matters_zh'];
  // BM25 query with synonym-aware analyzer for cross-language matching
  const mmQuery = { multi_match: { query: q, fields, type: 'best_fields', analyzer: 'ik_synonym_search' } };

  const body = {
    size,
    _source: [
      'item_id', 'url', 'title', 'title_zh', 'ai_title',
      'short_summary_zh', 'one_liner', 'source_label', 'source_slug',
      'language', 'author', 'published_at', 'score',
      'sig_alpha', 'sig_novelty',
    ],
    highlight: {
      fields: { title: {}, title_zh: {}, short_summary_zh: {} },
      pre_tags: ['<mark>'], post_tags: ['</mark>'],
      require_field_match: false,
    },
    collapse: { field: 'content_hash' },
    aggs: {
      ...buildAggs(),
      total_unique: { cardinality: { field: 'content_hash' } },
    },
  };

  // post_filter so aggregations reflect filtered results
  if (filterClauses.length) {
    body.post_filter = { bool: { filter: filterClauses } };
  }

  // Try to build with retrievers API (ES 9.x recommended), fall back to legacy
  const usedRetriever = await tryBuildRetriever(body, { mode, q, mmQuery, filterClauses });

  if (!usedRetriever) {
    // Legacy fallback: direct query/knn/rank
    legacyBuildQuery(body, { mode, q, mmQuery, fields });
  }

  const result = await esRequest('POST', `/${ES_INDEX}/_search`, body);
  const hits = (result.hits?.hits || []).map(h => ({
    ...h._source,
    _score: h._score,
    highlight: h.highlight || {},
  }));

  return {
    hits,
    total: typeof result.hits?.total === 'object' ? result.hits.total.value : (result.hits?.total || 0),
    aggs: result.aggregations || null,
    mode,
    engine: usedRetriever ? `es-${mode}-reranked` : `es-${mode}`,
    took: result.took || 0,
  };
}

/**
 * Build the query body using ES 9.x Retrievers API.
 * Supports: keyword → standard, semantic → kNN, hybrid/auto → RRF(+rerank).
 * Returns true if retriever was set; false if legacy fallback is needed.
 */
async function tryBuildRetriever(body, { mode, q, mmQuery, filterClauses }) {
  try {
    let innerRetriever;

    if (mode === 'keyword') {
      innerRetriever = { standard: { query: mmQuery } };
    } else {
      // Need embedding vector for semantic/hybrid/auto
      const queryVector = await getQueryEmbedding(q);

      const knnRetriever = {
        knn: {
          field: 'embedding',
          query_vector: queryVector,
          k: 20,
          num_candidates: 500,
        },
      };
      const bm25Retriever = { standard: { query: mmQuery } };

      if (mode === 'semantic') {
        innerRetriever = knnRetriever;
      } else if (mode === 'elser') {
        // ELSER sparse vector search — ES-native semantic, no external embedding needed
        innerRetriever = {
          standard: {
            query: {
              sparse_vector: {
                field: 'ml_tokens',
                inference_id: '.elser-2-elasticsearch',
                query: q,
              },
            },
          },
        };
      } else {
        // hybrid / auto → RRF combine BM25 + kNN
        const rrfRetriever = {
          rrf: {
            retrievers: [bm25Retriever, knnRetriever],
            rank_window_size: 100,
            rank_constant: 20,
          },
        };

        if (mode === 'hybrid') {
          innerRetriever = rrfRetriever;
        } else {
          // auto → wrap RRF in text_similarity_reranker for precision
          try {
            const rerankId = (require('./es-ai-setup').AI_INFERENCE_IDS || {}).rerank || '.rerank-v1-elasticsearch';
            innerRetriever = {
              text_similarity_reranker: {
                retriever: rrfRetriever,
                field: 'title',
                inference_id: rerankId,
                inference_text: q,
                rank_window_size: 50,
              },
            };
          } catch {
            innerRetriever = rrfRetriever;
          }
        }
      }
    }

    // Wrap inner retriever with rule retriever for query rules (pin/exclude)
    // rule must be the outermost retriever per ES docs
    // rank_window_size must be >= size to avoid validation error
    body.retriever = {
      rule: {
        ruleset_ids: ['eagleye-rules'],
        match_criteria: { user_query: q },
        retriever: innerRetriever,
        // `size` is a local of the caller, not a parameter here — referencing it
        // threw ReferenceError on every call, and the catch below swallowed it
        // and returned false, so the retriever path (hybrid + rerank + rules)
        // silently degraded to the legacy query builder every single time.
        // The caller already put the value on `body`.
        rank_window_size: Math.max(body.size || 20, 100),
      },
    };
    return true;
  } catch (err) {
    // This used to swallow silently, which is how a plain ReferenceError kept
    // the retriever path disabled without anyone noticing. Degrading to the
    // legacy builder is still the right behaviour — but say so.
    console.warn('  ⚠  ES retriever build failed, using legacy query:', err.message);
    return false; // signal legacy fallback
  }
}

/**
 * Legacy query builder (pre-retrievers API fallback).
 */
function legacyBuildQuery(body, { mode, q, mmQuery, fields }) {
  if (mode === 'keyword') {
    body.query = { bool: { must: [mmQuery] } };
  } else if (mode === 'semantic' || mode === 'hybrid' || mode === 'auto') {
    // Fallback: just do BM25 if we can't get embeddings (getQueryEmbedding failed)
    body.query = { bool: { must: [mmQuery] } };
  }
}

function buildAggs() {
  return {
    by_source: {
      terms: { field: 'source_label', size: 18 },
      aggs: {
        avg_alpha: { avg: { field: 'sig_alpha' } },
        avg_novelty: { avg: { field: 'sig_novelty' } },
      },
    },
    by_language: { terms: { field: 'language', size: 8 } },
    top_authors: { terms: { field: 'author', size: 8 } },
    over_time: {
      date_histogram: {
        field: 'published_at', calendar_interval: 'week', min_doc_count: 1,
      },
      aggs: {
        avg_alpha: { avg: { field: 'sig_alpha' } },
      },
    },
    alpha_buckets: {
      range: { field: 'sig_alpha', ranges: [
        { to: 0.3, key: 'low' },
        { from: 0.3, to: 0.7, key: 'mid' },
        { from: 0.7, key: 'high' },
      ] },
    },
    sig_terms: {
      significant_text: { field: 'ai_title', size: 10, filter_duplicate_text: true },
    },
  };
}

/**
 * Generate an embedding for a query string using the same model as the indexed docs.
 * Falls back to a hash-based pseudo-vector if the embedding model is unavailable
 * (kNN results will be low quality but won't crash).
 */
let _embedFn = null;

async function getQueryEmbedding(text) {
  if (_embedFn) return _embedFn(text);

  // Try fastembed via subprocess (available in kg-worker/.venv)
  const { execFileSync } = require('child_process');
  const path = require('path');
  const venvPython = path.join(__dirname, '..', '..', 'kg-worker', '.venv', 'bin', 'python');

  try {
    // Check if the python binary exists
    require('fs').accessSync(venvPython);
    const script = `
from fastembed import TextEmbedding
model = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
import json, sys
vec = list(model.embed([sys.argv[1][:2000]], parallel=0))
print(json.dumps([round(float(x), 6) for x in vec[0]]))
`;
    const out = execFileSync(venvPython, ['-c', script, text], {
      timeout: 30000,
      encoding: 'utf-8',
      env: { ...process.env },
    });
    return JSON.parse(out.trim());
  } catch (e) {
    // No fastembed — use a deterministic hash vector (384 dims) as last resort
    console.warn('[es] fastembed unavailable, using hash fallback for embedding:', e.message);
    return hashVector(text, 384);
  }
}

function hashVector(text, dims) {
  const crypto = require('crypto');
  const vec = new Array(dims).fill(0);
  const tokens = text.toLowerCase().split(/[\s,.!?;:'"()-]+/).filter(Boolean);
  for (const tok of tokens) {
    const hash = crypto.createHash('blake2b512').update(tok).digest();
    const bucket = hash.readUInt32BE(0) % dims;
    const sign = hash[4] & 1 ? 1 : -1;
    vec[bucket] += sign;
  }
  // Normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => Math.round(v / norm * 1e6) / 1e6);
}

/**
 * Rebuild the ES index from SQLite: delete + recreate mapping + bulk index.
 * Returns { indexed, errors }.
 */
async function esReindex() {
  const db = getDB();
  if (!db) throw new Error('Database not available');

  // Delete old index
  try { await esRequest('DELETE', `/${ES_INDEX}`); } catch { /* may not exist */ }

  // Create with mapping
  await esRequest('PUT', `/${ES_INDEX}`, INDEX_MAPPING);

  // Export rows
  const rows = db.prepare(`
    SELECT i.id, i.source_id, i.canonical_url, i.title, i.title_zh,
           i.content_text, i.original_summary, i.language, i.author,
           i.published_at, i.score, i.popularity,
           s.ai_title, s.one_liner, s.short_summary, s.why_it_matters,
           s.short_summary_zh, s.why_it_matters_zh,
           sig.novelty_score, sig.velocity_score, sig.cross_source_score,
           sig.source_quality_score, sig.thesis_match_score, sig.actionability_score,
           sig.alpha_score
    FROM information_items i
    LEFT JOIN ai_summaries s ON s.item_id = i.id
    LEFT JOIN signal_scores sig ON sig.item_id = i.id
    ORDER BY i.id
  `).all();

  const sources = {};
  for (const s of db.prepare('SELECT id, slug, label, label_zh FROM sources').all()) {
    sources[s.id] = s;
  }

  // Bulk index in chunks of 2000 docs
  const CHUNK = 2000;
  let indexed = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const lines = [];
    for (const row of chunk) {
      const src = sources[row.source_id] || {};
      let pop = {};
      try { pop = JSON.parse(row.popularity || '{}'); } catch {}
      const doc = {
        item_id: row.id,
        url: row.canonical_url,
        title: row.title,
        title_zh: row.title_zh,
        content: row.content_text,
        summary: row.original_summary,
        language: row.language || 'und',
        author: row.author,
        published_at: row.published_at,
        source_slug: src.slug,
        source_label: src.label,
        source_label_zh: src.label_zh,
        ai_title: row.ai_title,
        one_liner: row.one_liner,
        short_summary: row.short_summary,
        why_it_matters: row.why_it_matters,
        short_summary_zh: row.short_summary_zh,
        why_it_matters_zh: row.why_it_matters_zh,
        score: row.score || 0,
        views: pop.views,
        likes: pop.likes,
        comments: pop.replies,
        sig_novelty: row.novelty_score,
        sig_velocity: row.velocity_score,
        sig_alpha: row.alpha_score,
        sig_cross_source: row.cross_source_score,
        sig_quality: row.source_quality_score,
        sig_thesis_match: row.thesis_match_score,
        sig_actionability: row.actionability_score,
      };
      lines.push(JSON.stringify({ index: { _index: ES_INDEX, _id: row.id } }));
      lines.push(JSON.stringify(doc));
    }
    const ndjson = lines.join('\n') + '\n';

    // Use raw fetch for bulk (ndjson content type)
    const bulkRes = await fetch(`${ES_HOST}/_bulk?filter_path=errors,items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson', ...authHeader() },
      body: ndjson,
      signal: AbortSignal.timeout(120000),
    });
    const bulkJson = await bulkRes.json();
    for (const item of (bulkJson.items || [])) {
      const op = item.index || item.update || item.create;
      if (op && op.status >= 200 && op.status < 300) indexed++;
      else errors++;
    }
  }

  // Add dense_vector mapping if not present, then reindex embeddings
  try {
    await esRequest('PUT', `/${ES_INDEX}/_mapping`, {
      properties: { embedding: { type: 'dense_vector', dims: 384, index: true, similarity: 'cosine' } },
    });
  } catch { /* mapping may already exist */ }

  return { indexed, errors, total: rows.length };
}

const INDEX_MAPPING = {
  settings: {
    number_of_shards: 3,
    number_of_replicas: 1,
    analysis: {
      analyzer: {
        ik_index: { type: 'custom', tokenizer: 'ik_max_word', filter: ['lowercase', 'asciifolding'] },
        ik_search: { type: 'custom', tokenizer: 'ik_smart', filter: ['lowercase', 'asciifolding'] },
      },
    },
  },
  mappings: { properties: {
    item_id: { type: 'keyword' },
    url: { type: 'keyword', index: false, doc_values: false },
    title: { type: 'text', analyzer: 'ik_index', search_analyzer: 'ik_search', fields: { keyword: { type: 'keyword', ignore_above: 512 } } },
    title_zh: { type: 'text', analyzer: 'ik_index', search_analyzer: 'ik_search' },
    content: { type: 'text', analyzer: 'ik_index', search_analyzer: 'ik_search' },
    summary: { type: 'text', analyzer: 'ik_index', search_analyzer: 'ik_search' },
    ai_title: { type: 'text', analyzer: 'ik_index', search_analyzer: 'ik_search' },
    one_liner: { type: 'text', analyzer: 'ik_index', search_analyzer: 'ik_search' },
    short_summary: { type: 'text', analyzer: 'ik_index', search_analyzer: 'ik_search' },
    why_it_matters: { type: 'text', analyzer: 'ik_index', search_analyzer: 'ik_search' },
    short_summary_zh: { type: 'text', analyzer: 'ik_index', search_analyzer: 'ik_search' },
    why_it_matters_zh: { type: 'text', analyzer: 'ik_index', search_analyzer: 'ik_search' },
    language: { type: 'keyword' },
    author: { type: 'keyword' },
    source_slug: { type: 'keyword' },
    source_label: { type: 'keyword' },
    source_label_zh: { type: 'keyword' },
    published_at: { type: 'date', format: 'strict_date_optional_time||EEE, dd MMM yyyy HH:mm:ss Z||EEE, dd MMM yyyy HH:mm:ss z', ignore_malformed: true },
    score: { type: 'double' },
    views: { type: 'long' },
    likes: { type: 'long' },
    comments: { type: 'long' },
    sig_novelty: { type: 'float' },
    sig_velocity: { type: 'float' },
    sig_alpha: { type: 'float' },
    sig_cross_source: { type: 'float' },
    sig_quality: { type: 'float' },
    sig_thesis_match: { type: 'float' },
    sig_actionability: { type: 'float' },
  } },
};

/**
 * Incremental sync: only index items updated since last sync.
 * Uses ES's `_doc` API with upsert — only new/changed docs are sent.
 * Returns { synced, skipped, total }.
 */
async function esIncrementalSync() {
  const { getDB } = require('../db/connection');
  const { getValue, setValue } = require('../db/user-data');
  const db = getDB();
  if (!db) throw new Error('Database not available');

  const lastSync = getValue('es_last_sync') || '1970-01-01T00:00:00Z';
  const now = new Date().toISOString();

  // Get items updated since last sync
  const rows = db.prepare(`
    SELECT i.id, i.source_id, i.canonical_url, i.title, i.title_zh,
           i.content_text, i.original_summary, i.language, i.author,
           i.published_at, i.score, i.popularity, i.content_hash,
           s.ai_title, s.one_liner, s.short_summary, s.why_it_matters,
           s.short_summary_zh, s.why_it_matters_zh,
           sig.alpha_score, sig.novelty_score
    FROM information_items i
    LEFT JOIN ai_summaries s ON s.item_id = i.id
    LEFT JOIN signal_scores sig ON sig.item_id = i.id
    WHERE i.updated_at > ?
    ORDER BY i.updated_at
    LIMIT 500
  `).all(lastSync);

  if (!rows.length) return { synced: 0, skipped: 0, last_sync: lastSync };

  const sources = {};
  for (const s of db.prepare('SELECT id, slug, label FROM sources').all()) sources[s.id] = s;

  // Build bulk body
  const lines = [];
  for (const row of rows) {
    const src = sources[row.source_id] || {};
    let pop = {};
    try { pop = JSON.parse(row.popularity || '{}'); } catch {}
    const doc = {
      item_id: row.id, url: row.canonical_url, title: row.title, title_zh: row.title_zh,
      content: row.content_text, content_hash: row.content_hash || row.id,
      summary: row.original_summary, language: row.language || 'und', author: row.author,
      published_at: row.published_at, source_slug: src.slug, source_label: src.label,
      ai_title: row.ai_title, one_liner: row.one_liner, short_summary: row.short_summary,
      short_summary_zh: row.short_summary_zh, score: row.score || 0,
      sig_alpha: row.alpha_score, sig_novelty: row.novelty_score,
    };
    lines.push(JSON.stringify({ index: { _index: ES_INDEX, _id: row.id } }));
    lines.push(JSON.stringify(doc));
  }

  const ndjson = lines.join('\n') + '\n';
  const bulkRes = await fetch(`${ES_HOST}/_bulk?filter_path=errors,items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson', ...authHeader() },
    body: ndjson,
    signal: AbortSignal.timeout(60000),
  });
  const bulkJson = await bulkRes.json();
  const ok = (bulkJson.items || []).filter(i => (i.index || {}).status < 300).length;

  setValue('es_last_sync', now);
  return { synced: ok, total: rows.length, last_sync: lastSync, new_sync_time: now };
}

module.exports = { esAvailable, esHealth, esSearch, esReindex, esIncrementalSync, getQueryEmbedding, esRequest, ES_HOST, ES_INDEX };
