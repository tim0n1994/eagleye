/**
 * Eagleye — RSS Connector
 *
 * Generic connector for any RSS/Atom feed source.
 * Looks up the feed URL from the sources table.
 */

const { BaseConnector } = require('./base');
const { fetchURL } = require('../services/utils');
const { getDB } = require('../db/connection');

class RSSConnector extends BaseConnector {
  constructor(slug) {
    super(slug);
  }

  getFeedUrl() {
    const db = getDB();
    if (!db) return null;
    const row = db.prepare('SELECT feed_url FROM sources WHERE slug = ?').get(this.slug);
    return row?.feed_url || null;
  }

  async fetch(date, { signal } = {}) {
    signal?.throwIfAborted();
    const feedUrl = this.getFeedUrl();
    if (!feedUrl) {
      throw new Error(`No feed URL for source: ${this.slug}`);
    }

    try {
      const xml = await fetchURL(feedUrl, { signal });
      return this.parseRSS(xml, date, feedUrl);
    } catch (err) {
      signal?.throwIfAborted();
      const fallback = this.slug === 'solidot' && process.env.SOLIDOT_RSS_FALLBACK_URL;
      if (!fallback) throw err;
      console.warn(`RSS primary failed for ${this.slug}; using configured fallback: ${err.message}`);
      const xml = await fetchURL(fallback, { signal });
      return this.parseRSS(xml, date, fallback);
    }
  }

  parseRSS(xml, date, feedUrl = this.getFeedUrl()) {
    if (!/<(?:rss|feed)\b/i.test(xml)) throw new Error(`Invalid RSS/Atom response for ${this.slug}`);
    const items = [];
    const itemRegex = /<(item|entry)>([\s\S]*?)<\/\1>/gi;
    let itemMatch;

    while ((itemMatch = itemRegex.exec(xml)) !== null) {
      const block = itemMatch[2];

      const getField = (tag) => {
        // Try CDATA first
        const cdataMatch = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i'));
        if (cdataMatch) return cdataMatch[1];
        // Fallback: capture between tags
        const m2 = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return m2 ? m2[1].trim() : '';
      };

      let link = getField('link');
      if (!link) {
        const linkHrefMatch = block.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
        link = linkHrefMatch ? linkHrefMatch[1] : '';
      }

      const guidRaw = getField('guid') || getField('id');
      const pubDate = getField('pubDate') || getField('published') || getField('updated');
      const description = getField('description') || getField('content') || getField('summary') || '';
      const title = getField('title') || '[No Title]';

      // Determine digest date from pubDate or requested date
      let digestDate = date;
      if (pubDate) {
        try {
          const d = new Date(pubDate);
          if (!isNaN(d.getTime())) {
            digestDate = d.toISOString().slice(0, 10).replace(/-/g, '');
          }
        } catch {}
      }

      // If date filter is active, skip items not matching
      if (date && digestDate !== date) continue;

      const extractImage = (html) => {
        if (!html) return '';
        const m = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
        return m ? m[1] : '';
      };

      items.push({
        ...this.normalize({
          title,
          url: link || guidRaw || '',
          description: description.replace(/<[^>]*>/g, '').slice(0, 2000),
          publishedAt: pubDate || new Date().toISOString(),
          sourcePayload: {
            guid: guidRaw || '',
            feedUrl,
            image: extractImage(description),
          },
        }),
        digest_date: digestDate,
      });
    }

    return items;
  }
}

module.exports = { RSSConnector };
