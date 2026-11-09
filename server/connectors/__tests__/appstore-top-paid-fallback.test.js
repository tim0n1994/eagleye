// @vitest-environment node
/* global describe, it, expect */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const utils = require('../../services/utils');
const { normalizeDigestDate } = require('../../services/date-contract');
const { BaseConnector } = require('../base');

const SOURCE_URL = 'https://rss.marketingtools.apple.com/api/v2/us/apps/top-paid/25/apps.json';
const TOP_FREE_SOURCE_URL = 'https://rss.marketingtools.apple.com/api/v2/us/apps/top-free/25/apps.json';
const LEGACY_URL = 'https://itunes.apple.com/us/rss/toppaidapplications/limit=25/json';

class TestBaseConnector extends BaseConnector {
  getSourceId() {
    return this.slug;
  }
}

function primaryBody() {
  return JSON.stringify({ feed: { results: [
    { id: 'p1', name: 'Primary App', artistName: 'Primary Corp', url: 'https://apps.apple.com/us/app/idp1', genres: [{ name: 'Utilities' }] },
    { id: 'p2', name: 'Second App', artistName: 'Second Corp', url: 'https://apps.apple.com/us/app/idp2', genres: [{ name: 'Games' }] },
  ] } });
}

function legacyBody() {
  return JSON.stringify({ feed: { entry: [
    {
      id: { label: 'https://apps.apple.com/us/app/mock-app/id424242?uo=2', attributes: { 'im:id': '424242' } },
      'im:name': { label: 'Mock App' },
      'im:artist': { label: 'Mock Artist', attributes: { href: 'https://apps.apple.com/us/developer/mock/id99' } },
      link: [
        { attributes: { rel: 'alternate', type: 'text/html', href: 'https://apps.apple.com/us/app/mock-app/id424242' } },
      ],
      category: { attributes: { label: 'Productivity', term: 'Productivity' } },
      'im:image': [
        { label: 'https://example.com/image53.png', attributes: { height: '53' } },
        { label: 'https://example.com/image100.png', attributes: { height: '100' } },
      ],
      'im:releaseDate': { label: '2026-11-01T00:00:00Z' },
      kind: { label: 'Application' },
      contentAdvisoryRating: { label: '4+' },
    },
  ] } });
}

function loadAppstore(fetchURL) {
  const mod = { exports: {} };
  const context = {
    module: mod,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === './base') return { BaseConnector: TestBaseConnector };
      if (name === '../services/utils') return { ...utils, fetchURL };
      if (name === '../services/date-contract') return require('../../services/date-contract');
      throw new Error(`unexpected require: ${name}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../appstore.js'), 'utf8'), context, { filename: path.resolve(__dirname, '../appstore.js') });
  return mod.exports;
}

function harness({ primary = primaryBody(), legacy = legacyBody() } = {}) {
  const calls = [];
  const fetchURL = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (url === SOURCE_URL) {
      if (primary instanceof Error) throw primary;
      return primary;
    }
    if (url === TOP_FREE_SOURCE_URL) {
      if (primary instanceof Error) throw primary;
      return primary;
    }
    if (url === LEGACY_URL) {
      if (legacy instanceof Error) throw legacy;
      return legacy;
    }
    throw new Error(`unexpected url: ${url}`);
  };
  return { calls, ...loadAppstore(fetchURL) };
}

describe('App Store top-paid legacy RSS fallback', () => {
  it('does not call the fallback when the primary succeeds', async () => {
    const h = harness();
    const items = await new h.AppStoreTrendConnector().fetch('20261107');

    expect(h.calls.map((call) => call.url)).toEqual([SOURCE_URL]);
    expect(h.calls[0].timeoutMs).toBe(12000);
    expect(h.calls[0].deadline).toBeLessThanOrEqual(Date.now() + 12000);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Primary App — Primary Corp');
    expect(normalizeDigestDate(items[0].digest_date)).toBe('2026-11-07');
    expect(JSON.parse(items[0].source_payload)).toMatchObject({ app_id: 'p1', rank: 1, chart_type: 'top-paid' });
  });

  it('parses the legacy feed and preserves identity, artist, link, category, rank and digest date', async () => {
    const h = harness({ primary: Object.assign(new Error('Upstream 503: busy'), { upstreamStatus: 503 }) });
    const items = await new h.AppStoreTrendConnector().fetch('20261107');

    expect(h.calls.map((call) => call.url)).toEqual([SOURCE_URL, LEGACY_URL]);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Mock App — Mock Artist');
    expect(items[0].canonical_url).toBe('https://apps.apple.com/us/app/mock-app/id424242');
    const payload = JSON.parse(items[0].source_payload);
    expect(payload).toMatchObject({
      app_id: '424242',
      name: 'Mock App',
      developer: 'Mock Artist',
      developer_url: 'https://apps.apple.com/us/developer/mock/id99',
      category: 'Productivity',
      rank: 1,
      chart_type: 'top-paid',
      icon_url: 'https://example.com/image100.png',
      release_date: '2026-11-01T00:00:00Z',
      kind: 'Application',
      content_rating: '4+',
    });
    expect(normalizeDigestDate(items[0].digest_date)).toBe('2026-11-07');
  });

  it('rejects with the fallback error when both sources fail', async () => {
    const h = harness({
      primary: Object.assign(new Error('Request timeout'), { code: 'ETIMEDOUT' }),
      legacy: Object.assign(new Error('Upstream 502: bad gateway'), { upstreamStatus: 502 }),
    });

    await expect(new h.AppStoreTrendConnector().fetch('20261107')).rejects.toThrow('Upstream 502: bad gateway');
    expect(h.calls.map((call) => call.url)).toEqual([SOURCE_URL, LEGACY_URL]);
  });

  it.each([{}, { feed: { results: [] } }, { feed: { results: [{ id: '1' }] } }])('rejects an invalid or empty primary response without reporting success', async (body) => {
    const h = harness({ primary: JSON.stringify(body) });
    await expect(new h.AppStoreTrendConnector().fetch('20261107')).rejects.toThrow('missing valid results');
    expect(h.calls).toHaveLength(1);
  });

  it.each([{}, { feed: { entry: [] } }, { feed: { entry: [{ id: {} }] } }])('rejects an invalid or empty alternate response without reporting success', async (body) => {
    const h = harness({
      primary: Object.assign(new Error('Request timeout'), { code: 'ETIMEDOUT' }),
      legacy: JSON.stringify(body),
    });
    await expect(new h.AppStoreTrendConnector().fetch('20261107')).rejects.toThrow(/Apple legacy top-paid response/);
    expect(h.calls).toHaveLength(2);
  });

  it('does not call the fallback after cancellation', async () => {
    const controller = new AbortController();
    const failure = Object.assign(new Error('Request timeout'), { code: 'ETIMEDOUT' });
    const h = harness({ primary: failure, legacy: new Error('fallback must not run') });
    controller.abort(new Error('cancelled by caller'));

    await expect(new h.AppStoreTrendConnector().fetch('20261107', { signal: controller.signal }))
      .rejects.toThrow('cancelled by caller');
    expect(h.calls.map((call) => call.url)).toEqual([SOURCE_URL]);
  });

  it('keeps top-free on the origin direct-failure behavior and never uses the fallback', async () => {
    const h = harness({ primary: Object.assign(new Error('Upstream 503: busy'), { upstreamStatus: 503 }) });

    await expect(new h.AppStoreRankConnector().fetch('20261107')).rejects.toThrow('Upstream 503: busy');
    expect(h.calls.map((call) => call.url)).toEqual([TOP_FREE_SOURCE_URL]);
  });
});
