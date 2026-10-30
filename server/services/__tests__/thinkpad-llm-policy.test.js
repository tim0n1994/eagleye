// @vitest-environment node
/* global describe, it, expect */
const { buildPolicy, validateTarget } = require('../../../scripts/apply-thinkpad-llm-policy');
const { createPoolService } = require('../llm-pool');
const { LLMError } = require('../llm-transport');
const selection = { primary: { id: 'primary', model: 'test-primary-model' },
  fallback: { id: 'fallback', model: 'test-fallback-model' }, disabled_endpoint_ids: ['retired-graph'] };

function oldConfig() {
  const lane = (id, model, tasks, concurrency = 1) => ({ id, model, tasks, concurrency,
    protocol: 'openai', endpoint_url: 'http://127.0.0.1:4000/v1/chat/completions',
    api_key: '${LLM_API_KEY}', enabled: true, priority: 3 });
  return { schema_version: 1, enabled: true, global_concurrency: 4, max_attempts: 2,
    request_timeout_ms: 2000, queue_timeout_ms: 1000, queue_limit: 100,
    endpoints: [lane('primary', 'test-primary-model', ['enrich', 'translate'], 3),
      lane('retired-graph', 'test-fallback-model', ['graph']),
      lane('fallback', 'test-fallback-model', ['digest', 'classify', 'translate'])] };
}

describe('ThinkPad task routing recovery', () => {
  it.each(['translate', 'digest', 'graph', 'classify'])('recovers %s when the primary fails', async task => {
    const calls = [];
    const config = buildPolicy(oldConfig(), selection);
    const pool = createPoolService({ getValue: () => config, getDB: () => null,
      sendRequest: async endpoint => {
        calls.push(endpoint.id);
        if (endpoint.id === 'primary') throw new LLMError('HTTP_ERROR', 'upstream unavailable', { retryable: true, statusCode: 503 });
        return { text: '{"ok":true}', model: endpoint.model, usage: {} };
      } });
    const result = await pool.getPoolProvider().callWithMetadata('fixture', { task });
    expect(calls).toEqual(['primary', 'fallback']);
    expect(result.metadata.attempts).toBe(2);
    await pool.shutdownPool();
  });

  it('keeps four healthy parallel requests on the primary rather than spilling to reasoning fallback', async () => {
    const config = buildPolicy(oldConfig(), selection);
    const calls = [];
    const release = [];
    const pool = createPoolService({ getValue: () => config, getDB: () => null,
      sendRequest: endpoint => new Promise(resolve => {
        calls.push(endpoint.id);
        release.push(() => resolve({ text: '{}', model: endpoint.model, usage: {} }));
      }) });
    const pending = Array.from({ length: 4 }, () => pool.getPoolProvider().callWithMetadata('fixture', { task: 'translate' }));
    expect(calls).toEqual(Array(4).fill('primary'));
    release.forEach(done => done());
    await Promise.all(pending);
    await pool.shutdownPool();
  });

  it('preserves credentials and disabled lanes, is idempotent, and does not mutate the input', () => {
    const original = oldConfig();
    original.endpoints.push({ ...original.endpoints[0], id: 'retired', enabled: false });
    const before = JSON.stringify(original);
    const result = buildPolicy(original, selection);
    expect(JSON.stringify(original)).toBe(before);
    expect(buildPolicy(result, selection)).toEqual(result);
    expect(result.endpoints.find(e => e.id === 'retired-graph').enabled).toBe(false);
    expect(result.endpoints.find(e => e.id === 'retired')).toMatchObject({ enabled: false });
    expect(result.endpoints.every(e => e.api_key === '${LLM_API_KEY}')).toBe(true);
  });

  it('refuses missing or changed route identities and unexpected active routes', () => {
    const config = oldConfig();
    config.endpoints[0].model = 'unverified-model';
    expect(() => buildPolicy(config, selection)).toThrow();
    const unknown = oldConfig();
    unknown.endpoints.push({ ...unknown.endpoints[0], id: 'unreviewed' });
    expect(() => buildPolicy(unknown, selection)).toThrow();
    expect(() => buildPolicy({ ...oldConfig(), endpoints: [] }, selection)).toThrow();
    expect(() => buildPolicy(oldConfig(), { ...selection, fallback: selection.primary })).toThrow();
  });

  it('rejects a different host, backup DB or remote API before credentials are used', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-target-'));
    try {
      const live = path.join(root, 'live.db');
      const backup = path.join(root, 'backup.db');
      fs.writeFileSync(live, 'fixture');
      fs.writeFileSync(backup, 'fixture');
      const deployment = { hostname: 'test-host', database_path: live, api_base_url: 'http://127.0.0.1:3019' };
      expect(validateTarget(deployment, 'test-host', live, [])).toBe('http://127.0.0.1:3019');
      expect(() => validateTarget(deployment, 'other-host', live, [])).toThrow();
      expect(() => validateTarget(deployment, 'test-host', backup, [])).toThrow();
      for (const api_base_url of ['http://192.0.2.10:3019', 'http://user:secret@127.0.0.1:3019', 'http://127.0.0.1:3019/?key=fixture']) {
        expect(() => validateTarget({ ...deployment, api_base_url }, 'test-host', live, [])).toThrow();
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
