const crypto = require('node:crypto');
const { TASKS, validatePoolConfig, parsePoolText, maskConfig } = require('./llm-pool-config');
const { sendLLMRequest, LLMError } = require('./llm-transport');
const { classifyCode } = require('./llm-error-class');
// 案2 fix-morning-1022: write-time secret redaction. Pool credentials are
// stored as ${ENV_REF} placeholders (when the value matches an env var) or
// <redacted>; llm-transport resolves the reference back at request time.
const { redactForStorage } = require('./secret-redaction');

const CONFIG_KEY = 'llm_pool_config';
const SAFE_CODES = new Set(['AUTH_ERROR', 'CONFIG_ERROR', 'RATE_LIMIT', 'HTTP_ERROR', 'TIMEOUT', 'CANCELLED', 'NETWORK_ERROR', 'EMPTY_RESPONSE', 'INVALID_RESPONSE', 'TRUNCATED', 'INVALID_JSON', 'VALIDATION_ERROR', 'QUEUE_FULL', 'QUEUE_TIMEOUT', 'NO_ENDPOINT', 'POOL_DISABLED', 'SHUTDOWN']);

function safeCode(error) {
  return SAFE_CODES.has(error?.code) ? error.code : 'REQUEST_FAILED';
}

function safeError(error) {
  const code = safeCode(error);
  return Object.assign(new Error(`LLM request failed (${code})`), {
    code,
    retryable: error?.retryable === true,
    isPoolError: true,
    ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
  });
}

function createPoolService(dependencies = {}) {
  const getDB = dependencies.getDB || (() => require('../db/connection').getDB());
  const getValue = dependencies.getValue || (key => require('../db/user-data').getValue(key));
  const setValue = dependencies.setValue || ((key, value) => require('../db/user-data').setValue(key, value));
  const sendRequest = dependencies.sendRequest || sendLLMRequest;
  const now = dependencies.now || Date.now;
  let config;
  let loadedAt = 0;
  let active = 0;
  let sequence = 0;
  let wakeTimer = null;
  let pumping = false;
  let shuttingDown = false;
  const queue = [];
  const states = new Map();
  const groupBackoff = new Map();
  const records = new Set();
  const inFlight = new Set();

  function loadConfig() {
    if (config === undefined || now() - loadedAt > 5000) {
      const stored = getValue(CONFIG_KEY);
      config = stored ? validatePoolConfig(stored) : null;
      loadedAt = now();
    }
    return config;
  }

  function stateFor(id) {
    if (!states.has(id)) states.set(id, { active: 0, failures: 0, cooldown: 0, selected: 0, last_success_at: null, last_failure_at: null, last_error_code: null, last_latency_ms: null });
    return states.get(id);
  }

  function sameGroupMembers(endpoint) {
    return endpoint.quota_group ? loadConfig().endpoints.filter(row => row.id !== endpoint.id && row.quota_group === endpoint.quota_group) : [];
  }

  function nextGroupBackoffMs(groupId) {
    const jitter = 0.75 + Math.random() * 0.5;
    if (!groupId) return Math.round(1000 * jitter);
    const next = Math.min(Math.max((groupBackoff.get(groupId) || 0) * 2, 1000), 60000);
    groupBackoff.set(groupId, next);
    return Math.round(next * jitter);
  }

  function canFailoverAfterAuth(record, endpoint) {
    return !!loadConfig()?.endpoints.some(candidate => candidate.enabled && !record.tried.has(candidate.id)
      && (record.endpointId ? candidate.id === record.endpointId : candidate.tasks.includes(record.task))
      && (!endpoint.quota_group || candidate.quota_group !== endpoint.quota_group));
  }

  function recordEvent(record, endpoint, status, code, elapsed, usage = null, retryAfterMs = null) {
    try {
      getDB()?.prepare(`INSERT INTO llm_request_events
        (trace_id, attempt, endpoint_id, task, status, error_code, error_class, retry_after_ms, elapsed_ms, input_tokens, output_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(record.traceId, record.attempts, endpoint?.id || null, record.task, status, code || null,
        status === 'failed' ? classifyCode(code) : null, Number.isFinite(retryAfterMs) ? Math.round(retryAfterMs) : null,
        Math.max(0, Math.round(elapsed)), Number.isFinite(usage?.input_tokens) ? usage.input_tokens : Number.isFinite(usage?.prompt_tokens) ? usage.prompt_tokens : null,
        Number.isFinite(usage?.output_tokens) ? usage.output_tokens : Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : null);
    } catch { /* A missing telemetry table must not prevent a configured request. */ }
  }

  function finish(record, error, value) {
    if (record.done) return;
    record.done = true;
    records.delete(record);
    const index = queue.indexOf(record);
    if (index >= 0) queue.splice(index, 1);
    clearTimeout(record.queueTimer);
    clearTimeout(record.deadlineTimer);
    record.signal?.removeEventListener('abort', record.onAbort);
    if (error) {
      if (!record.inFlight && error !== record.lastError) recordEvent(record, null, error.code === 'CANCELLED' ? 'cancelled' : 'failed', safeCode(error), now() - record.started);
      record.reject(safeError(error));
    } else record.resolve(value);
    pump();
  }

  function eligibleEndpoints(record, cfg) {
    return cfg.endpoints.filter(endpoint => endpoint.enabled && !record.tried.has(endpoint.id)
      && (record.endpointId ? endpoint.id === record.endpointId : endpoint.tasks.includes(record.task)));
  }

  function pump() {
    if (pumping || shuttingDown) return;
    pumping = true;
    try { drain(); } finally { pumping = false; }
  }

  function drain() {
    clearTimeout(wakeTimer);
    wakeTimer = null;
    let cfg;
    try { cfg = loadConfig(); } catch { return; }
    if (!cfg?.enabled && !queue.some(record => record.endpointId)) {
      for (const record of [...queue]) finish(record, new LLMError('POOL_DISABLED', 'Pool disabled'));
      return;
    }
    if (!cfg) return;
    const ordered = [...queue].sort((a, b) => {
      const priority = record => now() - record.queuedAt > 2000 ? 0 : ['research', 'general'].includes(record.task) ? 1 : 2;
      return priority(a) - priority(b) || a.queuedAt - b.queuedAt;
    });
    let nextWake = Infinity;
    for (const record of ordered) {
      if (record.done) continue;
      if (now() >= record.deadline || now() >= record.queueDeadline) {
        finish(record, new LLMError(now() >= record.deadline ? 'TIMEOUT' : 'QUEUE_TIMEOUT', 'Request expired in queue'));
        continue;
      }
      if (!cfg.enabled && !record.endpointId) {
        finish(record, new LLMError('POOL_DISABLED', 'Pool disabled'));
        continue;
      }
      const eligible = eligibleEndpoints(record, cfg);
      if (!eligible.length) {
        finish(record, record.lastError || new LLMError('NO_ENDPOINT', 'No enabled endpoint for task'));
        continue;
      }
      if (active >= cfg.global_concurrency) break;
      const available = eligible.filter(endpoint => {
        const state = stateFor(endpoint.id);
        if (state.cooldown > now()) nextWake = Math.min(nextWake, state.cooldown);
        return state.active < endpoint.concurrency && state.cooldown <= now() && !(state.cooldown > 0 && state.active > 0);
      }).sort((a, b) => (a.priority - b.priority) || (stateFor(a.id).selected - stateFor(b.id).selected));
      if (!available.length) continue;
      queue.splice(queue.indexOf(record), 1);
      clearTimeout(record.queueTimer);
      record.attemptPromise = executeAttempt(record, available[0]);
    }
    if (Number.isFinite(nextWake) && queue.length) wakeTimer = setTimeout(pump, Math.max(1, nextWake - now()));
  }

  function enqueue(record) {
    if (record.done) return;
    const cfg = loadConfig();
    if (queue.length >= cfg.queue_limit) {
      finish(record, new LLMError('QUEUE_FULL', 'Pool queue is full'));
      return;
    }
    record.queuedAt = now();
    record.queueDeadline = Math.min(record.deadline, record.queuedAt + cfg.queue_timeout_ms);
    queue.push(record);
    record.queueTimer = setTimeout(() => finish(record, new LLMError('QUEUE_TIMEOUT', 'Pool queue timeout')), Math.min(cfg.queue_timeout_ms, Math.max(1, record.deadline - now())));
    pump();
  }

  async function executeAttempt(record, endpoint) {
    const state = stateFor(endpoint.id);
    state.active++;
    state.selected = ++sequence;
    active++;
    record.inFlight = true;
    inFlight.add(record);
    record.tried.add(endpoint.id);
    record.attempts++;
    const attemptStarted = now();
    const isCurrentEndpoint = () => config?.endpoints.some(current => current.id === endpoint.id
      && ['endpoint_url', 'api_key', 'model', 'protocol'].every(key => current[key] === endpoint[key]));
    let response;
    let failure;
    try {
      const alternativeCount = eligibleEndpoints(record, loadConfig()).filter(candidate => stateFor(candidate.id).cooldown < record.deadline).length;
      const remainingAttempts = Math.min(record.maxAttempts - record.attempts + 1, alternativeCount + 1);
      const attemptTimeout = Math.max(1, Math.floor((record.deadline - now()) / remainingAttempts));
      response = await sendRequest(endpoint, record.prompt, { ...record.options, signal: record.controller.signal, timeoutMs: attemptTimeout });
      if (now() >= record.deadline) throw new LLMError('TIMEOUT', 'Request deadline exceeded');
      if (record.controller.signal.aborted) throw new LLMError(record.expired ? 'TIMEOUT' : 'CANCELLED', 'Request ended');
      if (isCurrentEndpoint()) {
        state.failures = 0;
        state.cooldown = 0;
        if (endpoint.quota_group) {
          groupBackoff.delete(endpoint.quota_group);
          for (const member of sameGroupMembers(endpoint)) stateFor(member.id).cooldown = 0;
        }
        state.last_success_at = new Date().toISOString();
        state.last_error_code = null;
      }
      recordEvent(record, endpoint, 'completed', null, now() - attemptStarted, response.usage);
    } catch (error) {
      failure = record.expired ? new LLMError('TIMEOUT', 'Request deadline exceeded') : error;
      if (isCurrentEndpoint()) {
        state.last_failure_at = new Date().toISOString();
        state.last_error_code = safeCode(failure);
        if (failure.code !== 'CANCELLED') {
          state.failures++;
          const errorClass = classifyCode(safeCode(failure));
          if (errorClass === 'RATE_LIMITED') {
            const until = now() + Math.min(Math.max(Number(failure.retryAfterMs) || 0, nextGroupBackoffMs(endpoint.quota_group)), 300000);
            state.cooldown = until;
            for (const member of sameGroupMembers(endpoint)) stateFor(member.id).cooldown = until;
          } else if (errorClass === 'AUTH_CONFIG_ERROR') {
            const until = now() + 60000;
            state.cooldown = until;
            for (const member of sameGroupMembers(endpoint)) stateFor(member.id).cooldown = until;
          } else if (failure.retryable && state.failures >= 2) {
            state.cooldown = now() + 5000;
          }
        }
      }
      recordEvent(record, endpoint, failure.code === 'CANCELLED' ? 'cancelled' : 'failed', safeCode(failure), now() - attemptStarted,
        null, Number.isFinite(failure.retryAfterMs) ? failure.retryAfterMs : null);
    } finally {
      if (isCurrentEndpoint()) state.last_latency_ms = now() - attemptStarted;
      state.active--;
      active--;
      record.inFlight = false;
      inFlight.delete(record);
    }
    if (record.done) { pump(); return; }
    if (!failure) {
      finish(record, null, { text: response.text, metadata: {
        endpoint_id: endpoint.id, protocol: endpoint.protocol, provider: endpoint.protocol === 'anthropic' ? 'claude' : endpoint.protocol,
        requested_model: endpoint.model, model: response.model || endpoint.model, latency_ms: now() - record.started,
        usage: response.usage || null, attempts: record.attempts, trace_id: record.traceId,
      } });
    } else if ((failure.retryable || (classifyCode(safeCode(failure)) === 'AUTH_CONFIG_ERROR' && canFailoverAfterAuth(record, endpoint))) && !record.controller.signal.aborted && record.attempts < record.maxAttempts && now() < record.deadline) {
      record.lastError = failure;
      enqueue(record);
    } else {
      record.inFlight = true;
      finish(record, failure);
      record.inFlight = false;
    }
    pump();
  }

  function request(prompt, options = {}, endpointId = null) {
    if (shuttingDown) return Promise.reject(safeError(new LLMError('SHUTDOWN', 'Pool shutting down')));
    const cfg = loadConfig();
    if (!cfg || (!cfg.enabled && !endpointId)) return Promise.reject(safeError(new LLMError('POOL_DISABLED', 'Pool disabled')));
    const task = options.task || 'general';
    if (!TASKS.includes(task)) return Promise.reject(safeError(new LLMError('NO_ENDPOINT', 'Unsupported task')));
    if (options.signal?.aborted) return Promise.reject(safeError(new LLMError('CANCELLED', 'Request cancelled')));
    return new Promise((resolve, reject) => {
      const started = now();
      const timeout = Number.isFinite(options.timeoutMs) ? Math.min(cfg.request_timeout_ms, Math.max(1, options.timeoutMs)) : cfg.request_timeout_ms;
      const record = { prompt, options: { ...options, probe: !!endpointId }, task, endpointId, resolve, reject, traceId: crypto.randomUUID(), started, deadline: started + timeout,
        tried: new Set(), attempts: 0, maxAttempts: endpointId ? 1 : cfg.max_attempts, signal: options.signal, controller: new AbortController(), done: false, inFlight: false };
      records.add(record);
      record.onAbort = () => {
        record.controller.abort();
        finish(record, new LLMError('CANCELLED', 'Request cancelled'));
      };
      options.signal?.addEventListener('abort', record.onAbort, { once: true });
      record.deadlineTimer = setTimeout(() => {
        record.expired = true;
        record.controller.abort();
        finish(record, new LLMError('TIMEOUT', 'Request deadline exceeded'));
      }, timeout);
      enqueue(record);
    });
  }

  function getPoolConfig({ masked = true } = {}) {
    const cfg = loadConfig();
    return masked ? maskConfig(cfg) : cfg ? structuredClone(cfg) : null;
  }

  function savePoolConfig(input) {
    const validated = validatePoolConfig(input, loadConfig());
    // 案2 fix-morning-1022: redact BEFORE the write point (also covers pool
    // services constructed with injected setValue stubs) and keep the runtime
    // working off the redacted form — requests resolve ${ENV_REF} keys in
    // llm-transport, so nothing downstream needs the plaintext again.
    const { value: next } = redactForStorage(validated);
    setValue(CONFIG_KEY, next);
    for (const endpoint of next.endpoints) {
      const previous = config?.endpoints.find(row => row.id === endpoint.id);
      if (previous && ['endpoint_url', 'api_key', 'model', 'protocol'].some(key => previous[key] !== endpoint[key])) {
        const state = stateFor(endpoint.id);
        state.failures = 0;
        state.cooldown = 0;
        state.last_error_code = null;
        state.last_success_at = null;
        state.last_failure_at = null;
        state.last_latency_ms = null;
      }
    }
    config = next;
    loadedAt = now();
    pump();
    return maskConfig(next);
  }

  function parsePastedPoolConfig(pasted, { masked = true } = {}) {
    const parsed = parsePoolText(pasted);
    return masked ? maskConfig(parsed) : parsed;
  }

  function getPoolStatus() {
    const cfg = loadConfig();
    const runtime = { scope: 'process', enabled: !!cfg?.enabled, active, queued: queue.length,
      global_concurrency: cfg?.global_concurrency || 0, queue_limit: cfg?.queue_limit || 0,
      endpoints: (cfg?.endpoints || []).map(endpoint => {
        const state = stateFor(endpoint.id);
        return { id: endpoint.id, active: state.active,
          queued: queue.filter(record => !record.tried.has(endpoint.id) && (record.endpointId ? record.endpointId === endpoint.id : endpoint.tasks.includes(record.task))).length,
          state: !endpoint.enabled ? 'disabled' : state.cooldown > now() ? 'open' : state.failures >= 2 ? 'half-open' : 'ready',
          cooldown_until: state.cooldown > now() ? new Date(state.cooldown).toISOString() : null,
          last_success_at: state.last_success_at, last_failure_at: state.last_failure_at, last_error_code: state.last_error_code, last_latency_ms: state.last_latency_ms };
      }) };
    let metrics = { scope: 'persisted', available: false, total: 0, completed: 0, failed: 0, cancelled: 0, by_endpoint: [] };
    try {
      const rows = getDB()?.prepare(`SELECT endpoint_id, COUNT(*) AS total,
        SUM(status = 'completed') AS completed, SUM(status = 'failed') AS failed, SUM(status = 'cancelled') AS cancelled,
        ROUND(AVG(elapsed_ms)) AS avg_latency_ms, MAX(created_at) AS last_event_at
        FROM llm_request_events GROUP BY endpoint_id`).all();
      if (rows) {
        metrics = { ...metrics, available: true, by_endpoint: rows,
          ...Object.fromEntries(['total', 'completed', 'failed', 'cancelled'].map(key => [key, rows.reduce((sum, row) => sum + row[key], 0)])) };
      }
    } catch { /* Telemetry availability is reported separately from request health. */ }
    return { runtime, metrics };
  }

  function getLlmFailureBreakdown({ days = 7 } = {}) {
    const windowDays = Math.min(Math.max(Math.floor(Number(days) || 7), 1), 90);
    const empty = { scope: 'persisted', available: false, days: windowDays, by_class: [], by_code: [], by_task: [], recent: [] };
    try {
      const db = getDB();
      if (!db) return empty;
      const since = new Date(now() - windowDays * 86400000).toISOString().slice(0, 19).replace('T', ' ');
      return { scope: 'persisted', available: true, days: windowDays,
        by_class: db.prepare(`SELECT COALESCE(error_class, 'UNCATEGORIZED') AS error_class, COUNT(*) AS count FROM llm_request_events WHERE status = 'failed' AND created_at >= ? GROUP BY error_class ORDER BY count DESC, error_class`).all(since),
        by_code: db.prepare(`SELECT error_code, COUNT(*) AS count FROM llm_request_events WHERE status = 'failed' AND created_at >= ? GROUP BY error_code ORDER BY count DESC, error_code`).all(since),
        by_task: db.prepare(`SELECT task, COUNT(*) AS count FROM llm_request_events WHERE status = 'failed' AND created_at >= ? GROUP BY task ORDER BY count DESC, task`).all(since),
        recent: db.prepare(`SELECT trace_id, attempt, endpoint_id, task, error_code, error_class, retry_after_ms, elapsed_ms, created_at FROM llm_request_events WHERE status = 'failed' AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 20`).all(since) };
    } catch { return empty; }
  }

  function getPoolProvider(task = 'general') {
    if (!loadConfig()?.enabled) return null;
    return { name: 'pool', model: 'routed', isPool: true,
      callWithMetadata: (prompt, options = {}) => request(prompt, { task, ...options }),
      async call(prompt, options = {}) { return (await request(prompt, { task, ...options })).text; } };
  }

  async function testPoolEndpoint(endpointId) {
    if (!loadConfig()?.endpoints.some(endpoint => endpoint.id === endpointId && endpoint.enabled)) throw new Error('Unknown or disabled endpoint');
    try {
      const result = await request('Hi', { task: 'general', temperature: 0, maxTokens: 1, probe: true }, endpointId);
      return { ok: true, reachable: true, validated: false, endpoint_id: endpointId, model: result.metadata.model, latency_ms: result.metadata.latency_ms };
    } catch (error) {
      return { ok: false, reachable: false, validated: false, endpoint_id: endpointId, error_code: safeCode(error), message: `Endpoint test failed (${safeCode(error)})` };
    }
  }

  async function shutdownPool() {
    shuttingDown = true;
    clearTimeout(wakeTimer);
    const pendingAttempts = [...inFlight].map(record => record.attemptPromise);
    for (const record of [...records]) {
      record.controller.abort();
      finish(record, new LLMError('CANCELLED', 'Pool shutting down'));
    }
    await Promise.allSettled(pendingAttempts);
  }

  return { getPoolConfig, savePoolConfig, parsePastedPoolConfig, getPoolStatus, getPoolProvider, getLlmFailureBreakdown, testPoolEndpoint, shutdownPool };
}

const singleton = createPoolService();
module.exports = { ...singleton, createPoolService };
