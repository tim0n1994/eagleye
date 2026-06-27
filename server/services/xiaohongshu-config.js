/**
 * Eagleye — XiaoHongShu Search Keyword Config
 *
 * Reads a newline/comma-separated list of search keywords to crawl XiaoHongShu
 * for. Modeled on x-following-config.js.
 *
 * Config (priority order):
 *  XIAOHONGSHU_KEYWORDS env var (comma-separated)
 *  XIAOHONGSHU_CONFIG_PATH override → config/xiaohongshu-keywords.txt → ~/.eagleye/xiaohongshu-keywords.txt
 */

const fs = require('fs');
const path = require('path');

const REPO_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'xiaohongshu-keywords.txt');
const HOME_CONFIG_PATH = path.join(process.env.HOME || '/root', '.eagleye', 'xiaohongshu-keywords.txt');

const DEFAULT_KEYWORDS = [
  'AI',
  '大模型',
  'AI Agent',
  '具身智能',
];

function cleanKeyword(value) {
  if (!value) return '';
  return String(value).trim().replace(/[\n,]/g, '').trim();
}

/** Drop comment lines (starting with #) and blank lines from raw config text. */
function stripComments(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(line => line.trim() && !line.trim().startsWith('#'))
    .join('\n');
}

function dedupeKeywords(items) {
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const kw = cleanKeyword(raw);
    if (!kw) continue;
    const key = kw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
  }
  return out;
}

function getConfigPathCandidates() {
  return [
    process.env.XIAOHONGSHU_CONFIG_PATH,
    REPO_CONFIG_PATH,
    HOME_CONFIG_PATH,
  ].filter(Boolean);
}

function getWritableConfigPath() {
  return process.env.XIAOHONGSHU_CONFIG_PATH || REPO_CONFIG_PATH;
}

function readXiaohongshuConfig() {
  const envList = (process.env.XIAOHONGSHU_KEYWORDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (envList.length > 0) {
    return { keywords: dedupeKeywords(envList), path: 'env', exists: true, source: 'env' };
  }

  for (const configPath of getConfigPathCandidates()) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const text = fs.readFileSync(configPath, 'utf8');
      return {
        keywords: dedupeKeywords(stripComments(text).split(/[\n,]/)),
        path: configPath,
        exists: true,
        source: configPath === REPO_CONFIG_PATH ? 'repo' : 'home',
      };
    } catch (err) {
      return { keywords: [], path: configPath, exists: false, error: err.message };
    }
  }
  return { keywords: DEFAULT_KEYWORDS, path: getWritableConfigPath(), exists: false, source: 'default' };
}

module.exports = {
  REPO_CONFIG_PATH,
  HOME_CONFIG_PATH,
  DEFAULT_KEYWORDS,
  cleanKeyword,
  dedupeKeywords,
  stripComments,
  readXiaohongshuConfig,
};
