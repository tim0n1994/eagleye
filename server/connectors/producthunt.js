/**
 * Eagleye — Product Hunt Connector
 *
 * Scrapes the Product Hunt homepage for today's featured products.
 * Supports official API via PRODUCT_HUNT_API_KEY env var, falls back to HTML scraping.
 */

const https = require('https');
const { BaseConnector } = require('./base');
const { fetchURL } = require('../services/utils');

// Cloudflare 现在对 EagleyeBot 和无头请求直接 403（JS challenge），
// 首页抓取已不可用。Product Hunt 官方提供 Atom feed（/feed），用浏览器 UA
// 可稳定拉取，这是目前最可靠的无 API-key 途径。
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/atom+xml,application/xml,text/xml,*/*;q=0.8',
};

class ProductHuntConnector extends BaseConnector {
  constructor() {
    super('product-hunt');
  }

  async fetch(date) {
    // Try official API first if key is configured
    const apiKey = process.env.PRODUCT_HUNT_API_KEY;
    if (apiKey) {
      try {
        return await this._fetchViaAPI(apiKey, date);
      } catch (err) {
        console.warn('Product Hunt API fetch failed, falling back to Atom feed:', err.message);
      }
    }

    // Fallback: official Atom feed (Cloudflare blocks direct HTML scraping now)
    return await this._fetchViaFeed(date);
  }

  async _fetchViaFeed(date) {
    try {
      const xml = await fetchURL('https://www.producthunt.com/feed', { headers: BROWSER_HEADERS });
      const items = [];
      // Atom <entry> parsing — regex is robust enough for this stable feed schema.
      const entryRe = /<entry>[\s\S]*?<\/entry>/g;
      let m;
      while ((m = entryRe.exec(xml)) !== null) {
        const entry = m[0];
        const title = this._tagText(entry, 'title');
        const link = (entry.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/) ||
          entry.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
        const published = this._tagText(entry, 'published');
        const contentHtml = this._tagText(entry, 'content');
        // Feed content is HTML; strip tags for a plain-text description.
        const desc = contentHtml.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').trim().slice(0, 300);
        if (!title) continue;

        const pubDate = published ? new Date(published) : new Date();
        const dateStr = pubDate.toISOString().slice(0, 10).replace(/-/g, '');
        if (date && dateStr !== date) continue;

        items.push(this._makeItem(title, link, desc, pubDate.toISOString(), dateStr));
      }
      return items;
    } catch (err) {
      console.error('Product Hunt feed fetch error:', err.message);
      return [];
    }
  }

  /** Extract inner text of the first <tag>…</tag> in a fragment. */
  _tagText(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
  }

  async _fetchViaAPI(apiKey, date) {
    const query = JSON.stringify({
      query: `{
        posts(order: VOTES, first: 25) {
          edges {
            node {
              id, name, tagline, url, votesCount, createdAt
              website, description
              thumbnail { url }
              topics { edges { node { name } } }
            }
          }
        }
      }`
    });

    const body = await this._postJSON('https://api.producthunt.com/v2/api/graphql', {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }, query);

    const data = JSON.parse(body);
    const posts = data?.data?.posts?.edges?.map(e => e.node) || [];

    return posts.map(post => {
      const postDate = new Date(post.createdAt);
      const dateStr = postDate.toISOString().slice(0, 10).replace(/-/g, '');
      if (date && dateStr !== date) return null;

      return {
        ...this.normalize({
          title: `${post.name}: ${post.tagline}`,
          url: post.url || post.website || `https://www.producthunt.com/posts/${post.id}`,
          description: post.description || post.tagline || '',
          publishedAt: post.createdAt,
          sourcePayload: {
            phId: post.id,
            name: post.name,
            tagline: post.tagline,
            rank: 0,
            votes: post.votesCount || 0,
            icon_url: post.thumbnail?.url || '',
            website: post.website || '',
            topics: post.topics?.edges?.map(e => e.node.name) || [],
          },
          popularity: { votes: post.votesCount || 0 },
          score: Math.log2(1 + (post.votesCount || 0)),
        }),
        digest_date: dateStr,
      };
    }).filter(Boolean);
  }

  async _postJSON(url, headers, body) {
    const parsed = new URL(url);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname,
        method: 'POST',
        headers,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(body);
      req.end();
    });
  }

  async _fetchViaScraping(date) {
    // Deprecated: Cloudflare now blocks all non-JS clients on the homepage.
    // Kept as a no-op stub for API parity; prefer _fetchViaFeed.
    return [];
  }

  _makeItem(title, url, description, publishedAt, dateStr, extra = {}) {
    const base = this.normalize({
      title,
      url,
      description,
      publishedAt,
      sourcePayload: {
        name: title.split(':')[0].trim(),
        votes: extra.votes || 0,
        icon_url: extra.icon_url || '',
        ...(extra.slug ? { slug: extra.slug } : {}),
      },
      popularity: { votes: extra.votes || 0 },
      score: extra.votes ? Math.log2(1 + extra.votes) : 0,
    });
    return { ...base, digest_date: dateStr };
  }
}

module.exports = { ProductHuntConnector };
