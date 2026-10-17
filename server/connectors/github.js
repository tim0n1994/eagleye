/**
 * Eagleye — GitHub Trending Connector
 */

const { BaseConnector } = require('./base');
const { fetchURL } = require('../services/utils');

class GitHubConnector extends BaseConnector {
  constructor() {
    super('github-trending');
  }

  async fetch(date, options = {}) {
    // Accept canonical (YYYY-MM-DD) and compact (YYYYMMDD) day strings; the
    // old positional slice produced NaN day parts for canonical input and
    // crashed toISOString() with Invalid time value.
    const m = typeof date === 'string' ? date.match(/(\d{4})\D?(\d{2})\D?(\d{2})/) : null;
    const dateObj = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
    const baseMs = Number.isFinite(dateObj.getTime()) ? dateObj.getTime() : Date.now();
    const sevenDaysAgo = new Date(baseMs - 7 * 24 * 60 * 60 * 1000);
    const dateStr = sevenDaysAgo.toISOString().split('T')[0];
    
const searchUrl = `https://api.github.com/search/repositories?q=created:>${dateStr}+stars:>50&sort=stars&order=desc&per_page=25`;
    
    try {
      const body = await fetchURL(searchUrl);
      const data = JSON.parse(body);
      
      return (data.items || []).map(repo => {
        const dateStr2 = (repo.created_at || '').slice(0, 10).replace(/-/g, '');
        return {
          ...this.normalize({
            title: `${repo.full_name}: ${repo.description || ''}`,
            url: repo.html_url,
            description: repo.description || '',
            publishedAt: repo.created_at,
            language: 'en',
            sourcePayload: {
              repo_name: repo.full_name,
              owner: repo.owner?.login || '',
              repo: repo.name,
              stars: repo.stargazers_count || 0,
              forks: repo.forks_count || 0,
              language: repo.language || '',
              license: repo.license?.spdx_id || repo.license?.key || '',
              topics: repo.topics || [],
              open_issues: repo.open_issues_count || 0,
              watchers: repo.watchers_count || 0,
              description: repo.description || '',
              is_template: repo.is_template || false,
              has_pages: repo.has_pages || false,
              homepage: repo.homepage || '',
            },
            popularity: {
              stars: repo.stargazers_count || 0,
              forks: repo.forks_count || 0,
              stars_today: 0,
            },
            score: Math.log2(1 + (repo.stargazers_count || 0)),
          }),
          digest_date: dateStr2 || date,
        };
      });
    } catch (err) {
      if (options.limit !== undefined) throw err;
      console.error('GitHub fetch error:', err.message);
      return [];
    }
  }
}

module.exports = { GitHubConnector };
