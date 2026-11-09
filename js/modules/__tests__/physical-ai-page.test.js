import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPhysicalAI } from '../pages/papers.js';
import { setLanguage } from '../i18n.js';

const response = data => ({ ok: true, json: async () => data });
const categories = [
  { key: 'research', source_slug: 'physical-ai-arxiv', count: 32, is_active: 1 },
  { key: 'humanoid', source_slug: 'physical-ai-humanoid', count: 7, is_active: 1 },
  { key: 'open', source_slug: null, count: 0, is_active: 0 },
  { key: 'applications', source_slug: null, count: 0, is_active: 0 },
];
const baseItem = {
  id: 'pa-1', category: 'research', title: 'Dexterous manipulation', ai_title_zh: '灵巧操作研究',
  canonical_url: 'https://arxiv.org/abs/1234.5678', published_at: '2026-11-01T00:00:00Z',
  source_label: 'Physical AI — arXiv', source_slug: 'physical-ai-arxiv',
  one_liner: 'A new approach.', one_liner_zh: '一种新的方法。',
};
const feed = { status: 'ok', items: [baseItem], categories, stats: { total: 39 } };

beforeEach(() => {
  setLanguage('zh');
  window.history.replaceState(null, '', '/physical-ai');
  document.body.innerHTML = '<main id="pageContent"></main>';
  vi.stubGlobal('fetch', vi.fn(async () => response(feed)));
});

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('physical AI topic briefing', () => {
  it('shows real category counts, source status and localized, source-linked items', async () => {
    await renderPhysicalAI();
    const query = new URL(fetch.mock.calls[0][0], 'https://example.com').searchParams;
    expect(Object.fromEntries(query)).toMatchObject({ category: 'all', days: '30', limit: '24', offset: '0' });
    expect(document.querySelector('.education-hero h2').textContent).toBe('具身智能情报');
    const cards = [...document.querySelectorAll('.education-overview-card')];
    expect(cards).toHaveLength(4);
    expect(cards[0].textContent).toContain('32');
    expect(cards[2].textContent).toContain('信息源已停用');
    expect(document.querySelector('.education-results-count').textContent).toContain('39 条');
    expect(document.querySelector('.pa-item h3 a').textContent).toContain('灵巧操作研究');
    expect(document.querySelector('.pa-item h3 a').href).toBe(baseItem.canonical_url);
    expect(document.querySelector('.education-item-meta a').getAttribute('href')).toBe('/sources/physical-ai-arxiv');
    expect(document.querySelector('.pa-item time').getAttribute('datetime')).toBe(baseItem.published_at);
    expect(document.querySelector('.pa-item p').textContent).toContain('AI 摘要 一种新的方法。');
    expect(document.querySelector('.education-pagination a').getAttribute('href')).toContain('offset=24');
  });

  it('preserves the selected category and period when moving through filters', async () => {
    window.history.replaceState(null, '', '/physical-ai?category=humanoid&days=90&offset=24');
    await renderPhysicalAI();
    const query = new URL(fetch.mock.calls[0][0], 'https://example.com').searchParams;
    expect(Object.fromEntries(query)).toMatchObject({ category: 'humanoid', days: '90', offset: '24' });
    const research = new URL([...document.querySelectorAll('.education-filters a')].find(a => a.textContent.includes('研究论文')).href);
    expect(research.searchParams.get('days')).toBe('90');
    expect(research.searchParams.get('category')).toBe('research');
    expect(research.searchParams.has('offset')).toBe(false);
    expect(document.querySelector('.education-periods .is-active').textContent).toContain('90');
  });

  it('retains collection-date snapshots and clears the date when changing time range', async () => {
    window.history.replaceState(null, '', '/physical-ai?category=research&days=90&date=2026-11-01');
    await renderPhysicalAI();
    const query = new URL(fetch.mock.calls[0][0], 'https://example.com').searchParams;
    expect(query.get('date')).toBe('2026-11-01');
    expect(document.querySelector('#physicalDate').value).toBe('2026-11-01');
    expect(document.querySelector('.education-hero-note strong').textContent).toBe('2026-11-01');
    const period = new URL(document.querySelector('.education-periods a').href);
    expect(period.searchParams.has('date')).toBe(false);
    expect(period.searchParams.get('category')).toBe('research');
    const categoryLink = new URL(document.querySelectorAll('.education-filters a')[2].href);
    expect(categoryLink.searchParams.get('date')).toBe('2026-11-01');
  });

  it('explains an empty disabled source without inventing content', async () => {
    window.history.replaceState(null, '', '/physical-ai?category=open');
    fetch.mockResolvedValueOnce(response({ ...feed, items: [], stats: { total: 0 } }));
    await renderPhysicalAI();
    expect(document.querySelector('.education-empty').textContent).toContain('信息源当前已停用');
    expect(document.querySelectorAll('.pa-item')).toHaveLength(0);
  });

  it('shows archived items from a disabled source with their original summary', async () => {
    window.history.replaceState(null, '', '/physical-ai?category=open');
    const archived = { ...baseItem, source_slug: 'physical-ai-cn-photonics', one_liner: '', one_liner_zh: '', original_summary: '产业动态原文摘要' };
    fetch.mockResolvedValueOnce(response({ ...feed, items: [archived], stats: { total: 1 } }));
    await renderPhysicalAI();
    expect(document.querySelector('.pa-item')).not.toBeNull();
    expect(document.querySelector('.pa-item p').textContent).toContain('原文摘要 产业动态原文摘要');
    expect(document.querySelectorAll('.education-overview-card')[2].textContent).toContain('信息源已停用');
  });

  it('ignores an invalid collection date instead of requesting a malformed snapshot', async () => {
    window.history.replaceState(null, '', '/physical-ai?date=2026-02-30');
    await renderPhysicalAI();
    const query = new URL(fetch.mock.calls[0][0], 'https://example.com').searchParams;
    expect(query.has('date')).toBe(false);
    expect(document.querySelector('#physicalDate').value).toBe('');
  });

  it('escapes text and refuses unsafe original links', async () => {
    setLanguage('en');
    fetch.mockResolvedValueOnce(response({ ...feed, items: [{ ...baseItem, title: '<script>alert(1)</script>', canonical_url: 'javascript:alert(1)', one_liner: '<img src=x onerror=alert(1)>' }] }));
    await renderPhysicalAI();
    expect(document.querySelector('.pa-item h3').textContent).toContain('<script>');
    expect(document.querySelector('.pa-item h3 a')).toBeNull();
    expect(document.querySelector('.pa-item script')).toBeNull();
    expect(document.querySelector('.pa-item img')).toBeNull();
  });

  it('offers a working retry if the feed fails', async () => {
    fetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response(feed));
    await renderPhysicalAI();
    expect(document.querySelector('[role="alert"]').textContent).toContain('暂时无法加载');
    document.querySelector('#physicalRetry').click();
    await vi.waitFor(() => expect(document.querySelector('.pa-item')).not.toBeNull());
  });

  it('does not overwrite a newer filter result with an older response', async () => {
    let resolveFirst;
    fetch.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
    const first = renderPhysicalAI();
    window.history.replaceState(null, '', '/physical-ai?category=humanoid');
    await renderPhysicalAI();
    resolveFirst(response({ ...feed, items: [{ ...baseItem, title: 'Stale title', ai_title_zh: '过期标题' }] }));
    await first;
    expect(document.querySelector('.pa-item h3').textContent).toContain('灵巧操作研究');
  });
});
