// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createPoolService } = require('../llm-pool');
const { TASKS, validatePoolConfig } = require('../llm-pool-config');
const { LLMError, sendLLMRequest } = require('../llm-transport');
const { CLASS_BY_CODE, classifyCode, RETRYABLE_CLASSES, TERMINAL_CODES, isTerminalLLMError } = require('../llm-error-class');
const { CONFIG_KEY, defaultSwitches, getSwitches, setSwitches } = require('../runtime-switches');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let db;
let servers;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/031_llm_request_events.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/038_llm_error_class.sql'), 'utf8'));
  servers = [];
});

afterEach(async () => {
  await delay(5);
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  db.close();
});

function makePool(options = {}) {
  const persisted = new Map();
  return createPoolService({
    getDB: () => db,
    getValue: key => persisted.get(key),
    setValue: (key, value) => persisted.set(key, structuredClone(value)),
    ...options,
  });
}

function lane(id, quota_group) {
  return { id, label: id, protocol: 'anthropic', endpoint_url: `http://127.0.0.1:9/v1/messages-${id.slice(-1)}`,
    api_key: `key-${id}`, model: `model-${id}`, enabled: true, concurrency: 1, tasks: TASKS, ...(quota_group ? { quota_group } : {}) };
}

function save(pool, endpoints, overrides = {}) {
  pool.savePoolConfig({ schema_version: 1, enabled: true, global_concurrency: 4, queue_limit: 20,
    request_timeout_ms: 2000, queue_timeout_ms: 1000, max_attempts: 2, endpoints, ...overrides });
}

function failingPool(error, sent, options = {}) {
  return makePool({ ...options, sendRequest: async endpoint => { sent.push(endpoint.id); throw error; } });
}

describe('R0 LLM error classification contract', () => {
  it('maps transport and pool codes onto shared classes with explicit retry policy', () => {
    expect(CLASS_BY_CODE.AUTH_ERROR).toBe('AUTH_CONFIG_ERROR');
    expect(CLASS_BY_CODE.RATE_LIMIT).toBe('RATE_LIMITED');
    expect(CLASS_BY_CODE.NETWORK_ERROR).toBe('TEMPORARY_ERROR');
    expect(CLASS_BY_CODE.QUEUE_TIMEOUT).toBe('DEADLINE_EXCEEDED');
    expect(CLASS_BY_CODE.INVALID_RESPONSE).toBe('OUTPUT_INVALID');
    expect(classifyCode('NO_ENDPOINT')).toBe('AUTH_CONFIG_ERROR');
    expect(classifyCode('UNRECOGNIZED_CODE')).toBe('TEMPORARY_ERROR');
    expect([...RETRYABLE_CLASSES].sort()).toEqual(['RATE_LIMITED', 'TEMPORARY_ERROR']);
    expect([...TERMINAL_CODES].sort()).toEqual(['AUTH_ERROR', 'CANCELLED', 'CONFIG_ERROR', 'NO_ENDPOINT']);
    expect(isTerminalLLMError({ code: 'AUTH_ERROR' })).toBe(true);
    expect(isTerminalLLMError(Object.assign(new Error('stop'), { name: 'AbortError' }))).toBe(true);
    expect(isTerminalLLMError({ code: 'RATE_LIMIT' })).toBe(false);
    expect(isTerminalLLMError(null)).toBe(false);
  });

  it('persists error_class and retry_after_ms columns on llm_request_events', () => {
    const columns = db.prepare('PRAGMA table_info(llm_request_events)').all().map(row => row.name);
    expect(columns).toContain('error_class');
    expect(columns).toContain('retry_after_ms');
  });

  it('buckets failures by class, code, and task inside the requested window', () => {
    db.prepare(`INSERT INTO llm_request_events (trace_id, attempt, task, status, error_code, error_class, retry_after_ms, elapsed_ms, created_at)
      VALUES ('trace-old', 1, 'digest', 'failed', 'RATE_LIMIT', 'RATE_LIMITED', 1200, 55, datetime('now', '-10 days'))`).run();
    db.prepare(`INSERT INTO llm_request_events (trace_id, attempt, task, status, error_code, error_class, retry_after_ms, elapsed_ms, created_at)
      VALUES ('trace-new', 1, 'digest', 'failed', 'AUTH_ERROR', 'AUTH_CONFIG_ERROR', NULL, 40, datetime('now'))`).run();
    const pool = makePool();
    const week = pool.getLlmFailureBreakdown({ days: 7 });
    expect(week.available).toBe(true);
    expect(week.days).toBe(7);
    expect(week.by_class).toEqual([{ error_class: 'AUTH_CONFIG_ERROR', count: 1 }]);
    expect(week.recent).toHaveLength(1);
    expect(week.recent[0]).toMatchObject({ trace_id: 'trace-new', error_code: 'AUTH_ERROR', retry_after_ms: null });
    const quarter = pool.getLlmFailureBreakdown({ days: 90 });
    expect(quarter.by_class.map(row => row.error_class)).toEqual(['AUTH_CONFIG_ERROR', 'RATE_LIMITED']);
    expect(quarter.by_code.map(row => row.error_code)).toEqual(['AUTH_ERROR', 'RATE_LIMIT']);
    expect(quarter.by_task).toEqual([{ task: 'digest', count: 2 }]);
    expect(pool.getLlmFailureBreakdown({ days: 500 }).days).toBe(90);
  });

  it('cools the whole quota group on 429 and honors retry-after over the queue deadline', async () => {
    const sent = [];
    const pool = failingPool(new LLMError('RATE_LIMIT', 'slow down', { retryable: true, retryAfterMs: 1500 }), sent);
    save(pool, [lane('lane-1', 'vendor-a'), lane('lane-2', 'vendor-a')]);
    await expect(pool.getPoolProvider('general').callWithMetadata('hello', {})).rejects.toMatchObject({ code: 'QUEUE_TIMEOUT', isPoolError: true });
    expect(sent).toEqual(['lane-1']);
    const rows = db.prepare('SELECT endpoint_id, status, error_code, error_class, retry_after_ms FROM llm_request_events ORDER BY id').all();
    expect(rows).toEqual([
      { endpoint_id: 'lane-1', status: 'failed', error_code: 'RATE_LIMIT', error_class: 'RATE_LIMITED', retry_after_ms: 1500 },
      { endpoint_id: null, status: 'failed', error_code: 'QUEUE_TIMEOUT', error_class: 'DEADLINE_EXCEEDED', retry_after_ms: null },
    ]);
    const endpoints = pool.getPoolStatus().runtime.endpoints;
    expect(endpoints.map(row => row.state)).toEqual(['open', 'open']);
    expect(endpoints[0].cooldown_until).toBe(endpoints[1].cooldown_until);
    expect(Date.parse(endpoints[0].cooldown_until)).toBeGreaterThan(Date.now());
  });

  it('escalates quota-group backoff across consecutive 429s', async () => {
    const sent = [];
    let clock = 1700000000000;
    const pool = failingPool(new LLMError('RATE_LIMIT', 'slow down', { retryable: true }), sent, { now: () => clock });
    save(pool, [lane('lane-1', 'vendor-a'), lane('lane-2', 'vendor-a')], { queue_timeout_ms: 20, request_timeout_ms: 100 });
    await expect(pool.getPoolProvider('general').callWithMetadata('hello', {})).rejects.toMatchObject({ code: 'QUEUE_TIMEOUT' });
    expect(sent).toEqual(['lane-1']);
    const firstCooldown = pool.getPoolStatus().runtime.endpoints[0].cooldown_until;
    const firstDuration = Date.parse(firstCooldown) - clock;
    clock += 10000;
    await expect(pool.getPoolProvider('general').callWithMetadata('hello', {})).rejects.toMatchObject({ code: 'QUEUE_TIMEOUT' });
    expect(sent).toEqual(['lane-1', 'lane-2']);
    const secondCooldown = pool.getPoolStatus().runtime.endpoints[0].cooldown_until;
    const secondDuration = Date.parse(secondCooldown) - clock;
    expect(firstCooldown).not.toBeNull();
    expect(secondCooldown).not.toBeNull();
    expect(secondDuration).toBeGreaterThan(firstDuration);
  });

  it('fails over once across quota groups on auth errors, then stops', async () => {
    const sent = [];
    const pool = failingPool(new LLMError('AUTH_ERROR', 'bad credentials', { retryable: false }), sent);
    save(pool, [lane('lane-1', 'vendor-a'), lane('lane-2', 'vendor-a'), lane('lane-3', 'vendor-b')]);
    await expect(pool.getPoolProvider('general').callWithMetadata('hello', {})).rejects.toMatchObject({ code: 'AUTH_ERROR', isPoolError: true });
    expect(sent).toEqual(['lane-1', 'lane-3']);
    const rows = db.prepare('SELECT endpoint_id, error_code, error_class FROM llm_request_events ORDER BY id').all();
    expect(rows).toEqual([
      { endpoint_id: 'lane-1', error_code: 'AUTH_ERROR', error_class: 'AUTH_CONFIG_ERROR' },
      { endpoint_id: 'lane-3', error_code: 'AUTH_ERROR', error_class: 'AUTH_CONFIG_ERROR' },
    ]);
    const endpoints = pool.getPoolStatus().runtime.endpoints;
    expect(endpoints[0].cooldown_until).toBe(endpoints[1].cooldown_until);
    expect(endpoints[0].cooldown_until).not.toBeNull();
    expect(endpoints[2].cooldown_until).not.toBeNull();
  });

  it('keeps same-group auth failures terminal without failover', async () => {
    const sent = [];
    const pool = failingPool(new LLMError('AUTH_ERROR', 'bad credentials', { retryable: false }), sent);
    save(pool, [lane('lane-1', 'vendor-a'), lane('lane-2', 'vendor-a')]);
    await expect(pool.getPoolProvider('general').callWithMetadata('hello', {})).rejects.toMatchObject({ code: 'AUTH_ERROR', isPoolError: true });
    expect(sent).toEqual(['lane-1']);
    const endpoints = pool.getPoolStatus().runtime.endpoints;
    expect(endpoints[0].cooldown_until).toBe(endpoints[1].cooldown_until);
    expect(endpoints[0].cooldown_until).not.toBeNull();
  });

  it('treats config errors on the only lane as terminal', async () => {
    const sent = [];
    const pool = failingPool(new LLMError('CONFIG_ERROR', 'bad model', { retryable: false }), sent);
    save(pool, [lane('lane-1')]);
    await expect(pool.getPoolProvider('general').callWithMetadata('hello', {})).rejects.toMatchObject({ code: 'CONFIG_ERROR', isPoolError: true });
    expect(sent).toEqual(['lane-1']);
    expect(db.prepare('SELECT COUNT(*) AS count FROM llm_request_events WHERE status = ?').get('failed').count).toBe(1);
  });

  it('rejects invalid endpoint URLs and parses retry-after from real 429 responses', async () => {
    await expect(sendLLMRequest({ id: 'x', protocol: 'anthropic', endpoint_url: 'not-a-url', api_key: 'k', model: 'm' }, 'hi')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(sendLLMRequest({ id: 'x', protocol: 'anthropic', endpoint_url: 'ftp://127.0.0.1/v1/messages', api_key: 'k', model: 'm' }, 'hi')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    const server = http.createServer((_req, res) => {
      res.statusCode = 429;
      res.setHeader('retry-after', '2');
      res.end('slow down');
    });
    servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = { id: 'lane-1', protocol: 'anthropic', endpoint_url: `http://127.0.0.1:${server.address().port}/v1/messages`, api_key: 'k', model: 'm' };
    await expect(sendLLMRequest(endpoint, 'hi', { timeoutMs: 2000 })).rejects.toMatchObject({ code: 'RATE_LIMIT', retryAfterMs: 2000 });
  });

  it('validates quota groups and preserves previous secrets and groups', () => {
    const endpoint = lane('lane-1');
    const base = { schema_version: 1, enabled: true, endpoints: [endpoint] };
    const config = validatePoolConfig(base);
    expect(config.endpoints[0].quota_group).toBeUndefined();
    expect(config.max_attempts).toBe(2);
    const previous = validatePoolConfig({ ...base, endpoints: [{ ...endpoint, quota_group: 'team-a' }] });
    const kept = validatePoolConfig({ schema_version: 1, enabled: true,
      endpoints: [{ id: 'lane-1', protocol: 'anthropic', endpoint_url: endpoint.endpoint_url, api_key: '••••', model: 'm' }] }, previous);
    expect(kept.endpoints[0].quota_group).toBe('team-a');
    expect(kept.endpoints[0].api_key).toBe('key-lane-1');
    expect(() => validatePoolConfig({ ...base, endpoints: [{ ...endpoint, quota_group: 'bad group!' }] })).toThrow('quota_group must be a safe identifier');
    expect(() => validatePoolConfig({ ...base, endpoints: [{ ...endpoint, quota_group: 'team_a-1' }] })).not.toThrow();
  });

  it('round-trips runtime switches with fail-open defaults', () => {
    expect(CONFIG_KEY).toBe('runtime_switches');
    expect(getSwitches(() => null)).toEqual(defaultSwitches());
    expect(getSwitches(() => 'not-json')).toEqual(defaultSwitches());
    const store = new Map();
    const io = { getValue: key => store.get(key), setValue: (key, value) => store.set(key, value) };
    const next = setSwitches({ digest: false, graph: false }, io);
    expect(next).toEqual({ ...defaultSwitches(), digest: false, graph: false });
    expect(JSON.parse(store.get(CONFIG_KEY))).toEqual(next);
    expect(getSwitches(key => store.get(key))).toEqual(next);
    expect(() => setSwitches({ unknown: false }, io)).toThrow('Unknown runtime switch: unknown');
    expect(() => setSwitches({ digest: 'yes' }, io)).toThrow('Runtime switch digest must be boolean');
    expect(() => setSwitches('digest', io)).toThrow('Switch patch must be an object');
  });
});
