/**
 * Eagleye — Hacker News Connector
 */

const { BaseConnector } = require('./base');
const { fetchURL } = require('../services/utils');

class HNConnector extends BaseConnector {
  constructor() {
    super('hacker-news');
  }

  async fetch(date) {
    const idsBody = await fetchURL('https://hacker-news.firebaseio.com/v0/topstories.json');
    const ids = JSON.parse(idsBody).slice(0, 30);
    const items = [];

    const results = await Promise.allSettled(ids.map(async (id) => {
      try {
        const body = await fetchURL(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        return JSON.parse(body);
      } catch {
        return null;
      }
    }));

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const raw = r.value;
      if (!raw || raw.deleted || raw.dead) continue;

      const itemDate = new Date(raw.time * 1000);
      const dateStr = itemDate.toISOString().slice(0, 10).replace(/-/g, '');
      if (date && dateStr !== date) continue;

      items.push({
        ...this.normalize({
          title: raw.title,
          url: raw.url || `https://news.ycombinator.com/item?id=${raw.id}`,
          description: raw.text || '',
          publishedAt: new Date(raw.time * 1000).toISOString(),
          author: raw.by || '',
          score: raw.score || 0,
          sourcePayload: {
            hnId: raw.id,
            hnUrl: `https://news.ycombinator.com/item?id=${raw.id}`,
            points: raw.score || 0,
            comments: raw.descendants || 0,
            domain: raw.url ? new URL(raw.url).hostname.replace(/^www\./, '') : 'news.ycombinator.com',
            by: raw.by || '',
            type: raw.type || 'story',
          },
          popularity: { points: raw.score || 0, comments: raw.descendants || 0 },
        }),
        digest_date: dateStr,
      });
    }

    return items;
  }
}

module.exports = { HNConnector };
