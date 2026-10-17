// @vitest-environment node
/* global describe, it, expect, afterEach */
const http = require('node:http');
const { sendLLMRequest, LLMError } = require('../llm-transport');

const servers = [];
async function endpoint(handler, protocol = 'anthropic') {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { id: 'test', protocol, endpoint_url: `http://127.0.0.1:${server.address().port}/v1/messages-5?token=query-secret`, api_key: 'key-secret', model: 'gemini-via-anthropic' };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  })));
});

const anthropic = (text = 'hello', extra = {}) => ({ content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text }], model: 'actual-model', usage: { input_tokens: 4, output_tokens: 2 }, stop_reason: 'end_turn', ...extra });

describe('single-attempt LLM transport', () => {
  it('keeps the full path, sends Anthropic despite a Gemini model name, and joins text blocks', async () => {
    let received;
    const ep = await endpoint((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        received = { path: req.url, headers: req.headers, body: JSON.parse(body) };
        res.end(JSON.stringify(anthropic('', { content: [{ type: 'thinking' }, { type: 'text', text: 'one' }, { type: 'text', text: 'two' }] })));
      });
    }, 'claude');
    const result = await sendLLMRequest(ep, 'prompt-secret');
    expect(received.path).toBe('/v1/messages-5?token=query-secret');
    expect(received.headers['x-api-key']).toBe('key-secret');
    expect(received.body.model).toBe('gemini-via-anthropic');
    expect(result).toMatchObject({ text: 'onetwo', model: 'actual-model', usage: { input_tokens: 4, output_tokens: 2 } });
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ['openai', { choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }], model: 'openai-actual', usage: { total_tokens: 3 } }, 'openai-actual'],
    ['gemini', { candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text: 'hello' }] }, finishReason: 'STOP' }], modelVersion: 'gemini-actual', usageMetadata: { totalTokenCount: 3 } }, 'gemini-actual'],
  ])('supports native %s JSON and its actual model', async (protocol, response, model) => {
    const ep = await endpoint((_req, res) => res.end(JSON.stringify(response)), protocol);
    expect(await sendLLMRequest(ep, 'prompt')).toMatchObject({ text: 'hello', model });
  });

  it('aggregates Anthropic SSE text, ignores thinking, and merges usage', async () => {
    const frames = [
      { type: 'message_start', message: { model: 'sse-model', usage: { input_tokens: 7 } } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'secret' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"ok":' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'true}' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    const ep = await endpoint((_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      const wire = frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('');
      for (let index = 0; index < wire.length; index += 13) res.write(wire.slice(index, index + 13));
      res.end();
    });
    expect(await sendLLMRequest(ep, 'prompt', { json: true, validate: value => value.ok === true })).toMatchObject({ text: '{"ok":true}', model: 'sse-model', usage: { input_tokens: 7, output_tokens: 5 } });
  });

  it('aggregates OpenAI SSE with a trailing usage-only chunk', async () => {
    const ep = await endpoint((_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      for (const frame of [
        { model: 'stream-actual', choices: [{ delta: { content: 'hello' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { total_tokens: 9 } },
      ]) res.write(`data: ${JSON.stringify(frame)}\n\n`);
      res.end('data: [DONE]\n\n');
    }, 'openai');
    expect(await sendLLMRequest(ep, 'prompt')).toMatchObject({ text: 'hello', model: 'stream-actual', usage: { total_tokens: 9 } });
  });

  it.each([[401, 'AUTH_ERROR', false], [403, 'AUTH_ERROR', false], [429, 'RATE_LIMIT', true], [529, 'HTTP_ERROR', true], [400, 'HTTP_ERROR', false]])('types HTTP %s without retrying or leaking upstream data', async (status, code, retryable) => {
    let calls = 0;
    const ep = await endpoint((_req, res) => { calls++; res.writeHead(status); res.end('key-secret prompt-secret query-secret'); });
    const error = await sendLLMRequest(ep, 'prompt-secret').catch(error => error);
    expect(error).toBeInstanceOf(LLMError);
    expect(error).toMatchObject({ code, retryable, statusCode: status });
    expect(JSON.stringify(error) + error.message + error.stack).not.toMatch(/key-secret|prompt-secret|query-secret/);
    expect(calls).toBe(1);
  });

  it.each([
    ['', 'EMPTY_RESPONSE'],
    ['not-json key-secret', 'INVALID_RESPONSE'],
    [JSON.stringify(anthropic('')), 'EMPTY_RESPONSE'],
    [JSON.stringify(anthropic('partial', { stop_reason: 'max_tokens' })), 'TRUNCATED'],
    [JSON.stringify({ error: { type: 'authentication_error', message: 'key-secret' } }), 'AUTH_ERROR'],
  ])('classifies invalid protocol output %#', async (body, code) => {
    const ep = await endpoint((_req, res) => res.end(body));
    await expect(sendLLMRequest(ep, 'prompt')).rejects.toMatchObject({ code });
  });

  it.each(['```json\n{"items":[1]}\n```', '[{"id":1}]'])('validates whole or fenced JSON objects and arrays', async text => {
    const ep = await endpoint((_req, res) => res.end(JSON.stringify(anthropic(text))));
    let parsed;
    await sendLLMRequest(ep, 'prompt', { json: true, validate: value => { parsed = value; return true; } });
    expect(typeof parsed).toBe('object');
  });

  it.each(['prefix {"ok":true}', '{"ok":true} trailing', 'null', '42'])('rejects non-whole or scalar JSON %#', async text => {
    const ep = await endpoint((_req, res) => res.end(JSON.stringify(anthropic(text))));
    await expect(sendLLMRequest(ep, 'prompt', { json: true })).rejects.toMatchObject({ code: 'INVALID_JSON' });
  });

  it.each([() => false, () => { throw new Error('key-secret'); }])('sanitizes validator failures %#', async validate => {
    const ep = await endpoint((_req, res) => res.end(JSON.stringify(anthropic('{}'))));
    const error = await sendLLMRequest(ep, 'prompt', { json: true, validate }).catch(error => error);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).not.toContain('key-secret');
  });

  it('enforces an overall deadline despite continuous response activity and closes the socket', async () => {
    let closed;
    const closure = new Promise(resolve => { closed = resolve; });
    const ep = await endpoint((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const interval = setInterval(() => res.write(': keepalive\n\n'), 5);
      req.socket.on('close', () => { clearInterval(interval); closed(); });
    });
    await expect(sendLLMRequest(ep, 'prompt', { timeoutMs: 60 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    await closure;
  });

  it('does not send already-cancelled requests', async () => {
    let calls = 0;
    const ep = await endpoint((_req, res) => { calls++; res.end(); });
    const controller = new AbortController();
    controller.abort(new Error('key-secret'));
    await expect(sendLLMRequest(ep, 'prompt', { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
    expect(calls).toBe(0);
  });

  it('cancels an in-flight request and closes its socket', async () => {
    const controller = new AbortController();
    let closed;
    const closure = new Promise(resolve => { closed = resolve; });
    const ep = await endpoint(req => {
      req.socket.on('close', closed);
      controller.abort();
    });
    await expect(sendLLMRequest(ep, 'prompt', { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    await closure;
  });

  it('rejects an interrupted network stream', async () => {
    const ep = await endpoint((_req, res) => { res.write('partial'); setImmediate(() => res.destroy()); });
    await expect(sendLLMRequest(ep, 'prompt')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('rejects SSE missing completion even when its text is valid JSON', async () => {
    const ep = await endpoint((_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.end('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{}"}}\n\n');
    });
    await expect(sendLLMRequest(ep, 'prompt', { json: true })).rejects.toMatchObject({ code: 'TRUNCATED' });
  });

  it('bounds response memory', async () => {
    const ep = await endpoint((_req, res) => res.end('x'.repeat(8 * 1024 * 1024 + 1)));
    await expect(sendLLMRequest(ep, 'prompt')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('checks the actual deadline after synchronous output validation delays timers', async () => {
    const ep = await endpoint((_req, res) => res.end(JSON.stringify(anthropic('{}'))));
    await expect(sendLLMRequest(ep, 'prompt', {
      timeoutMs: 50,
      validate: () => {
        const until = Date.now() + 60;
        while (Date.now() < until) { continue; }
        return true;
      },
    })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('rejects an async validator without leaving an unhandled rejection', async () => {
    const ep = await endpoint((_req, res) => res.end(JSON.stringify(anthropic('{}'))));
    await expect(sendLLMRequest(ep, 'prompt', { validate: async () => { throw new Error('validator-secret'); } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('requires Anthropic message_stop even if the gateway emits an OpenAI DONE marker', async () => {
    const ep = await endpoint((_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.end('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{}"}}\n\ndata: [DONE]\n\n');
    });
    await expect(sendLLMRequest(ep, 'prompt')).rejects.toMatchObject({ code: 'TRUNCATED' });
  });

  it.each([
    ['anthropic', anthropic('', { stop_reason: 'max_tokens' })],
    ['openai', { choices: [{ message: { content: '' }, finish_reason: 'length' }] }],
    ['gemini', { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }],
  ])('allows one-token %s probes to return truncated or empty text only with probe enabled', async (protocol, response) => {
    let tokens;
    const ep = await endpoint((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const payload = JSON.parse(body);
        tokens = payload.max_tokens ?? payload.generationConfig?.maxOutputTokens;
        res.end(JSON.stringify(response));
      });
    }, protocol);
    const result = await sendLLMRequest(ep, 'probe', {
      probe: true, maxTokens: 1, json: true,
      validate: () => { throw new Error('Probe must skip business validation'); },
    });
    expect(result.text).toBe('');
    expect(tokens).toBe(1);
    await expect(sendLLMRequest(ep, 'normal', { maxTokens: 1 })).rejects.toMatchObject({ code: 'TRUNCATED' });
  });

  it.each(['anthropic', 'openai', 'gemini'])('rejects arbitrary HTTP 200 JSON in %s probes', async protocol => {
    const ep = await endpoint((_req, res) => res.end('{}'), protocol);
    await expect(sendLLMRequest(ep, 'probe', { probe: true, maxTokens: 1 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('accepts a completed Anthropic one-token SSE probe with no text', async () => {
    const ep = await endpoint((_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.end([
        { type: 'message_start', message: { model: 'probe-model', content: [] } },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
        { type: 'message_stop' },
      ].map(value => `data: ${JSON.stringify(value)}\n\n`).join(''));
    });
    expect(await sendLLMRequest(ep, 'probe', { probe: true, maxTokens: 1 })).toMatchObject({ text: '', model: 'probe-model' });
  });

  it.each([false, true])('requires an Anthropic message_start envelope (probe=%s)', async probe => {
    const ep = await endpoint((_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.end([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
        { type: 'message_stop' },
      ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    });
    await expect(sendLLMRequest(ep, 'safe', { probe })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects a DONE-only SSE response as an invalid probe envelope', async () => {
    const ep = await endpoint((_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.end('data: [DONE]\n\n');
    }, 'openai');
    await expect(sendLLMRequest(ep, 'probe', { probe: true, maxTokens: 1 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
