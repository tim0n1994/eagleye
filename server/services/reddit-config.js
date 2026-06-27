/**
 * Eagleye — Reddit Subreddit Config
 *
 * Reads a newline/comma-separated list of subreddits to crawl. Modeled on
 * x-following-config.js so adding/removing a subreddit is a one-line config
 * edit, no code change.
 *
 * Config (priority order):
 *  REDDIT_SUBREDDITS env var (comma-separated)
 *  REDDIT_CONFIG_PATH override → config/reddit-subreddits.txt → ~/.eagleye/reddit-subreddits.txt
 */

const fs = require('fs');
const path = require('path');

const REPO_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'reddit-subreddits.txt');
const HOME_CONFIG_PATH = path.join(process.env.HOME || '/root', '.eagleye', 'reddit-subreddits.txt');

const DEFAULT_SUBREDDITS = [
  'LocalLLaMA',
  'MachineLearning',
  'singularity',
  'artificial',
];

/** Normalize a subreddit name: strip r/ prefix, whitespace, commas. */
function cleanSubreddit(value) {
  if (!value) return '';
  return String(value)
    .trim()
    .replace(/^r\//i, '')
    .split(/[/?#\s,]/)[0]
    .replace(/[^A-Za-z0-9_]/g, '');
}

function dedupeSubreddits(items) {
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const name = cleanSubreddit(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Drop comment lines (starting with #) and blank lines from raw config text. */
function stripComments(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(line => line.trim() && !line.trim().startsWith('#'))
    .join('\n');
}

function getConfigPathCandidates() {
  return [
    process.env.REDDIT_CONFIG_PATH,
    REPO_CONFIG_PATH,
    HOME_CONFIG_PATH,
  ].filter(Boolean);
}

function getWritableConfigPath() {
  return process.env.REDDIT_CONFIG_PATH || REPO_CONFIG_PATH;
}

function readRedditConfig() {
  // Env override takes precedence
  const envList = (process.env.REDDIT_SUBREDDITS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (envList.length > 0) {
    return { subreddits: dedupeSubreddits(envList), path: 'env', exists: true, source: 'env' };
  }

  for (const configPath of getConfigPathCandidates()) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const text = fs.readFileSync(configPath, 'utf8');
      return {
        subreddits: dedupeSubreddits(stripComments(text).split(/[\n,]/)),
        path: configPath,
        exists: true,
        source: configPath === REPO_CONFIG_PATH ? 'repo' : 'home',
      };
    } catch (err) {
      return { subreddits: [], path: configPath, exists: false, error: err.message };
    }
  }
  return { subreddits: DEFAULT_SUBREDDITS, path: getWritableConfigPath(), exists: false, source: 'default' };
}

module.exports = {
  REPO_CONFIG_PATH,
  HOME_CONFIG_PATH,
  DEFAULT_SUBREDDITS,
  cleanSubreddit,
  dedupeSubreddits,
  stripComments,
  readRedditConfig,
};
