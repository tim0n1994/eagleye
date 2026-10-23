/**
 * Eagleye — Write-time Secret Redaction (案2 fix-morning-1022)
 *
 * Contract (2026-10-22 morning fix, case 2): no plaintext
 * api_key/authorization/LLM_API_KEY value may ever reach a persistence
 * layer (user_data.value or any other column), in either form:
 *   ① structured — an object field named api_key / authorization / …;
 *   ② embedded   — a JSON string (e.g. stringified headers) that itself
 *                  contains such fields.
 *
 * Fail-closed (分工④): a field that cannot be processed (throwing getter,
 * unsupported shape) is dropped or replaced with <redacted> — it is never
 * persisted as plaintext, and an unprocessable whole value aborts the
 * write rather than falling back to the raw value.
 *
 * Round-trip: when a secret matches an environment variable value, the
 * stored form becomes the reference `${NAME}` (LLM_API_KEY preferred),
 * resolved back at request time by resolveSecret() in llm-transport — so
 * the running pool keeps authenticating without ever storing the key.
 * Secrets with no matching env var are stored as <redacted>; using them
 * then surfaces an honest upstream AUTH_ERROR instead of a leak.
 */

'use strict';

const REDACTED = '<redacted>';
const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const MASKED = /^[•*]{3,}$/;
const MAX_DEPTH = 12;
// Credential-bearing field names after normalisation (case-insensitive,
// '-' and whitespace folded to '_'). Header-style spellings such as
// "x-api-key" or "LLM_API_KEY" land on these canonical names.
const SENSITIVE_FIELDS = new Set(['api_key', 'apikey', 'authorization', 'llm_api_key', 'x_api_key', 'x_goog_api_key']);
const PREFERRED_ENV_NAMES = ['LLM_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

function normaliseField(name) {
  return String(name).toLowerCase().replace(/[-\s]/g, '_');
}

function isSensitiveField(name) {
  return SENSITIVE_FIELDS.has(normaliseField(name));
}

/** Already-safe stored forms: <redacted> (any case), •••• / **** masks, ${ENV_REF}. */
function isRedactionForm(value) {
  return typeof value === 'string' && value.length > 0
    && (/redacted/i.test(value) || MASKED.test(value) || ENV_REF.test(value));
}

/** ${NAME} → process.env.NAME; anything else is returned unchanged (legacy plaintext rows keep working). */
function resolveSecret(value) {
  if (typeof value !== 'string') return value;
  const match = value.match(ENV_REF);
  if (!match) return value;
  const resolved = process.env[match[1]];
  return typeof resolved === 'string' && resolved ? resolved : value;
}

function envRefFor(secret) {
  if (typeof secret !== 'string' || !secret) return null;
  for (const name of PREFERRED_ENV_NAMES) {
    if (process.env[name] === secret) return `\${${name}}`;
  }
  for (const name of Object.keys(process.env).sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (process.env[name] === secret) return `\${${name}}`;
  }
  return null;
}

function redactSecret(value) {
  if (typeof value !== 'string' || !value) return value; // nothing to leak
  if (isRedactionForm(value)) return value;              // idempotent re-save
  return envRefFor(value) || REDACTED;
}

/**
 * Redact a string that itself embeds JSON (e.g. headers stored via
 * JSON.stringify). Non-JSON strings are returned untouched.
 * @returns {{ value: string, changed: boolean }}
 */
function redactEmbeddedJSON(text) {
  const trimmed = text.trim();
  if (trimmed.charAt(0) !== '{' && trimmed.charAt(0) !== '[') return { value: text, changed: false };
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return { value: text, changed: false }; }
  if (!parsed || typeof parsed !== 'object') return { value: text, changed: false };
  const walked = redactNode(parsed, 0);
  if (!walked.changed) return { value: text, changed: false };
  return { value: JSON.stringify(walked.result), changed: true };
}

/**
 * Deep, fail-closed redaction walk.
 * @returns {{ result: unknown, changed: boolean }} — when changed is false the
 * ORIGINAL node is returned so untouched values serialise byte-identically to
 * the legacy path (exotic shapes like Dates are only rebuilt when something
 * inside them actually changed).
 */
function redactNode(node, depth) {
  if (node === null || node === undefined) return { result: node, changed: false };
  if (typeof node === 'string') {
    const embedded = redactEmbeddedJSON(node);
    return { result: embedded.value, changed: embedded.changed };
  }
  if (typeof node !== 'object') return { result: node, changed: false };
  if (depth > MAX_DEPTH) return { result: REDACTED, changed: true }; // unbounded nesting — refuse plaintext
  if (Array.isArray(node)) {
    let changed = false;
    const out = [];
    for (let index = 0; index < node.length; index++) {
      let walked;
      try { walked = redactNode(node[index], depth + 1); }
      catch { walked = { result: REDACTED, changed: true }; } // hostile element — fail closed
      if (walked.changed) changed = true;
      out.push(walked.result);
    }
    return changed ? { result: out, changed: true } : { result: node, changed: false };
  }
  let names;
  try { names = Object.keys(node); } catch { return { result: REDACTED, changed: true }; }
  let changed = false;
  const out = {};
  for (const name of names) {
    let current;
    try { current = node[name]; } catch { changed = true; continue; } // hostile getter → drop the field (④), keep the write
    if (isSensitiveField(name)) {
      if (current === null || current === undefined) { out[name] = current; continue; } // absent — keep shape
      if (typeof current === 'string') {
        const safe = redactSecret(current);
        if (safe !== current) changed = true;
        out[name] = safe;
      } else {
        out[name] = REDACTED; // credential-named but not a plain string — refuse to store it
        changed = true;
      }
      continue;
    }
    let walked;
    try { walked = redactNode(current, depth + 1); }
    catch { changed = true; continue; } // unprocessable value → drop the field, never plaintext
    if (walked.changed) changed = true;
    out[name] = walked.result;
  }
  return changed ? { result: out, changed: true } : { result: node, changed: false };
}

/**
 * Entry point for every persistence path. Accepts objects, arrays and
 * pre-stringified JSON strings (e.g. runtime-switches stores a stringified
 * blob); the returned value is safe to JSON.stringify into storage.
 * @returns {{ value: unknown, changed: boolean }}
 */
function redactForStorage(value) {
  if (typeof value === 'string') return redactEmbeddedJSON(value);
  if (value === null || typeof value !== 'object') return { value, changed: false };
  const walked = redactNode(value, 0);
  return { value: walked.result, changed: walked.changed };
}

module.exports = { REDACTED, redactForStorage, redactSecret, resolveSecret, isRedactionForm, isSensitiveField };
