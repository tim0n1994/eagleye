/**
 * Eagleye — V2EX Connector
 *
 * Fetches hot topics from V2EX API.
 */

const { BaseConnector } = require('./base');
const { fetchURL } = require('../services/utils');
const { isWithinFetchWindow, compactDigestDate, todayDigestDate } = require('../services/date-contract');

class V2EXConnector extends BaseConnector {
  constructor() {
    super('v2ex');
  }

  async fetch(date) {
    const digestDate = date || compactDigestDate(todayDigestDate());
    try {
      const body = await fetchURL('https://www.v2ex.com/api/topics/hot.json');
      const data = JSON.parse(body);

      return data.map(item => {
        // D2 time-window freshness replaces the digest-day == item-UTC-day
        // equality filter (see date-contract.js isWithinFetchWindow).
        if (date && !isWithinFetchWindow(item.created * 1000)) return null;

        return {
          ...this.normalize({
            title: item.title,
            url: item.url,
            publishedAt: new Date(item.created * 1000).toISOString(),
            description: item.content || '',
            author: item.member?.username || '',
            language: 'zh',
            sourcePayload: {
              node: item.node?.name || '',
              nodeTitle: item.node?.title || '',
              replies: item.replies || 0,
              member: item.member?.username || '',
              created: item.created,
            },
            popularity: { replies: item.replies || 0 },
            score: Math.log2(1 + (item.replies || 0)),
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

module.exports = { V2EXConnector };
