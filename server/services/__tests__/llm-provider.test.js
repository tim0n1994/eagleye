// @vitest-environment node
/* global describe, it, expect, beforeEach, vi */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let provider;
let stored;
let transport;
let pool;

beforeEach(() => {
  stored = new Map();
  transport = { sendLLMRequest: vi.fn(async endpoint => ({ text: 'ok', model: `actual-${endpoint.model}`, usage: { input_tokens: 1 }, latency_ms: 2 })) };
  pool = { getPoolProvider: vi.fn(() => null), getPoolConfig: vi.fn(() => null), testPoolEndpoint: vi.fn() };
  const subject = { exports: {} };
  const dependencies = {
    './llm-pool-config': require('../llm-pool-config'), './llm-transport': transport, './llm-pool': pool,
    '../db/user-data': { getValue: key => stored.get(key), setValue: (key, value) => stored.set(key, value) },
    '../db/connection': { getDB: () => ({ prepare: () => ({ run: key => stored.delete(key) }) }) },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../llm-provider.js'), 'utf8'), {
    module: subject, exports: subject.exports, console, URL, process: { env: {} },
    require: id => {
      if (id === 'node:crypto') return require('node:crypto');
      if (dependencies[id]) return dependencies[id];
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  provider = subject.exports;
});

const legacy = () => ({ provider: 'claude', base_url: 'http://127.0.0.1:1234/v1', endpoint_url: 'http://127.0.0.1:1234/v1/messages-3', api_key: 'fake-original-key', model: 'requested-model' });

describe('legacy compatibility and shared pool entry', () => {
  it('retains full Anthropic route paths despite a Gemini model name', () => {
    const result = provider.parsePastedLLMConfig('Provider: Google\nProtocol: Anthropic Messages\nBase URL: http://127.0.0.1:1234\nMessages URL: http://127.0.0.1:1234/v1/messages-3\nAPI Key: fake-key\nModel: gemini-flash');
    expect(result).toMatchObject({ provider: 'claude', endpoint_url: 'http://127.0.0.1:1234/v1/messages-3', model: 'gemini-flash' });
  });

  it('honors an explicit JSON protocol independently from vendor/model fields', () => {
    const result = provider.parsePastedLLMConfig(JSON.stringify({ protocol: 'anthropic', provider: 'gemini', endpoint_url: 'http://127.0.0.1:1234/v1/messages-4', api_key: 'fake-key', model: 'gemini' }));
    expect(result).toMatchObject({ provider: 'claude', endpoint_url: 'http://127.0.0.1:1234/v1/messages-4' });
  });

  it('retains Anthropic curl endpoints and recognizes x-api-key', () => {
    const result = provider.parsePastedLLMConfig(`curl http://127.0.0.1:1234/v1/messages-2 -H 'x-api-key: fake-key' -d '{"model":"gemini"}'`);
    expect(result).toMatchObject({ provider: 'claude', endpoint_url: 'http://127.0.0.1:1234/v1/messages-2', api_key: 'fake-key' });
  });

  it('preserves legacy secrets when omitted or represented by either supported mask', () => {
    provider.saveLLMConfig(legacy());
    provider.saveLLMConfig({ ...legacy(), api_key: 'sk-****1234' });
    expect(stored.get('llm_config').api_key).toBe('fake-original-key');
    provider.saveLLMConfig({ ...legacy(), api_key: '••••' });
    expect(stored.get('llm_config').api_key).toBe('fake-original-key');
    provider.saveLLMConfig({ ...legacy(), api_key: undefined });
    expect(stored.get('llm_config').api_key).toBe('fake-original-key');
    expect(provider.maskSecret('fake-original-key')).toBe('••••');
  });

  it('keeps call string compatibility and reports the actual response model and route', async () => {
    provider.saveLLMConfig(legacy());
    const selected = provider.getProvider();
    expect(selected.isPool).toBe(false);
    expect(await selected.call('safe')).toBe('ok');
    const response = await selected.callWithMetadata('safe');
    expect(response.metadata).toMatchObject({ endpoint_id: 'legacy', protocol: 'anthropic', provider: 'claude', model: 'actual-requested-model', requested_model: 'requested-model', attempts: 1 });
    expect(transport.sendLLMRequest.mock.calls[0][0]).toMatchObject({ endpoint_url: legacy().endpoint_url, protocol: 'anthropic' });
  });

  it('routes both getters through the same process pool when enabled', () => {
    provider.saveLLMConfig(legacy());
    const shared = { isPool: true, call: vi.fn(), callWithMetadata: vi.fn() };
    pool.getPoolProvider.mockReturnValue(shared);
    expect(provider.getProvider('research')).toBe(shared);
    expect(provider.getEnrichProvider()).toBe(shared);
    expect(pool.getPoolProvider.mock.calls).toEqual([['research'], ['enrich']]);
  });

  it('does not fall back to legacy when enabled pool configuration is invalid', () => {
    provider.saveLLMConfig(legacy());
    pool.getPoolProvider.mockImplementation(() => { throw new Error('Invalid pool config'); });
    expect(() => provider.getProvider()).toThrow('Invalid pool config');
    expect(transport.sendLLMRequest).not.toHaveBeenCalled();
  });

  it('legacy probes use one token and report reachability separately from validation', async () => {
    provider.saveLLMConfig(legacy());
    transport.sendLLMRequest.mockResolvedValue({ text: '', model: 'actual', usage: {}, latency_ms: 1 });
    const response = await provider.testLLMConfig();
    expect(response).toMatchObject({ ok: true, reachable: true, validated: false, model: 'actual' });
    expect(transport.sendLLMRequest.mock.calls[0][2]).toMatchObject({ maxTokens: 1, probe: true });
  });

  it('preserves the outer JSON object when it contains arrays', () => {
    expect(provider.extractJSON('{"headline":"hello","top_signals":[{"id":"one"}]}')).toEqual({ headline: 'hello', top_signals: [{ id: 'one' }] });
  });
});
