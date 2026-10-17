/**
 * Eagleye — LLM helpers shared by the enrichment and digest passes.
 */

const crypto = require('crypto');

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
  taskContext, abortableDelay };
