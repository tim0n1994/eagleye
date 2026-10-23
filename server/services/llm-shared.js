/**
 * Eagleye — LLM helpers shared by the enrichment and digest passes.
 */

const crypto = require('crypto');
const { classifyCode } = require('./llm-error-class');

function _isOverloadError(msg) {
  return /529|overloaded|1305|访问量过大|稍后再试/i.test(String(msg || ''));
}

function generateId() {
  return crypto.randomUUID();
}

function getPromptVersion() {
  return 'v3.1-knowledge-card-graph-zh';
}

async function _llmBackoff(attempt, errMsg, signal) {
  // 529 模型过载：需要长退避（10s/20s/30s），让它恢复容量
  const base = _isOverloadError(errMsg) ? 10000 : 2000;
  const ms = Math.min(30000, base * attempt);
  await abortableDelay(ms, signal);
  return ms;
}

function parseJSONOutput(text) {
  const clean = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validCard(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (!nonEmpty(data.title_zh || data.ai_title_zh) || !nonEmpty(data.one_liner_zh) || !nonEmpty(data.short_summary_zh)) return false;
  for (const field of ['key_points', 'key_points_zh', 'suggested_tags', 'tags', 'topic_slugs']) {
    if (data[field] !== undefined && (!Array.isArray(data[field]) || !data[field].every(nonEmpty))) return false;
  }
  if (data.entities !== undefined && (!Array.isArray(data.entities) || !data.entities.every(e => e && nonEmpty(e.name) && nonEmpty(e.type)))) return false;
  return data.confidence === undefined || (typeof data.confidence === 'number' && Number.isFinite(data.confidence) && data.confidence >= 0 && data.confidence <= 1);
}

function validateBatch(data, allowedIds, validateRow) {
  if (!Array.isArray(data) || !data.length) return false;
  const seen = new Set();
  for (const row of data) {
    if (!row || !allowedIds.has(row.id) || seen.has(row.id)) return false;
    seen.add(row.id);
  }
  return data.some(validateRow);
}

function llmErrorCode(error) {
  if (error?.code && error.code !== 'REQUEST_FAILED') return error.code;
  const message = String(error?.message || '');
  if (/LLM_EMPTY_OUTPUT|empty response|empty output/i.test(message)) return 'EMPTY_RESPONSE';
  if (/TRUNCATED|max_tokens|reached its token limit/i.test(message)) return 'TRUNCATED';
  if (/LLM_INVALID_OUTPUT|did not pass validation/i.test(message)) return 'VALIDATION_ERROR';
  if (/JSON/i.test(message)) return 'INVALID_JSON';
  return 'REQUEST_FAILED';
}

function llmErrorClass(error) {
  return classifyCode(llmErrorCode(error));
}

function isOutputRepairable(error) {
  return ['EMPTY_RESPONSE', 'INVALID_RESPONSE', 'TRUNCATED', 'INVALID_JSON', 'VALIDATION_ERROR']
    .includes(llmErrorCode(error));
}

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(text.length / 4);
}

const ITEM_STATE = {
  SUCCESS: 'success',
  EXPLICIT_FAILED: 'explicit_failed',
  DEFERRED: 'deferred',
};

const ITEM_REASON = {
  SUCCEEDED: 'succeeded',
  TITLE_ONLY: 'title_only',
  GATE_SKIPPED: 'gate_skipped',
  UNCOVERED_IN_RESPONSE: 'uncovered_in_response',
  REPAIR_DEFERRED: 'repair_deferred',
  REPAIR_EXHAUSTED: 'repair_exhausted',
  TRANSPORT_DEFERRED: 'transport_deferred',
  CONTENT_FILTERED: 'content_filtered',
  TERMINAL_ERROR: 'terminal_error',
  PERSIST_FAILED: 'persist_failed',
  NO_PROVIDER: 'no_provider',
};

function repairCallBudget(itemCount) {
  const count = Math.max(1, itemCount);
  return Math.max(4, Math.min(2 * count - 1, count + 2));
}

function createCoverage(inputIds) {
  return { order: [...inputIds], states: new Map(), reasons: new Map() };
}

function markItem(coverage, id, state, reason, force = false) {
  if (force || !coverage.states.has(id) || coverage.states.get(id) !== ITEM_STATE.SUCCESS) {
    coverage.states.set(id, state);
    coverage.reasons.set(id, reason);
  }
}

function finalizeCoverage(coverage, label) {
  for (const id of coverage.order) {
    if (!coverage.states.has(id)) {
      throw new Error('LLM_COVERAGE_BROKEN(' + label + '): input item ' + id + ' left without a final state');
    }
  }
  const counts = { total: coverage.order.length, success: 0, explicit_failed: 0, deferred: 0 };
  const itemStates = {};
  const itemReasons = {};
  for (const id of coverage.order) {
    const state = coverage.states.get(id);
    if (!Object.values(ITEM_STATE).includes(state)) {
      throw new Error('LLM_COVERAGE_BROKEN(' + label + '): input item ' + id + ' has invalid state ' + state);
    }
    counts[state]++;
    itemStates[id] = state;
    itemReasons[id] = coverage.reasons.get(id) || null;
  }
  return { ...counts, item_states: itemStates, item_reasons: itemReasons };
}

function mergeFinalCoverage(target, finalized) {
  for (const [id, state] of Object.entries(finalized.item_states)) {
    markItem(target, id, state, finalized.item_reasons[id] || ITEM_REASON.TERMINAL_ERROR);
  }
}

function taskAttempt(attempt, batch, maxTokens, error = null, elapsedMs = 0, metadata = null, kind = 'initial') {
  return {
    kind,
    attempt,
    batch_size: Array.isArray(batch) ? batch.length : 0,
    max_tokens: maxTokens,
    elapsed_ms: Math.max(0, Math.round(elapsedMs)),
    error_code: error ? llmErrorCode(error) : null,
    error_class: error ? llmErrorClass(error) : null,
    ...(metadata ? { pool_attempts: metadata.attempts ?? null, latency_ms: metadata.latency_ms ?? null } : {}),
  };
}

// Task stats describe logical business calls only. A pool may retry internally;
// report that opaque retry count only when provider metadata supplies it. Token
// usage and billing authority remain the llm_request_events records.
function withTaskStats(rows, stats, coverage = null) {
  if (!Array.isArray(rows)) return rows;
  const finalCoverage = coverage ? finalizeCoverage(coverage, 'task-stats') : null;
  rows.task_stats = {
    attempts: stats,
    attempt_count: stats.length,
    transport_retry_calls: stats.filter(row => row.kind === 'transport_retry').length,
    output_repair_calls: stats.filter(row => row.kind === 'output_repair').length,
    final_status: finalCoverage
      ? (finalCoverage.success === finalCoverage.total
        ? 'succeeded'
        : finalCoverage.success === 0 ? 'degraded' : 'partial')
      : (stats.at(-1)?.error_code ? 'degraded' : 'succeeded'),
    final_error_code: stats.at(-1)?.error_code || null,
    final_error_class: stats.at(-1)?.error_class || null,
    total_elapsed_ms: stats.reduce((sum, row) => sum + row.elapsed_ms, 0),
    ...(finalCoverage ? {
      coverage: {
        total: finalCoverage.total,
        success: finalCoverage.success,
        explicit_failed: finalCoverage.explicit_failed,
        deferred: finalCoverage.deferred,
      },
      item_states: finalCoverage.item_states,
      item_reasons: finalCoverage.item_reasons,
    } : {}),
  };
  return rows;
}

async function callWithMetadata(provider, prompt, options = {}) {
  throwIfAborted(options.signal);
  const result = typeof provider.callWithMetadata === 'function'
    ? await provider.callWithMetadata(prompt, options)
    : { text: await provider.call(prompt, options) };
  throwIfAborted(options.signal);
  if (!nonEmpty(result?.text)) throw new Error('LLM_EMPTY_OUTPUT');
  const data = options.json ? parseJSONOutput(result.text) : result.text;
  if (options.validate && options.validate(data) === false) throw new Error('LLM_INVALID_OUTPUT');
  const fallback = {
    provider: provider.name || provider.provider || 'unknown',
    endpoint_id: null, protocol: provider.protocol || provider.name || 'unknown',
    requested_model: provider.model || 'unknown', model: provider.model || 'unknown',
    latency_ms: null, usage: null, attempts: 1, trace_id: null,
  };
  return { text: result.text, data, metadata: { ...fallback, ...result.metadata } };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('LLM task cancelled');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

function taskContext(options = {}, jobs = null) {
  const signal = options.signal || jobs?.getJobSignal?.(options.jobId);
  const isCancelled = () => !!(signal?.aborted || (jobs && jobs.isJobCancelled(options.jobId)));
  return { ...options, signal, isCancelled, check: () => {
    if (isCancelled()) throwIfAborted({ aborted: true });
  } };
}

function abortableDelay(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      try { throwIfAborted(signal); } catch (error) { reject(error); }
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

const VALID_SUMMARY_SQL = `LENGTH(TRIM(COALESCE(short_summary, '') || COALESCE(short_summary_zh, '') ||
  COALESCE(one_liner, '') || COALESCE(one_liner_zh, '') || COALESCE(deep_summary, ''), char(9) || char(10) || char(13) || ' ')) > 0`;

module.exports = { generateId, getPromptVersion, _llmBackoff, _isOverloadError,
  callWithMetadata, parseJSONOutput, nonEmpty, validCard, validateBatch, VALID_SUMMARY_SQL,
  taskContext, abortableDelay, llmErrorCode, llmErrorClass, isOutputRepairable,
  estimateTokens, taskAttempt, withTaskStats, ITEM_STATE, ITEM_REASON,
  repairCallBudget, createCoverage, markItem, finalizeCoverage, mergeFinalCoverage };
