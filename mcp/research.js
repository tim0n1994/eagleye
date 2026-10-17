const queries = require('./queries');

const RESULT_LIMIT = 20;
const TEXT_LIMIT = 12000;
const ITEM_ID = /^item:([A-Za-z0-9_-]{1,128})$/;
const SYSTEM_DOCUMENTS = {
  'system:overview': { title: 'Eagleye live system overview / 系统概览', url: 'https://eagleye.udify.fun/settings' },
  'system:llm-usage': { title: 'Eagleye live LLM usage, past 7 days / 模型用量', url: 'https://eagleye.udify.fun/settings' },
};
const SYSTEM_QUERY = /\b(system|overview|product|health|metrics|freshness|counts?|operations?|iteration)\b|系统|概览|产品|健康|指标|新鲜度|运营|迭代/i;
const USAGE_QUERY = /\b(llm|usage|tokens?|latency|cost|requests?|failures?)\b|模型|用量|消耗|成本|延迟|请求|失败/i;

function citationUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.local') || !hostname.includes('.') ||
        /^[\d.]+$/.test(hostname) || hostname.includes(':')) return null;
    const pathname = decodeURIComponent(url.pathname);
    // Reject connector routes and secret-shaped path segments, not ordinary article slugs.
    if (/(?:^|[.-])mcp(?:[.-]|$)/i.test(hostname) ||
        /\/(?:mcp|token|secret|password|api[-_]?key|credentials?)(?:\/|$)/i.test(pathname) ||
        /\/(?:[a-f0-9]{32,}|[A-Za-z0-9_]{40,})(?:\/|$)/.test(pathname)) return null;
    const identity = hostname === 'news.ycombinator.com' && pathname === '/item' && /^\d{1,20}$/.test(url.searchParams.get('id') || '')
      ? ['id', url.searchParams.get('id')]
      : ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(hostname) && pathname === '/watch' && /^[A-Za-z0-9_-]{6,20}$/.test(url.searchParams.get('v') || '')
        ? ['v', url.searchParams.get('v')] : null;
    url.search = '';
    if (identity) url.searchParams.set(...identity);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function safeText(value, limit) {
  return String(value ?? '').slice(0, limit)
    .replace(/\b(api[-_ ]?key|access[-_ ]?token|secret|password|authorization)["']?\s*[:=]\s*(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'(?:\\[\s\S]|[^'\\])*(?:'|\\?$))/gi, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s<>"')]+/gi, (url) => citationUrl(url) || '[REDACTED URL]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|ccr-dev-)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\b(api[-_ ]?key|access[-_ ]?token|secret|password|authorization)["']?\s*[:=]\s*["']?[^\s,;"']+/gi, '$1=[REDACTED]');
}

function search({ query }) {
  if (typeof query !== 'string' || !query.trim() || query.length > 200) {
    throw new Error('query must contain 1-200 characters');
  }
  const results = [];
  if (SYSTEM_QUERY.test(query)) results.push({ id: 'system:overview', ...SYSTEM_DOCUMENTS['system:overview'] });
  if (USAGE_QUERY.test(query) || SYSTEM_QUERY.test(query)) results.push({ id: 'system:llm-usage', ...SYSTEM_DOCUMENTS['system:llm-usage'] });
  const rows = queries.searchItems({ query: query.trim(), limit: RESULT_LIMIT - results.length });
  for (const row of rows) {
    const id = `item:${row.id}`;
    const url = citationUrl(row.canonical_url);
    if (ITEM_ID.test(id) && url) results.push({ id, title: safeText(row.title, 300), url });
  }
  return { results };
}

function fetchDocument({ id }) {
  if (Object.hasOwn(SYSTEM_DOCUMENTS, id)) return fetchSystemDocument(id);
  const match = typeof id === 'string' && ITEM_ID.exec(id);
  if (!match) throw new Error('Unsupported evidence id; use an item id returned by search');
  const row = queries.getItem({ id: match[1] });
  const url = row && citationUrl(row.item.canonical_url);
  if (!row || !url) throw new Error('Evidence document not found or has no safe citation URL');
  const generatedAt = new Date().toISOString();
  const text = [
    'Eagleye stored article excerpt and AI summary. This is a live read, not an immutable snapshot.',
    `Generated at: ${generatedAt}`,
    `Published at: ${safeText(row.item.published_at, 40)}`,
    `Fetched at: ${safeText(row.item.fetched_at, 40)}`,
    safeText(row.item.content_text_excerpt, 2000),
    'AI summary (may contain errors):',
    safeText(row.summary?.one_liner, 1000),
    safeText(row.summary?.short_summary, 4000),
    safeText(row.summary?.why_it_matters, 2000),
  ].join('\n').slice(0, TEXT_LIMIT);
  return {
    id, title: safeText(row.item.title, 300), text, url,
    metadata: {
      generated_at: generatedAt,
      source_fetched_at: safeText(row.item.fetched_at, 40),
      summary_created_at: safeText(row.summary?.created_at, 40),
      mutable: true,
      excerpt_only: true,
    },
  };
}

function fetchSystemDocument(id) {
  const generatedAt = new Date().toISOString();
  let data;
  let sourceFetchedAt = '';
  let returnedRows = 0;
  let totalRows = 0;
  if (id === 'system:overview') {
    data = queries.systemOverview();
    sourceFetchedAt = safeText(data.latest_fetched_at, 40);
  } else {
    const rows = queries.llmUsageStats({ days: 7 });
    totalRows = rows.length;
    data = rows.slice(0, 30).map(row => ({
      day: safeText(row.day, 10), task: safeText(row.task, 60), status: safeText(row.status, 30),
      requests: row.requests, avg_elapsed_ms: row.avg_elapsed_ms,
      input_tokens: row.input_tokens, output_tokens: row.output_tokens,
    }));
    returnedRows = data.length;
  }
  return {
    id, ...SYSTEM_DOCUMENTS[id],
    text: [
      'Eagleye live aggregate evidence, generated by a curated read-only database query.',
      'Citation URL identifies the product settings page; it is not a public snapshot endpoint and may require login.',
      `Generated at: ${generatedAt}. Mutable data: save this response to reproduce an observation.`,
      id === 'system:llm-usage' ? `Rolling 7-day window; newest day first. Showing ${returnedRows} of ${totalRows} grouped rows (maximum 30). Token counts do not establish monetary cost. Latest event time is not available in this aggregate.` : `Source freshness watermark: ${sourceFetchedAt || 'unknown'}. Counts describe the current database, not user engagement or server uptime.`,
      safeText(JSON.stringify(data), 10000),
    ].join('\n').slice(0, TEXT_LIMIT),
    metadata: {
      generated_at: generatedAt, source_fetched_at: sourceFetchedAt, summary_created_at: '',
      mutable: true, excerpt_only: true, citation_kind: 'product_page_not_snapshot',
      ...(id === 'system:llm-usage' ? { lookback_days: 7, returned_rows: returnedRows, total_rows: totalRows } : {}),
    },
  };
}

module.exports = { search, fetchDocument, citationUrl, safeText, RESULT_LIMIT, TEXT_LIMIT };
