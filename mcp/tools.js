/**
 * Eagleye — MCP tool definitions
 *
 * Curated read-only tools and research search/fetch. Handlers enforce the
 * runtime gate (admin switch), output size cap and secret redaction.
 */

const { z } = require('zod');
const queries = require('./queries');
const research = require('./research');

const RESPONSE_CAP_BYTES = 256 * 1024;

function enforceCap(result) {
  const json = JSON.stringify(result);
  if (json.length <= RESPONSE_CAP_BYTES) return result;
  return {
    truncated: true,
    note: 'Response exceeded 256KB and was dropped. Narrow your filters.',
    byte_size: json.length,
  };
}

function guard(enabledRef) {
  if (!enabledRef.value) {
    const err = new Error('Eagleye MCP is disabled by the administrator switch.');
    err.code = 'MCP_DISABLED';
    throw err;
  }
}

function registerTools(server, enabledRef) {
  const register = (name, config, handler) => server.registerTool(name, {
    ...config,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, handler);
  const wrap = (fn) => async (args) => {
    guard(enabledRef);
    return { content: [{ type: 'text', text: JSON.stringify(enforceCap(queries.redactSecrets(fn(args || {})))) }] };
  };

  const researchWrap = (fn) => async (args) => {
    guard(enabledRef);
    const result = queries.redactSecrets(fn(args || {}));
    const text = JSON.stringify(result);
    if (Buffer.byteLength(text, 'utf8') > RESPONSE_CAP_BYTES) throw new Error('Evidence response exceeds size limit');
    return { structuredContent: result, content: [{ type: 'text', text }] };
  };
  const citationFields = { id: z.string(), title: z.string(), url: z.string().url() };
  register('search', {
    title: 'Search research evidence',
    description: 'Search stored article titles/summaries and live product evidence. English/Chinese system, product, metrics or usage queries also return allowlisted overview/7-day LLM usage documents. Returns at most 20 citations; use fetch for data.',
    inputSchema: { query: z.string().trim().min(1).max(200) },
    outputSchema: { results: z.array(z.object(citationFields)).max(20) },
  }, researchWrap(research.search));
  register('fetch', {
    title: 'Fetch research evidence',
    description: 'Read a stored article by item: id, or live system:overview/system:llm-usage aggregates. Includes generation/freshness metadata; system URLs identify the product UI, not immutable snapshots. Never downloads URLs or reads arbitrary files.',
    inputSchema: { id: z.string().regex(/^(?:item:[A-Za-z0-9_-]{1,128}|system:overview|system:llm-usage)$/) },
    outputSchema: {
      ...citationFields,
      text: z.string().max(research.TEXT_LIMIT),
      metadata: z.object({
        generated_at: z.string(), source_fetched_at: z.string(), summary_created_at: z.string(),
        mutable: z.literal(true), excerpt_only: z.literal(true),
        citation_kind: z.literal('product_page_not_snapshot').optional(),
        lookback_days: z.literal(7).optional(), returned_rows: z.number().int().max(30).optional(), total_rows: z.number().int().optional(),
      }),
    },
  }, researchWrap(research.fetchDocument));

  register('system_overview', {
    title: 'System overview',
    description: 'Row counts and freshness watermarks for Eagleye business data, plus optional sanitized local monitor issues and backlog/disk metrics with explicit freshness.',
    inputSchema: {},
  }, wrap(() => queries.systemOverview()));

  register('list_sources', {
    title: 'List sources',
    description: 'All configured information sources with activity counters.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().describe('Rows to return (default 100)'),
      offset: z.number().int().min(0).optional(),
    },
  }, wrap((args) => queries.listSources(args)));

  register('search_items', {
    title: 'Search information items',
    description: 'Search/filter Eagleye items. Optional full-text query (title/summary), source, date range, minimum alpha score. Sorted by relevance or recency.',
    inputSchema: {
      query: z.string().max(200).optional().describe('Full-text search across title and summary'),
      source_id: z.string().max(100).optional().describe('Filter by source id/slug'),
      date_from: z.string().optional().describe('YYYY-MM-DD or YYYYMMDD, inclusive'),
      date_to: z.string().optional().describe('YYYY-MM-DD or YYYYMMDD, inclusive'),
      date_field: z.enum(['published_at', 'digest_date', 'fetched_at']).optional().describe('Date column the range applies to (default published_at)'),
      min_score: z.number().min(0).max(1).optional().describe('Minimum alpha_score on the 0-1 scale'),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    },
  }, wrap((args) => queries.searchItems(args)));

  register('get_item', {
    title: 'Get item detail',
    description: 'One item with its AI summary, signal scores and topics by item id (from search_items).',
    inputSchema: { id: z.string().min(1).max(128).describe('Item id') },
  }, wrap((args) => {
    const row = queries.getItem(args);
    if (!row) throw new Error(`Item not found: ${args.id}`);
    return row;
  }));

  register('list_digests', {
    title: 'List daily digests',
    description: 'Daily digest index, newest first.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    },
  }, wrap((args) => queries.listDigests(args)));

  register('get_digest', {
    title: 'Get one daily digest',
    description: 'The full daily digest for a date (YYYY-MM-DD) including headline, executive summary and watchlists.',
    inputSchema: { date: z.string().min(8).max(10).describe('Digest date YYYY-MM-DD') },
  }, wrap((args) => {
    const row = queries.getDigest(args);
    if (!row) throw new Error(`No digest for ${args.date}`);
    return row;
  }));

  register('search_topics', {
    title: 'Search topics',
    description: 'Dynamic topics with growth scores and item counts.',
    inputSchema: {
      query: z.string().max(100).optional().describe('Name/slug substring'),
      status: z.string().max(30).optional().describe('active/retired/...'),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    },
  }, wrap((args) => queries.searchTopics(args)));

  register('query_entities', {
    title: 'Query canonical entities',
    description: 'Companies/models/people resolved by the knowledge graph, with mention counts and momentum.',
    inputSchema: {
      query: z.string().max(100).optional().describe('Name/slug substring'),
      entity_type: z.string().max(50).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    },
  }, wrap((args) => queries.queryEntities(args)));

  register('llm_usage_stats', {
    title: 'LLM usage stats',
    description: 'Aggregated LLM request telemetry by day/task/status: counts, latency, tokens. Contains no credentials.',
    inputSchema: { days: z.number().int().min(1).max(90).optional().describe('Lookback window (default 7)') },
  }, wrap((args) => queries.llmUsageStats(args)));

  register('job_status', {
    title: 'Recent background jobs',
    description: 'Latest background jobs with status and truncated params/results.',
    inputSchema: { limit: z.number().int().min(1).max(200).optional() },
  }, wrap((args) => queries.jobStatus(args)));
}

module.exports = { registerTools, enforceCap, guard, RESPONSE_CAP_BYTES };
