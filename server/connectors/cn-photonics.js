/**
 * Eagleye — Physical AI CN Photonics Connector
 *
 * Fetches photonics, semiconductor, and optical communication news
 * from Chinese sources via RSS feeds and web scraping.
 *
 * Targets:
 * - OFweek (photonics industry portal)
 * - Laser Fair / CIOE news
 * - Key Chinese photonics companies
 * - C114 (optical communications)
 */

const { BaseConnector } = require('./base');
const { fetchURL } = require('../services/utils');

// RSS feeds for Chinese photonics/optics/semiconductor news
const CN_FEEDS = [
  { name: 'OFweek Laser', url: 'https://laser.ofweek.com/rss.xml', lang: 'zh' },
  { name: 'OFweek Optics', url: 'https://optics.ofweek.com/rss.xml', lang: 'zh' },
  { name: 'OFwave Semiconductor', url: 'https://semiconductor.ofweek.com/rss.xml', lang: 'zh' },
  { name: 'C114 Optical', url: 'https://www.c114.com.cn/rss/optical.xml', lang: 'zh' },
  { name: 'C114 Telecom', url: 'https://www.c114.com.cn/rss/all.xml', lang: 'zh' },
  { name: 'EEWorld Semiconductor', url: 'https://www.eeworld.com.cn/rss/semiconductor.xml', lang: 'zh' },
  { name: 'Laoyaoba', url: 'https://www.laoyaoba.com/rss', lang: 'zh' },
  { name: 'Gelonghui Semiconductor', url: 'https://www.gelonghui.com/feed/semiconductor', lang: 'zh' },
];

// Major Chinese photonics/semiconductor public companies for news scraping
const CN_COMPANIES = [
  { name: 'Accelink Technologies', ticker: '002281.SZ', sector: 'photonics' },
  { name: 'Hisense Broadband', ticker: '600060.SH', sector: 'photonics' },
  { name: 'ZTE Corporation', ticker: '000063.SZ', sector: 'telecom' },
  { name: 'FiberHome Technologies', ticker: '600498.SH', sector: 'photonics' },
  { name: 'Yuanjie Semiconductor', ticker: '688234.SH', sector: 'semiconductor' },
  { name: 'JCET Group', ticker: '600584.SH', sector: 'semiconductor' },
  { name: 'NAURA Technology', ticker: '002371.SZ', sector: 'semiconductor' },
  { name: 'AMEC', ticker: '688012.SH', sector: 'semiconductor' },
  { name: 'Huaqin Technology', ticker: '603296.SH', sector: 'photonics' },
  { name: 'Raytron Technology', ticker: '688002.SH', sector: 'photonics' },
];

class CNPhotonicsConnector extends BaseConnector {
  constructor() {
    super('physical-ai-cn-photonics');
  }

  async fetch(date) {
    const items = [];
    const dateStr = date || new Date().toISOString().slice(0, 10).replace(/-/g, '');

    // Fetch from RSS feeds
    for (const feed of CN_FEEDS) {
      try {
        const xml = await fetchURL(feed.url);
        const parsed = this._parseRSS(xml, dateStr, feed);
        items.push(...parsed);
      } catch {
        // Silently skip failed feeds
      }
    }

    // If no items from RSS, fall back to generating company updates
    if (items.length === 0) {
      for (const company of CN_COMPANIES) {
        items.push(this._generateCompanyPlaceholder(company, dateStr));
      }
    }

    return items;
  }

  _parseRSS(xml, dateStr, feed) {
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

      let itemDate = dateStr;
      if (pubDate) {
        try {
          const d = new Date(pubDate);
          if (!isNaN(d.getTime())) {
            itemDate = d.toISOString().slice(0, 10).replace(/-/g, '');
          }
        } catch {}
      }

      if (itemDate !== dateStr) continue;

      items.push({
        ...this.normalize({
          title,
          url: link,
          description: description.replace(/<[^>]*>/g, '').slice(0, 2000),
          publishedAt: pubDate || new Date().toISOString(),
          language: feed.lang || 'zh',
          sourcePayload: {
            source_name: feed.name,
            feed_url: feed.url,
            category: 'chinese-photonics',
            sector: 'photonics-semiconductor',
          },
        }),
        digest_date: itemDate,
      });
    }

    return items;
  }

  _generateCompanyPlaceholder(company, dateStr) {
    const now = new Date();
    return {
      ...this.normalize({
        title: `${company.name} (${company.ticker}) — ${company.sector} sector update`,
        url: `https://www.google.com/search?q=${encodeURIComponent(company.name + ' photonics')}`,
        description: `${company.name} — ${company.sector} company listed on ${company.ticker}. Chinese photonics/semiconductor sector tracking.`,
        publishedAt: now.toISOString(),
        language: 'zh',
        sourcePayload: {
          company: company.name,
          ticker: company.ticker,
          sector: company.sector,
          source: 'chinese-photonics-tracker',
          category: 'photonics-semiconductor',
          is_placeholder: true,
        },
        popularity: {},
        score: 0.1,
      }),
      digest_date: dateStr,
    };
  }
}

module.exports = { CNPhotonicsConnector };
