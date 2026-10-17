const TASKS = ['enrich', 'classify', 'translate', 'digest', 'research', 'graph', 'general'];
const DEFAULTS = { schema_version: 1, enabled: false, global_concurrency: 5, queue_limit: 100, request_timeout_ms: 120000, queue_timeout_ms: 30000, max_attempts: 2 };
// Additional endpoint hostnames accepted beyond loopback (comma/space separated).
// For same-host gateways that only bind a specific interface, e.g. the LiteLLM
// gateway's Tailscale address. Credentials still must travel in headers.
const EXTRA_HOSTS = String(process.env.EAGLEYE_POOL_EXTRA_HOSTS || '')
  .split(/[,\s]+/).filter(Boolean).filter(host => /^[a-zA-Z0-9.-]+$/.test(host));

function configError(message) {
  return Object.assign(new Error(message), { code: 'INVALID_CONFIG' });
}

function integer(value, fallback, min, max, field) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw configError(`Invalid ${field}`);
  return number;
}

function protocolName(value, endpoint = '') {
  const name = String(value || '').trim().toLowerCase();
  if (/^(claude|anthropic)(?:\s+messages(?:\s+api)?)?$/.test(name) || name === 'messages') return 'anthropic';
  if (/^openai(?:[- ]compatible)?(?:\s+chat\s+completions)?$/.test(name)) return 'openai';
  if (/^(gemini|google gemini)$/.test(name)) return 'gemini';
  if (!name && /\/messages(?:-\d+)?(?:\?|$)/.test(endpoint)) return 'anthropic';
  if (!name && /\/chat\/completions(?:\?|$)/.test(endpoint)) return 'openai';
  throw configError('Explicit supported protocol is required');
}

function maskedKey(key) {
  return key ? '••••' : '';
}

function isMasked(key) {
  return typeof key === 'string' && (/•/.test(key) || /\*{4,}/.test(key));
}

function maskConfig(config) {
  if (!config) return null;
  return { ...config, endpoints: config.endpoints.map(endpoint => ({ ...endpoint, tasks: [...endpoint.tasks], api_key: maskedKey(endpoint.api_key) })) };
}

function validatePoolConfig(input, previous = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw configError('Pool config object required');
  if (input.schema_version !== undefined && input.schema_version !== 1) throw configError('Unsupported pool schema version');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw configError('enabled must be boolean');
  if (!Array.isArray(input.endpoints) || input.endpoints.length > 32 || (input.enabled && !input.endpoints.length)) throw configError('Pool requires 1 to 32 endpoints when enabled');
  const oldEndpoints = new Map((previous?.endpoints || []).map(endpoint => [endpoint.id, endpoint]));
  const ids = new Set();
  const endpoints = input.endpoints.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw configError(`Invalid endpoint at index ${index}`);
    const id = String(entry.id || `lane-${index + 1}`);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ids.has(id)) throw configError('Endpoint ids must be unique safe identifiers');
    ids.add(id);
    const endpoint_url = String(entry.endpoint_url || '').trim();
    let url;
    try { url = new URL(endpoint_url); } catch { throw configError(`Endpoint ${id} requires a full URL`); }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!['http:', 'https:'].includes(url.protocol) || !(/^(localhost|127(?:\.\d{1,3}){3}|::1)$/.test(hostname) || EXTRA_HOSTS.includes(hostname)) || url.username || url.password || url.hash || url.pathname === '/') {
      throw configError(`Endpoint ${id} must be a complete local HTTP(S) endpoint without URL credentials`);
    }
    if ([...url.searchParams.keys()].some(key => /key|token|secret|auth/i.test(key))) throw configError(`Endpoint ${id} must send credentials in headers`);
    const protocol = protocolName(entry.protocol, endpoint_url);
    const model = String(entry.model || '').trim();
    if (!model || model.length > 200) throw configError(`Endpoint ${id} requires a model`);
    const old = oldEndpoints.get(id);
    const api_key = entry.api_key === undefined || isMasked(entry.api_key) ? old?.api_key : entry.api_key;
    if (typeof api_key !== 'string' || !api_key.trim()) throw configError(`Endpoint ${id} requires a key`);
    const tasks = entry.tasks === undefined ? [...TASKS] : entry.tasks;
    if (!Array.isArray(tasks) || !tasks.length || tasks.some(task => !TASKS.includes(task))) throw configError(`Endpoint ${id} has invalid tasks`);
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw configError(`Endpoint ${id} enabled must be boolean`);
    const quota_group = entry.quota_group === undefined || entry.quota_group === null || entry.quota_group === ''
      ? old?.quota_group
      : String(entry.quota_group).trim();
    if (quota_group && !/^[a-zA-Z0-9_-]{1,64}$/.test(quota_group)) throw configError(`Endpoint ${id} quota_group must be a safe identifier`);
    return { id, label: String(entry.label || id).slice(0, 120), protocol, endpoint_url, api_key, model,
      enabled: entry.enabled !== false, priority: integer(entry.priority, 0, 0, 9, 'endpoint priority'), concurrency: integer(entry.concurrency, 1, 1, 32, 'endpoint concurrency'), tasks: [...new Set(tasks)],
      ...(quota_group ? { quota_group } : {}) };
  });
  return { schema_version: 1, enabled: input.enabled ?? false,
    global_concurrency: integer(input.global_concurrency, DEFAULTS.global_concurrency, 1, 64, 'global_concurrency'),
    queue_limit: integer(input.queue_limit, DEFAULTS.queue_limit, 1, 10000, 'queue_limit'),
    request_timeout_ms: integer(input.request_timeout_ms, DEFAULTS.request_timeout_ms, 10, 900000, 'request_timeout_ms'),
    queue_timeout_ms: integer(input.queue_timeout_ms, DEFAULTS.queue_timeout_ms, 10, 900000, 'queue_timeout_ms'),
    max_attempts: integer(input.max_attempts, DEFAULTS.max_attempts, 1, 2, 'max_attempts'), endpoints };
}

function parsePoolText(pasted) {
  if (typeof pasted !== 'string' || !pasted.trim()) throw configError('Pasted endpoint configuration is required');
  if (pasted.length > 1048576) throw configError('Pasted configuration is too large');
  const text = pasted.trim();
  if (/^[{[]/.test(text)) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw configError('Invalid configuration JSON'); }
    return validatePoolConfig(Array.isArray(parsed) ? { ...DEFAULTS, endpoints: parsed } : parsed);
  }
  const endpoints = [];
  const current = {};
  function flush() {
    if (!current.endpoint_url && !current.base_url) return;
    if (!current.endpoint_url) {
      const base = String(current.base_url).replace(/\/+$/, '');
      if (/\/(messages(?:-\d+)?|chat\/completions)(?:\?|$)/.test(base)) current.endpoint_url = base;
      else {
        const protocol = protocolName(current.protocol);
        if (protocol === 'gemini') throw configError('Gemini requires an explicit complete endpoint URL');
        current.endpoint_url = `${base}${protocol === 'anthropic' ? '/messages' : '/chat/completions'}`;
      }
    }
    const endpoint = { ...current };
    Reflect.deleteProperty(endpoint, 'base_url');
    endpoints.push({ id: `lane-${endpoints.length + 1}`, ...endpoint });
    for (const laneKey of Object.keys(current)) Reflect.deleteProperty(current, laneKey);
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*]\s*)?([\w -]+(?:\s*\([^)]*\))?)\s*[:=]\s*(.*?)\s*$/);
    if (!match) continue;
    const field = match[1].trim().toLowerCase().replace(/\s*\([^)]*\)/g, '').replace(/[ _-]/g, '');
    const value = match[2].replace(/^['"]|['"]$/g, '');
    if (['provider', 'localendpoint'].includes(field)) {
      if ((current.endpoint_url || current.base_url) && current.model) flush();
      if (field === 'provider' && value) current.label = value;
      continue;
    }
    if (/^(endpoint|lane)\d+$/.test(field)) {
      flush();
      if (value) current.label = value;
      continue;
    }
    const key = { protocol: 'protocol', baseurl: 'base_url', messagesurl: 'endpoint_url', chaturl: 'endpoint_url', endpointurl: 'endpoint_url', url: 'endpoint_url', apikey: 'api_key', key: 'api_key', token: 'api_key', model: 'model', modelname: 'model', quotagroup: 'quota_group' }[field.replace(/\d+$/, '')];
    if (!key) continue;
    if (current[key] && (current.endpoint_url || current.base_url) && current.model) flush();
    current[key] = value;
  }
  flush();
  if (!endpoints.length) throw configError('No complete endpoints found');
  return validatePoolConfig({ ...DEFAULTS, endpoints });
}

module.exports = { TASKS, DEFAULTS, validatePoolConfig, parsePoolText, maskConfig, protocolName, isMasked };
