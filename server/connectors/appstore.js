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
const { fetchURL, isRetryableFetchError, currentFetchDeadline } = require('../services/utils');
const { compactDigestDate, todayDigestDate } = require('../services/date-contract');

class AppStoreBaseConnector extends BaseConnector {
  constructor(slug, chartType, country) {
    super(slug);
    this.chartType = chartType || 'top-free';
    this.country = country || 'us';
  }

  async fetch(date, opts = {}) {
    // Top-paid alone has the legacy fallback; other charts retain this
    // release's existing propagate-errors behavior.
    if (this.chartType === 'top-paid') {
      return this._fetchTopPaid(date, opts);
    }

    const url = `https://rss.marketingtools.apple.com/api/v2/${this.country}/apps/${this.chartType}/25/apps.json`;
    const body = await fetchURL(url, { signal: opts.signal });
    const data = JSON.parse(body);
    const results = data?.feed?.results || [];
    return this._normalizeApps(results, date);
  }

  async _fetchTopPaid(date, opts = {}) {
    try {
      const url = `https://rss.marketingtools.apple.com/api/v2/${this.country}/apps/top-paid/25/apps.json`;
      // Keep time in the source's overall budget for the alternate feed.
      const sourceDeadline = typeof currentFetchDeadline === 'function' ? currentFetchDeadline() : null;
      const primaryDeadline = Math.min(Date.now() + 12000, sourceDeadline === null ? Infinity : sourceDeadline - 15000);
      const body = await fetchURL(url, { signal: opts.signal, timeoutMs: 12000, deadline: primaryDeadline });
      const data = JSON.parse(body);
      const results = data?.feed?.results;
      if (!Array.isArray(results) || !results.length || results.some(app => !app || !app.id || !app.name)) {
        throw new Error('App Store top-paid response missing valid results', { cause: data });
      }
      return this._normalizeApps(results, date);
    } catch (primaryErr) {
      // A cancellation is a caller decision. Never turn it into another
      // request, and never mask it as empty success.
      opts.signal?.throwIfAborted();
      if (!isRetryableFetchError(primaryErr)) throw primaryErr;

      const url = `https://itunes.apple.com/${this.country}/rss/toppaidapplications/limit=25/json`;
      try {
        const body = await fetchURL(url, { signal: opts.signal });
        const data = JSON.parse(body);
        const results = data?.feed?.entry;
        if (!Array.isArray(results) || !results.length) throw new Error('Apple legacy top-paid response missing entries', { cause: primaryErr });
        const apps = results.map((entry) => this._legacyTopPaidApp(entry));
        if (apps.some(app => !app.id || !app.name)) throw new Error('Apple legacy top-paid response contains invalid entries', { cause: primaryErr });
        return this._normalizeApps(apps, date);
      } catch (fallbackErr) {
        console.error(`App Store top-paid fallback error (${this.slug}):`, fallbackErr.message);
        throw fallbackErr;
      }
    }
  }

  _normalizeApps(results, date) {
    const now = new Date();
    // D2: chart data is current-only (no per-item publish timestamps), so
    // items are judged against fetch time — always inside the freshness
    // window — and digest_date takes the requested digest date instead of
    // UTC today.
    const digestDate = date || compactDigestDate(todayDigestDate());

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
      digest_date: digestDate,
    }));
  }

  _legacyTopPaidApp(entry) {
    const links = Array.isArray(entry?.link) ? entry.link : entry?.link ? [entry.link] : [];
    const alternateLink = links.find((link) => link?.attributes?.rel === 'alternate' && link?.attributes?.href);
    const htmlLink = links.find((link) => link?.attributes?.href);
    const image = Array.isArray(entry?.['im:image'])
      ? entry['im:image'].find((item) => item?.attributes?.height === '100') || entry['im:image'].at(-1)
      : entry?.['im:image'];

    return {
      id: entry?.id?.attributes?.['im:id'],
      name: entry?.['im:name']?.label || '',
      artistName: entry?.['im:artist']?.label || '',
      url: alternateLink?.attributes?.href || htmlLink?.attributes?.href || entry?.id?.label || '',
      artistUrl: entry?.['im:artist']?.attributes?.href || '',
      genres: [{ name: entry?.category?.attributes?.label || entry?.category?.attributes?.term || '' }],
      artworkUrl100: image?.label || '',
      releaseDate: entry?.['im:releaseDate']?.label || '',
      kind: entry?.kind?.label || 'app',
      contentAdvisoryRating: entry?.contentAdvisoryRating?.label || '',
    };
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
