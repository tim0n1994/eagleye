// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createPoolService } = require('../llm-pool');
const { TASKS } = require('../llm-pool-config');
const { LLMError } = require('../llm-transport');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let db;
let pool;
let servers;
let persisted;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/031_llm_request_events.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/038_llm_error_class.sql'), 'utf8'));
  persisted = new Map();
  servers = [];
  pool = createPoolService({ getDB: () => db, getValue: key => persisted.get(key), setValue: (key, value) => persisted.set(key, structuredClone(value)) });
});

afterEach(async () => {
  await delay(5);
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  db.close();
});

async function endpoint(handler, count = 2) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return Array.from({ length: count }, (_, index) => ({ id: `lane-${index + 1}`, label: `Lane ${index + 1}`, protocol: 'anthropic',
    endpoint_url: `http://127.0.0.1:${server.address().port}/v1/messages${index ? `-${index + 1}` : ''}`,
    api_key: `secret-sentinel-${index}`, model: `requested-${index}`, enabled: true, concurrency: 1, tasks: TASKS }));
}

function save(endpoints, overrides = {}) {
  return pool.savePoolConfig({ schema_version: 1, enabled: true, global_concurrency: 2, queue_limit: 20,
    request_timeout_ms: 2000, queue_timeout_ms: 1000, max_attempts: 2, endpoints, ...overrides });
}

function reply(res, text = '{"ok":true}', model = 'actual-model') {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } }));
}

describe('pool configuration', () => {
  it('roundtrips masked keys and preserves full distinct endpoint URLs and protocols', async () => {
    const endpoints = await endpoint((_req, res) => reply(res), 5);
    const masked = save(endpoints);
    expect(masked.endpoints.every(row => row.api_key === '••••')).toBe(true);
    expect(JSON.stringify(pool.getPoolConfig())).not.toContain('secret-sentinel');
    masked.endpoints[0].model = 'gemini-via-anthropic';
    delete masked.endpoints[1].api_key;
    masked.endpoints[2].api_key = 'sk-****1234';
    pool.savePoolConfig(masked);
    const raw = pool.getPoolConfig({ masked: false });
    expect(raw.endpoints.map(row => row.endpoint_url)).toEqual(endpoints.map(row => row.endpoint_url));
    expect(raw.endpoints[0].protocol).toBe('anthropic');
    expect(raw.endpoints.map(row => row.api_key)).toEqual(endpoints.map(row => row.api_key));
    const restarted = createPoolService({ getDB: () => db, getValue: key => persisted.get(key), setValue: (key, value) => persisted.set(key, value) });
    expect(restarted.getPoolConfig({ masked: false })).toEqual(raw);
  });

  it('parses five pasted endpoint blocks without model-name protocol guessing or key exposure', () => {
    const pasted = Array.from({ length: 5 }, (_, index) => `Provider: Display vendor ${index}\nProtocol: Anthropic Messages\nLocal Endpoint:\n  Base URL: http://127.0.0.1:56185\n  Messages URL: http://127.0.0.1:56185/v1/messages${index ? `-${index + 1}` : ''}\n  API Key: secret-sentinel-${index}\n  Model: gemini-${index}`).join('\n\n');
    const masked = pool.parsePastedPoolConfig(pasted);
    expect(masked.endpoints).toHaveLength(5);
    expect(masked.endpoints.map(row => row.protocol)).toEqual(Array(5).fill('anthropic'));
    expect(masked.endpoints[4].endpoint_url).toBe('http://127.0.0.1:56185/v1/messages-5');
    expect(JSON.stringify(masked)).not.toContain('secret-sentinel');
    const saved = pool.savePoolConfig({ ...pool.parsePastedPoolConfig(pasted, { masked: false }), enabled: true });
    expect(saved.enabled).toBe(true);
  });

  it('rejects duplicate ids, new masked keys, non-local routes, unsafe URLs and invalid limits', async () => {
    const endpoints = await endpoint((_req, res) => reply(res));
    expect(() => save([endpoints[0], endpoints[0]])).toThrow();
    expect(() => save([{ ...endpoints[0], api_key: '••••' }])).toThrow();
    expect(() => save([{ ...endpoints[0], endpoint_url: 'https://example.com/v1/messages' }])).toThrow();
    expect(() => save([{ ...endpoints[0], endpoint_url: 'http://user:password@127.0.0.1/v1/messages' }])).toThrow();
    expect(() => save([{ ...endpoints[0], endpoint_url: 'http://127.0.0.1/v1/messages?api_key=secret' }])).toThrow();
    expect(() => save(endpoints, { max_attempts: 3 })).toThrow();
    expect(() => save(endpoints, { global_concurrency: 0 })).toThrow();
  });

  it('keeps repeated base-url blocks distinct and requires explicit native Gemini URLs', () => {
    const config = pool.parsePastedPoolConfig('Provider: A\nProtocol: Anthropic Messages\nBase URL: http://127.0.0.1:1234/v1\nAPI Key: fake-a\nModel: a\nProvider: B\nProtocol: OpenAI Chat Completions\nBase URL: http://127.0.0.1:1235/v1\nAPI Key: fake-b\nModel: b');
    expect(config.endpoints).toHaveLength(2);
    expect(config.endpoints[1].endpoint_url).toBe('http://127.0.0.1:1235/v1/chat/completions');
    expect(() => pool.parsePastedPoolConfig('Protocol: Gemini\nBase URL: http://127.0.0.1:1234/v1\nAPI Key: fake\nModel: model')).toThrow('explicit complete');
  });
});

describe('bounded shared scheduling', () => {
  it('enforces global and per-route concurrency across separate provider wrappers', async () => {
    let active = 0;
    let peak = 0;
    const routeActive = new Map();
    const routePeak = new Map();
    const paths = new Set();
    const endpoints = await endpoint((req, res) => {
      paths.add(req.url);
      active++;
      peak = Math.max(peak, active);
      routeActive.set(req.url, (routeActive.get(req.url) || 0) + 1);
      routePeak.set(req.url, Math.max(routePeak.get(req.url) || 0, routeActive.get(req.url)));
      setTimeout(() => { active--; routeActive.set(req.url, routeActive.get(req.url) - 1); reply(res); }, 20);
    }, 5);
    save(endpoints, { global_concurrency: 3 });
    const results = await Promise.all(Array.from({ length: 15 }, (_, index) => pool.getPoolProvider(index % 2 ? 'enrich' : 'research').callWithMetadata('safe test', { json: true })));
    expect(peak).toBe(3);
    expect([...routePeak.values()].every(value => value === 1)).toBe(true);
    expect(paths.size).toBe(5);
    expect(results.every(row => row.metadata.model === 'actual-model' && row.metadata.attempts === 1)).toBe(true);
    expect(pool.getPoolStatus().runtime).toMatchObject({ active: 0, queued: 0 });
    expect(pool.getPoolStatus().metrics).toMatchObject({ total: 15, completed: 15, available: true });
  });

  it.each([429, 529, 401])('fails over HTTP %s to a different route within two attempts', async status => {
    const paths = [];
    const endpoints = await endpoint((req, res) => {
      paths.push(req.url);
      if (req.url.endsWith('/messages')) { res.statusCode = status; res.end('secret-sentinel-body'); }
      else reply(res, '{"ok":true}', 'actual-lane-2');
    });
    save(endpoints);
    const result = await pool.getPoolProvider().callWithMetadata('prompt-sentinel', { json: true });
    expect(paths).toEqual(['/v1/messages', '/v1/messages-2']);
    expect(result.metadata).toMatchObject({ attempts: 2, endpoint_id: 'lane-2', requested_model: 'requested-1', model: 'actual-lane-2' });
    expect(JSON.stringify(pool.getPoolStatus())).not.toMatch(/secret-sentinel|prompt-sentinel/);
    expect(JSON.stringify(db.prepare('SELECT * FROM llm_request_events').all())).not.toMatch(/secret-sentinel|prompt-sentinel/);
  });

  it('invalid JSON or validator failures use the same bounded route fallback', async () => {
    const paths = [];
    const endpoints = await endpoint((req, res) => { paths.push(req.url); reply(res, req.url.endsWith('/messages') ? '{"wrong":true}' : '{"ok":true}'); });
    save(endpoints);
    const result = await pool.getPoolProvider('classify').callWithMetadata('safe', { json: true, validate: parsed => parsed.ok === true });
    expect(result.metadata.attempts).toBe(2);
    expect(paths).toHaveLength(2);
  });

  it('all routes failing stops after two attempts and never calls legacy endpoints', async () => {
    let count = 0;
    const endpoints = await endpoint((_req, res) => { count++; res.statusCode = 529; res.end('secret-sentinel'); }, 5);
    save(endpoints);
    await expect(pool.getPoolProvider().call('prompt-sentinel')).rejects.toMatchObject({ code: 'HTTP_ERROR', isPoolError: true });
    expect(count).toBe(2);
    expect(pool.getPoolStatus().runtime.active).toBe(0);
  });

  it('bounds queue length and queue waiting time', async () => {
    const endpoints = await endpoint((_req, res) => setTimeout(() => reply(res), 90), 1);
    save(endpoints, { global_concurrency: 1, queue_limit: 1, queue_timeout_ms: 30 });
    const first = pool.getPoolProvider().call('first');
    const second = pool.getPoolProvider().call('second');
    const waiting = expect(second).rejects.toMatchObject({ code: 'QUEUE_TIMEOUT' });
    await expect(pool.getPoolProvider().call('third')).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    await waiting;
    await first;
    expect(pool.getPoolStatus().runtime).toMatchObject({ active: 0, queued: 0 });
  });

  it('cancels queued and active calls, releases slots and continues later work', async () => {
    const requests = [];
    const endpoints = await endpoint((req, res) => { requests.push(req.url); if (requests.length > 1) reply(res); }, 1);
    save(endpoints, { global_concurrency: 1 });
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const first = pool.getPoolProvider().call('first', { signal: activeController.signal });
    const firstCheck = expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await delay(20);
    const second = pool.getPoolProvider().call('second', { signal: queuedController.signal });
    const secondCheck = expect(second).rejects.toMatchObject({ code: 'CANCELLED' });
    queuedController.abort();
    activeController.abort();
    await Promise.all([firstCheck, secondCheck]);
    await delay(10);
    expect(requests).toHaveLength(1);
    expect(pool.getPoolStatus().runtime).toMatchObject({ active: 0, queued: 0 });
    await expect(pool.getPoolProvider().call('third')).resolves.toBe('{"ok":true}');
  });

  it('request deadline includes repeated streaming heartbeats and frees the slot', async () => {
    const endpoints = await endpoint((_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 5);
      res.on('close', () => clearInterval(timer));
    }, 1);
    save(endpoints, { request_timeout_ms: 45 });
    await expect(pool.getPoolProvider().call('safe')).rejects.toMatchObject({ code: 'TIMEOUT' });
    await delay(10);
    expect(pool.getPoolStatus().runtime).toMatchObject({ active: 0, queued: 0 });
  });

  it('reserves time to fail over a silent first route before the total deadline', async () => {
    const paths = [];
    const endpoints = await endpoint((req, res) => { paths.push(req.url); if (req.url.endsWith('-2')) reply(res); });
    save(endpoints, { request_timeout_ms: 180 });
    const started = Date.now();
    const result = await pool.getPoolProvider().callWithMetadata('safe');
    expect(result.metadata).toMatchObject({ attempts: 2, endpoint_id: 'lane-2' });
    expect(Date.now() - started).toBeLessThan(180);
    expect(paths).toHaveLength(2);
  });

  it('gives the only task-eligible route its full request budget', async () => {
    const requests = [];
    const endpoints = await endpoint((req, res) => {
      requests.push(req.url);
      setTimeout(() => reply(res), 180);
    });
    save([{ ...endpoints[0], tasks: ['research'] }, { ...endpoints[1], tasks: ['enrich'] }], { request_timeout_ms: 300 });
    const result = await pool.getPoolProvider('research').callWithMetadata('safe');
    expect(result.metadata).toMatchObject({ attempts: 1, endpoint_id: 'lane-1' });
    expect(requests).toEqual(['/v1/messages']);
  });

  it('rejects expired queued work before sending even when timer callbacks are delayed', async () => {
    let release;
    const sent = [];
    const endpoints = await endpoint((_req, res) => reply(res), 1);
    pool = createPoolService({ getDB: () => db, getValue: key => persisted.get(key), setValue: (key, value) => persisted.set(key, value),
      sendRequest: async (_endpoint, prompt) => {
        sent.push(prompt);
        if (prompt === 'first') await new Promise(resolve => { release = resolve; });
        return { text: 'ok', model: 'actual', usage: {} };
      } });
    save(endpoints, { global_concurrency: 1 });
    const first = pool.getPoolProvider().call('first');
    const second = pool.getPoolProvider().call('expired', { timeoutMs: 10 });
    const check = expect(second).rejects.toMatchObject({ code: 'TIMEOUT' });
    const until = Date.now() + 25;
    while (Date.now() < until) { /* Delay timer callbacks while the queue deadline expires. */ }
    release();
    await Promise.all([first, check]);
    expect(sent).toEqual(['first']);
  });

  it('shutdown cancels active and queued requests and rejects new work', async () => {
    const endpoints = await endpoint(() => {}, 1);
    save(endpoints, { global_concurrency: 1 });
    const first = pool.getPoolProvider().call('first');
    const second = pool.getPoolProvider().call('second');
    const checks = [expect(first).rejects.toMatchObject({ code: 'CANCELLED' }), expect(second).rejects.toMatchObject({ code: 'CANCELLED' })];
    await delay(10);
    await pool.shutdownPool();
    await Promise.all(checks);
    expect(pool.getPoolStatus().runtime).toMatchObject({ active: 0, queued: 0 });
    await expect(pool.getPoolProvider().call('third')).rejects.toMatchObject({ code: 'SHUTDOWN' });
  });

  it('old credential failures cannot trip the newly saved credential circuit', async () => {
    let releaseOld;
    const endpoints = await endpoint((req, res) => {
      if (req.headers['x-api-key'] === 'new-key') reply(res);
      else releaseOld = () => { res.statusCode = 401; res.end(); };
    }, 1);
    save(endpoints);
    const first = pool.getPoolProvider().call('first');
    const failed = expect(first).rejects.toMatchObject({ code: 'AUTH_ERROR' });
    while (!releaseOld) await delay(1);
    pool.savePoolConfig({ ...pool.getPoolConfig(), endpoints: [{ ...endpoints[0], api_key: 'new-key' }] });
    releaseOld();
    await failed;
    expect(pool.getPoolStatus().runtime.endpoints[0].state).toBe('ready');
    await expect(pool.getPoolProvider().call('second')).resolves.toBe('{"ok":true}');
    expect(pool.getPoolStatus().metrics.total).toBe(2);
  });

  it('hot updates preserve active counters and existing keys', async () => {
    let active = 0;
    let peak = 0;
    const endpoints = await endpoint((_req, res) => {
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => { active--; reply(res); }, 35);
    }, 1);
    save(endpoints, { global_concurrency: 1 });
    const first = pool.getPoolProvider().call('first');
    await delay(10);
    pool.savePoolConfig({ ...pool.getPoolConfig(), global_concurrency: 1 });
    const second = pool.getPoolProvider().call('second');
    await Promise.all([first, second]);
    expect(peak).toBe(1);
  });

  it('keeps unsupported tasks explicit and tests only a saved endpoint', async () => {
    const endpoints = await endpoint((_req, res) => reply(res));
    save(endpoints.map(row => ({ ...row, tasks: ['enrich'] })));
    await expect(pool.getPoolProvider('research').call('safe')).rejects.toMatchObject({ code: 'NO_ENDPOINT' });
    await expect(pool.testPoolEndpoint('missing')).rejects.toThrow('Unknown');
    const probe = await pool.testPoolEndpoint('lane-2');
    expect(probe).toMatchObject({ ok: true, reachable: true, validated: false, endpoint_id: 'lane-2', model: 'actual-model' });
  });

  it('a minimal saved-route probe uses one token and does not classify truncation as outage', async () => {
    let payload;
    const endpoints = await endpoint((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        payload = JSON.parse(body);
        res.end(JSON.stringify({ model: 'actual-probe', content: [], stop_reason: 'max_tokens' }));
      });
    }, 1);
    save(endpoints);
    const result = await pool.testPoolEndpoint('lane-1');
    expect(payload.max_tokens).toBe(1);
    expect(result).toMatchObject({ ok: true, reachable: true, validated: false });
    expect(pool.getPoolStatus().runtime.endpoints[0].last_error_code).toBe(null);
    await expect(pool.getPoolProvider().call('business', { probe: true })).rejects.toMatchObject({ code: 'TRUNCATED' });
  });

  it('opens a temporary circuit and allows exactly one half-open request', async () => {
    let clock = Date.now();
    let calls = 0;
    let release;
    const endpoints = await endpoint((_req, res) => reply(res), 1);
    pool = createPoolService({ now: () => clock, getDB: () => db, getValue: key => persisted.get(key), setValue: (key, value) => persisted.set(key, value),
      sendRequest: async () => {
        calls++;
        if (calls <= 2) throw new LLMError('HTTP_ERROR', 'temporary', { retryable: true });
        if (calls === 3) await new Promise(resolve => { release = resolve; });
        return { text: 'ok', model: 'actual', usage: {} };
      } });
    save([{ ...endpoints[0], concurrency: 3 }], { global_concurrency: 3, max_attempts: 1 });
    await expect(pool.getPoolProvider().call('one')).rejects.toMatchObject({ code: 'HTTP_ERROR' });
    await expect(pool.getPoolProvider().call('two')).rejects.toMatchObject({ code: 'HTTP_ERROR' });
    expect(pool.getPoolStatus().runtime.endpoints[0].state).toBe('open');
    clock += 5001;
    const third = pool.getPoolProvider().call('three');
    const fourth = pool.getPoolProvider().call('four');
    expect(calls).toBe(3);
    expect(pool.getPoolStatus().runtime).toMatchObject({ active: 1, queued: 1 });
    release();
    await Promise.all([third, fourth]);
    expect(calls).toBe(4);
    expect(pool.getPoolStatus().runtime.endpoints[0].state).toBe('ready');
  });

  it.each([false, true])('prioritizes interactive work while protecting aged background work (aged=%s)', async aged => {
    let clock = Date.now();
    let release;
    const order = [];
    const endpoints = await endpoint((_req, res) => reply(res), 1);
    pool = createPoolService({ now: () => clock, getDB: () => db, getValue: key => persisted.get(key), setValue: (key, value) => persisted.set(key, value),
      sendRequest: async (_endpoint, prompt) => {
        order.push(prompt);
        if (prompt === 'first') await new Promise(resolve => { release = resolve; });
        return { text: 'ok', model: 'actual', usage: {} };
      } });
    save(endpoints, { global_concurrency: 1, request_timeout_ms: 10000, queue_timeout_ms: 10000 });
    const first = pool.getPoolProvider().call('first');
    const background = pool.getPoolProvider('enrich').call('background');
    if (aged) clock += 2500;
    const interactive = pool.getPoolProvider('research').call('interactive');
    release();
    await Promise.all([first, background, interactive]);
    expect(order).toEqual(aged ? ['first', 'background', 'interactive'] : ['first', 'interactive', 'background']);
  });
});
