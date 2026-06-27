/**
 * Eagleye — arXiv Connector
 *
 * Fetches open preprints from arXiv Atom API and stores paper metadata.
 */

const { BaseConnector } = require('./base');
const { fetchURL } = require('../services/utils');

const SOURCE_CONFIG = {
  'physical-ai-arxiv': {
    query: 'all:"physical AI" OR all:"embodied AI" OR all:humanoid OR all:VLA OR cat:cs.RO',
    maxResults: 50,
  },
  'arxiv-ai': {
    query: 'cat:cs.AI OR cat:cs.LG OR cat:cs.CL OR cat:cs.CV OR cat:cs.RO OR cat:stat.ML',
    maxResults: 60,
  },
};

function stripTags(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function getTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXml(stripTags(match[1])) : '';
}

function getLinks(block) {
  const links = [];
  const re = /<link\s+([^>]*?)\/?>/gi;
  let match;
  while ((match = re.exec(block)) !== null) {
    const attrs = match[1];
    const href = attrs.match(/href=["']([^"']+)["']/i)?.[1] || '';
    const rel = attrs.match(/rel=["']([^"']+)["']/i)?.[1] || '';
    const title = attrs.match(/title=["']([^"']+)["']/i)?.[1] || '';
    const type = attrs.match(/type=["']([^"']+)["']/i)?.[1] || '';
    if (href) links.push({ href: decodeXml(href), rel, title, type });
  }
  return links;
}

function getAuthors(block) {
  const authors = [];
  const re = /<author>([\s\S]*?)<\/author>/gi;
  let match;
  while ((match = re.exec(block)) !== null) {
    const name = getTag(match[1], 'name');
    if (name) authors.push(name);
  }
  return authors;
}

function getCategories(block) {
  const categories = [];
  const re = /<category\s+([^>]*?)\/?>/gi;
  let match;
  while ((match = re.exec(block)) !== null) {
    const term = match[1].match(/term=["']([^"']+)["']/i)?.[1] || '';
    if (term) categories.push(term);
  }
  return categories;
}

function arxivIdFromUrl(url) {
  const clean = String(url || '').replace(/v\d+$/, '');
  return clean.split('/').pop() || '';
}

class ArxivConnector extends BaseConnector {
  constructor(slug) {
    super(slug);
    this.config = SOURCE_CONFIG[slug] || SOURCE_CONFIG['arxiv-ai'];
  }

  buildUrl() {
    const params = new URLSearchParams({
      search_query: this.config.query,
      sortBy: 'submittedDate',
      sortOrder: 'descending',
      max_results: String(this.config.maxResults || 50),
    });
    return `https://export.arxiv.org/api/query?${params.toString()}`;
  }

  async fetch(date) {
    try {
      const xml = await fetchURL(this.buildUrl());
      return this.parseAtom(xml, date);
    } catch (err) {
      console.error(`arXiv fetch error for ${this.slug}:`, err.message);
      return [];
    }
  }

  parseAtom(xml, date) {
    const entries = [];
    const re = /<entry>([\s\S]*?)<\/entry>/gi;
    let match;
    while ((match = re.exec(xml)) !== null) {
      const block = match[1];
      const idUrl = getTag(block, 'id');
      const title = getTag(block, 'title');
      const abstract = getTag(block, 'summary');
      const published = getTag(block, 'published') || new Date().toISOString();
      const updated = getTag(block, 'updated') || published;
      const authors = getAuthors(block);
      const categories = getCategories(block);
      const links = getLinks(block);
      const arxivId = arxivIdFromUrl(idUrl);
      const landingUrl = idUrl || `https://arxiv.org/abs/${arxivId}`;
      const pdfUrl = links.find(l => l.title === 'pdf' || l.type === 'application/pdf')?.href || `https://arxiv.org/pdf/${arxivId}`;
      const digestDate = date || published.slice(0, 10).replace(/-/g, '');

      if (!title || !landingUrl) continue;

      entries.push({
        ...this.normalize({
          id: arxivId,
          title,
          url: landingUrl,
          description: abstract,
          publishedAt: published,
          language: 'en',
          author: authors.join(', '),
          sourcePayload: {
            arxivId,
            provider: 'arxiv',
            categories,
            authors,
            updated,
            pdfUrl,
          },
          paperMetadata: {
            paper_id: arxivId,
            provider: 'arxiv',
            arxiv_id: arxivId,
            title,
            abstract,
            authors,
            categories,
            published_at: published,
            updated_at: updated,
            landing_url: landingUrl,
            pdf_url: pdfUrl,
            dedupe_key: arxivId,
            metadata: { query: this.config.query },
          },
          popularity: {},
          score: 1,
        }),
        digest_date: digestDate,
      });
    }
    return entries;
  }
}

module.exports = { ArxivConnector };
