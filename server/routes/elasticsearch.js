/**
 * Eagleye — Elasticsearch routes
 *
 * Search, RAG chat, suggestions, trends, saved searches and cluster ops.
 * Extends the search that SQLite FTS5 provides; when ES is unreachable these
 * degrade to ftsSearch rather than failing.
 */

const { getDB } = require('../db/connection');
const { getValue, setValue } = require('../db/user-data');
const {
  esAvailable, esHealth, esSearch, esReindex, esIncrementalSync, esRequest, ES_HOST, ES_INDEX,
} = require('../services/elasticsearch');
const { ragChat } = require('../services/es-rag');
const { setupAI, checkAIReady, AI_INFERENCE_IDS } = require('../services/es-ai-setup');
const { sendJSON, sendError, readBody, requireAdmin, ftsSearch } = require('./_shared');

function register(routes) {
  // --- Elasticsearch: Health ---
  // GET /api/es/health
  routes['/api/es/health'] = async (req, res) => {
    try {
      if (!ES_HOST) { sendJSON(res, 200, { connected: false, configured: false }); return; }
      const data = await esHealth();
      sendJSON(res, 200, { status: 'ok', ...data });
    } catch (err) {
      sendJSON(res, 200, { connected: false, configured: true, error: err.message });
    }
  };

  // --- Elasticsearch: Aggregation Search ---
  // GET /api/es/search?q=...&mode=bm25|knn|rrf&source=...&language=...&dateFrom=...&size=20
  routes['/api/es/search'] = async (req, res, parsed) => {
    const q = (parsed.query.q || '').trim();
    const mode = parsed.query.mode || 'bm25';
    const { source, language, dateFrom } = parsed.query;
    const size = parsed.query.size || '20';

    // ES not configured or unavailable → graceful degradation to FTS5
    if (!ES_HOST || !(await esAvailable())) {
      const ftsResult = ftsSearch(getDB(), q, Math.min(parseInt(size, 10) || 30, 50));
      sendJSON(res, 200, { status: 'ok', ...ftsResult, mode, engine: 'fts5-fallback', es_down: true });
      return;
    }

    try {
      const result = await esSearch({ q, mode, source, language, dateFrom, size });
      sendJSON(res, 200, { status: 'ok', ...result });
    } catch (err) {
      // ES query error → degrade to FTS5
      const ftsResult = ftsSearch(getDB(), q, Math.min(parseInt(size, 10) || 30, 50));
      sendJSON(res, 200, { status: 'ok', ...ftsResult, mode, engine: 'fts5-fallback', es_error: err.message });
    }
  };

  // --- Elasticsearch: Reindex (admin) ---
  // POST /api/es/reindex
  routes['/api/es/reindex'] = async (req, res) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed; use POST');
    if (requireAdmin(req, res)) return;
    try {
      const result = await esReindex();
      sendJSON(res, 200, { status: 'ok', ...result });
    } catch (err) {
      sendError(res, 500, `Reindex failed: ${err.message}`);
    }
  };

  // --- Elasticsearch: Incremental Sync ---
  // POST /api/es/sync — only sync items updated since last sync
  routes['/api/es/sync'] = async (req, res) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed; use POST');
    if (requireAdmin(req, res)) return;
    try {
      const result = await esIncrementalSync();
      sendJSON(res, 200, { status: 'ok', ...result });
    } catch (err) {
      sendError(res, 500, `Sync failed: ${err.message}`);
    }
  };

  // --- Elasticsearch: AI Setup (initialize inference endpoints + pipelines) ---
  // POST /api/es/setup-ai
  routes['/api/es/setup-ai'] = async (req, res) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed; use POST');
    if (requireAdmin(req, res)) return;
    try {
      const result = await setupAI();
      sendJSON(res, 200, { status: 'ok', ...result });
    } catch (err) {
      sendError(res, 500, `AI setup failed: ${err.message}`);
    }
  };

  // --- Elasticsearch: AI Status ---
  // GET /api/es/ai-status
  routes['/api/es/ai-status'] = async (req, res) => {
    try {
      const ready = await checkAIReady();
      sendJSON(res, 200, { status: 'ok', ready, inference_ids: AI_INFERENCE_IDS });
    } catch (err) {
      sendError(res, 500, `AI status check failed: ${err.message}`);
    }
  };

  // --- Elasticsearch: RAG Chat (AI Builder) ---
  // POST /api/es/chat  body: { question, mode?, source?, language?, dateFrom? }
  routes['/api/es/chat'] = async (req, res, parsed) => {
    // Parse JSON body
    // readBody caps the payload; the hand-rolled loop this replaced had no
    // size limit, so a large body could be buffered without bound.
    let body;
    try { body = await readBody(req, 65536); } catch { body = {}; }

    const question = (body.question || '').trim();
    if (question.length < 2) {
      sendJSON(res, 200, { status: 'ok', answer: '问题太短了，请详细一点。', sources: [], total_found: 0 });
      return;
    }

    try {
      const result = await ragChat(question, {
        mode: body.mode || 'rrf',
        source: body.source,
        language: body.language,
        dateFrom: body.dateFrom,
      });
      sendJSON(res, 200, { status: 'ok', ...result, question });
    } catch (err) {
      sendError(res, 500, `RAG failed: ${err.message}`);
    }
  };

  // --- Elasticsearch: Search Suggestions ---
  // GET /api/es/suggest?q=...
  routes['/api/es/suggest'] = async (req, res, parsed) => {
    const q = (parsed.query.q || '').trim();
    if (q.length < 1) { sendJSON(res, 200, { suggestions: [] }); return; }

    if (!ES_HOST || !(await esAvailable().catch(() => false))) {
      sendJSON(res, 200, { suggestions: [], es_down: true });
      return;
    }

    try {
      // Use completion suggester on title + terms aggregation as fallback
      const result = await esRequest('POST', `/${ES_INDEX}/_search`, {
        size: 0,
        suggest: {
          title_suggest: {
            prefix: q,
            completion: { field: 'title.keyword', size: 8, skip_duplicates: true },
          },
        },
      });
      const options = result.suggest?.title_suggest?.[0]?.options || [];
      const suggestions = options.map(o => ({
        text: o._source.title || o.text,
        source: o._source.source_label,
      }));
      sendJSON(res, 200, { status: 'ok', suggestions });
    } catch (err) {
      // Fallback: simple terms aggregation
      try {
        const result = await esRequest('POST', `/${ES_INDEX}/_search`, {
          size: 0,
          query: { prefix: { 'title.keyword': q } },
          aggs: { titles: { terms: { field: 'title.keyword', size: 8 } } },
        });
        const suggestions = (result.aggregations?.titles?.buckets || []).map(b => ({ text: b.key }));
        sendJSON(res, 200, { status: 'ok', suggestions });
      } catch (e2) {
        sendJSON(res, 200, { suggestions: [] });
      }
    }
  };

  // --- Elasticsearch: Trend Comparison ---
  // GET /api/es/trend?q=...  — compares this week vs last week for a query
  routes['/api/es/trend'] = async (req, res, parsed) => {
    if (!ES_HOST || !(await esAvailable().catch(() => false))) {
      sendJSON(res, 200, { es_down: true });
      return;
    }
    const q = (parsed.query.q || '').trim();
    if (q.length < 2) { sendJSON(res, 200, { error: 'query too short' }); return; }

    try {
      const now = Date.now();
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      const thisWeekStart = now - weekMs;
      const lastWeekStart = now - 2 * weekMs;

      const result = await esRequest('POST', `/${ES_INDEX}/_search`, {
        size: 0,
        query: {
          multi_match: { query: q, fields: ['title^3', 'title_zh^3', 'ai_title^2', 'short_summary_zh^2', 'content'], type: 'best_fields', analyzer: 'ik_synonym_search' },
        },
        aggs: {
          this_week: {
            filter: { range: { published_at: { gte: thisWeekStart } } },
            aggs: {
              count: { value_count: { field: 'published_at' } },
              avg_alpha: { avg: { field: 'sig_alpha' } },
              top_sources: { terms: { field: 'source_label', size: 3 } },
            },
          },
          last_week: {
            filter: { range: { published_at: { gte: lastWeekStart, lt: thisWeekStart } } },
            aggs: {
              count: { value_count: { field: 'published_at' } },
              avg_alpha: { avg: { field: 'sig_alpha' } },
              top_sources: { terms: { field: 'source_label', size: 3 } },
            },
          },
          weekly: {
            date_histogram: { field: 'published_at', calendar_interval: 'week', min_doc_count: 1 },
            aggs: { avg_alpha: { avg: { field: 'sig_alpha' } } },
          },
        },
      });

      const a = result.aggregations;
      const tw = a.this_week, lw = a.last_week;
      const thisCount = tw.doc_count, lastCount = lw.doc_count;
      const growth = lastCount > 0 ? Math.round((thisCount - lastCount) / lastCount * 100) : (thisCount > 0 ? 100 : 0);

      sendJSON(res, 200, {
        status: 'ok',
        q,
        this_week: { count: thisCount, avg_alpha: tw.avg_alpha.value, sources: tw.top_sources.buckets },
        last_week: { count: lastCount, avg_alpha: lw.avg_alpha.value, sources: lw.top_sources.buckets },
        growth_pct: growth,
        weekly: a.weekly.buckets.map(b => ({
          week: new Date(b.key).toISOString().slice(0, 10),
          count: b.doc_count,
          alpha: b.avg_alpha.value,
        })),
      });
    } catch (err) {
      sendJSON(res, 200, { error: err.message.slice(0, 200) });
    }
  };

  // --- Elasticsearch: Saved Searches (CRUD via user_data) ---
  // GET /api/es/saved — list saved searches
  // POST /api/es/saved — { query, mode, filters } create
  // DELETE /api/es/saved/:id — remove
  routes['/api/es/saved'] = async (req, res, parsed) => {
    const db = getDB();
    if (!db) { sendError(res, 500, 'DB not available'); return; }
    const key = 'es_saved_searches';
    const method = req.method || 'GET';

    if (method === 'GET') {
      sendJSON(res, 200, { status: 'ok', searches: getValue(key, req.user.id) || [] });
      return;
    }

    if (method === 'POST') {
      let body;
      try { body = await readBody(req, 65536); } catch { body = {}; }
      const searches = getValue(key, req.user.id) || [];
      const entry = {
        id: Date.now().toString(36),
        query: body.query || '',
        mode: body.mode || 'auto',
        filters: body.filters || {},
        created_at: new Date().toISOString(),
      };
      searches.unshift(entry);
      setValue(key, searches, req.user.id);
      sendJSON(res, 200, { status: 'ok', ...entry });
      return;
    }

    sendError(res, 405, 'Method not allowed');
  };

  // --- Elasticsearch: Saved search delete ---
  routes['/api/es/saved/delete'] = async (req, res, parsed) => {
    const id = parsed.query.id;
    if (!id) { sendError(res, 400, 'id required'); return; }
    let searches = getValue('es_saved_searches', req.user.id) || [];
    searches = searches.filter(s => s.id !== id);
    setValue('es_saved_searches', searches, req.user.id);
    sendJSON(res, 200, { status: 'ok' });
  };

  // --- Elasticsearch: New items since last check (for alerts) ---
  // GET /api/es/alerts?q=...&since=ISO_DATE — count of new matching items
  routes['/api/es/alerts'] = async (req, res, parsed) => {
    if (!ES_HOST || !(await esAvailable().catch(() => false))) {
      sendJSON(res, 200, { es_down: true, new_count: 0 });
      return;
    }
    const q = (parsed.query.q || '').trim();
    const since = parsed.query.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    if (q.length < 2) { sendJSON(res, 200, { new_count: 0 }); return; }

    try {
      const result = await esRequest('POST', `/${ES_INDEX}/_search`, {
        size: 5,
        _source: ['title', 'title_zh', 'source_label', 'short_summary_zh', 'published_at', 'url', 'sig_alpha'],
        query: {
          bool: {
            must: [{ multi_match: { query: q, fields: ['title^3', 'title_zh^3', 'ai_title^2', 'short_summary_zh^2', 'content'], type: 'best_fields' } }],
            filter: [{ range: { published_at: { gte: since } } }],
          },
        },
        sort: [{ published_at: 'desc' }],
      });
      const hits = (result.hits?.hits || []).map(h => h._source);
      sendJSON(res, 200, { status: 'ok', new_count: result.hits?.total?.value || 0, items: hits, since });
    } catch (err) {
      sendJSON(res, 200, { new_count: 0, error: err.message.slice(0, 100) });
    }
  };
}

module.exports = register;
