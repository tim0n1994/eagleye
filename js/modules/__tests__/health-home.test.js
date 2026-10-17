import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../pages/shared.js', async importOriginal => ({
  ...await importOriginal(),
  fetchJSON: vi.fn(),
}));
vi.mock('../i18n.js', () => ({ getLanguage: () => 'en', t: key => key }));
vi.mock('../router.js', () => ({ router: { onCleanup: vi.fn() } }));

import { fetchJSON } from '../pages/shared.js';
import { renderHome } from '../pages/home.js';
import { refreshSystemHealth } from '../pages/settings-panels.js';
import { router } from '../router.js';

const stats = {
  total_items: 100, summaries: 30, enrichment_success: 30, enrichment_backlog: 10, enrichment_exhausted: 60,
  scored: 20, uncategorized: 5, entities: 3, research_reports: 0, kg_features: 10,
  server_date: '2026-09-08', latest_digest_date: '2026-08-01', data_freshness: { status: 'stale', age_days: 38 },
};
let observerCallback;
let observerDisconnect;
beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="pageContent"></div><div id="systemHealthPanel"></div>';
  window.history.replaceState({}, '', '/');
  observerDisconnect = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    disconnect() { observerDisconnect(); }
  });
  vi.stubGlobal('CSS', { escape: text => text });
});
afterEach(() => vi.unstubAllGlobals());

describe('system health rendered output', () => {
  it('renders 30% success and exposes exhausted work and stale actual data', async () => {
    fetchJSON.mockResolvedValue({ stats: { ...stats, connectors: [{
      label: 'Source', items_7d: 0, total_items: 100, last_fetched_at: '2026-09-08T09:00:00Z',
      latest_digest_date: '2026-08-01', data_freshness: { status: 'stale', age_days: 38 },
    }] } });
    await refreshSystemHealth();
    const panel = document.getElementById('systemHealthPanel');
    expect(panel.textContent).toContain('30%');
    expect(panel.textContent).not.toContain('90%');
    expect(panel.textContent).toContain('Retries exhausted: 60');
    expect(panel.textContent).toContain('Stale · 38 days old');
    expect(panel.textContent).toContain('2026-08-01');
  });

  it('shows no data for an empty database and unknown on request failure', async () => {
    fetchJSON.mockResolvedValue({ stats: { total_items: 0, summaries: 0, data_freshness: { status: 'empty' } } });
    await refreshSystemHealth();
    expect(document.getElementById('systemHealthPanel').textContent).toContain('No data; coverage is not applicable');
    expect(document.getElementById('systemHealthPanel').textContent).not.toContain('100%');
    fetchJSON.mockRejectedValue(new Error('HTTP 503'));
    await refreshSystemHealth();
    expect(document.getElementById('systemHealthPanel').textContent).toContain('System status unknown');
  });

  it('distinguishes vector types and preserves fractional coverage', async () => {
    fetchJSON.mockResolvedValue({ stats: { ...stats, total_items: 41008, enrichment_success: 40991, kg_features: 18401,
      vector_models: [
        { model_name: 'eagleye-hash-v1', vector_type: 'semantic-lite', kind: 'hash', items: 18836 },
        { model_name: 'eagleye-hash-v1', vector_type: 'semantic-hash', kind: 'hash', items: 9977 },
      ],
    } });
    await refreshSystemHealth();
    const panel = document.getElementById('systemHealthPanel');
    expect(panel.textContent).toContain('99.96%');
    expect(panel.textContent).toContain('44.87%');
    expect(panel.textContent).not.toContain('100%');
    const vectorRows = [...panel.querySelectorAll('p')].filter(row => row.textContent.includes('eagleye-hash-v1'));
    expect(vectorRows).toHaveLength(2);
    expect(vectorRows[0].textContent).toContain('eagleye-hash-v1 · semantic-lite');
    expect(vectorRows[1].textContent).toContain('eagleye-hash-v1 · semantic-hash');
  });

  it('reserves 100% for complete coverage even at the rounding boundary', async () => {
    fetchJSON.mockResolvedValue({ stats: { ...stats, total_items: 100000, enrichment_success: 99999, kg_features: 100000 } });
    await refreshSystemHealth();
    const metrics = [...document.querySelectorAll('#systemHealthPanel .metric-stat')];
    expect(metrics.find(metric => metric.textContent.includes('Enriched')).textContent).toContain('>99.99%');
    expect(metrics.find(metric => metric.textContent.includes('KG feature coverage')).textContent).toContain('100%');
  });
});

function installHomeResponses({ empty = false, failStats = false, paginate = false } = {}) {
  const items = Array.from({ length: paginate ? 60 : 1 }, (_, i) => ({
    id: `item-${i}`, title: `Historic item ${i}`, source_label: 'Source', source_slug: 'source',
    digest_date: '2026-08-01', canonical_url: 'https://example.com',
  }));
  fetchJSON.mockImplementation(async url => {
    if (url === '/api/sources') return { sources: [{ id: 's', slug: 'source', label: 'Source', is_active: 1 }] };
    if (url === '/api/system/stats') {
      if (failStats) throw new Error('HTTP 503');
      return { stats: empty ? { ...stats, total_items: 0, latest_digest_date: null } : stats };
    }
    if (url.startsWith('/api/items?date=2026-09-08') || url.startsWith('/api/items?date=20260908')) return { items: [], total: 0 };
    if (url.includes('offset=60')) return { items: [{ ...items[0], id: 'item-60', title: 'Next page item' }], total: 61 };
    if (url.startsWith('/api/items?date=2026-08-01') || url.startsWith('/api/items?date=20260801')) return { items, total: paginate ? 61 : 200 };
    if (url === '/api/digest/coverage') return { coverage: {} };
    if (url.startsWith('/api/digest?')) return {};
    return { items: [], total: 0 };
  });
}

describe('home real render and pagination', () => {
  it('falls back to latest stored date, labels archive and loaded sample separately', async () => {
    installHomeResponses();
    await renderHome({});
    expect(fetchJSON).toHaveBeenCalledWith('/api/items?date=2026-08-01&limit=60');
    expect(document.getElementById('homeFreshnessNotice').textContent).toContain('ARCHIVE · 2026-08-01');
    expect(document.getElementById('homeLoadedCount').textContent).toContain('1 LOADED · 200 TOTAL FOR DATE');
    expect(document.getElementById('pageContent').textContent).toContain('Historic item 0');
    const navigate = vi.fn();
    window.__router = { navigate };
    window.__changeDate(1);
    expect(navigate).toHaveBeenCalledWith('/news/20260802');
  });

  it('appends from offset60 into source feed without duplicating initial items', async () => {
    installHomeResponses({ paginate: true });
    await renderHome({});
    await observerCallback([{ isIntersecting: true }]);
    expect(fetchJSON).toHaveBeenCalledWith('/api/items?date=2026-08-01&offset=60&limit=40');
    expect(document.querySelector('#section-Source .feed-list').children).toHaveLength(61);
    expect(document.getElementById('homeLoadedCount').textContent).toContain('61 LOADED · 61 TOTAL');
    expect(observerDisconnect).toHaveBeenCalled();
    expect(router.onCleanup).toHaveBeenCalled();
  });

  it('keeps explicitly requested empty date and distinguishes empty from unknown', async () => {
    installHomeResponses();
    await renderHome({ date: '20260908' });
    expect(fetchJSON).not.toHaveBeenCalledWith('/api/items?date=2026-08-01&limit=60');
    expect(document.getElementById('homeFreshnessNotice').textContent).toBe('No items for this date.');
    installHomeResponses({ empty: true });
    await renderHome({});
    expect(document.getElementById('homeFreshnessNotice').textContent).toBe('No stored data.');
    installHomeResponses({ failStats: true });
    await renderHome({ date: '20260908' });
    expect(document.getElementById('homeFreshnessNotice').textContent).toContain('status unknown');
  });
});
