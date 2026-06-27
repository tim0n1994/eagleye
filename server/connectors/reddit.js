/**
 * Eagleye — Reddit Connector (via agent-reach opencli)
 *
 * Fetches hot posts from a curated list of subreddits using the agent-reach
 * opencli backend (browser bridge — requires Chrome logged into reddit.com).
 *
 * Backend notes (verified against live opencli output):
 *  - `opencli reddit subreddit <name>` names the upvote metric `upvotes`
 *    (the `search` subcommand calls the same metric `score`). We read `upvotes`
 *    and fall back to `score` defensively.
 *  - `created_utc` is epoch seconds; converted to ISO here.
 *  - opencli drives real Chrome, so each call is multi-second. We crawl
 *    subreddits sequentially with a small politeness delay (rate-limit safety).
 *  - If the opencli bridge is down (Chrome closed) or auth expires, fetch()
 *    logs a warning and returns [] rather than crashing the allSettled fetch.
 */

const { BaseConnector } = require('./base');
const reach = require('../services/agent-reach');
const { readRedditConfig } = require('../services/reddit-config');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class RedditConnector extends BaseConnector {
  constructor() {
    super('reddit');
  }

  /**
   * Map an opencli reddit post record to a normalized raw item.
   * Handles the subreddit/search metric-name divergence (`upvotes` vs `score`).
   */
  _postToItem(post) {
    const id = String(post.id || '');
    const url = post.url || (id ? `https://reddit.com/comments/${id}` : '');
    const upvotes = Number(post.upvotes !== undefined && post.upvotes !== null ? post.upvotes : post.score) || 0;
    const comments = Number(post.comments) || 0;
    const createdUtc = Number(post.created_utc) || 0;
    const publishedAt = createdUtc > 0
      ? new Date(createdUtc * 1000).toISOString()
      : new Date().toISOString();
    const subreddit = (post.subreddit || '').replace(/^r\//i, '');
    const title = post.title || '[No Title]';
    const selftext = post.selftext || '';

    return this.normalize({
      title,
      url,
      description: selftext.slice(0, 500),
      content: selftext,
      author: post.author || '',
      publishedAt,
      externalId: `reddit:${id}`,
      language: 'en',
      score: Math.log2(1 + upvotes) + Math.log2(1 + comments) * 0.5,
      sourcePayload: {
        subreddit,
        postId: id,
        postHint: post.post_hint || '',
        outboundUrl: post.url_overridden_by_dest || '',
        upvotes,
        comments,
      },
      popularity: { upvotes, comments },
    });
  }

  async fetch(_date) {
    const { subreddits } = readRedditConfig();
    if (subreddits.length === 0) {
      console.log('  ⚠ Reddit: no subreddits configured (set REDDIT_SUBREDDITS env or config/reddit-subreddits.txt)');
      return [];
    }

    const ready = await reach.isReachReady('reddit').catch(() => true);
    if (!ready) {
      console.warn('  ⚠ Reddit: opencli backend not ready — skipping (open Chrome and log into reddit.com)');
      return [];
    }

    const limit = parseInt(process.env.REDDIT_POSTS_PER_SUB || '20', 10) || 20;
    const delayMs = parseInt(process.env.REDDIT_POLITENESS_MS || '2000', 10) || 0;
    console.log(`  🔖 Reddit: fetching ${subreddits.length} subreddits via opencli...`);

    const allItems = [];
    for (let i = 0; i < subreddits.length; i++) {
      const sub = subreddits[i];
      const result = await reach.redditSubreddit(sub, { sort: 'hot', limit });
      if (!result.ok) {
        // Bridge down / auth expired: no point retrying every subreddit.
        if (result.code === 'BRIDGE_DOWN' || result.code === 'AUTH_REQUIRED') {
          console.warn(`  ⚠ Reddit: opencli ${result.code} — aborting remaining subreddits (${result.message})`);
          break;
        }
        console.warn(`  ⚠ Reddit r/${sub}: ${result.code} — ${result.message}`);
      } else {
        const items = (result.data || [])
          .filter(Boolean)
          .map(p => this._postToItem(p))
          .filter(it => it.canonical_url);
        allItems.push(...items);
        console.log(`  🔖 Reddit r/${sub}: ${items.length} posts`);
      }
      if (delayMs > 0 && i < subreddits.length - 1) await sleep(delayMs);
    }

    console.log(`  🔖 Reddit: ${allItems.length} posts from ${subreddits.length} subreddits`);
    return allItems;
  }
}

module.exports = { RedditConnector };
