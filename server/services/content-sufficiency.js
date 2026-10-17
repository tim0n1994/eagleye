/**
 * Eagleye — content sufficiency contract (Iteration Plan v1.0 §R0-03).
 *
 * Trust boundary: a title or a login page must never yield strong unsupported
 * conclusions. Safety floor, independent of any switch: TITLE_ONLY items never
 * reach long-form LLM paths (llm.js routes them to the deterministic
 * title-only card). The sufficiency_gate switch retracts the NEW thresholds
 * (LOGIN_WALL / UNREADABLE skip, digest exclusion) but a missing or corrupted
 * switch config must keep the gate ON. No unified word-count threshold: the
 * only length bound is a page-shape heuristic for login-wall / anti-bot pages.
 */

const { getSwitches } = require('./runtime-switches');

const CONTENT_STATES = [
  'TITLE_ONLY', 'ABSTRACT_ONLY', 'PARTIAL', 'FULL',
  'LOGIN_WALL', 'UNREADABLE', 'UNKNOWN',
];

const BLOCKING_STATES = ['TITLE_ONLY', 'LOGIN_WALL', 'UNREADABLE'];

// Login prompts and anti-bot interstitials are short pages; fetch-artefact
// shape bound, not a sufficiency word count.
const WALL_BODY_MAX_CHARS = 240;

const LOGIN_WALL_RE = new RegExp(
  [
    '\\b(?:log\\s?in|sign\\s?in|sign\\s?up|register)\\b[^.!?,;]{0,48}\\b(?:to|or|before|required)\\b',
    'create\\s+an?\\s+account\\s+to',
    'continue\\s+reading\\s+(?:with|requires?)',
    'subscribe\\s+to\\s+(?:read|continue|unlock)',
    '请(?:先)?登录',
    '登录后(?:查看|阅读|可见)',
    '需要登录',
    '开通会员',
  ].join('|'),
  'i',
);

const UNREADABLE_RE = /just a moment|checking your browser|verify you are (?:a )?human|are you a robot|attention required|access denied|enable javascript|enable cookies|请开启 ?javascript|安全验证|无法访问|页面不存在/i;

const TRUNCATION_TAIL_RE = /(…|\.{3}|\[(?:truncated|cut off)\]|read more|continue reading|show more|阅读全文|阅读更多|展开全文|查看全文|点击查看)\s*$/i;

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rawPresent(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function usableCandidate(value, title) {
  const cleaned = cleanText(value);
  return cleaned.length > 0 && cleaned !== title ? cleaned : '';
}

function isWallShaped(cleaned) {
  return cleaned.length <= WALL_BODY_MAX_CHARS && LOGIN_WALL_RE.test(cleaned);
}

function isUnreadableShaped(cleaned) {
  return cleaned.length <= WALL_BODY_MAX_CHARS && UNREADABLE_RE.test(cleaned);
}

function payloadFlagsTruncated(item) {
  let payload = item.source_payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return false; }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  return payload.truncated === true || payload.content_truncated === true;
}

function hasTruncationEvidence(item, body) {
  if (payloadFlagsTruncated(item)) return true;
  return TRUNCATION_TAIL_RE.test(body);
}

/** Never throws: malformed items degrade to UNKNOWN (which does not block). */
function classifyContentState(item) {
  if (!item || typeof item !== 'object') return 'UNKNOWN';
  try {
    const title = cleanText(item.title);
    const contentUsable = usableCandidate(item.content_text, title);
    const abstractUsable = usableCandidate(item.original_summary, title);

    const hasMarkupOnlyJunk = (rawPresent(item.content_text) && !cleanText(item.content_text))
      || (rawPresent(item.original_summary) && !cleanText(item.original_summary));

    if (!contentUsable && !abstractUsable) {
      if (hasMarkupOnlyJunk) return 'UNREADABLE';
      return title ? 'TITLE_ONLY' : 'UNKNOWN';
    }

    if (contentUsable && isWallShaped(contentUsable)) return 'LOGIN_WALL';
    if (abstractUsable && !contentUsable && isWallShaped(abstractUsable)) return 'LOGIN_WALL';
    if (contentUsable && isUnreadableShaped(contentUsable)) return 'UNREADABLE';
    if (abstractUsable && !contentUsable && isUnreadableShaped(abstractUsable)) return 'UNREADABLE';

    if (!contentUsable) return 'ABSTRACT_ONLY';
    return hasTruncationEvidence(item, contentUsable) ? 'PARTIAL' : 'FULL';
  } catch {
    return 'UNKNOWN';
  }
}

/** True exactly for the three states that must not produce strong conclusions. */
function shouldBlockDeepEnrich(item) {
  return BLOCKING_STATES.includes(classifyContentState(item));
}

/** Fail-open: a missing or corrupted switch config keeps the gate ON. */
function isSufficiencyGateEnabled() {
  try {
    return getSwitches().sufficiency_gate !== false;
  } catch {
    return true;
  }
}

/** Switch-aware enrichment guard for llm.js: reason string, or null to proceed.
 *  TITLE_ONLY is intentionally not returned here — the title-only floor is
 *  enforced earlier by the no-evidence path, independent of the switch. */
function deepEnrichSkipReason(item, gateEnabled = isSufficiencyGateEnabled()) {
  if (!gateEnabled) return null;
  const state = classifyContentState(item);
  if (state === 'LOGIN_WALL' || state === 'UNREADABLE') return 'content_state=' + state;
  return null;
}

/** Switch-aware digest guard: gate ON excludes all three blocking states. */
function isDigestInclusionBlocked(item, gateEnabled = isSufficiencyGateEnabled()) {
  return gateEnabled && shouldBlockDeepEnrich(item);
}

module.exports = {
  CONTENT_STATES,
  BLOCKING_STATES,
  classifyContentState,
  shouldBlockDeepEnrich,
  isSufficiencyGateEnabled,
  deepEnrichSkipReason,
  isDigestInclusionBlocked,
};
