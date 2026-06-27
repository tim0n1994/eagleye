/**
 * Eagleye — Product Hunt Connector
 *
 * Scrapes the Product Hunt homepage for today's featured products.
 * Supports official API via PRODUCT_HUNT_API_KEY env var, falls back to HTML scraping.
 */

const https = require('https');
const { BaseConnector } = require('./base');
const { fetchURL } = require('../services/utils');

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
        console.warn('Product Hunt API fetch failed, falling back to scraping:', err.message);
      }
    }

    // Fallback: scrape homepage
    return await this._fetchViaScraping(date);
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
    try {
      const html = await fetchURL('https://www.producthunt.com/');
      const items = [];

      // Try JSON-LD extraction first
      const jsonLdRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
      let match;
      while ((match = jsonLdRegex.exec(html)) !== null) {
        try {
          const parsed = JSON.parse(match[1]);
          if (parsed['@type'] === 'ItemList' && parsed.itemListElement) {
            for (const element of parsed.itemListElement) {
              const post = element.item || element;
              if (!post.name) continue;
              const now = new Date();
              const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
              if (date && dateStr !== date) continue;
              items.push(this._makeItem(post.name, post.url || '', post.description || '', now.toISOString(), dateStr));
            }
          }
        } catch { /* skip */ }
      }

      // Fallback: __NEXT_DATA__ or window.__INITIAL_STATE__
      if (items.length === 0) {
        const stateMatch = html.match(/<script[^>]*>window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})<\/script>/);
        if (stateMatch) {
          try {
            const state = JSON.parse(stateMatch[1]);
            const posts = state?.posts || state?.feed?.posts || state?.redux?.posts || [];
            const arr = Array.isArray(posts) ? posts : Object.values(posts);
            for (const post of arr) {
              if (!post.name) continue;
              const now = new Date();
              const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
              if (date && dateStr !== date) continue;
              items.push(this._makeItem(
                `${post.name}: ${post.tagline || ''}`,
                post.url || post.website || '',
                post.description || post.tagline || '',
                post.createdAt || now.toISOString(),
                dateStr,
                {
                  votes: post.votesCount || post.votes || 0,
                  icon_url: post.thumbnail?.url || post.icon?.url || '',
                }
              ));
            }
          } catch { /* skip */ }
        }
      }

      // Last resort: regex-based extraction from HTML
      if (items.length === 0) {
        console.warn('Product Hunt scraping: JSON-LD and __INITIAL_STATE__ extraction failed, using fragile regex fallback');
        const productRegex = /<a[^>]*href="\/posts\/([^"/]+)[^>]*>[\s\S]*?<img[^>]*alt="([^"]*)"[\s\S]*?<p[^>]*>([^<]*)<\/p>/gi;
        const seen = new Set();
        while ((match = productRegex.exec(html)) !== null) {
          const slug = match[1];
          if (seen.has(slug)) continue;
          seen.add(slug);
          const now = new Date();
          const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
          if (date && dateStr !== date) continue;
          items.push(this._makeItem(
            match[2] || slug,
            `https://www.producthunt.com/posts/${slug}`,
            (match[3] || '').replace(/<[^>]*>/g, '').trim(),
            now.toISOString(),
            dateStr,
            { slug }
          ));
        }
      }

      return items;
    } catch (err) {
      console.error('Product Hunt fetch error:', err.message);
      return [];
    }
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
