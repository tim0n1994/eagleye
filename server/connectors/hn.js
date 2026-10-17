/**
 * Eagleye — Hacker News Connector
 */

const { BaseConnector, parseItemLimit } = require('./base');
const { fetchURL } = require('../services/utils');

class HNConnector extends BaseConnector {
  constructor() {
    super('hacker-news');
  }

  async fetch(date, opts = {}) {
    const limit = parseItemLimit(opts.limit) ?? 30;
    const stats = opts.stats || { requested: 0, failed: 0, skipped: 0 };
    const idsBody = await fetchURL('https://hacker-news.firebaseio.com/v0/topstories.json');
    const topIds = JSON.parse(idsBody);
    if (!Array.isArray(topIds)) throw new Error('Invalid Hacker News topstories response');
    const ids = [...new Set(topIds)].slice(0, limit);
    stats.requested = ids.length;
    const items = [];

    const results = await Promise.allSettled(ids.map(async (id) => {
      if (!Number.isInteger(id) || id < 1) throw new Error('Invalid Hacker News story ID');
      const body = await fetchURL(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      return JSON.parse(body);
    }));

    for (const r of results) {
      if (r.status !== 'fulfilled') { stats.failed++; continue; }
      const raw = r.value;
      if (!raw) { stats.failed++; continue; }
      if (raw.deleted || raw.dead) { stats.skipped++; continue; }

      try {
        const itemDate = new Date(raw.time * 1000);
        const dateStr = itemDate.toISOString().slice(0, 10).replace(/-/g, '');
        if (date && dateStr !== date) { stats.skipped++; continue; }
        if (typeof raw.title !== 'string' || !raw.title.trim()) throw new Error('Missing Hacker News title');

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
      } catch {
        stats.failed++;
      }
    }

    return items;
  }
}

module.exports = { HNConnector };
