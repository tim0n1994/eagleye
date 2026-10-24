/**
 * Eagleye — Lobste.rs Connector
 *
 * Fetches hottest stories from Lobste.rs API.
 */

const { BaseConnector } = require('./base');
const { fetchURL } = require('../services/utils');
const { isWithinFetchWindow, compactDigestDate, todayDigestDate } = require('../services/date-contract');

class LobstersConnector extends BaseConnector {
  constructor() {
    super('lobsters');
  }

  async fetch(date) {
    const digestDate = date || compactDigestDate(todayDigestDate());
    try {
      const body = await fetchURL('https://lobste.rs/hottest.json');
      const data = JSON.parse(body);

      return data.map(item => {
        // D2 time-window freshness replaces the digest-day == item-UTC-day
        // equality filter (see date-contract.js isWithinFetchWindow).
        if (date && !isWithinFetchWindow(item.created_at)) return null;

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
          digest_date: digestDate,
        };
      }).filter(Boolean);
    } catch (err) {
      console.error(`[${this.slug}] fetch error:`, err.message);
      return [];
    }
  }
}

module.exports = { LobstersConnector };
