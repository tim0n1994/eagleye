/**
 * Eagleye — Lobste.rs Connector
 *
 * Fetches hottest stories from Lobste.rs API.
 */

const { BaseConnector } = require('./base');
const { fetchURL } = require('../services/utils');

class LobstersConnector extends BaseConnector {
  constructor() {
    super('lobsters');
  }

  async fetch(date) {
    try {
      const body = await fetchURL('https://lobste.rs/hottest.json');
      const data = JSON.parse(body);

      return data.map(item => {
        const dateStr = new Date(item.created_at).toISOString().slice(0, 10).replace(/-/g, '');
        if (date && dateStr !== date) return null;

        return {
          ...this.normalize({
            title: item.title,
            url: item.short_id_url || item.url,
            publishedAt: item.created_at,
            description: item.description || '',
            author: item.submitter_user?.username || '',
            sourcePayload: {
              shortId: item.short_id,
              tags: item.tags || [],
              score: item.score || 0,
              commentsCount: item.comment_count || 0,
              submitter: item.submitter_user?.username || '',
            },
            popularity: { score: item.score || 0, comments: item.comment_count || 0 },
            score: Math.log2(1 + (item.score || 0)),
          }),
          digest_date: dateStr,
        };
      }).filter(Boolean);
    } catch (err) {
      console.error('Lobsters fetch error:', err.message);
      return [];
    }
  }
}

module.exports = { LobstersConnector };
