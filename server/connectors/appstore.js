/**
 * Eagleye — App Store Rank & Trend Connector
 *
 * Uses Apple's official RSS Feed Generator API for top charts.
 * - App Store Rank: top free, top paid, top grossing charts
 * - App Store Trend: top free with larger sample, tracks rank changes
 *
 * API: https://rss.marketingtools.apple.com/api/v2/{country}/apps/{chart-type}/{limit}/apps.json
 */

const { BaseConnector } = require('./base');
const { fetchURL } = require('../services/utils');

class AppStoreBaseConnector extends BaseConnector {
  constructor(slug, chartType, country) {
    super(slug);
    this.chartType = chartType || 'top-free';
    this.country = country || 'us';
  }

  async fetch(date) {
    try {
      const url = `https://rss.marketingtools.apple.com/api/v2/${this.country}/apps/${this.chartType}/50/apps.json`;
      const body = await fetchURL(url);
      const data = JSON.parse(body);
      const results = data?.feed?.results || [];
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');

      if (date && dateStr !== date) {
        // Provide a coherent response even if date doesn't match
        // (Apple API always returns current data, not historical)
      }

      return results.map((app, index) => ({
        ...this.normalize({
          title: `${app.name} — ${app.artistName}`,
          url: app.url || `https://apps.apple.com/${this.country}/app/id${app.id}`,
          description: `${app.name} by ${app.artistName}. ${this._chartLabel()} chart position #${index + 1}`,
          publishedAt: now.toISOString(),
          sourcePayload: {
            app_id: app.id,
            name: app.name,
            developer: app.artistName,
            developer_url: app.artistUrl || '',
            category: app.genres?.[0]?.name || app.primaryGenre?.name || '',
            country: this.country,
            rank: index + 1,
            chart_type: this.chartType,
            icon_url: app.artworkUrl100 || '',
            release_date: app.releaseDate || '',
            kind: app.kind || 'app',
            content_rating: app.contentAdvisoryRating || '',
          },
          popularity: { rank: index + 1, chart_type: this.chartType },
          score: Math.max(0, 50 - index) / 50,
        }),
        digest_date: dateStr,
      }));
    } catch (err) {
      console.error(`App Store fetch error (${this.slug}):`, err.message);
      return [];
    }
  }

  _chartLabel() {
    const labels = {
      'top-free': 'Top Free',
      'top-paid': 'Top Paid',
      'top-grossing': 'Top Grossing',
    };
    return labels[this.chartType] || this.chartType;
  }
}

class AppStoreRankConnector extends AppStoreBaseConnector {
  constructor() {
    super('app-store-rank', 'top-free', 'us');
  }
}

class AppStoreTrendConnector extends AppStoreBaseConnector {
  constructor() {
    // Apple deprecated top-grossing (404). top-paid provides a distinct
    // signal from app-store-rank (top-free) and is still supported.
    super('app-store-trend', 'top-paid', 'us');
  }
}

module.exports = { AppStoreRankConnector, AppStoreTrendConnector };
