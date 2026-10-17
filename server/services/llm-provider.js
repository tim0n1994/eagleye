const { protocolName, isMasked } = require('./llm-pool-config');

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
  const previous = getLLMConfig();
  const apiKey = cfg.api_key === undefined || isMasked(cfg.api_key) ? previous?.api_key : cfg.api_key;
  const required = ['provider', 'model'];
  for (const k of required) {
    if (!cfg[k]) throw new Error(`config.${k} is required`);
  }
  if (!apiKey) throw new Error('config.api_key is required');
  if (!cfg.base_url && !cfg.endpoint_url) throw new Error('config.endpoint_url or base_url is required');
  const protocol = protocolName(cfg.protocol || cfg.provider, cfg.endpoint_url);
  const stored = {
    api_key: String(apiKey),
    base_url: String(cfg.base_url || '').replace(/\/+$/, ''),
    ...(cfg.endpoint_url ? { endpoint_url: String(cfg.endpoint_url).trim() } : {}),
    model: String(cfg.model),
    provider: protocol === 'anthropic' ? 'claude' : protocol,
    protocol,
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
  return secret ? '••••' : '';
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
  const urlMatch = text.match(/curl\s+(?:-X\s+POST\s+)?['"]?(https?:\/\/[^\s'"]+)/i);
  if (!urlMatch) return null;
  let url = urlMatch[1].trim();
  const protocol = /\/messages(?:-\d+)?(?:\?|$)/.test(url) ? 'claude' : 'openai';
  if (!/\/(chat\/completions|messages(?:-\d+)?)(?:\?|$)/.test(url)) {
    url = url.replace(/\/+$/, '') + '/chat/completions';
  }
  const baseUrl = url.replace(/\/(chat\/completions|messages(?:-\d+)?).*$/i, '');
  // Bearer token
  const authMatch = text.match(/-H\s+['"]?Authorization:\s*Bearer\s+([^'"\s]+)['"]?/i)
    || text.match(/Authorization:\s*Bearer\s+([^\s'"]+)/i)
    || text.match(/x-api-key:\s*([^\s'"]+)/i);
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
  if (!model) model = text.match(/"model"\s*:\s*"([^"]+)"/)?.[1] || null;
  return { base_url: baseUrl, endpoint_url: url, provider: protocol, api_key: apiKey, model };
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
      const provider = (obj.protocol || obj.provider || obj.type || 'openai').toString().toLowerCase();
      const api_key = obj.api_key || obj.apiKey || obj.key || obj.token;
      const base_url = (obj.base_url || obj.baseUrl || obj.endpoint_url || obj.endpoint || obj.url || '').toString().replace(/\/+$/, '');
      const model = obj.model || obj.model_name || obj.modelName;
      if (!api_key) return { error: 'JSON config missing api_key' };
      if (!base_url) return { error: 'JSON config missing base_url' };
      if (!model) return { error: 'JSON config missing model' };
      return {
        provider: _normaliseProvider(provider, raw),
        api_key: String(api_key),
        base_url: String(base_url),
        ...(obj.endpoint_url ? { endpoint_url: String(obj.endpoint_url) } : /\/(messages(?:-\d+)?|chat\/completions)$/.test(base_url) ? { endpoint_url: base_url } : {}),
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
        provider: _normaliseProvider(extracted.provider, raw),
        api_key: extracted.api_key,
        base_url: extracted.base_url,
        endpoint_url: extracted.endpoint_url,
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
    ...(messages_url || chat_url ? { endpoint_url: messages_url || chat_url } : /\/(messages(?:-\d+)?|chat\/completions)$/.test(base_url) ? { endpoint_url: base_url } : {}),
    model: model,
  };
}

function _normaliseProvider(guess, raw) {
  const declared = _extractField(raw || '', ['Protocol']);
  const protocol = protocolName(declared || guess);
  return protocol === 'anthropic' ? 'claude' : protocol;
}

// ─── Test the active config by sending a tiny "hi" prompt ──────────────

async function testLLMConfig() {
  const pool = require('./llm-pool');
  const poolConfig = pool.getPoolConfig();
  if (poolConfig?.enabled) {
    const endpoint = poolConfig.endpoints.find(row => row.enabled);
    if (!endpoint) return { ok: false, reachable: false, validated: false, message: 'No enabled endpoint' };
    return pool.testPoolEndpoint(endpoint.id);
  }
  const provider = getProvider();
  if (!provider) {
    return { ok: false, message: 'No active LLM provider. Save a config or set .env first.' };
  }
  const info = getProviderInfo();
  const t0 = Date.now();
  try {
    const result = await provider.callWithMetadata('Hi', { temperature: 0, maxTokens: 1, probe: true });
    const ms = Date.now() - t0;
    return {
      ok: true,
      reachable: true,
      validated: false,
      message: `LLM endpoint reachable in ${ms}ms`,
      provider: info.provider,
      model: result.metadata.model,
      latency_ms: ms,
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

function buildLegacyProvider(cfg) {
  const protocol = cfg.protocol || (cfg.provider === 'claude' ? 'anthropic' : cfg.provider);
  const base = String(cfg.base_url || '').replace(/\/+$/, '');
  const endpoint = {
    id: 'legacy', protocol, api_key: cfg.api_key, model: cfg.model,
    endpoint_url: cfg.endpoint_url || (protocol === 'gemini'
      ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`
      : `${base}/${protocol === 'anthropic' ? 'messages' : 'chat/completions'}`),
  };
  return {
    name: protocol === 'anthropic' ? 'claude' : protocol, model: cfg.model, isPool: false,
    async callWithMetadata(prompt, options = {}) {
      const { sendLLMRequest } = require('./llm-transport');
      const response = await sendLLMRequest(endpoint, prompt, options);
      return { text: response.text, metadata: {
        endpoint_id: 'legacy', protocol, provider: protocol === 'anthropic' ? 'claude' : protocol,
        requested_model: cfg.model, model: response.model || cfg.model, latency_ms: response.latency_ms,
        usage: response.usage, attempts: 1, trace_id: require('node:crypto').randomUUID(),
      } };
    },
    async call(prompt, options = {}) { return (await this.callWithMetadata(prompt, options)).text; },
  };
}

function legacyConfig() {
  const cfg = getLLMConfig();
  if (cfg?.api_key && cfg.model) return cfg;
  const env = process.env;
  const keys = { gemini: env.GEMINI_API_KEY || env.LLM_API_KEY, openai: env.OPENAI_API_KEY, claude: env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY };
  const preferred = String(env.LLM_PROVIDER || '').toLowerCase();
  const provider = keys[preferred] ? preferred : ['gemini', 'openai', 'claude'].find(name => keys[name]);
  if (!provider) return null;
  return {
    provider, api_key: keys[provider], source: 'env',
    model: provider === 'gemini' ? env.LLM_MODEL || 'gemini-2.0-flash' : provider === 'openai' ? env.OPENAI_MODEL || 'gpt-4o-mini' : env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
    base_url: provider === 'openai' ? env.OPENAI_BASE_URL || 'https://api.openai.com/v1' : provider === 'claude' ? env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1' : '',
  };
}

function getProvider(task = 'general') {
  const pool = require('./llm-pool').getPoolProvider(task);
  if (pool) return pool;
  const cfg = legacyConfig();
  return cfg ? buildLegacyProvider(cfg) : null;
}

function getEnrichProvider() {
  const pool = require('./llm-pool').getPoolProvider('enrich');
  if (pool) return pool;
  const cfg = legacyConfig();
  if (!cfg) return null;
  return buildLegacyProvider({ ...cfg, model: process.env.ENRICH_LLM_MODEL || cfg.model });
}

function getProviderInfo() {
  const cfg = require('./llm-pool').getPoolConfig();
  if (cfg?.enabled) return { provider: 'pool', model: 'routed', key_configured: cfg.endpoints.some(endpoint => endpoint.enabled && endpoint.api_key), source: 'pool' };
  const legacy = legacyConfig();
  return legacy ? { provider: legacy.provider, model: legacy.model, key_configured: !!legacy.api_key, source: legacy.source || 'runtime', base_url: legacy.base_url || '', endpoint_url: legacy.endpoint_url || '' }
    : { provider: 'none', model: 'none', key_configured: false, source: 'env' };
}

/**
 * Extract JSON from LLM response text.
 * Handles markdown code fences and partial JSON.
 */
function extractJSON(text) {
  if (!text) return null;

  // Strip markdown code fences
  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(clean); } catch {}

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
