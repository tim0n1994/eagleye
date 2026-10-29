// @vitest-environment node
/* global describe, it, expect */
const { buildPolicy } = require('../../../scripts/apply-thinkpad-llm-policy');
const { createPoolService } = require('../llm-pool');
const { LLMError } = require('../llm-transport');

function oldConfig() {
  const lane = (id, model, tasks, concurrency = 1) => ({ id, model, tasks, concurrency,
    protocol: 'openai', endpoint_url: 'http://127.0.0.1:4000/v1/chat/completions',
    api_key: '${LLM_API_KEY}', enabled: true, priority: 3 });
  return { schema_version: 1, enabled: true, global_concurrency: 4, max_attempts: 2,
    request_timeout_ms: 2000, queue_timeout_ms: 1000, queue_limit: 100,
    endpoints: [lane('configured-model-10', 'configured-model-8', ['enrich', 'translate'], 3),
      lane('lane-2', 'configured-model-6', ['graph']),
      lane('lane-3', 'configured-model-6', ['digest', 'classify', 'translate'])] };
}

describe('ThinkPad task routing recovery', () => {
  it.each(['translate', 'digest', 'graph', 'classify'])('recovers %s when the primary fails', async task => {
    const calls = [];
    const config = buildPolicy(oldConfig());
    const pool = createPoolService({ getValue: () => config, getDB: () => null,
      sendRequest: async endpoint => {
        calls.push(endpoint.id);
        if (endpoint.id === 'configured-model-10') throw new LLMError('HTTP_ERROR', 'upstream unavailable', { retryable: true, statusCode: 503 });
        return { text: '{"ok":true}', model: endpoint.model, usage: {} };
      } });
    const result = await pool.getPoolProvider().callWithMetadata('fixture', { task });
    expect(calls).toEqual(['configured-model-10', 'lane-3']);
    expect(result.metadata.attempts).toBe(2);
    await pool.shutdownPool();
  });

  it('keeps four healthy parallel requests on the primary rather than spilling to reasoning fallback', async () => {
    const config = buildPolicy(oldConfig());
    const calls = [];
    const release = [];
    const pool = createPoolService({ getValue: () => config, getDB: () => null,
      sendRequest: endpoint => new Promise(resolve => {
        calls.push(endpoint.id);
        release.push(() => resolve({ text: '{}', model: endpoint.model, usage: {} }));
      }) });
    const pending = Array.from({ length: 4 }, () => pool.getPoolProvider().callWithMetadata('fixture', { task: 'translate' }));
    expect(calls).toEqual(Array(4).fill('configured-model-10'));
    release.forEach(done => done());
    await Promise.all(pending);
    await pool.shutdownPool();
  });

  it('preserves credentials and disabled lanes, is idempotent, and does not mutate the input', () => {
    const original = oldConfig();
    original.endpoints.push({ ...original.endpoints[0], id: 'retired', enabled: false });
    const before = JSON.stringify(original);
    const result = buildPolicy(original);
    expect(JSON.stringify(original)).toBe(before);
    expect(buildPolicy(result)).toEqual(result);
    expect(result.endpoints.find(e => e.id === 'lane-2').enabled).toBe(false);
    expect(result.endpoints.find(e => e.id === 'retired')).toMatchObject({ enabled: false });
    expect(result.endpoints.every(e => e.api_key === '${LLM_API_KEY}')).toBe(true);
  });

  it('refuses missing or changed route identities and unexpected active routes', () => {
    const config = oldConfig();
    config.endpoints[0].model = 'unverified-model';
    expect(() => buildPolicy(config)).toThrow();
    const unknown = oldConfig();
    unknown.endpoints.push({ ...unknown.endpoints[0], id: 'unreviewed' });
    expect(() => buildPolicy(unknown)).toThrow();
    expect(() => buildPolicy({ ...oldConfig(), endpoints: [] })).toThrow();
  });
});
