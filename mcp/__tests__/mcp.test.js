// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const workDir = mkdtempSync(path.join(tmpdir(), 'eagleye-mcp-test-'));
const dbPath = path.join(workDir, 'test.sqlite');
const auditPath = path.join(workDir, 'audit.sqlite');
const port = 31277;
const token = 'e2e-test-token';

process.env.EAGLEYE_DB_PATH = dbPath;
process.env.EAGLEYE_MCP_AUDIT_PATH = auditPath;

const queries = require('../queries');
const tools = require('../tools');
const research = require('../research');
const { audit, closeAudit } = require('../audit');

const writer = new Database(dbPath);
writer.pragma('journal_mode = WAL');
writer.exec(`
  CREATE TABLE sources (id TEXT PRIMARY KEY, slug TEXT UNIQUE, label TEXT, description TEXT DEFAULT '', connector_type TEXT DEFAULT 'rss', is_active INTEGER DEFAULT 1, item_count INTEGER DEFAULT 0, last_fetched_at TEXT);
  CREATE TABLE information_items (id TEXT PRIMARY KEY, title TEXT, title_zh TEXT, canonical_url TEXT, source_id TEXT, language TEXT, author TEXT, published_at TEXT, fetched_at TEXT, digest_date TEXT, score REAL, content_text TEXT);
  CREATE TABLE ai_summaries (item_id TEXT PRIMARY KEY, ai_title TEXT, ai_title_zh TEXT, one_liner TEXT, one_liner_zh TEXT, short_summary TEXT, short_summary_zh TEXT, key_points TEXT DEFAULT '[]', key_points_zh TEXT DEFAULT '[]', why_it_matters TEXT, audience TEXT, risks TEXT, opportunities TEXT, action_items TEXT, confidence REAL, model_name TEXT, prompt_version TEXT, created_at TEXT);
  CREATE TABLE signal_scores (item_id TEXT PRIMARY KEY, signal_type TEXT, novelty_score REAL, velocity_score REAL, cross_source_score REAL, source_quality_score REAL, thesis_match_score REAL, actionability_score REAL, alpha_score REAL, consensus_penalty REAL, evidence_summary TEXT, scored_at TEXT);
  CREATE TABLE topics (id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT, name_zh TEXT, description TEXT, status TEXT DEFAULT 'active', confidence REAL, growth_score REAL DEFAULT 0, first_seen_at TEXT, last_seen_at TEXT);
  CREATE TABLE item_topics (item_id TEXT, topic_id TEXT, relevance REAL, PRIMARY KEY (item_id, topic_id));
  CREATE TABLE canonical_entities (id TEXT PRIMARY KEY, canonical_name TEXT, canonical_slug TEXT UNIQUE, entity_type TEXT, aliases TEXT DEFAULT '[]', description TEXT, description_zh TEXT, confidence REAL, homepage_url TEXT);
  CREATE TABLE item_entities (item_id TEXT, entity_id TEXT, PRIMARY KEY (item_id, entity_id));
  CREATE TABLE entity_momentum (entity_id TEXT, window TEXT, burst_score REAL DEFAULT 0, PRIMARY KEY (entity_id, window));
  CREATE TABLE daily_digests (id TEXT PRIMARY KEY, digest_date TEXT UNIQUE, headline TEXT, executive_summary TEXT, top_signals TEXT DEFAULT '[]', emerging_topics TEXT DEFAULT '[]', repo_watch TEXT DEFAULT '[]', paper_watch TEXT DEFAULT '[]', product_watch TEXT DEFAULT '[]', risk_watch TEXT DEFAULT '[]', item_count INTEGER DEFAULT 0, ai_generated INTEGER DEFAULT 0, model_name TEXT, created_at TEXT);
  CREATE TABLE llm_request_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT, status TEXT, elapsed_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE background_jobs (id TEXT PRIMARY KEY, job_type TEXT, status TEXT, params TEXT DEFAULT '{}', result TEXT, error TEXT, created_at TEXT, started_at TEXT, completed_at TEXT);
  CREATE TABLE research_reports (id TEXT PRIMARY KEY, title TEXT, created_at TEXT);
  CREATE TABLE user_data (key TEXT, user_id TEXT DEFAULT '', value TEXT, PRIMARY KEY (key, user_id));
  CREATE VIRTUAL TABLE items_fts USING fts5(title, title_zh, summary, content='', tokenize='trigram');
`);
writer.prepare("INSERT INTO sources (id, slug, label, item_count, last_fetched_at) VALUES ('src-hn', 'hacker-news', 'Hacker News', 2, '2026-09-17 08:00:00')").run();
const insertItem = writer.prepare("INSERT INTO information_items (id, title, canonical_url, source_id, published_at, fetched_at, digest_date, score, content_text) VALUES (?, ?, ?, 'src-hn', ?, '2026-09-17 08:05:00', '2026-09-17', 5, ?)");
insertItem.run('item-1', 'GLM model release', 'https://example.com/glm', '2026-09-17 07:00:00', 'GLM released a new model with long context support');
insertItem.run('item-2', ' unrelated story', 'https://example.com/other', '2026-09-16 07:00:00', 'something else entirely');
writer.prepare("INSERT INTO items_fts (rowid, title, summary) SELECT rowid, title, content_text FROM information_items").run();
writer.prepare("INSERT INTO ai_summaries (item_id, ai_title, one_liner, model_name, prompt_version, created_at) VALUES ('item-1', 'GLM ships new model', 'A concise one-liner', 'glm-test', 'pv1', '2026-09-17 08:10:00')").run();
writer.prepare("INSERT INTO signal_scores (item_id, signal_type, alpha_score, evidence_summary, scored_at) VALUES ('item-1', 'breakthrough', 0.875, 'strong evidence', '2026-09-17 08:11:00')").run();
writer.prepare("INSERT INTO topics (id, slug, name, growth_score, last_seen_at) VALUES ('topic-1', 'llm-releases', 'LLM releases', 3.2, '2026-09-17')").run();
writer.prepare("INSERT INTO item_topics (item_id, topic_id, relevance) VALUES ('item-1', 'topic-1', 0.9)").run();
writer.prepare("INSERT INTO canonical_entities (id, canonical_name, canonical_slug, entity_type, confidence) VALUES ('ent-1', 'Zhipu AI', 'zhipu-ai', 'company', 0.95)").run();
writer.prepare("INSERT INTO item_entities (item_id, entity_id) VALUES ('item-1', 'ent-1')").run();
writer.prepare("INSERT INTO entity_momentum (entity_id, window, burst_score) VALUES ('ent-1', '7d', 4.5)").run();
writer.prepare("INSERT INTO daily_digests (id, digest_date, headline, executive_summary, item_count, created_at) VALUES ('d1', '2026-09-17', 'Big day', 'Summary text', 2, '2026-09-17 09:00:00')").run();
writer.prepare("INSERT INTO llm_request_events (task, status, elapsed_ms, input_tokens, output_tokens) VALUES ('digest', 'completed', 1200, 100, 200)").run();
writer.prepare("INSERT INTO llm_request_events (task, status, elapsed_ms, input_tokens, output_tokens) VALUES ('enrich', 'failed', 300, 10, 0)").run();
writer.prepare("INSERT INTO background_jobs (id, job_type, status, created_at) VALUES ('job-1', 'sync', 'completed', '2026-09-17 08:00:00')").run();

const setSwitch = (enabled) => writer.prepare("INSERT OR REPLACE INTO user_data (key, user_id, value) VALUES ('mcp_server_config', '', ?)").run(JSON.stringify({ enabled }));

afterAll(() => {
  writer.close();
  queries.closeRoDB();
  closeAudit();
  rmSync(workDir, { recursive: true, force: true });
});

describe('read-only enforcement', () => {
  it('opens the business database strictly read-only', () => {
    expect(() => queries.getRoDB().prepare("INSERT INTO user_data (key, value) VALUES ('x', 'y')").run()).toThrow();
  });
});

describe('admin switch contract', () => {
  it('defaults to enabled when unset; malformed values fail closed', () => {
    setSwitch(true);
    expect(queries.isMcpEnabled()).toBe(true);
    setSwitch(false);
    expect(queries.isMcpEnabled()).toBe(false);
    writer.prepare("INSERT OR REPLACE INTO user_data (key, user_id, value) VALUES ('mcp_server_config', '', 'not-json')").run();
    expect(queries.isMcpEnabled()).toBe(false);
    writer.prepare("DELETE FROM user_data WHERE key = 'mcp_server_config'").run();
    expect(queries.isMcpEnabled()).toBe(true);
  });
});

describe('query layer', () => {
  it('summarizes counts and watermarks', () => {
    const overview = queries.systemOverview();
    expect(overview.information_items).toBe(2);
    expect(overview.ai_summaries).toBe(1);
    expect(overview.latest_digest_date).toBe('2026-09-17');
    expect(overview.score_scale).toEqual({ alpha_score: '0-1' });
  });

  it('filters items by source, date and score; supports FTS', () => {
    expect(queries.searchItems({ source_id: 'src-hn' })).toHaveLength(2);
    expect(queries.searchItems({ date_from: '2026-09-17', date_to: '2026-09-17' }).map(r => r.id)).toEqual(['item-1']);
    expect(queries.searchItems({ date_from: '20260917', date_to: '20260917' }).map(r => r.id)).toEqual(['item-1']);
    expect(queries.searchItems({ date_field: 'digest_date', date_from: '2026-09-17', date_to: '2026-09-17' }).map(r => r.id)).toEqual(['item-1', 'item-2']);
    expect(queries.searchItems({ min_score: 0.5 }).map(r => r.id)).toEqual(['item-1']);
    expect(queries.searchItems({ query: 'GLM model' }).map(r => r.id)).toEqual(['item-1']);
    expect(queries.searchItems({ query: 'nomatch-xyz' })).toHaveLength(0);
  });

  it('rejects malformed dates and unsafe FTS input', () => {
    expect(() => queries.searchItems({ date_from: '2026/09/01' })).toThrow(/date_from/);
    expect(() => queries.searchItems({ min_score: 50 })).toThrow(/min_score/);
    expect(() => queries.searchItems({ date_field: 'bogus' })).toThrow(/date_field/);
    expect(queries.ftsQuery('a"b*c')).toBe('"a b c"');
  });

  it('joins summary, signals and topics for one item', () => {
    const row = queries.getItem({ id: 'item-1' });
    expect(row.summary.one_liner).toBe('A concise one-liner');
    expect(row.signals.alpha_score).toBe(0.875);
    expect(row.topics[0].slug).toBe('llm-releases');
    expect(queries.getItem({ id: 'missing' })).toBeNull();
  });

  it('returns digests, topics, entities, usage stats and jobs', () => {
    expect(queries.getDigest({ date: '2026-09-17' }).headline).toBe('Big day');
    expect(queries.getDigest({ date: '1999-01-01' })).toBeNull();
    expect(queries.searchTopics({ query: 'LLM' })[0].slug).toBe('llm-releases');
    expect(queries.queryEntities({ entity_type: 'company' })[0].mention_count).toBe(1);
    expect(queries.queryEntities({ entity_type: 'company' })[0].max_burst_score).toBe(4.5);
    const usage = queries.llmUsageStats({ days: 7 });
    expect(usage).toHaveLength(2);
    expect(queries.jobStatus({ limit: 5 })).toHaveLength(1);
  });

  it('clamps limits and redacts secret-shaped keys defensively', () => {
    expect(queries.clampLimit(500)).toBe(200);
    expect(queries.clampLimit('x')).toBe(20);
    expect(queries.redactSecrets({ api_key: 'k', nested: { access_token: 't', ok: 1 } })).toEqual({ api_key: '[REDACTED]', nested: { access_token: '[REDACTED]', ok: 1 } });
    expect(queries.clampText('x'.repeat(3000))).toContain('truncated');
  });
});

describe('tool gating and response cap', () => {
  const enabledRef = { value: false };
  it('blocks tool execution while disabled', () => {
    expect(() => tools.guard(enabledRef)).toThrow(/disabled/);
  });
  it('drops oversized responses with a truncation marker', () => {
    const big = { blob: 'x'.repeat(tools.RESPONSE_CAP_BYTES + 10) };
    expect(tools.enforceCap(big).truncated).toBe(true);
  });
  it('audit log stays separate from business data and records calls', () => {
    audit({ tool: 'system_overview', status: 'ok', durationMs: 1 });
    const auditDb = new Database(auditPath, { readonly: true });
    const row = auditDb.prepare("SELECT tool, status FROM mcp_audit WHERE tool = 'system_overview'").get();
    expect(row.status).toBe('ok');
    auditDb.close();
  });
  it('stores bounded fingerprints instead of caller-controlled arguments and errors', () => {
    const requestId = '00000000-0000-4000-8000-000000000001';
    audit({ requestId, tool: 'private-marker', argsJson: JSON.stringify({ query: 'private-marker', api_key: 'private-marker', huge: 'x'.repeat(10000) }), client: 'private-marker', status: 'error', error: 'private-marker' });
    const auditDb = new Database(auditPath, { readonly: true });
    const row = auditDb.prepare('SELECT * FROM mcp_audit WHERE request_id = ?').get(requestId);
    expect(JSON.stringify(row)).not.toContain('private-marker');
    expect(JSON.parse(row.args_json).sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(row.args_json).bytes).toBeGreaterThan(10000);
    expect(row.args_json.length).toBeLessThan(120);
    auditDb.close();
  });
});

describe('research evidence boundaries', () => {
  it('discovers and fetches only allowlisted live product evidence in English and Chinese', () => {
    for (const query of ['product system metrics', '产品迭代系统概览']) {
      const found = research.search({ query }).results;
      expect(found.map(row => row.id)).toContain('system:overview');
      expect(found.map(row => row.id)).toContain('system:llm-usage');
      expect(found.length).toBeLessThanOrEqual(20);
    }
    expect(research.search({ query: '模型用量' }).results[0].id).toBe('system:llm-usage');
    const overview = research.fetchDocument({ id: 'system:overview' });
    expect(overview.url).toBe('https://eagleye.udify.fun/settings');
    expect(overview.text).toContain('"information_items":2');
    expect(overview.metadata.source_fetched_at).toBe('2026-09-17 08:05:00');
    expect(overview.metadata.citation_kind).toBe('product_page_not_snapshot');
    const usage = research.fetchDocument({ id: 'system:llm-usage' });
    expect(usage.text).toContain('"input_tokens":100');
    expect(usage.text).toContain('"status":"failed"');
    expect(usage.text).toContain('Latest event time is not available');
    expect(usage.metadata.lookback_days).toBe(7);
    expect(usage.metadata.returned_rows).toBe(2);
    expect(() => research.fetchDocument({ id: 'system:config' })).toThrow(/Unsupported/);
  });

  it('bounds usage evidence to 30 aggregate groups with an explicit total', () => {
    try {
      const insert = writer.prepare("INSERT INTO llm_request_events (task, status, elapsed_ms, input_tokens, output_tokens) VALUES (?, 'completed', 100, 1, 2)");
      for (let i = 0; i < 35; i += 1) insert.run(`bounded-${i}`);
      const usage = research.fetchDocument({ id: 'system:llm-usage' });
      expect(usage.metadata.returned_rows).toBe(30);
      expect(usage.metadata.total_rows).toBe(37);
      expect(usage.text.length).toBeLessThanOrEqual(research.TEXT_LIMIT);
      expect(usage.text).toContain('Showing 30 of 37');
    } finally {
      writer.prepare("DELETE FROM llm_request_events WHERE task LIKE 'bounded-%'").run();
    }
  });

  it('returns citation ids and bounded live document excerpts', () => {
    expect(research.search({ query: 'GLM model' })).toEqual({ results: [
      { id: 'item:item-1', title: 'GLM model release', url: 'https://example.com/glm' },
    ] });
    const document = research.fetchDocument({ id: 'item:item-1' });
    expect(document.text).toContain('GLM released a new model');
    expect(document.text.length).toBeLessThanOrEqual(research.TEXT_LIMIT);
    expect(document.metadata.mutable).toBe(true);
    expect(document.metadata.source_fetched_at).toBe('2026-09-17 08:05:00');
    expect(Number.isNaN(Date.parse(document.metadata.generated_at))).toBe(false);
    expect(research.search({ query: 'absent-document' })).toEqual({ results: [] });
  });

  it('rejects arbitrary ids, files, URLs and unbounded queries', () => {
    for (const id of ['file:///etc/passwd', 'https://example.com', 'item:../config/mcp-token', 'item:x'.repeat(100)]) {
      expect(() => research.fetchDocument({ id })).toThrow(/Unsupported evidence id/);
    }
    expect(() => research.fetchDocument({ id: 'item:missing' })).toThrow(/not found/);
    for (const query of ['', '   ', 'x'.repeat(201), null]) {
      expect(() => research.search({ query })).toThrow(/1-200/);
    }
  });

  it('filters citation credentials and redacts recognized inline secrets', () => {
    for (const url of ['file:///etc/passwd', 'http://127.0.0.1:3020/mcp', 'https://user:pass@example.com/story', 'https://example.com/secret/value', 'https://eagleye-mcp.example.com/hidden/mcp']) {
      expect(research.citationUrl(url)).toBeNull();
    }
    expect(research.citationUrl('https://example.com/story?token=private#secret')).toBe('https://example.com/story');
    const text = research.safeText('Bearer PRIVATE api_key=PRIVATE sk-PRIVATE ccr-dev-PRIVATE https://example.com/story?token=PRIVATE {"password":"PRIVATE"}', 1000);
    expect(text).not.toContain('PRIVATE');
    expect(text).toContain('[REDACTED]');
    expect(research.citationUrl('https://news.ycombinator.com/item?id=12345&token=PRIVATE')).toBe('https://news.ycombinator.com/item?id=12345');
    expect(research.citationUrl('https://www.youtube.com/watch?v=abc123&utm_source=test')).toBe('https://www.youtube.com/watch?v=abc123');
    expect(research.citationUrl('https://example.com/articles/api-key-management')).toBe('https://example.com/articles/api-key-management');
    expect(research.citationUrl('https://example.com/a-long-human-readable-title-that-exceeds-forty-characters')).toBe('https://example.com/a-long-human-readable-title-that-exceeds-forty-characters');
  });

  it('caps search rows and document fields even when stored summaries are large', () => {
    try {
      writer.prepare("UPDATE ai_summaries SET short_summary = ? WHERE item_id = 'item-1'").run('large'.repeat(10000));
      const result = research.fetchDocument({ id: 'item:item-1' });
      expect(result.text.length).toBeLessThanOrEqual(research.TEXT_LIMIT);
      for (let i = 0; i < 25; i += 1) {
        insertItem.run(`extra-${i}`, 'Bounded research article', `https://example.com/article/${i}`, '2026-09-17', 'excerpt');
      }
      writer.prepare("INSERT INTO items_fts (rowid, title, summary) SELECT rowid, title, content_text FROM information_items WHERE id LIKE 'extra-%'").run();
      expect(research.search({ query: 'Bounded research' }).results).toHaveLength(20);
    } finally {
      writer.prepare("UPDATE ai_summaries SET short_summary = NULL WHERE item_id = 'item-1'").run();
      writer.prepare("DELETE FROM information_items WHERE id LIKE 'extra-%'").run();
    }
  });
});

describe('http transport (e2e)', () => {
  let child;
  const regressionEvidence = [];
  const base = `http://127.0.0.1:${port}`;
  const rpc = async (body, withAuth = true) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(withAuth ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, requestId: res.headers.get('x-eagleye-request-id'), json: await res.json().catch(() => null) };
  };
  beforeAll(async () => {
    setSwitch(false);
    child = spawn(process.execPath, [path.resolve(__dirname, '../server.js'), String(port)], {
      env: { ...process.env, EAGLEYE_MCP_TOKEN: token, EAGLEYE_MCP_AUDIT_PATH: auditPath, EAGLEYE_DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', () => {});
    for (let i = 0; i < 50; i += 1) {
      try {
        const res = await fetch(`${base}/health`);
        if (res.ok) return;
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('mcp server did not start');
  });
  afterAll(() => {
    child?.kill('SIGTERM');
    if (process.env.EAGLEYE_MCP_EVIDENCE_PATH) writeFileSync(`${process.env.EAGLEYE_MCP_EVIDENCE_PATH}.review-regressions.json`, JSON.stringify(regressionEvidence, null, 2));
  });

  it('answers health without auth and rejects missing/incorrect tokens', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, false)).status).toBe(401);
    const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' }, body: '{}' });
    expect(bad.status).toBe(401);
  });

  it('handshakes and lists the curated tools', async () => {
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    expect(init.json.result.serverInfo.name).toBe('eagleye-readonly');
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.json.result.tools.map(t => t.name);
    expect(names).toContain('system_overview');
    expect(names).toContain('search_items');
    expect(names).toContain('search');
    expect(names).toContain('fetch');
    expect(names).toHaveLength(12);
    for (const tool of list.json.result.tools) expect(tool.annotations.readOnlyHint).toBe(true);
    for (const name of ['search', 'fetch']) {
      expect(list.json.result.tools.find(t => t.name === name).outputSchema.type).toBe('object');
    }
  });

  it('rejects JSON-RPC batches before transport dispatch and audits the rejection', async () => {
    const batch = await rpc([
      { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'system_overview', arguments: {} } },
      { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'fetch', arguments: { id: 'system:overview' } } },
    ]);
    expect(batch.status).toBe(400);
    expect(batch.json).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });
    expect(batch.json.result).toBeUndefined();
    const auditDb = new Database(auditPath, { readonly: true });
    const rows = auditDb.prepare('SELECT tool, status, args_json FROM mcp_audit WHERE request_id = ?').all(batch.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: 'batch_rejected', status: 'bad_request' });
    expect(JSON.parse(rows[0].args_json).bytes).toBeGreaterThan(0);
    auditDb.close();
    regressionEvidence.push({ scenario: 'batch rejected before dispatch', response: batch, audit: rows });
  });

  it('fails closed when the admin switch is off, then serves real data once enabled', { timeout: 15000 }, async () => {
    const call = (name, args) => rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } });
    const denied = await call('system_overview', {});
    expect(denied.json.result.isError).toBe(true);
    expect(denied.json.result.content[0].text).toContain('disabled');
    for (const [name, args] of [['search', { query: 'GLM model' }], ['fetch', { id: 'item:item-1' }]]) {
      const result = await call(name, args);
      expect(result.json.result.isError).toBe(true);
      expect(result.json.result.content[0].text).toContain('disabled');
    }
    setSwitch(true);
    await new Promise(r => setTimeout(r, 5600));
    const allowed = await call('system_overview', {});
    const payload = JSON.parse(allowed.json.result.content[0].text);
    expect(payload.information_items).toBe(2);
    const searched = await call('search_items', { query: 'GLM model' });
    expect(JSON.parse(searched.json.result.content[0].text)[0].id).toBe('item-1');
    const evidenceSearch = await call('search', { query: 'GLM model' });
    const searchResult = evidenceSearch.json.result;
    expect(searchResult.isError).not.toBe(true);
    expect(searchResult.structuredContent).toEqual(JSON.parse(searchResult.content[0].text));
    expect(searchResult.structuredContent.results[0].url).toBe('https://example.com/glm');
    const fetched = await call('fetch', { id: searchResult.structuredContent.results[0].id });
    expect(fetched.json.result.isError).not.toBe(true);
    expect(fetched.json.result.structuredContent).toEqual(JSON.parse(fetched.json.result.content[0].text));
    expect(fetched.json.result.structuredContent.text).toContain('GLM released a new model');
    const invalid = await call('fetch', { id: 'file:///etc/passwd' });
    expect(invalid.json.result.isError || invalid.json.error).toBeTruthy();
    const protocolFailure = await rpc({ jsonrpc: '2.0', id: 7, method: 'unknown/method' });
    expect(protocolFailure.json.error).toBeTruthy();
    const privateQuery = await call('search', { query: 'api_key=private-argument-marker' });
    expect(privateQuery.json.result.isError).not.toBe(true);
    const productSearch = await call('search', { query: '产品系统指标与模型用量' });
    expect(productSearch.json.result.structuredContent.results.map(row => row.id)).toEqual(['system:overview', 'system:llm-usage']);
    const productDocuments = [];
    for (const item of productSearch.json.result.structuredContent.results) {
      const fetchedProduct = await call('fetch', { id: item.id });
      expect(fetchedProduct.json.result.isError).not.toBe(true);
      expect(fetchedProduct.json.result.structuredContent).toEqual(JSON.parse(fetchedProduct.json.result.content[0].text));
      expect(fetchedProduct.json.result.structuredContent.metadata.citation_kind).toBe('product_page_not_snapshot');
      productDocuments.push(fetchedProduct.json);
    }
    const auditDb = new Database(auditPath, { readonly: true });
    const auditRows = auditDb.prepare('SELECT tool, status, request_id, args_json, error FROM mcp_audit').all();
    expect(auditRows.length).toBeGreaterThanOrEqual(4);
    expect(auditRows.find(row => row.request_id === invalid.requestId).status).toBe('tool_error');
    expect(auditRows.find(row => row.request_id === evidenceSearch.requestId).status).toBe('ok');
    expect(auditRows.some(row => row.status === 'tool_error')).toBe(true);
    expect(auditDb.prepare('SELECT status FROM mcp_audit WHERE request_id = ?').get(denied.requestId).status).toBe('tool_error');
    expect(auditDb.prepare('SELECT status FROM mcp_audit WHERE request_id = ?').get(protocolFailure.requestId).status).toBe('protocol_error');
    expect(JSON.stringify(auditRows)).not.toContain('file:///etc/passwd');
    expect(JSON.stringify(auditRows)).not.toContain('private-argument-marker');
    auditDb.close();
    if (process.env.EAGLEYE_MCP_EVIDENCE_PATH) {
      writeFileSync(process.env.EAGLEYE_MCP_EVIDENCE_PATH, JSON.stringify({
        scenario: 'Fixture database, spawned HTTP server, authenticated search/fetch, admin gating and audit',
        generated_at: new Date().toISOString(),
        search: evidenceSearch.json,
        fetch: fetched.json,
        product_search: productSearch.json,
        product_documents: productDocuments,
        invalid_id: invalid.json,
        protocol_failure: protocolFailure.json,
        request_ids: { search: evidenceSearch.requestId, invalid: invalid.requestId, disabled: denied.requestId, protocol_failure: protocolFailure.requestId },
        disabled: denied.json,
        audit: auditRows,
      }, null, 2));
    }
  });

  it('redacts complete quoted values through HTTP fetch while preserving article citation identity', async () => {
    const original = writer.prepare("SELECT content_text, canonical_url FROM information_items WHERE id = 'item-2'").get();
    const sensitive = [
      JSON.stringify({ password: 'hello world private-tail' }),
      JSON.stringify({ api_key: 'escaped "quote", private-comma-tail' }),
      "secret='hello \\'quoted\\' private-single-tail'",
      'authorization="unterminated private-final-tail\\',
    ].join('\n');
    const call = (name, args) => rpc({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name, arguments: args } });
    try {
      writer.prepare("UPDATE information_items SET content_text = ?, canonical_url = ? WHERE id = 'item-2'").run(sensitive, 'https://news.ycombinator.com/item?id=12345&token=PRIVATE');
      const searched = await call('search', { query: 'unrelated story' });
      expect(searched.json.result.structuredContent.results[0].url).toBe('https://news.ycombinator.com/item?id=12345');
      const fetched = await call('fetch', { id: 'item:item-2' });
      expect(fetched.json.result.isError).not.toBe(true);
      const wireOutput = JSON.stringify(fetched.json);
      for (const marker of ['private-tail', 'private-comma-tail', 'private-single-tail', 'private-final-tail', 'PRIVATE']) expect(wireOutput).not.toContain(marker);
      expect(fetched.json.result.structuredContent.text.match(/\[REDACTED\]/g)).toHaveLength(4);
      expect(fetched.json.result.structuredContent.url).toBe('https://news.ycombinator.com/item?id=12345');
      regressionEvidence.push({ scenario: 'quoted secrets absent from public fetch; HN id retained', search: searched, fetch: fetched });
      const longUrl = 'https://example.com/a-long-human-readable-title-that-exceeds-forty-characters';
      writer.prepare("UPDATE information_items SET canonical_url = ? WHERE id = 'item-2'").run(longUrl);
      const longFetched = await call('fetch', { id: 'item:item-2' });
      expect(longFetched.json.result.structuredContent.url).toBe(longUrl);
      regressionEvidence.push({ scenario: 'ordinary long slug retained', fetch: longFetched });
    } finally {
      writer.prepare("UPDATE information_items SET content_text = ?, canonical_url = ? WHERE id = 'item-2'").run(original.content_text, original.canonical_url);
    }
  });
});
