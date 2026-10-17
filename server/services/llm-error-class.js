/**
 * R0-04: single source of truth mapping transport/pool error codes to the
 * business classes persisted in llm_request_events.error_class and shared
 * with the task-layer retry policy, so failures trace across layers without
 * a translation table.
 */

const CLASSES = {
  AUTH_CONFIG_ERROR: 'AUTH_CONFIG_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  TEMPORARY_ERROR: 'TEMPORARY_ERROR',
  OUTPUT_INVALID: 'OUTPUT_INVALID',
  CANCELLED: 'CANCELLED',
  DEADLINE_EXCEEDED: 'DEADLINE_EXCEEDED',
};

const CLASS_BY_CODE = {
  AUTH_ERROR: CLASSES.AUTH_CONFIG_ERROR,
  CONFIG_ERROR: CLASSES.AUTH_CONFIG_ERROR,
  NO_ENDPOINT: CLASSES.AUTH_CONFIG_ERROR,
  RATE_LIMIT: CLASSES.RATE_LIMITED,
  HTTP_ERROR: CLASSES.TEMPORARY_ERROR,
  NETWORK_ERROR: CLASSES.TEMPORARY_ERROR,
  TIMEOUT: CLASSES.DEADLINE_EXCEEDED,
  QUEUE_TIMEOUT: CLASSES.DEADLINE_EXCEEDED,
  QUEUE_FULL: CLASSES.TEMPORARY_ERROR,
  POOL_DISABLED: CLASSES.TEMPORARY_ERROR,
  SHUTDOWN: CLASSES.CANCELLED,
  CANCELLED: CLASSES.CANCELLED,
  EMPTY_RESPONSE: CLASSES.OUTPUT_INVALID,
  INVALID_RESPONSE: CLASSES.OUTPUT_INVALID,
  TRUNCATED: CLASSES.OUTPUT_INVALID,
  INVALID_JSON: CLASSES.OUTPUT_INVALID,
  VALIDATION_ERROR: CLASSES.OUTPUT_INVALID,
  REQUEST_FAILED: CLASSES.TEMPORARY_ERROR,
};

function classifyCode(code) {
  return CLASS_BY_CODE[code] || CLASSES.TEMPORARY_ERROR;
}

// T14: credentials/config are deterministic — auto-retry only burns shared
// quota; bounded cross-group failover is handled by the pool instead.
const RETRYABLE_CLASSES = new Set([CLASSES.RATE_LIMITED, CLASSES.TEMPORARY_ERROR]);

// Legacy provider path: stage loops must not backoff-and-repeat these.
const TERMINAL_CODES = new Set(['AUTH_ERROR', 'CONFIG_ERROR', 'CANCELLED', 'NO_ENDPOINT']);

function isTerminalLLMError(error) {
  return TERMINAL_CODES.has(error?.code) || error?.name === 'AbortError';
}

module.exports = { CLASSES, CLASS_BY_CODE, classifyCode, RETRYABLE_CLASSES, TERMINAL_CODES, isTerminalLLMError };
