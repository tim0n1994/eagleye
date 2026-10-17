/** Reddit collector: explicit server adapter when configured, otherwise OpenCLI. */

const { BaseConnector } = require('./base');
const reach = require('../services/agent-reach');
const collectors = require('../services/server-collectors');
const { setTimeout: sleep } = require('node:timers/promises');
const { readRedditConfig } = require('../services/reddit-config');

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

  async fetch(_date, { signal } = {}) {
    signal?.throwIfAborted();
    const serverBackend = Boolean(process.env.AGENT_REACH_RDT_BIN);
    const { subreddits } = readRedditConfig();
    if (subreddits.length === 0) {
      console.log('  ⚠ Reddit: no subreddits configured (set REDDIT_SUBREDDITS env or config/reddit-subreddits.txt)');
      return [];
    }

    if (!serverBackend && !await reach.isReachReady('reddit', { signal })) {
      throw new Error('reddit: BACKEND_NOT_READY');
    }

    const limit = parseInt(process.env.REDDIT_POSTS_PER_SUB || '20', 10) || 20;
    const delayMs = parseInt(process.env.REDDIT_POLITENESS_MS || '2000', 10) || 0;
    console.log(`  🔖 Reddit: fetching ${subreddits.length} subreddits via ${serverBackend ? 'server' : 'opencli'}...`);

    const allItems = [];
    for (let i = 0; i < subreddits.length; i++) {
      const sub = subreddits[i];
      signal?.throwIfAborted();
      const result = await (serverBackend ? collectors : reach).redditSubreddit(sub, { sort: 'hot', limit, signal });
      if (!result.ok) {
        throw new Error(`reddit: ${result.code || 'COLLECTION_FAILED'}`);
      } else {
        if (!Array.isArray(result.data)) throw new Error('SCHEMA_ERROR');
        const items = result.data
          .filter(Boolean)
          .map(p => this._postToItem(p))
          .filter(it => it.canonical_url);
        allItems.push(...items);
        console.log(`  🔖 Reddit r/${sub}: ${items.length} posts`);
      }
      if (delayMs > 0 && i < subreddits.length - 1) await sleep(delayMs, undefined, { signal });
    }

    console.log(`  🔖 Reddit: ${allItems.length} posts from ${subreddits.length} subreddits`);
    return allItems;
  }
}

module.exports = { RedditConnector };
