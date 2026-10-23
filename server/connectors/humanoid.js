/**
 * Eagleye — Physical AI Humanoid Connector
 *
 * Fetches news from major humanoid robotics companies via their
 * RSS feeds, news pages, and PR channels.
 *
 * Targets: Tesla Optimus, Figure AI, Boston Dynamics, Agility Robotics,
 * Apptronik, 1X Technologies, Sanctuary AI, Fourier Intelligence, Unitree, etc.
 */

const { BaseConnector } = require('./base');
const { fetchURL } = require('../services/utils');
const { isWithinFetchWindow, compactDigestDate, todayDigestDate } = require('../services/date-contract');

// Known RSS/news sources for humanoid robotics companies
const HUMAN_NEWS_SOURCES = [
  { name: 'Tesla Optimus', url: 'https://www.tesla.com/blog', type: 'scrape' },
  { name: 'Boston Dynamics', url: 'https://bostondynamics.com/blog', type: 'scrape' },
  { name: 'Figure AI', url: 'https://www.figure.ai/news', type: 'scrape' },
  { name: '1X Technologies', url: 'https://www.1x.tech/news', type: 'scrape' },
  { name: 'Agility Robotics', url: 'https://agilityrobotics.com/news', type: 'scrape' },
  { name: 'Sanctuary AI', url: 'https://www.sanctuary.ai/news', type: 'scrape' },
  { name: 'Apptronik', url: 'https://apptronik.com/news', type: 'scrape' },
  { name: 'Fourier Intelligence', url: 'https://www.fourierintelligence.com/en/news', type: 'scrape' },
  { name: 'Unitree', url: 'https://www.unitree.com/news', type: 'scrape' },
  { name: 'Engineered Arts', url: 'https://www.engineeredarts.co.uk/news', type: 'scrape' },
];

// Humanoid robotics RSS feeds from industry aggregators
const HUMAN_FEEDS = [
  { name: 'IEEE Spectrum Robotics', url: 'https://spectrum.ieee.org/feeds/topic/robotics.rss', type: 'rss' },
  { name: 'TechCrunch Robotics', url: 'https://techcrunch.com/category/robotics/feed/', type: 'rss' },
  { name: 'The Robot Report', url: 'https://www.therobotreport.com/feed/', type: 'rss' },
  { name: 'Humanoid History', url: 'https://humanoidhistory.substack.com/feed', type: 'rss' },
];

class HumanoidConnector extends BaseConnector {
  constructor() {
    super('physical-ai-humanoid');
  }

  async fetch(date) {
    const items = [];
    // D2: digest date basis is the requested local digest date (fallback:
    // local today), never the item's own UTC day.
    const dateStr = date || compactDigestDate(todayDigestDate());

    // Fetch from RSS feeds
    for (const source of HUMAN_FEEDS) {
      try {
        const xml = await fetchURL(source.url);
        const parsed = this._parseRSS(xml, dateStr, source.name);
        items.push(...parsed);
      } catch (err) {
        console.error(`[${this.slug}] RSS feed failed (${source.name} ${source.url}):`, err.message);
      }
    }

    // Scrape company news pages
    for (const source of HUMAN_NEWS_SOURCES) {
      try {
        const html = await fetchURL(source.url);
        const parsed = this._scrapePage(html, dateStr, source.name, source.url);
        items.push(...parsed);
      } catch (err) {
        console.error(`[${this.slug}] company page scrape failed (${source.name} ${source.url}):`, err.message);
      }
    }

    return items;
  }

  _parseRSS(xml, dateStr, sourceName) {
    const items = [];
    const itemRegex = /<(item|entry)>([\s\S]*?)<\/\1>/gi;
    let match;

    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[2];

      const getField = (tag) => {
        const cdataMatch = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i'));
        if (cdataMatch) return cdataMatch[1];
        const m2 = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return m2 ? m2[1].trim() : '';
      };

      let link = getField('link');
      if (!link) {
        const linkHref = block.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
        link = linkHref ? linkHref[1] : '';
      }

      const pubDate = getField('pubDate') || getField('published') || getField('updated');
      const description = getField('description') || getField('summary') || '';
      const title = getField('title') || '[No Title]';

      // D2 time-window freshness replaces the digest-day == item-UTC-day
      // equality filter; items without a parseable pubDate keep the legacy
      // keep-behavior (judged against fetch time).
      const pubTs = Date.parse(pubDate);
      const effectiveTs = Number.isFinite(pubTs) ? pubTs : Date.now();
      if (dateStr && !isWithinFetchWindow(effectiveTs)) continue;

      items.push({
        ...this.normalize({
          title,
          url: link,
          description: description.replace(/<[^>]*>/g, '').slice(0, 2000),
          publishedAt: pubDate || new Date().toISOString(),
          sourcePayload: {
            company: sourceName,
            feed_type: 'rss',
            category: 'humanoid-robotics',
          },
        }),
        digest_date: dateStr,
      });
    }

    return items;
  }

  _scrapePage(html, dateStr, companyName, pageUrl) {
    const items = [];
    const now = new Date();
    // D2: the company-page add-on gate compares against the LOCAL calendar
    // today (the digest date basis). The old UTC-today comparison kept the
    // gate permanently closed during the 01:00 Asia/Shanghai run, when UTC is
    // still on the previous day.
    const todayStr = compactDigestDate(todayDigestDate(now));

    if (dateStr !== todayStr) return items; // Only scrape for the current local day

    // Try to extract article links and titles
    const articleRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    const seen = new Set();

    while ((match = articleRegex.exec(html)) !== null) {
      let href = match[1];
      const text = match[2].replace(/<[^>]*>/g, '').trim();

      // Filter for meaningful article links
      if (!text || text.length < 15) continue;
      if (href.startsWith('#') || href.startsWith('javascript:')) continue;

      // Resolve relative URLs
      if (href.startsWith('/')) {
        try {
          const base = new URL(pageUrl);
          href = `${base.protocol}//${base.host}${href}`;
        } catch { continue; }
      } else if (!href.startsWith('http')) {
        continue;
      }

      const key = text.slice(0, 50);
      if (seen.has(key)) continue;
      seen.add(key);

      items.push({
        ...this.normalize({
          title: text,
          url: href,
          description: `${companyName} news: ${text}`,
          publishedAt: now.toISOString(),
          sourcePayload: {
            company: companyName,
            scraped_from: pageUrl,
            feed_type: 'scrape',
            category: 'humanoid-robotics',
          },
          popularity: {},
          score: 0,
        }),
        digest_date: dateStr,
      });

      // Limit to 5 items per source
      if (items.length >= 5) break;
    }

    return items;
  }
}

module.exports = { HumanoidConnector };
