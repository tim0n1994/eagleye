const http = require('node:http');
const https = require('node:https');
// 案2 fix-morning-1022: pool credentials are stored redacted; env references
// (${LLM_API_KEY}) are resolved here at request time. Plaintext values from
// legacy pre-fix rows keep working unchanged.
const { resolveSecret } = require('./secret-redaction');

const MAX_BODY_BYTES = 8 * 1024 * 1024;

class LLMError extends Error {
  /** @param {string} code @param {string} message @param {{retryable?: boolean, statusCode?: number, retryAfterMs?: number}} [options] */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.statusCode !== undefined) this.statusCode = options.statusCode;
    if (Number.isFinite(options.retryAfterMs)) this.retryAfterMs = options.retryAfterMs;
  }
}

function failure(code, message, retryable = true) {
  return new LLMError(code, message, { retryable });
}

function statusError(statusCode, headers = null) {
  const code = [401, 403].includes(statusCode) ? 'AUTH_ERROR' : statusCode === 429 ? 'RATE_LIMIT' : 'HTTP_ERROR';
  const options = { statusCode, retryable: statusCode === 429 || statusCode >= 500 };
  const retryAfter = headers?.['retry-after'];
  let waitMs = NaN;
  if (retryAfter !== undefined && retryAfter !== null && String(retryAfter).trim() !== '') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) waitMs = seconds * 1000;
    else {
      const at = Date.parse(String(retryAfter));
      if (Number.isFinite(at)) waitMs = at - Date.now();
    }
  }
  if (Number.isFinite(waitMs) && waitMs > 0) options.retryAfterMs = Math.min(Math.round(waitMs), 300000);
  return new LLMError(code, `LLM endpoint returned HTTP ${statusCode}`, options);
}

function upstreamError(value) {
  const kind = value?.error?.type || value?.error?.code;
  if (['authentication_error', 'permission_error', 'invalid_api_key', 'UNAUTHENTICATED', 'PERMISSION_DENIED'].includes(kind)) {
    return failure('AUTH_ERROR', 'LLM endpoint rejected credentials', false);
  }
  if (['rate_limit_error', 'RESOURCE_EXHAUSTED'].includes(kind)) return failure('RATE_LIMIT', 'LLM endpoint rate limited the request');
  return failure('INVALID_RESPONSE', 'LLM endpoint returned an API error');
}

function checkStop(reason, probe = false) {
  if (!probe && ['max_tokens', 'length', 'MAX_TOKENS'].includes(reason)) throw failure('TRUNCATED', 'LLM output reached its token limit');
}

function parseJSON(raw) {
  try { return JSON.parse(raw); } catch { throw failure('INVALID_RESPONSE', 'LLM endpoint returned malformed protocol data'); }
}

function textBlocks(content) {
  return Array.isArray(content) ? content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : '';
}

function parseResponse(value, protocol, options = {}) {
  if (!value || typeof value !== 'object' || value.error) throw upstreamError(value);
  const envelope = protocol === 'anthropic' ? value.content : protocol === 'openai' ? value.choices : value.candidates;
  if (!Array.isArray(envelope)) throw failure('INVALID_RESPONSE', 'LLM endpoint returned an invalid protocol envelope');
  if (protocol === 'anthropic') {
    checkStop(value.stop_reason, options.probe);
    return { text: textBlocks(value.content), model: value.model, usage: value.usage };
  }
  if (protocol === 'openai') {
    const choice = value.choices?.[0];
    checkStop(choice?.finish_reason, options.probe);
    const content = choice?.message?.content;
    return { text: typeof content === 'string' ? content : textBlocks(content), model: value.model, usage: value.usage };
  }
  const candidate = value.candidates?.[0];
  checkStop(candidate?.finishReason, options.probe);
  return {
    text: (candidate?.content?.parts || []).filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join(''),
    model: value.modelVersion, usage: value.usageMetadata,
  };
}

function parseSSE(body, protocol, options = {}) {
  let text = '';
  let model;
  let usage = {};
  let complete = false;
  let envelope = false;
  for (const frame of body.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    if (data === '[DONE]') { if (protocol === 'openai') complete = true; continue; }
    const value = parseJSON(data);
    if (value.error || value.type === 'error') throw upstreamError(value);
    if (protocol === 'anthropic') {
      if (value.type === 'message_start') {
        if (!value.message || typeof value.message !== 'object') throw failure('INVALID_RESPONSE', 'LLM endpoint returned an invalid protocol envelope');
        envelope = true;
        model = value.message?.model || model;
        usage = { ...usage, ...value.message?.usage };
        text += textBlocks(value.message?.content);
      } else if (value.type === 'content_block_start') {
        text += textBlocks([value.content_block]);
      } else if (value.type === 'content_block_delta' && value.delta?.type === 'text_delta') {
        if (typeof value.delta.text !== 'string') throw failure('INVALID_RESPONSE', 'LLM endpoint returned malformed text delta');
        text += value.delta.text;
      } else if (value.type === 'message_delta') {
        checkStop(value.delta?.stop_reason, options.probe);
        usage = { ...usage, ...value.usage };
      } else if (value.type === 'message_stop') complete = true;
    } else if (protocol === 'openai') {
      if (Array.isArray(value.choices)) envelope = true;
      model = value.model || model;
      usage = { ...usage, ...value.usage };
      const choice = value.choices?.[0];
      checkStop(choice?.finish_reason, options.probe);
      if (typeof choice?.delta?.content === 'string') text += choice.delta.content;
    } else {
      const parsed = parseResponse(value, protocol, options);
      envelope = true;
      text += parsed.text;
      model = parsed.model || model;
      usage = { ...usage, ...parsed.usage };
      if (value.candidates?.[0]?.finishReason) complete = true;
    }
  }
  if (!complete) throw failure('TRUNCATED', 'LLM stream ended without a completion marker');
  if (!envelope) throw failure('INVALID_RESPONSE', 'LLM endpoint returned an invalid protocol envelope');
  return { text, model, usage };
}

function validateResult(result, options) {
  if (typeof result.text !== 'string' || !result.text.trim()) throw failure('EMPTY_RESPONSE', 'LLM endpoint returned no text');
  let value = result.text;
  if (options.json) {
    const trimmed = result.text.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
    try { value = JSON.parse(fenced ? fenced[1] : trimmed); } catch { throw failure('INVALID_JSON', 'LLM output is not valid JSON'); }
    if (!value || typeof value !== 'object') throw failure('INVALID_JSON', 'LLM JSON output must be an object or array');
  }
  if (options.validate) {
    try {
      const valid = options.validate(value);
      if (valid?.then) {
        Promise.resolve(valid).catch(() => {});
        throw new Error('Invalid output');
      }
      if (valid === false) throw new Error('Invalid output');
    } catch { throw failure('VALIDATION_ERROR', 'LLM output did not pass validation'); }
  }
  return result;
}

/**
 * Perform one attempt only. Validators receive parsed JSON when json=true, otherwise text.
 * @param {{id?: string, protocol: string, endpoint_url: string, api_key?: string, model: string}} endpoint
 * @param {string} prompt
 * @param {{signal?: AbortSignal, timeoutMs?: number, maxTokens?: number, temperature?: number, json?: boolean, validate?: Function, probe?: boolean}} [options]
 * @returns {Promise<{text: string, model: string, usage: object, latency_ms: number}>}
 */
async function sendLLMRequest(endpoint, prompt, options = {}) {
  if (options.signal?.aborted) throw failure('CANCELLED', 'LLM request was cancelled', false);
  const protocol = endpoint.protocol === 'claude' ? 'anthropic' : endpoint.protocol;
  let url;
  try { url = new URL(endpoint.endpoint_url); } catch { throw failure('CONFIG_ERROR', 'Invalid LLM endpoint configuration', false); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['anthropic', 'openai', 'gemini'].includes(protocol)) {
    throw failure('CONFIG_ERROR', 'Invalid LLM endpoint configuration', false);
  }
  const timeoutMs = options.timeoutMs ?? 300000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw failure('TIMEOUT', 'LLM request deadline expired');
  const maxTokens = options.maxTokens ?? 4096;
  const temperature = options.temperature ?? 0.3;
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  let payload;
  if (protocol === 'anthropic') {
    headers['x-api-key'] = resolveSecret(endpoint.api_key || '');
    headers['anthropic-version'] = '2023-06-01';
    payload = { model: endpoint.model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature };
  } else if (protocol === 'openai') {
    headers.authorization = `Bearer ${resolveSecret(endpoint.api_key || '')}`;
    payload = { model: endpoint.model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature };
  } else {
    headers['x-goog-api-key'] = resolveSecret(endpoint.api_key || '');
    payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, temperature } };
    if (options.json) payload.generationConfig.responseMimeType = 'application/json';
  }
  const body = JSON.stringify(payload);
  headers['content-length'] = Buffer.byteLength(body);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let request;
    let response;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) {
        response?.destroy();
        request?.destroy();
        reject(error);
      } else resolve(result);
    };
    const onAbort = () => finish(failure('CANCELLED', 'LLM request was cancelled', false));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => finish(failure('TIMEOUT', 'LLM request deadline expired')), Math.min(timeoutMs, 2147483647));
    try {
      request = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', headers, agent: false }, res => {
        response = res;
        if (settled) { res.destroy(); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) { finish(statusError(res.statusCode, res.headers)); return; }
        const chunks = [];
        let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) { finish(failure('INVALID_RESPONSE', 'LLM response exceeded the size limit')); return; }
          chunks.push(chunk);
        });
        res.on('aborted', () => finish(failure('NETWORK_ERROR', 'LLM response connection was interrupted')));
        res.on('error', () => finish(failure('NETWORK_ERROR', 'LLM response connection failed')));
        res.on('end', () => {
          if (settled) return;
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw.trim()) throw failure('EMPTY_RESPONSE', 'LLM endpoint returned an empty body');
            const isSSE = String(res.headers['content-type'] || '').includes('text/event-stream');
            const parsed = isSSE ? parseSSE(raw, protocol, options) : parseResponse(parseJSON(raw), protocol, options);
            if (!options.probe) validateResult(parsed, options);
            if (options.signal?.aborted) { onAbort(); return; }
            if (Date.now() - started >= timeoutMs) throw failure('TIMEOUT', 'LLM request deadline expired');
            finish(null, { text: parsed.text, model: typeof parsed.model === 'string' && parsed.model ? parsed.model : endpoint.model, usage: parsed.usage || {}, latency_ms: Date.now() - started });
          } catch (error) {
            finish(error instanceof LLMError ? error : failure('INVALID_RESPONSE', 'LLM endpoint returned malformed protocol data'));
          }
        });
      });
      request.on('error', () => finish(failure('NETWORK_ERROR', 'LLM endpoint connection failed')));
      request.end(body);
      if (options.signal?.aborted) onAbort();
    } catch {
      finish(failure('NETWORK_ERROR', 'LLM request could not be sent'));
    }
  });
}

module.exports = { sendLLMRequest, LLMError };
