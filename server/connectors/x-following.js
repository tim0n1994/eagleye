/**
 * Eagleye — X (Twitter) Following Connector
 *
 * Fetches latest tweets from a curated list of X accounts.
 *
 * Primary backend: agent-reach twitter-cli (`twitter user-posts`), which returns
 * structured JSON (exact metrics, ISO timestamps, media) — far richer than the
 * legacy Jina Reader path. See server/services/agent-reach.js for the bridge.
 *
 * Fallback backend: Jina Reader (https://r.jina.ai) renders public profile pages
 * to Markdown, which we parse. This is kept for resilience: if twitter-cli's
 * cookies expire (TWITTER_AUTH_TOKEN / TWITTER_CT0) or the tool isn't installed,
 * the source keeps producing items instead of going dark. The Jina path can also
 * read profiles without auth.
 *
 * Why two backends:
 *  - X closed the free API tier in 2023 and charges $100+/mo
 *  - twitter-cli gives clean structured data when authenticated (preferred)
 *  - Jina needs no auth but is rate-limited and loses exact metrics/dates
 *
 * Config (env or runtime):
 *  X_FOLLOWING_USERS="elonmusk,sama,DHH,paulg"           (comma-separated, no @)
 *  X_FOLLOWING_CONFIG_PATH="/abs/path/to/users.txt"      (optional override)
 *  X_FOLLOWING_CACHE_TTL_MS=1800000                       (default 30 min, Jina path)
 */

const { BaseConnector } = require('./base');
const { fetchURL } = require('../services/utils');
const { readXFollowingConfig } = require('../services/x-following-config');
const reach = require('../services/agent-reach');

const CACHE = new Map(); // username -> { ts, posts }  (Jina path only)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function envInt(name, fallback, min, max) {
  const value = parseInt(process.env[name] || `${fallback}`, 10);
  const bounded = Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(bounded, max));
}

function parseRetryAfterMs(errorMessage) {
  const text = String(errorMessage || '');
  const retryAfter = text.match(/"retryAfter"\s*:\s*(\d+)/);
  if (retryAfter) return Math.max(1000, parseInt(retryAfter[1], 10) * 1000);

  const retryAfterDate = text.match(/"retryAfterDate"\s*:\s*"([^"]+)"/);
  if (retryAfterDate) {
    const target = Date.parse(retryAfterDate[1]);
    if (!Number.isNaN(target)) return Math.max(1000, target - Date.now());
  }

  if (/Upstream 429|rate limit/i.test(text)) return 20000;
  return 0;
}

/**
 * Detect network-level failures (timeout, DNS, connection reset/refused).
 * Distinct from HTTP errors: these mean the endpoint itself is unreachable,
 * which is what the fetch-loop circuit breaker keys on.
 */
function isNetworkError(err) {
  const text = String((err && err.message) || err);
  return /timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i.test(text);
}

class XFollowingConnector extends BaseConnector {
  constructor() {
    super('x-following');
  }

  /**
   * Load the user's curated following list.
   * Priority: config file → X_FOLLOWING_USERS (env) → default seed.
   */
  loadUserList() {
    const cfg = readXFollowingConfig();
    if (cfg.users.length > 0) return cfg.users;

    const envUsers = (process.env.X_FOLLOWING_USERS || '').split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);
    if (envUsers.length > 0) return envUsers;

    // Seed list — a few high-quality tech accounts so the source has content out of the box
    return [
      'elonmusk',
      'sama',
      'paulg',
      'DHH',
      'naval',
      'pmarca',
      'daboreta',
      'karpathy',
      'ylecun',
      'AndrewYNg',
    ];
  }

  // ─── Primary backend: twitter-cli via agent-reach bridge ───────────────

  /**
   * Fetch a user's recent tweets via `twitter user-posts`.
   * Returns an array of normalized raw items (pre-`this.normalize`), or null
   * if twitter-cli is structurally unavailable (not installed / auth missing)
   * — null signals the caller to fall back to Jina for the whole run.
   */
  async _fetchUserTimelineTwitter(username, count) {
    const result = await reach.twitterUserPosts(username, count);
    if (!result.ok) {
      // Structural failures mean twitter-cli can't serve this run at all:
      // fall back to Jina rather than retrying twitter-cli per-user.
      if (result.code === 'ENOENT' || result.code === 'AUTH_REQUIRED' || result.code === 'SPAWN_ERROR') {
        return null;
      }
      // Transient errors (TIMEOUT / NOT_FOUND / EXIT_n) — treat as no posts for this user.
      console.warn(`  ⚠ twitter-cli @${username}: ${result.code} — ${result.message}`);
      return [];
    }
    return (result.data || []).filter(Boolean).map(tw => {
      const handle = tw.author?.screenName || username;
      const text = String(tw.text || '').replace(/\s+/g, ' ').trim();
      const tweetId = String(tw.id || '');
      const url = tweetId ? `https://x.com/${handle}/status/${tweetId}` : '';
      const m = tw.metrics || {};
      return {
        id: tweetId,
        url,
        text,
        isoDate: tw.createdAtISO || new Date().toISOString(),
        views: m.views || 0,
        likes: m.likes || 0,
        retweets: m.retweets || 0,
        replies: m.replies || 0,
        bookmarks: m.bookmarks || 0,
        author: handle,
        lang: tw.lang || 'und',
      };
    });
  }

  _twitterPostToItem(username, p) {
    const cleanedText = (p.text || '')
      .replace(/^Quote\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const titleText = cleanedText.length > 110 ? cleanedText.slice(0, 107) + '…' : cleanedText;
    const title = titleText ? `@${username}: ${titleText}` : `@${username} posted`;
    const score = p.likes + p.retweets * 2 + p.replies + p.views / 1000;
    return this.normalize({
      title,
      url: p.url,
      description: cleanedText,
      content: cleanedText,
      author: `@${username}`,
      publishedAt: p.isoDate,
      externalId: `x:${p.id}`,
      language: p.lang || 'en',
      score,
      sourcePayload: {
        tweetId: p.id,
        handle: username,
        backend: 'twitter-cli',
        views: p.views,
        likes: p.likes,
        retweets: p.retweets,
        replies: p.replies,
        bookmarks: p.bookmarks,
        xUrl: p.url,
      },
      popularity: {
        views: p.views,
        likes: p.likes,
        retweets: p.retweets,
        replies: p.replies,
        bookmarks: p.bookmarks,
      },
    });
  }

  // ─── Fallback backend: Jina Reader ─────────────────────────────────────

  /**
   * Parse Jina Reader Markdown into discrete tweet objects.
   *
   * Two output shapes are supported:
   *  1) Date+URL headers (most public profiles):
   *       [Jun 3](https://x.com/handle/status/123)
   *       Tweet text here...
   *       [24M](https://x.com/.../analytics)
   *
   *  2) Image-only/limited profiles (e.g. paulg):
   *       Text block
   *       [![Image 1: ...](url)](https://x.com/handle/status/ID/photo/1)
   *       Next text block
   *       ...
   *     Here we associate each image+status URL with the text block immediately
   *     preceding it.
   */
  parseJinaMarkdown(md, username) {
    const tweets = [];
    const lines = md.split('\n');

    // Find the "posts" section anchor
    const postsStartIdx = lines.findIndex(l => /’s posts|posts$/i.test(l));
    if (postsStartIdx < 0) return tweets;

    // Strategy: walk forward, accumulate text in a buffer, and when we hit
    // a status URL (either as [date](url) or as an image link), flush the
    // buffer as a new tweet.
    let buffer = [];
    let lastTweetId = null;
    let lastStatusUrl = null;
    let lastDateLabel = '';
    let lastMetrics = { views: 0, likes: 0, retweets: 0, replies: 0 };
    let metricsBuffer = { views: 0, likes: 0, retweets: 0, replies: 0 };
    let firstDateLinkSeen = false;

    const flush = () => {
      if (!lastTweetId) return;
      const text = buffer.join(' ').trim();
      tweets.push({
        id: lastTweetId,
        url: lastStatusUrl,
        text,
        dateLabel: lastDateLabel,
        isoDate: this.approxDateFromLabel(lastDateLabel),
        views: lastMetrics.views,
        likes: lastMetrics.likes,
        retweets: lastMetrics.retweets,
        replies: lastMetrics.replies,
        bookmarks: 0,
        author: username,
        lang: 'und',
      });
      buffer = [];
      lastTweetId = null;
      lastStatusUrl = null;
      lastDateLabel = '';
      lastMetrics = { views: 0, likes: 0, retweets: 0, replies: 0 };
    };

    for (let i = postsStartIdx + 1; i < lines.length; i++) {
      const line = lines[i];

      // Stop at next major section
      if (/^#+\s/.test(line) && i > postsStartIdx + 1) break;

      // Pattern A: [Mon DD](https://x.com/handle/status/ID)
      const dateLinkMatch = line.match(/\[([A-Z][a-z]{2}\s+\d{1,2}(?:,\s+\d{4})?)\]\((https:\/\/x\.com\/([a-zA-Z0-9_]+)\/status\/(\d+))\)/);
      if (dateLinkMatch) {
        // Skip date-links for handles other than the user we're parsing.
        // Jina Reader surfaces quoted tweets by re-rendering the original
        // tweet (with its own [Mon DD](url)) inside the quote card; if we
        // naively accept that link, the next flush() will attribute the
        // quoted content to the wrong tweet ID. We require the link handle
        // to match the profile owner — except for the very first hit, where
        // we still need to drop the byline "Pinned / Name / @handle".
        const linkHandle = dateLinkMatch[3];
        if (linkHandle !== username) continue;
        // First date link — drop the byline "Pinned / Name / @handle" that
        // precedes the first tweet. Subsequent date links flush normally.
        if (!firstDateLinkSeen) {
          firstDateLinkSeen = true;
          buffer = [];
        }
        flush();
        lastDateLabel = dateLinkMatch[1];
        lastStatusUrl = dateLinkMatch[2];
        lastTweetId = dateLinkMatch[4];
        metricsBuffer = { views: 0, likes: 0, retweets: 0, replies: 0 };
        continue;
      }

      // Pattern B: image link containing status URL  ![...](url)(https://x.com/HANDLE/status/ID/...)
      // Skip if the URL points to the profile (no /status/) or to analytics.
      const imgStatusMatch = line.match(/\]\((https:\/\/x\.com\/([a-zA-Z0-9_]+)\/status\/(\d+))(?:\/photo\/\d+)?\)/);
      if (imgStatusMatch && !line.includes('analytics') && imgStatusMatch[2] === username) {
        if (!firstDateLinkSeen) {
          firstDateLinkSeen = true;
          buffer = [];
        }
        flush();
        lastStatusUrl = `https://x.com/${username}/status/${imgStatusMatch[3]}`;
        lastTweetId = imgStatusMatch[3];
        if (!lastDateLabel) lastDateLabel = 'Recent';
        metricsBuffer = { views: 0, likes: 0, retweets: 0, replies: 0 };
        continue;
      }

      // Skip byline lines that link to the user's own profile (not a status).
      // Format: [Name ![img]](https://x.com/username) or [@handle](https://x.com/username)
      // Tolerate image links, trailing whitespace, and optional trailing slash.
      const profileLinkRe = new RegExp(String.raw`\]\(https?://x\.com/${username}(?:/photo)?\)?\s*$`);
      if (profileLinkRe.test(line)) continue;
      if (new RegExp(`^\\[@?[A-Za-z0-9_.]+\\]\\(https?://x\\.com/${username}\\)?\\s*$`).test(line)) continue;
      if (line.trim() === 'Pinned') continue;
      // Skip header navigation links (Posts / Replies / Media etc)
      if (/^\[(Posts|Replies|Media|Highlights|Articles)\]\(https?:\/\/x\.com\//.test(line)) continue;

      // Metrics line: [123](https://x.com/.../analytics) or [24M](...)
      // Also skip empty metrics brackets like [](https://.../analytics) — these
      // are Jina placeholders for tweets with no public metrics yet.
      if (/^\[\]\(https?:\/\/.*analytics/.test(line)) continue;
      const metricsMatch = line.match(/\[([\d.,]+)([KM]?)\]\(https?:\/\/.*analytics/);
      if (metricsMatch) {
        const num = parseFloat(metricsMatch[1].replace(/,/g, ''));
        const mult = metricsMatch[2] === 'K' ? 1000 : metricsMatch[2] === 'M' ? 1000000 : 1;
        const val = Math.round(num * mult);
        if (metricsBuffer.views === 0) metricsBuffer.views = val;
        else if (metricsBuffer.likes === 0) metricsBuffer.likes = val;
        else if (metricsBuffer.retweets === 0) metricsBuffer.retweets = val;
        else metricsBuffer.replies = val;
        lastMetrics = { ...metricsBuffer };
        continue;
      }

      // Skip pure image/icon lines and blank lines
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('![') && trimmed.length < 250) continue;
      if (/^!?\[Image \d+/.test(trimmed) && trimmed.length < 250) continue;
      if (/^Click to (Follow|Refresh)/.test(trimmed)) continue;

      // Strip remaining markdown noise
      const cleaned = trimmed
        .replace(/\[(\d+(?:\.\d+)?[KM]?)\]\(https?:\/\/[^)]+\)/g, '')
        .replace(/!\[.*?\]\(.*?\)/g, '')
        .replace(/\]\(https?:\/\/[^)]+\)/g, '')
        .replace(/\[(Joined [^]]+)\]\(https?:\/\/[^)]+\)/g, '')
        .replace(/\[(\d+\s*Posts?)\]\(https?:\/\/[^)]+\)/gi, '')
        .replace(new RegExp(`^\\[@?${username}\\]\\(https?://[^\\)]+\\)`, 'i'), '')
        .replace(new RegExp(`^\\[@?[A-Z][a-z]+\\s+\\[@?${username}\\]`, 'i'), '')
        .trim();

      if (cleaned) buffer.push(cleaned);
    }

    // Flush the last one
    flush();

    return tweets;
  }

  /**
   * Convert X's "Jun 3" / "Mar 19, 2024" labels to ISO 8601.
   * X omits the year for recent posts (assumes current year).
   */
  approxDateFromLabel(label) {
    const now = new Date();
    const year = now.getFullYear();
    const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
    const m = label.match(/^([A-Z][a-z]{2})\s+(\d{1,2})(?:,\s+(\d{4}))?$/);
    if (!m) return now.toISOString();
    const yyyy = m[3] ? parseInt(m[3]) : year;
    const mm = months[m[1]];
    const dd = parseInt(m[2]);
    if (mm === undefined || isNaN(dd)) return now.toISOString();
    return new Date(Date.UTC(yyyy, mm, dd, 12, 0, 0)).toISOString();
  }

  async fetchUserTimelineJina(username, attempt = 1) {
    const ttl = parseInt(process.env.X_FOLLOWING_CACHE_TTL_MS || '1800000', 10);
    const cached = CACHE.get(username);
    if (cached && Date.now() - cached.ts < ttl) {
      return cached.posts;
    }
    const url = `https://r.jina.ai/https://x.com/${encodeURIComponent(username)}`;
    const timeoutMs = envInt('X_FOLLOWING_FETCH_TIMEOUT_MS', 8000, 2000, 30000);
    let md;
    try {
      md = await fetchURL(url, { timeoutMs });
    } catch (err) {
      const maxRetries = envInt('X_FOLLOWING_RETRIES', 2, 0, 5);
      const retryAfterMs = parseRetryAfterMs(err.message);
      const maxWaitMs = envInt('X_FOLLOWING_MAX_RETRY_MS', 45000, 1000, 120000);
      if (retryAfterMs > 0 && attempt <= maxRetries) {
        const waitMs = Math.min(retryAfterMs, maxWaitMs);
        console.warn(`  ⚠ Jina rate-limited @${username}, retry ${attempt}/${maxRetries} in ${Math.ceil(waitMs / 1000)}s`);
        await sleep(waitMs);
        return this.fetchUserTimelineJina(username, attempt + 1);
      }
      console.warn(`  ⚠ Jina fetch failed for @${username}: ${err.message}`);
      // Network-level failures bubble up (tagged) so the fetch loop's circuit
      // breaker can abort the whole source when Jina is unreachable, instead
      // of waiting out every user's timeout.
      if (isNetworkError(err)) {
        const netErr = new Error(err.message);
        netErr.networkError = true;
        throw netErr;
      }
      return [];
    }
    if (!md || md.length < 100) {
      console.warn(`  ⚠ Empty response from Jina for @${username}`);
      return [];
    }
    const posts = this.parseJinaMarkdown(md, username);
    CACHE.set(username, { ts: Date.now(), posts });
    return posts;
  }

  async fetch(_date) {
    const users = this.loadUserList();
    if (users.length === 0) {
      console.log('  ⚠ X Following: no users configured (set X_FOLLOWING_USERS env or ~/.eagleye/x-following.txt)');
      return [];
    }

    const perUser = envInt('X_FOLLOWING_TWEETS_PER_USER', 10, 1, 40);
    const concurrency = envInt('X_FOLLOWING_CONCURRENCY', 4, 1, 8);
    const delayMs = envInt('X_FOLLOWING_BATCH_DELAY_MS', 0, 0, 60000);

    // Decide backend: probe twitter-cli with the first user. If structurally
    // unavailable (null), switch the entire run to Jina fallback.
    let useTwitter = true;
    const ready = await reach.isReachReady('twitter').catch(() => true);
    if (!ready) {
      useTwitter = false;
      console.log('  🐦 X Following: twitter backend not ready, using Jina fallback');
    } else {
      const probe = await this._fetchUserTimelineTwitter(users[0], perUser);
      if (probe === null) {
        useTwitter = false;
        console.log('  🐦 X Following: twitter-cli unavailable (not installed / no auth), using Jina fallback');
      }
    }
    console.log(`  🐦 X Following: fetching ${users.length} users via ${useTwitter ? 'twitter-cli' : 'Jina Reader'}...`);

    const allItems = [];
    // Circuit breaker: when a backend is unreachable every request burns a
    // full timeout, so 442 users can stall the whole pipeline for tens of
    // minutes. Trip after N consecutive failures. On the twitter path, tripping
    // flips the run to the Jina fallback for the remaining users.
    const circuitThreshold = envInt('X_FOLLOWING_CIRCUIT_FAILURES', 8, 3, 100);
    let consecutiveFailures = 0;
    let circuitTripped = false;
    // Live backend selection — flipped in-flight when twitter-cli degrades.
    let backend = useTwitter ? 'twitter' : 'jina';

    const fetchOneTwitter = async (username) => {
      const posts = await this._fetchUserTimelineTwitter(username, perUser);
      if (posts === null) return []; // structural failure already flipped backend
      if (posts.length === 0) {
        // Empty result: could be a genuine empty timeline OR a transient
        // twitter-cli failure (EXIT_1 ClientTransaction, NOT_FOUND, etc.).
        // Track consecutive empties; if they pile up, twitter-cli has degraded
        // and we should switch the remaining users to Jina.
        consecutiveFailures++;
        if (!circuitTripped && consecutiveFailures >= circuitThreshold) {
          circuitTripped = true;
          backend = 'jina';
          console.warn(`  🛑 X Following: twitter-cli degraded (${consecutiveFailures} consecutive empty/failure) — switching remaining users to Jina fallback`);
        }
      } else {
        consecutiveFailures = 0; // a success resets the breaker
      }
      return posts.map(p => this._twitterPostToItem(username, p));
    };

    const fetchOneJina = async (username) => {
      if (circuitTripped && backend === 'twitter') {
        // twitter→jina mid-run switch: un-trip so Jina gets a fresh attempt.
        circuitTripped = false;
        consecutiveFailures = 0;
        console.log(`  🐦 X Following: now fetching @${username} via Jina fallback`);
      } else if (circuitTripped) {
        // Jina's own breaker tripped (network unreachable) — skip remaining.
        return [];
      }
      try {
        const posts = await this.fetchUserTimelineJina(username);
        consecutiveFailures = 0; // a success resets the breaker
        return posts.map(p => {
          const cleanedText = (p.text || '')
            .replace(/^Quote\s+/i, '')
            .replace(/\s+/g, ' ')
            .trim();
          const titleText = cleanedText.length > 110 ? cleanedText.slice(0, 107) + '…' : cleanedText;
          const title = titleText ? `@${username}: ${titleText}` : `@${username} posted`;
          return this.normalize({
            title,
            url: p.url,
            description: cleanedText,
            content: cleanedText,
            author: `@${username}`,
            publishedAt: p.isoDate,
            externalId: `x:${p.id}`,
            score: p.likes + p.retweets * 2 + p.views / 1000,
            sourcePayload: {
              tweetId: p.id,
              handle: username,
              backend: 'jina',
              dateLabel: p.dateLabel,
              views: p.views,
              likes: p.likes,
              retweets: p.retweets,
              replies: p.replies,
              xUrl: p.url,
            },
            popularity: { views: p.views, likes: p.likes, retweets: p.retweets, replies: p.replies },
          });
        });
      } catch {
        // Only network errors bubble out of fetchUserTimelineJina.
        consecutiveFailures++;
        if (consecutiveFailures >= circuitThreshold && !circuitTripped) {
          circuitTripped = true;
          console.warn(`  🛑 X Following: Jina unreachable — circuit breaker tripped after ${consecutiveFailures} consecutive network failures; skipping remaining users`);
        }
        return [];
      }
    };

    // Dispatch by live `backend` so a mid-run twitter→jina switch takes effect.
    const fetchOne = (username) => (backend === 'twitter' ? fetchOneTwitter(username) : fetchOneJina(username));

    for (let i = 0; i < users.length; i += concurrency) {
      if (circuitTripped && backend === 'jina') break; // Jina fully down — abort
      const chunk = users.slice(i, i + concurrency);
      const results = await Promise.all(chunk.map(fetchOne));
      for (const items of results) allItems.push(...items);
      console.log(`  🐦 X Following: ${Math.min(i + chunk.length, users.length)}/${users.length} users, ${allItems.length} posts (${backend})`);
      if (i + concurrency < users.length && delayMs > 0) {
        await sleep(delayMs);
      }
    }

    if (circuitTripped) {
      console.warn(`  🛑 X Following: aborted early with ${allItems.length} posts (Jina unreachable)`);
    } else {
      console.log(`  🐦 X Following: ${allItems.length} posts from ${users.length} users`);
    }
    return allItems;
  }
}

module.exports = { XFollowingConnector };
