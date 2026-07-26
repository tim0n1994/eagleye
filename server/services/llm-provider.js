const http = require('http');
const https = require('https');

const MAX_LLM_SOCKETS = Math.max(8, parseInt(process.env.LLM_MAX_SOCKETS || '64', 10));
const HTTP_KEEP_ALIVE_AGENT = new http.Agent({
  keepAlive: true,
  maxSockets: MAX_LLM_SOCKETS,
  maxFreeSockets: Math.min(MAX_LLM_SOCKETS, 16),
  timeout: 300000,
});
const HTTPS_KEEP_ALIVE_AGENT = new https.Agent({
  keepAlive: true,
  maxSockets: MAX_LLM_SOCKETS,
  maxFreeSockets: Math.min(MAX_LLM_SOCKETS, 16),
  keepAliveMsecs: 30000,
  timeout: 300000,
});

/**
 * Eagleye — LLM Provider Abstraction
 *
 * Unified interface for multiple LLM providers (Gemini, OpenAI, Claude).
 * Each provider implements: { call(prompt, options): Promise<string|null> }
 *
 * Runtime config:
 *   The active provider can be overridden at runtime via /api/settings/llm.
 *   The override is persisted in the user_data table under key 'llm_config'
 *   and takes precedence over .env. .env remains the boot-time fallback.
 *
 * Usage:
 *   const provider = getProvider();
 *   const text = await provider.call("Your prompt here", { temperature: 0.2 });
 */

// Pick the right transport module based on the URL scheme so OpenAI-compatible
// endpoints that speak plain HTTP (e.g. local routers / proxies) work as
// configured via OPENAI_BASE_URL. This previously hard-coded `https`, which
// silently downgraded http:// URLs to 127.0.0.1:443 and returned ECONNREFUSED.
function _requestModule(parsedUrl) {
  return parsedUrl.protocol === 'http:' ? http : https;
}

function _requestAgent(parsedUrl) {
  return parsedUrl.protocol === 'http:' ? HTTP_KEEP_ALIVE_AGENT : HTTPS_KEEP_ALIVE_AGENT;
}

// ─── Runtime config store ───────────────────────────────────────────────

const RUNTIME_CONFIG_KEY = 'llm_config';

let _runtimeConfigCache = null;
let _runtimeConfigLoadedAt = 0;
const RUNTIME_CONFIG_TTL_MS = 5000; // re-read from DB at most every 5s

function _readRuntimeConfigFromDB() {
  try {
    const { getValue } = require('../db/user-data');
    return getValue(RUNTIME_CONFIG_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Return the currently-active runtime LLM config (or null if not set).
 * Caches for a few seconds to avoid hitting the DB on every request.
 */
function getLLMConfig() {
  const now = Date.now();
  if (_runtimeConfigCache && (now - _runtimeConfigLoadedAt) < RUNTIME_CONFIG_TTL_MS) {
    return _runtimeConfigCache;
  }
  _runtimeConfigCache = _readRuntimeConfigFromDB();
  _runtimeConfigLoadedAt = now;
  return _runtimeConfigCache;
}

function saveLLMConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('config object required');
  const required = ['provider', 'api_key', 'base_url', 'model'];
  for (const k of required) {
    if (!cfg[k]) throw new Error(`config.${k} is required`);
  }
  const stored = {
    ...cfg,
    api_key: String(cfg.api_key),
    base_url: String(cfg.base_url).replace(/\/+$/, ''),
    model: String(cfg.model),
    provider: String(cfg.provider).toLowerCase(),
    source: cfg.source || 'manual',
    updated_at: new Date().toISOString(),
  };
  const { setValue } = require('../db/user-data');
  setValue(RUNTIME_CONFIG_KEY, stored);
  _runtimeConfigCache = stored;
  _runtimeConfigLoadedAt = Date.now();
  return stored;
}

function clearLLMConfig() {
  const { getDB } = require('../db/connection');
  const db = getDB();
  if (db) db.prepare('DELETE FROM user_data WHERE key = ?').run(RUNTIME_CONFIG_KEY);
  _runtimeConfigCache = null;
  _runtimeConfigLoadedAt = 0;
}

function maskSecret(secret) {
  if (!secret) return '';
  const s = String(secret);
  if (s.length <= 4) return '••••';
  return s.slice(0, 2) + '••••' + s.slice(-2);
}

// ─── Parser for the user's pasted config format ────────────────────────
//
// We accept the well-known "Local Endpoint" key/value format the user
// typically pastes from a proxy or model-router console, but we also
// recognise the more common variants: JSON, INI-ish, and curl.
//
// Examples that work:
//   Provider:  🌐 AliCloud SG
//   Upstream:  https://dashscope-intl.aliyuncs.com/...
//   Protocol:  OpenAI Chat Completions
//   Local Endpoint:
//     Base URL:           http://127.0.0.1:3458/v1
//     Chat URL:           http://127.0.0.1:3458/v1/chat/completions
//     Models URL:         http://127.0.0.1:3458/v1/models
//     API Key:             test
//     Model:               qwq-plus
//
// Or:
//   curl http://127.0.0.1:3458/v1/chat/completions \
//     -H 'Authorization: Bearer test' \
//     -H 'Content-Type: application/json' \
//     -d '{"model":"qwq-plus", ...}'

function _extractField(text, labels) {
  for (const label of labels) {
    // Match: "Label:   value"  or  "Label = value"  or  "Label: 'value'"
    const re = new RegExp(
      `^\\s*${label}\\s*[:=]\\s*(?:['"\`])?([^\\n'"\`]+?)(?:['"\`])?\\s*$`,
      'im',
    );
    const m = text.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function _extractFromCurl(text) {
  // Find the URL inside the curl command
  const urlMatch = text.match(/curl\s+['"]?([^\s'"]+)\/chat\/completions/i)
    || text.match(/curl\s+['"]?([^\s'"]+)/i);
  if (!urlMatch) return null;
  let url = urlMatch[1].trim();
  if (!/\/chat\/completions/.test(url)) {
    url = url.replace(/\/+$/, '') + '/chat/completions';
  }
  const baseUrl = url.replace(/\/chat\/completions.*$/i, '');
  // Bearer token
  const authMatch = text.match(/-H\s+['"]?Authorization:\s*Bearer\s+([^'"\s]+)['"]?/i)
    || text.match(/Authorization:\s*Bearer\s+([^\s'"]+)/i);
  const apiKey = authMatch ? authMatch[1].trim() : null;
  // Model from inline -d
  let model = null;
  const dataMatch = text.match(/-d\s+['"](.+?)['"]/s);
  if (dataMatch) {
    try {
      const obj = JSON.parse(dataMatch[1]);
      if (obj.model) model = String(obj.model);
    } catch {
      const m2 = dataMatch[1].match(/"model"\s*:\s*"([^"]+)"/);
      if (m2) model = m2[1];
    }
  }
  return { base_url: baseUrl, api_key: apiKey, model };
}

function parsePastedLLMConfig(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { error: 'Empty config text' };
  }
  const raw = text.trim();

  // 1) Try plain JSON first
  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      const provider = (obj.provider || obj.type || 'openai').toString().toLowerCase();
      const api_key = obj.api_key || obj.apiKey || obj.key || obj.token;
      const base_url = (obj.base_url || obj.baseUrl || obj.endpoint || obj.url || '').toString().replace(/\/+$/, '');
      const model = obj.model || obj.model_name || obj.modelName;
      if (!api_key) return { error: 'JSON config missing api_key' };
      if (!base_url) return { error: 'JSON config missing base_url' };
      if (!model) return { error: 'JSON config missing model' };
      return {
        provider: _normaliseProvider(provider, raw),
        api_key: String(api_key),
        base_url: String(base_url),
        model: String(model),
      };
    } catch {
      // fall through to key/value parser
    }
  }

  // 2) Try curl-style
  if (/^\s*curl\b/im.test(raw)) {
    const extracted = _extractFromCurl(raw);
    if (extracted && extracted.base_url && extracted.api_key && extracted.model) {
      return {
        provider: _normaliseProvider('openai', raw),
        api_key: extracted.api_key,
        base_url: extracted.base_url,
        model: extracted.model,
      };
    }
  }

  // 3) Key/value lines (the user's exact format)
  let base_url = _extractField(raw, [
    'Base URL', 'BaseURL', 'Base Url', 'base_url', 'baseUrl', 'Endpoint', 'endpoint', 'URL',
  ]);
  const api_key = _extractField(raw, [
    'API Key', 'API key', 'Api Key', 'api_key', 'apiKey', 'Key', 'Token', 'token', 'apikey',
  ]);
  const model = _extractField(raw, [
    'Model', 'model', 'Model Name', 'model_name', 'modelName', 'Model ID', 'model_id',
  ]);
  const chat_url = _extractField(raw, ['Chat URL', 'ChatURL', 'Chat Url', 'chat_url']);
  const models_url = _extractField(raw, ['Models URL', 'ModelsURL', 'Models Url', 'models_url']);
  // Anthropic Messages API endpoints use a /messages path (vs OpenAI's
  // /chat/completions). Detect it so we route to the claude provider and strip
  // the path back to the /v1 base.
  const messages_url = _extractField(raw, ['Messages URL', 'MessagesURL', 'Messages Url', 'messages_url']);

  let isAnthropic = !!messages_url;

  // Messages URL is the most authoritative source for the API base: it carries
  // the version segment (/v1) that a bare "Base URL" host field often omits
  // (e.g. Base URL "http://127.0.0.1:3458" + Messages URL ".../v1/messages").
  // When present, derive base_url from it by stripping the /messages path,
  // even if a Base URL field was also filled in.
  if (messages_url) {
    base_url = messages_url.replace(/\/messages.*$/i, '').replace(/\/+$/, '');
    isAnthropic = true;
  } else if (chat_url) {
    base_url = chat_url.replace(/\/chat\/completions.*$/i, '').replace(/\/+$/, '');
  } else if (models_url) {
    base_url = models_url.replace(/\/models.*$/i, '').replace(/\/+$/, '');
  }
  if (!base_url) {
    // last resort: any http(s)://… in the text
    const any = raw.match(/https?:\/\/[^\s'"]+/i);
    if (any) {
      base_url = any[0].replace(/\/messages.*$/i, '').replace(/\/chat\/completions.*$/i, '').replace(/\/models.*$/i, '').replace(/\/+$/, '');
    }
  }

  if (!base_url) return { error: 'Could not find Base URL / endpoint in pasted config' };
  if (!api_key) return { error: 'Could not find API Key / token in pasted config' };
  if (!model) return { error: 'Could not find Model name in pasted config' };

  return {
    provider: _normaliseProvider(isAnthropic ? 'claude' : 'openai', raw),
    api_key: api_key,
    base_url: base_url,
    model: model,
  };
}

function _normaliseProvider(guess, raw) {
  const t = (raw || '').toLowerCase();
  if (/claude|anthropic/.test(t)) return 'claude';
  if (/gemini|google/.test(t)) return 'gemini';
  if (/openai|chat\s*completions|aliyun|dashscope|ali\s*cloud|qwen|deepseek|moonshot|groq|together|fireworks|openrouter/.test(t)) {
    return 'openai';
  }
  return (guess || 'openai').toLowerCase();
}

// ─── Test the active config by sending a tiny "hi" prompt ──────────────

async function testLLMConfig() {
  const provider = getProvider();
  if (!provider) {
    return { ok: false, message: 'No active LLM provider. Save a config or set .env first.' };
  }
  const info = getProviderInfo();
  const t0 = Date.now();
  try {
    const text = await provider.call('Reply with the single word: pong', { temperature: 0, maxTokens: 32 });
    const ms = Date.now() - t0;
    if (!text) return { ok: false, message: 'Provider returned empty response', provider: info.provider, model: info.model, latency_ms: ms };
    return {
      ok: true,
      message: `LLM responded in ${ms}ms`,
      provider: info.provider,
      model: info.model,
      latency_ms: ms,
      sample: text.slice(0, 200),
    };
  } catch (err) {
    return { ok: false, message: err.message, provider: info.provider, model: info.model, latency_ms: Date.now() - t0 };
  }
}

function describeProvider(name) {
  switch ((name || '').toLowerCase()) {
    case 'openai': return 'OpenAI-compatible (Chat Completions)';
    case 'gemini': return 'Google Gemini';
    case 'claude': return 'Anthropic Claude';
    default: return name || 'unknown';
  }
}

// ─── Provider Implementations ───────────────────────────────────────────

class GeminiProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'gemini';
    this.model = process.env.LLM_MODEL || 'gemini-2.0-flash';
  }

  async call(prompt, options = {}) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: options.maxTokens || 4096,
        topP: 0.95,
      },
    };

    const text = await this._post(url, payload);
    if (!text) return null;

    try {
      const response = JSON.parse(text);
      return response.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch {
      return null;
    }
  }

  async _post(url, payload) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const body = JSON.stringify(payload);
      const mod = _requestModule(parsed);
      const req = mod.request({
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        agent: _requestAgent(parsed),
        headers: {
          'Content-Type': 'application/json',
          'Connection': 'keep-alive',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(300000, () => { req.destroy(); reject(new Error('LLM request timeout')); });
      req.write(body);
      req.end();
    });
  }
}

class OpenAIProvider {
  constructor(opts = {}) {
    // Accept either an apiKey string (legacy) or a full config object
    if (typeof opts === 'string') {
      this.apiKey = opts;
      this.model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
      this.baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    } else {
      this.apiKey = opts.apiKey || opts.api_key;
      this.model = opts.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
      this.baseUrl = (opts.baseUrl || opts.base_url || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    }
    this.name = 'openai';
  }

  async call(prompt, options = {}) {
    const url = `${this.baseUrl}/chat/completions`;
    const payload = {
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens || 4096,
      enable_thinking: false,
    };
    // Request strict JSON output when the caller opts in (e.g. signal
    // classification). Some local routers ignore this field, so callers must
    // still parse defensively.
    if (options.json === true) {
      payload.response_format = { type: 'json_object' };
    }

    const text = await this._post(url, payload);
    if (!text) {
      console.warn('  ⚠  OpenAI API returned empty response');
      return null;
    }

    try {
      const response = JSON.parse(text);
      if (response.error) {
        console.warn(`  ⚠  OpenAI API error: ${response.error.message || JSON.stringify(response.error).slice(0, 200)}`);
        return null;
      }
      const message = response.choices?.[0]?.message;
      // Prefer standard `content`; fall back to `reasoning_content` (used by
      // reasoning models routed through FCM / OpenRouter / DeepSeek).
      const result = message?.content || message?.reasoning_content || null;
      // Strip <｜end▁of▁thinking｜><｜end▁of▁thinking｜>
      return result;
    } catch {
      return null;
    }
  }

  async _post(url, payload, retries = 2) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const result = await new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const body = JSON.stringify(payload);
        const mod = _requestModule(parsed);
        const req = mod.request({
          hostname: parsed.hostname,
          port: parsed.port || undefined,
          path: parsed.pathname + parsed.search,
          method: 'POST',
          agent: _requestAgent(parsed),
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
            'Connection': 'keep-alive',
            'Content-Length': Buffer.byteLength(body),
          },
        }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(300000, () => { req.destroy(); reject(new Error('LLM request timeout')); });
        req.write(body);
        req.end();
      }).catch(err => {
        const isRetryable = err.message?.includes('ECONNRESET') || err.message?.includes('EOF') || err.message?.includes('EPIPE') || err.message?.includes('ETIMEDOUT');
        if (isRetryable && attempt < retries) {
          return null; // signal retry
        }
        throw err;
      });

      if (result !== null) return result;
      await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }
}

class ClaudeProvider {
  constructor(opts = {}) {
    // Accept either an apiKey string (legacy) or a full config object.
    if (typeof opts === 'string') {
      this.apiKey = opts;
      this.model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
      this.baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    } else {
      this.apiKey = opts.apiKey || opts.api_key;
      this.model = opts.model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
      this.baseUrl = (opts.baseUrl || opts.base_url || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    }
    this.name = 'claude';
  }

  async call(prompt, options = {}) {
    const url = `${this.baseUrl}/messages`;
    const payload = {
      model: this.model,
      max_tokens: options.maxTokens || 4096,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature ?? 0.2,
    };

    const text = await this._post(url, payload);
    if (!text) return null;

    try {
      const response = JSON.parse(text);
      return response.content?.[0]?.text || null;
    } catch {
      return null;
    }
  }

  async _post(url, payload) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const body = JSON.stringify(payload);
      const mod = _requestModule(parsed);
      const req = mod.request({
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        agent: _requestAgent(parsed),
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'Connection': 'keep-alive',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            const snippet = (data || '').slice(0, 300).replace(/\s+/g, ' ');
            reject(new Error(`LLM HTTP ${res.statusCode}: ${snippet || '(empty body)'}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(300000, () => { req.destroy(); reject(new Error('LLM request timeout')); });
      req.write(body);
      req.end();
    });
  }
}

// ─── Provider Registry ──────────────────────────────────────────────────

function _buildFromRuntime() {
  const cfg = getLLMConfig();
  if (!cfg) return null;
  if (cfg.provider === 'openai' && cfg.api_key && cfg.base_url && cfg.model) {
    return new OpenAIProvider({ apiKey: cfg.api_key, baseUrl: cfg.base_url, model: cfg.model });
  }
  if (cfg.provider === 'gemini' && cfg.api_key && cfg.model) {
    return new GeminiProvider(cfg.api_key);
  }
  if (cfg.provider === 'claude' && cfg.api_key && cfg.model) {
    return new ClaudeProvider({ apiKey: cfg.api_key, baseUrl: cfg.base_url, model: cfg.model });
  }
  return null;
}

function getProvider() {
  // 1) Runtime override always wins (the user pasted it via the UI)
  const fromRuntime = _buildFromRuntime();
  if (fromRuntime) return fromRuntime;

  // 2) Fall back to .env
  const geminiKey = process.env.GEMINI_API_KEY || process.env.LLM_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const claudeKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;

  // Priority: explicit LLM_PROVIDER env var, then first available key, then gemini
  const preferred = (process.env.LLM_PROVIDER || '').toLowerCase();

  if (preferred === 'openai' && openaiKey) return new OpenAIProvider(openaiKey);
  if (preferred === 'claude' && claudeKey) return new ClaudeProvider({ apiKey: claudeKey, baseUrl: process.env.ANTHROPIC_BASE_URL, model: process.env.CLAUDE_MODEL });
  if (preferred === 'gemini' && geminiKey) return new GeminiProvider(geminiKey);

  // Auto-detect based on available keys
  if (geminiKey) return new GeminiProvider(geminiKey);
  if (openaiKey) return new OpenAIProvider(openaiKey);
  if (claudeKey) return new ClaudeProvider({ apiKey: claudeKey, baseUrl: process.env.ANTHROPIC_BASE_URL, model: process.env.CLAUDE_MODEL });

  // Fallback: no provider available
  return null;
}

/**
 * Provider for high-volume enrichment. Same endpoint/key as getProvider(),
 * but overrides the model via ENRICH_LLM_MODEL (e.g. glm-4.5-air) so the
 * heavy batch work doesn't overload the primary model (e.g. glm-5.2).
 * Falls back to getProvider() if ENRICH_LLM_MODEL is not set.
 */
function getEnrichProvider() {
  const enrichModel = process.env.ENRICH_LLM_MODEL;
  if (!enrichModel) return getProvider();

  // Reuse the active provider's type/key/base, just swap the model.
  const cfg = getLLMConfig();
  if (cfg) {
    if (cfg.provider === 'openai') return new OpenAIProvider({ apiKey: cfg.api_key, baseUrl: cfg.base_url, model: enrichModel });
    if (cfg.provider === 'claude') return new ClaudeProvider({ apiKey: cfg.api_key, baseUrl: cfg.base_url, model: enrichModel });
    if (cfg.provider === 'gemini') return new GeminiProvider(cfg.api_key);
  }

  // .env fallback
  const claudeKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (claudeKey) return new ClaudeProvider({ apiKey: claudeKey, baseUrl: process.env.ANTHROPIC_BASE_URL, model: enrichModel });
  if (openaiKey) return new OpenAIProvider({ apiKey: openaiKey, baseUrl: process.env.OPENAI_BASE_URL, model: enrichModel });

  return getProvider();
}

function getProviderInfo() {
  // 1) Runtime
  const cfg = getLLMConfig();
  if (cfg && cfg.provider && cfg.model) {
    return {
      provider: cfg.provider,
      model: cfg.model,
      key_configured: !!cfg.api_key,
      source: cfg.source || 'runtime',
      base_url: cfg.base_url || '',
    };
  }

  // 2) .env
  const geminiKey = process.env.GEMINI_API_KEY || process.env.LLM_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const claudeKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  const preferred = (process.env.LLM_PROVIDER || '').toLowerCase();

  let provider = 'none';
  let model = 'none';

  if (preferred === 'openai' && openaiKey) { provider = 'openai'; model = process.env.OPENAI_MODEL || 'gpt-4o-mini'; }
  else if (preferred === 'claude' && claudeKey) { provider = 'claude'; model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514'; }
  else if (preferred === 'gemini' && geminiKey) { provider = 'gemini'; model = process.env.LLM_MODEL || 'gemini-2.0-flash'; }
  else if (geminiKey) { provider = 'gemini'; model = process.env.LLM_MODEL || 'gemini-2.0-flash'; }
  else if (openaiKey) { provider = 'openai'; model = process.env.OPENAI_MODEL || 'gpt-4o-mini'; }
  else if (claudeKey) { provider = 'claude'; model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514'; }

  return { provider, model, key_configured: !!geminiKey || !!openaiKey || !!claudeKey, source: 'env' };
}

/**
 * Extract JSON from LLM response text.
 * Handles markdown code fences and partial JSON.
 */
function extractJSON(text) {
  if (!text) return null;

  // Strip markdown code fences
  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  // Try parsing as array
  const arrayMatch = clean.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try { return JSON.parse(arrayMatch[0]); } catch {}
  }

  // Try parsing as object
  const objMatch = clean.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch {}
  }

  // Try direct parse
  try { return JSON.parse(clean); } catch {}

  return null;
}

module.exports = {
  getProvider,
  getEnrichProvider,
  getProviderInfo,
  extractJSON,
  // New runtime-config exports
  getLLMConfig,
  saveLLMConfig,
  clearLLMConfig,
  parsePastedLLMConfig,
  maskSecret,
  testLLMConfig,
  describeProvider,
};
