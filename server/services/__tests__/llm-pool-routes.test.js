import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const servicePath = require.resolve('../llm-pool');
const previous = require.cache[servicePath];
const secret = 'test-only-private-key';
const config = { enabled: true, endpoints: [{ id: 'route-2', endpoint_url: 'http://127.0.0.1:1234/v1/messages-2', model: 'gemini', api_key: '••••' }] };
const pool = {
  getPoolConfig: vi.fn(() => config),
  getPoolStatus: vi.fn(() => ({ runtime: { active: 0 }, metrics: [] })),
  savePoolConfig: vi.fn(() => config),
  parsePastedPoolConfig: vi.fn((_text, options) => options?.masked === false ? { ...config, endpoints: [{ ...config.endpoints[0], api_key: secret }] } : config),
  testPoolEndpoint: vi.fn(async id => ({ ok: true, endpoint_id: id, latency_ms: 10 })),
  getLlmFailureBreakdown: vi.fn(() => ({ scope: 'persisted', available: true, days: 7, by_class: [], by_code: [], by_task: [], recent: [] })),
};
require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: pool };
const register = require('../../routes/llm-pool');

afterAll(() => {
  if (previous) require.cache[servicePath] = previous;
  else delete require.cache[servicePath];
});

async function request(path, { method = 'GET', role = 'admin', body } = {}) {
  const routes = {};
  register(routes);
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  Object.assign(req, { method, url: path, user: role ? { id: 'user-test', role } : null });
  let status, result;
  const res = { writeHead(code) { status = code; }, end(text) { result = JSON.parse(text); } };
  await routes[path.split('?')[0]](req, res);
  return { status, body: result };
}

describe('endpoint pool management boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['/api/settings/llm/pool', 'GET'], ['/api/settings/llm/pool', 'PUT'],
    ['/api/settings/llm/pool/parse', 'POST'], ['/api/settings/llm/pool/test', 'POST'],
    ['/api/settings/llm/pool/failures', 'GET'],
  ])('rejects a regular user before invoking %s %s', async (path, method) => {
    expect((await request(path, { method, role: 'user', body: { endpoint_id: 'route-2', config } })).status).toBe(403);
    for (const operation of Object.values(pool)) expect(operation).not.toHaveBeenCalled();
  });

  it.each(['/api/settings/llm/pool/parse', '/api/settings/llm/pool/test'])('GET does not trigger %s', async path => {
    expect((await request(path)).status).toBe(405);
    expect(pool.testPoolEndpoint).not.toHaveBeenCalled();
    expect(pool.parsePastedPoolConfig).not.toHaveBeenCalled();
  });

  it('keeps failure analytics read-only and admin-scoped', async () => {
    expect((await request('/api/settings/llm/pool/failures', { method: 'POST', body: {} })).status).toBe(405);
    expect(pool.getLlmFailureBreakdown).not.toHaveBeenCalled();
    const response = await request('/api/settings/llm/pool/failures?days=30');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', available: true, days: 7 });
    expect(pool.getLlmFailureBreakdown).toHaveBeenCalledWith({ days: 30 });
  });

  it('previews masked credentials without saving or probing', async () => {
    const response = await request('/api/settings/llm/pool/parse', { method: 'POST', body: { pasted: 'private endpoint block' } });
    expect(response.status).toBe(200);
    expect(response.body.config.endpoints[0].endpoint_url).toContain('/messages-2');
    expect(JSON.stringify(response.body)).not.toContain(secret);
    expect(pool.savePoolConfig).not.toHaveBeenCalled();
    expect(pool.testPoolEndpoint).not.toHaveBeenCalled();
  });

  it('uses raw parsed credentials only for persistence and returns masked configuration', async () => {
    const response = await request('/api/settings/llm/pool', { method: 'PUT', body: { pasted: 'private endpoint block', enabled: true } });
    expect(pool.savePoolConfig.mock.calls[0][0].endpoints[0].api_key).toBe(secret);
    expect(response.body.config.enabled).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain(secret);
  });

  it('tests only a saved endpoint identity', async () => {
    const response = await request('/api/settings/llm/pool/test', { method: 'POST', body: { endpoint_id: 'route-2' } });
    expect(response.body.ok).toBe(true);
    expect(pool.testPoolEndpoint).toHaveBeenCalledWith('route-2');
    expect((await request('/api/settings/llm/pool/test', { method: 'POST', body: { endpoint_url: 'http://untrusted' } })).status).toBe(400);
    expect(pool.testPoolEndpoint).toHaveBeenCalledTimes(1);
  });

  it('does not echo untrusted error bodies that contain credentials', async () => {
    pool.savePoolConfig.mockImplementationOnce(() => { throw new Error(secret); });
    const response = await request('/api/settings/llm/pool', { method: 'PUT', body: { config } });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain(secret);
  });
});
