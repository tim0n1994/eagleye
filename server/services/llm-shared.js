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

async function _llmBackoff(attempt, errMsg) {
  // 529 模型过载：需要长退避（10s/20s/30s），让它恢复容量
  const base = _isOverloadError(errMsg) ? 10000 : 2000;
  const ms = Math.min(30000, base * attempt);
  await new Promise(r => setTimeout(r, ms));
  return ms;
}

module.exports = { generateId, getPromptVersion, _llmBackoff, _isOverloadError };
