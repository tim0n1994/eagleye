/**
 * Eagleye — Physical AI Open Source (GitHub) Connector
 *
 * Discovers embodied-AI / robotics open-source repositories created within
 * the last 180 days, via the GitHub repository search API. The API works
 * without credentials — a plain User-Agent over standard HTTPS is enough, so
 * the connector adds no key dependency.
 *
 * Contract:
 *   - Exactly ONE HTTPS request per fetch round: the search API caps
 *     per_page at 100 and the query is sorted by stars, so a single page is
 *     the whole request budget.
 *   - Query window is "created:>= <digest date - 180 days>" (UTC-anchored on
 *     the requested digest date, now when absent) with a stars floor, so only
 *     recently-created projects with some traction surface.
 *   - digest_date is the COLLECTION-day snapshot (the date fetch() received,
 *     local-today fallback) — never the repo's own creation day; published_at
 *     and payload.created_at stay the real created_at returned by GitHub.
 *   - Text matching is intentionally broad ("robot" also hits chat/RPA
 *     naming), so a local allow/deny pass keeps repos with actual
 *     robot/embodied semantics and drops chatbots, RPA/test-automation
 *     frameworks (e.g. Robot Framework) and marketing aggregators.
 *   - Only public, non-archived repos with an EXPLICIT open-source license
 *     are collected, checked against the SAME whitelist the server enforces
 *     for the 'open' category: OPEN_LICENSES from
 *     server/services/physical-ai-classifier.js. NOASSERTION, Other and
 *     non-commercial licenses (CC-BY-NC-*) are not in the set and fall out
 *     automatically; the payload stores the normalized (lowercase) SPDX id so
 *     collector output is byte-consistent with the server-side check.
 *   - Nothing is fabricated: source_payload records the repo, the SPDX
 *     license string, topics, description and the REAL created_at; repos
 *     without a parseable created_at are skipped. canonical_url is the
 *     repository's own https html_url and resource_kind='github_repository',
 *     so server-side validation can classify strictly.
 */

const { BaseConnector } = require('./base');
const { fetchURL } = require('../services/utils');
const { compactDigestDate, todayDigestDate } = require('../services/date-contract');
const { OPEN_LICENSES } = require('../services/physical-ai-classifier');

const SEARCH_ENDPOINT = 'https://api.github.com/search/repositories';
const LOOKBACK_DAYS = 180;
const MIN_STARS = 30;
// GitHub search API hard cap — one request, one page, per round.
const PER_PAGE = 100;

// Kept under GitHub's 256-character search query limit.
const QUERY_TERMS = [
  'robot',
  'robotics',
  'humanoid',
  'quadruped',
  '"embodied ai"',
  '"legged robot"',
];

// Named noise the upstream query cannot avoid: chatbots, RPA / test-automation
// frameworks riding the word "robot", and marketing aggregators.
const ROBOTICS_DENY_RE = /robot[\s_-]*framework|\brpa\b|chat[\s_-]*bot|\bmarketing\b/i;

// Positive robot/embodied semantics: platforms and morphologies, manipulation,
// teleoperation, aerial robots, and the common robotics software stack
// (ROS 2, MuJoCo, Gazebo, MoveIt, NVIDIA Isaac).
const ROBOTICS_ALLOW_RE = new RegExp([
  '\\brobots?\\b',
  '\\brobotic',
  'humanoid',
  'quadruped',
  '\\blegged\\b',
  'embodied',
  'manipulat(?:ion|or)',
  '(?:robot|robotic)[\\s_-]*(?:arm|hand|dog)',
  '\\bcobot\\b',
  'exoskeleton',
  '\\bteleop(?:eration)?\\b',
  '\\bdrones?\\b',
  'quadrotor',
  '\\buav\\b',
  '\\bslam\\b',
  '\\bnav2\\b',
  '\\bros2\\b',
  'mujoco',
  'gazebo',
  'moveit',
  '\\bisaac\\b',
  'locomotion',
].join('|'), 'i');

class PhysicalAIOpenGitHubConnector extends BaseConnector {
  constructor() {
    super('physical-ai-open-github');
  }

  /**
   * Cutoff day (YYYY-MM-DD, UTC) for the 180-day creation window. Anchored on
   * the requested digest date (canonical or compact both accepted) via
   * Date.UTC, so the window never depends on the host timezone; without a
   * date it anchors on now.
   */
  _cutoffDate(date) {
    const m = typeof date === 'string' ? date.match(/(\d{4})\D?(\d{2})\D?(\d{2})/) : null;
    const baseMs = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Date.now();
    return new Date(baseMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  _buildSearchUrl(cutoff) {
    const q = QUERY_TERMS.join(' OR ')
      + ' created:>=' + cutoff + ' stars:>=' + MIN_STARS;
    const url = new URL(SEARCH_ENDPOINT);
    url.searchParams.set('q', q);
    url.searchParams.set('sort', 'stars');
    url.searchParams.set('order', 'desc');
    url.searchParams.set('per_page', String(PER_PAGE));
    url.searchParams.set('page', '1');
    return url.toString();
  }

  _isCollectibleRepo(repo) {
    if (!repo || typeof repo !== 'object') return false;
    // Search hits must be affirmatively public and non-archived — a missing
    // flag is a rejection, never an assumption.
    if (repo.private !== false || repo.archived !== false || repo.disabled === true) return false;
    if (typeof repo.full_name !== 'string' || !repo.full_name.trim()) return false;
    // canonical_url must survive the server-side strict validation in
    // physical-ai-classifier.openResource(): standard https, no userinfo or
    // port, host github.com, path exactly owner/repo in GitHub-name charset,
    // no reserved first segment — anything else would be ingested here and
    // then silently dropped from the 'open' category server-side.
    if (!PhysicalAIOpenGitHubConnector._isCanonicalRepoUrl(repo.html_url)) return false;
    // Same whitelist the classifier applies (lowercase SPDX ids); the
    // normalized id is what the payload stores.
    if (!OPEN_LICENSES.has(PhysicalAIOpenGitHubConnector._normalizeLicense(repo.license))) return false;
    // created_at must be real and parseable — it feeds published_at verbatim.
    if (typeof repo.created_at !== 'string' || !Number.isFinite(Date.parse(repo.created_at))) return false;
    const haystack = [repo.full_name, repo.name, repo.description,
      ...(Array.isArray(repo.topics) ? repo.topics : [])]
      .filter(value => typeof value === 'string').join(' ');
    if (ROBOTICS_DENY_RE.test(haystack)) return false;
    return ROBOTICS_ALLOW_RE.test(haystack);
  }

  static _normalizeLicense(license) {
    const raw = typeof license === 'object' && license !== null ? license.spdx_id : license;
    return String(raw || '').replace(/^license:/i, '').trim().toLowerCase();
  }

  // Mirrors the canonical-URL rules of services/physical-ai-classifier.js
  // openResource() for GITHUB_SOURCES — kept in lockstep deliberately.
  static _isCanonicalRepoUrl(value) {
    let url;
    try { url = new URL(value); } catch { return false; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    if (url.hostname.toLowerCase() !== 'github.com') return false;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_.-]+$/.test(part))) return false;
    return !['topics', 'orgs', 'users', 'search', 'features'].includes(parts[0].toLowerCase());
  }

  async fetch(date, opts = {}) {
    opts.signal?.throwIfAborted();
    // Snapshot semantics: digest_date is THIS collection round's day (the
    // requested digest date; local-today fallback), not the repo's creation
    // day — repeated syncs land on the current snapshot and the base layer's
    // cross-day dedup keeps one row per repo.
    const digestDate = compactDigestDate(date) || compactDigestDate(todayDigestDate());
    const body = await fetchURL(this._buildSearchUrl(this._cutoffDate(date)), {
      headers: {
        'User-Agent': 'EagleyeBot/1.0',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: opts.signal,
    });
    const data = JSON.parse(body);
    if (!data || !Array.isArray(data.items)) {
      throw new Error('Invalid GitHub search response: missing items');
    }
    return data.items
      .filter(repo => this._isCollectibleRepo(repo))
      .map(repo => this._toItem(repo, digestDate));
  }

  _toItem(repo, digestDate) {
    const description = typeof repo.description === 'string' ? repo.description : '';
    const topics = Array.isArray(repo.topics) ? repo.topics : [];
    const stars = Number(repo.stargazers_count) || 0;
    const license = PhysicalAIOpenGitHubConnector._normalizeLicense(repo.license);
    return {
      ...this.normalize({
        title: description.trim() ? repo.full_name + ': ' + description.trim() : repo.full_name,
        url: repo.html_url,
        description,
        publishedAt: repo.created_at,
        language: 'en',
        sourcePayload: {
          resource_kind: 'github_repository',
          repo: repo.full_name,
          owner: repo.owner?.login || '',
          name: repo.name || '',
          html_url: repo.html_url,
          license,
          license_name: repo.license.name || '',
          topics,
          description,
          created_at: repo.created_at,
          stars,
          forks: Number(repo.forks_count) || 0,
          language: repo.language || '',
        },
        popularity: {
          stars,
          forks: Number(repo.forks_count) || 0,
        },
        score: Math.log2(1 + stars),
      }),
      digest_date: digestDate,
    };
  }
}

module.exports = { PhysicalAIOpenGitHubConnector };
