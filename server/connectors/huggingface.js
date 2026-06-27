/**
 * Eagleye — Hugging Face Connector
 *
 * Fetches daily papers from Hugging Face API.
 */

const { BaseConnector } = require('./base');
const { fetchURL } = require('../services/utils');

class HuggingFaceConnector extends BaseConnector {
  constructor() {
    super('hugging-face');
  }

  async fetch(_date) {
    try {
      const body = await fetchURL('https://huggingface.co/api/daily_papers');
      const papers = JSON.parse(body).slice(0, 25);

      return papers.map(p => {
        const paperTitle = p.title || p.paper?.title || '';
        const paperSummary = p.summary || p.paper?.summary || '';
        const paperId = p.id || p.paper?.id || '';
        const pubDate = p.publishedAt || p.paper?.publishedAt || new Date().toISOString();
        const dateStr = _date;  // Use the requested date instead of paper publish date
        const authors = p.paper?.authors || [];
        const tasks = p.paper?.tasks || [];
        const paperUrl = p.paper?.url || '';

        return {
          ...this.normalize({
            title: paperTitle,
            url: `https://huggingface.co/papers/${paperId}`,
            description: paperSummary,
            publishedAt: pubDate,
            language: 'en',
            sourcePayload: {
              paperId: paperId,
              paperType: p.type || p.paper?.type || 'paper',
              upvotes: p.upvotes || p.paper?.upvotes || 0,
              numPages: p.paper?.num_pages || 0,
              authors,
              paperUrl,
              isOpenAccess: p.paper?.is_open_access || false,
              publishedAt: pubDate,
              tasks,
            },
            paperMetadata: {
              paper_id: paperId,
              provider: 'hugging-face',
              title: paperTitle,
              abstract: paperSummary,
              authors,
              categories: [],
              published_at: pubDate,
              landing_url: `https://huggingface.co/papers/${paperId}`,
              pdf_url: paperUrl,
              tasks,
              dedupe_key: paperId || paperTitle.toLowerCase().replace(/\s+/g, '-'),
              metadata: {
                upvotes: p.upvotes || p.paper?.upvotes || 0,
                numPages: p.paper?.num_pages || 0,
                isOpenAccess: p.paper?.is_open_access || false,
              },
            },
            popularity: { upvotes: p.upvotes || 0 },
            score: Math.log2(1 + (p.upvotes || 0)),
          }),
          digest_date: dateStr,
        };
      });
    } catch (err) {
      console.error('HuggingFace fetch error:', err.message);
      return [];
    }
  }
}

module.exports = { HuggingFaceConnector };
