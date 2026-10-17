import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderSignals, renderSignalDetail } from '../pages/signals.js';
import { router } from '../router.js';
import { setLanguage } from '../i18n.js';
import { localDateStr } from '../utils.js';

const response = data => ({ ok: true, json: async () => data });
const signal = (id, fields = {}) => ({ item_id: id, title: `Signal ${id}`, signal_type: 'new_paper', alpha_score: 0.7, ...fields });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let signals;
let details;
let listResponse;

beforeEach(() => {
  router._runCleanups();
  setLanguage('en');
  window.history.replaceState(null, '', '/signals');
  document.body.innerHTML = '<main id="pageContent"></main>';
  signals = [];
  details = new Map();
  listResponse = null;
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (url === '/api/signal-types') return response({ types: [{ slug: 'new_paper', name: 'Paper', today_count: 999 }, { slug: 'new_repo', name: 'Repo', today_count: 888 }] });
    if (url === '/api/radar/audiences') return response({ audiences: [{ key: 'investor', label: 'Investor' }, { key: 'developer', label: 'Developer' }] });
    if (url.startsWith('/api/entities/momentum')) return response({ entities: [] });
    if (url.startsWith('/api/signals?')) return listResponse || response({ signals });
    if (url.startsWith('/api/signals/')) {
      const id = url.split('/').pop();
      return details.get(id)?.promise || response({ signal: signals.find(row => row.item_id === id) || signal(id) });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
});

afterEach(() => {
  router._runCleanups();
  vi.unstubAllGlobals();
});

const parsedLink = selector => {
  const url = new URL(document.querySelector(selector).href);
  expect(url.pathname).toBe('/signals');
  return Object.fromEntries(url.searchParams);
};

describe('signals page contracts', () => {
  it('offers an all-time recovery link without claiming the corpus is unscored', async () => {
    await renderSignals({ type: 'new_paper', audience: 'investor', range: '30' });
    expect(document.querySelector('.signal-empty-state').textContent).toContain('No signals match the current filters.');
    expect(parsedLink('.signal-empty-state a')).toEqual({ type: 'new_paper', audience: 'investor', range: '9999' });
    expect(document.querySelector('.signal-empty-state a[href="/settings"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Run enrichment');
    expect(document.querySelector('.signals-rising').textContent).toContain('Stored entity momentum');
    expect(document.querySelector('.signals-rising').textContent).toContain('update time unavailable');
    expect(fetch.mock.calls.some(([url]) => url === '/api/system/stats')).toBe(false);
    setLanguage('zh');
    await renderSignals({ type: 'new_paper', audience: 'investor' });
    expect(document.querySelector('.signal-empty-state').textContent).toContain('当前筛选条件下没有信号');
    expect(document.querySelector('.signals-rising').textContent).toContain('已保存实体动量');
  });

  it('preserves the other filters when switching type, audience and range', async () => {
    await renderSignals({ audience: 'investor', range: '30' });
    expect(parsedLink('.audience-tab')).toEqual({ range: '30' });
    expect(parsedLink('.signal-type-item:nth-of-type(2)')).toEqual({ type: 'new_paper', audience: 'investor', range: '30' });
    await renderSignals({ type: 'new_paper', audience: 'investor', range: '30' });
    expect(parsedLink('.signal-type-item')).toEqual({ audience: 'investor', range: '30' });
    expect(parsedLink('.audience-tab')).toEqual({ type: 'new_paper', range: '30' });
    expect(parsedLink('.range-tab')).toEqual({ type: 'new_paper', audience: 'investor', range: '1' });
    expect(parsedLink('.range-tab:nth-child(2)')).toEqual({ type: 'new_paper', audience: 'investor' });
    const exportUrl = document.querySelector('[download]').getAttribute('href');
    expect(fetch.mock.calls.some(([url]) => url === exportUrl)).toBe(true);
    expect(new URL(exportUrl, window.location.origin).searchParams.get('limit')).toBe('2000');
  });

  it('uses audience scores consistently and excludes unknown scores from averages and histogram', async () => {
    signals = [signal('a', { alpha_score: 0.9, alpha_score_audience: 0.2 }), signal('b', { alpha_score: 0.5, alpha_score_audience: 0.8 }), signal('c', { alpha_score: 0.99 })];
    await renderSignals({ audience: 'investor' });
    expect(document.querySelector('.signal-avg-alpha').textContent).toBe('0.50');
    expect(document.querySelector('.signal-top-alpha').textContent).toBe('0.80');
    expect([...document.querySelectorAll('.signal-card .signal-alpha')].map(el => el.textContent)).toEqual(['20', '80', '—']);
    expect(document.querySelector('[title="1 signals at <50"]')).not.toBeNull();
    expect(document.querySelector('[title="1 signals at 70-85"]')).not.toBeNull();
    expect(document.querySelector('.signal-sample-note').textContent).toContain('2 scored, 1 missing scores');
    expect(document.querySelector('.signal-type-item:nth-of-type(2) .st-count').textContent).toBe('3');
    expect(document.querySelector('.signal-quality-trend').textContent).toContain('No scored sample today');
    expect(document.body.textContent).not.toContain('NaN');
  });

  it('does not label missing dates or scores as declining and preserves genuine zero scores', async () => {
    signals = [signal('a', { alpha_score: null, digest_date: localDateStr() }), signal('b', { alpha_score: 0 })];
    await renderSignals({});
    expect(document.querySelector('.signal-avg-alpha').textContent).toBe('0.00');
    expect(document.querySelector('.signal-quality-trend').textContent).toContain('No scored sample today');
    signals = [signal('c', { alpha_score: null })];
    await renderSignals({});
    expect(document.querySelector('.signal-avg-alpha').textContent).toBe('—');
    expect(document.querySelector('[title="0 signals at <50"]')).not.toBeNull();
  });

  it('calculates today trend using the selected lens and real digest dates', async () => {
    signals = [signal('a', { digest_date: localDateStr(), alpha_score: 0.1, alpha_score_audience: 0.9 }), signal('b', { digest_date: '20000101', alpha_score: 0.9, alpha_score_audience: 0.1 })];
    await renderSignals({ audience: 'investor' });
    expect(document.querySelector('.signal-quality-trend').textContent).toContain('Rising today');
  });

  it('labels the capped sample and does not imply other type counts were fetched', async () => {
    signals = Array.from({ length: 2000 }, (_, i) => signal(String(i)));
    await renderSignals({ type: 'new_paper' });
    expect(document.querySelector('.signal-sample-note').textContent).toContain('Limit reached; more results may exist.');
    expect(document.querySelector('.signal-type-item:nth-of-type(3) .st-count').textContent).toBe('—');
  }, 60000);

  it('keeps the latest selected detail when responses arrive in reverse order', async () => {
    signals = [signal('a'), signal('b')];
    const a = deferred(), b = deferred();
    details.set('a', a); details.set('b', b);
    await renderSignals({});
    document.querySelector('[data-signal-id="b"]').click();
    b.resolve(response({ signal: signal('b') }));
    await vi.waitFor(() => expect(document.querySelector('#signalsDetail').textContent).toContain('Signal b'));
    a.resolve(response({ signal: signal('a') }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector('#signalsDetail').textContent).not.toContain('Signal a');
    expect(document.querySelector('.signal-card.selected').dataset.signalId).toBe('b');
  });

  it('does not overwrite the next page when list or detail loading finishes after cleanup', async () => {
    const pending = deferred();
    listResponse = pending.promise;
    const rendering = renderSignals({});
    await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => url.startsWith('/api/signals?'))).toBe(true));
    router._runCleanups();
    document.querySelector('#pageContent').innerHTML = '<h2>Next page</h2>';
    pending.resolve(response({ signals: [signal('a')] }));
    await rendering;
    expect(document.querySelector('#pageContent').textContent).toBe('Next page');
    const detail = deferred();
    details.set('a', detail);
    const fullRendering = renderSignalDetail({ id: 'a' });
    router._runCleanups();
    detail.resolve(response({ signal: signal('a') }));
    await fullRendering;
    expect(document.querySelector('.signal-detail-page')).toBeNull();
  });

  it('ignores an old detail error and renders missing detail dimensions as unknown', async () => {
    signals = [signal('a'), signal('b', { alpha_score: null })];
    const old = deferred();
    details.set('a', old);
    await renderSignals({});
    document.querySelector('[data-signal-id="b"]').click();
    await vi.waitFor(() => expect(document.querySelector('#signalsDetail').textContent).toContain('Signal b'));
    old.reject(new Error('<img src=x onerror=alert(1)>'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector('#signalsDetail').textContent).not.toContain('Error:');
    expect(document.querySelector('#signalsDetail').textContent).toContain('Base Alpha: —');
    expect(document.querySelector('#signalsDetail').textContent).not.toContain('NaN');
    expect(document.querySelector('#signalsDetail polygon[fill="var(--accent)"]')).toBeNull();
  });

  it('leaves detached detail untouched when the user navigates away', async () => {
    signals = [signal('a')];
    const pending = deferred();
    details.set('a', pending);
    await renderSignals({});
    const pane = document.querySelector('#signalsDetail');
    router._runCleanups();
    document.querySelector('#pageContent').innerHTML = '<h2>Other page</h2>';
    pending.resolve(response({ signal: signal('a') }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector('#pageContent').textContent).toBe('Other page');
    expect(pane.querySelector('.spinner')).not.toBeNull();
  });
});
