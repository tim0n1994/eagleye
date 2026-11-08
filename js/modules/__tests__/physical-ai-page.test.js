import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPhysicalAI } from '../pages/papers.js';
import { setLanguage } from '../i18n.js';

const response = data => ({ ok: true, json: async () => data });
const sectionUrl = slug => `/api/items?source=${slug}&limit=10&sort=recent&dedupe=1&exclude_placeholders=1`;
const SLUGS = ['physical-ai-arxiv', 'physical-ai-humanoid', 'physical-ai-cn-photonics', 'physical-ai-sec-8k'];

const baseItem = {
  id: 'pa-1',
  title: 'Latent RL Priors for Data-Efficient Dexterous Manipulation',
  ai_title_zh: '面向灵巧操作的强化先验',
  canonical_url: 'https://arxiv.org/abs/1234.5678',
  published_at: new Date().toISOString(),
  source_label: 'Physical AI — arXiv',
  source_slug: 'physical-ai-arxiv',
  ai_summary: { one_liner: 'Reinforcement priors cut demo needs.', one_liner_zh: '强化先验降低演示数据需求。' },
};

let failSlugs;

beforeEach(() => {
  setLanguage('en');
  window.history.replaceState(null, '', '/physical-ai');
  document.body.innerHTML = '<main id="pageContent"></main>';
  failSlugs = new Set();
  vi.stubGlobal('fetch', vi.fn(async url => {
    const hit = SLUGS.find(slug => url === sectionUrl(slug));
    if (!hit) throw new Error(`Unexpected request: ${url}`);
    if (failSlugs.has(hit)) throw new Error('boom');
    const items = hit === 'physical-ai-arxiv' ? [{ ...baseItem }] : [];
    return response({ status: 'ok', items });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('renderPhysicalAI', () => {
  it('requests recent, deduplicated, placeholder-free items for every section', async () => {
    await renderPhysicalAI({});
    await vi.waitFor(() => {
      for (const slug of SLUGS) {
        expect(fetch.mock.calls.some(([url]) => url === sectionUrl(slug))).toBe(true);
      }
    });
    expect(fetch.mock.calls.every(([url]) => url.includes('exclude_placeholders=1'))).toBe(true);
    expect(fetch.mock.calls.every(([url]) => url.includes('sort=recent&dedupe=1'))).toBe(true);
  });

  it('links every section title to its source archive', async () => {
    await renderPhysicalAI({});
    await vi.waitFor(() => expect(document.querySelectorAll('.pa-section-title-link').length).toBe(SLUGS.length));
    const hrefs = [...document.querySelectorAll('.pa-section-title-link')].map(a => a.getAttribute('href'));
    expect(hrefs).toEqual(SLUGS.map(slug => '/sources/' + slug));
  });

  it('renders title, link, timestamp and summary', async () => {
    await renderPhysicalAI({});
    await vi.waitFor(() => expect(document.querySelector('.pa-item-title')).not.toBeNull());
    const link = document.querySelector('.pa-item-title');
    expect(link.textContent).toContain('Latent RL Priors');
    expect(link.href).toBe('https://arxiv.org/abs/1234.5678');
    expect(document.querySelector('.pa-item-time').getAttribute('datetime')).toBe(baseItem.published_at);
    expect(document.querySelector('.pa-item-summary').textContent).toContain('Reinforcement priors');
    expect(document.querySelector('.pa-summary-label').textContent).toBe('AI summary');
    expect(document.querySelector('.pa-freshness').textContent).toContain('Latest');
  });

  it('passes the selected collection date to each source', async () => {
    window.history.replaceState(null, '', '/physical-ai?date=2026-11-01');
    vi.stubGlobal('fetch', vi.fn(async () => response({ items: [] })));
    await renderPhysicalAI({});
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(fetch.mock.calls.every(([url]) => url.endsWith('&date=2026-11-01'))).toBe(true);
    expect(document.querySelector('#physicalDate').value).toBe('2026-11-01');
  });

  it('renders four sections with honest empty states', async () => {
    await renderPhysicalAI({});
    await vi.waitFor(() => expect(document.querySelectorAll('.pa-empty').length).toBe(3));
    expect(document.querySelectorAll('.pa-section').length).toBe(4);
    const emptyTexts = [...document.querySelectorAll('.pa-empty')].map(el => el.textContent);
    expect(emptyTexts.filter(text => text.includes('No items available')).length).toBe(1);
    expect(emptyTexts.filter(text => text.includes('No SEC filings available')).length).toBe(1);
    expect(emptyTexts.filter(text => text.includes('No content available from this source yet.')).length).toBe(1);
    expect(document.querySelector('[data-slug="physical-ai-sec-8k"] .pa-empty').textContent)
      .toContain('No SEC filings available.');
  });

  it('uses zh source labels, zh item title and zh empty note under the zh locale', async () => {
    setLanguage('zh');
    await renderPhysicalAI({});
    await vi.waitFor(() => expect(document.querySelector('.pa-item-title')).not.toBeNull());
    expect(document.querySelector('.pa-section-title').textContent).toBe('具身智能 · arXiv');
    expect(document.querySelector('.pa-item-title').textContent).toBe('面向灵巧操作的强化先验');
    expect(document.querySelector('.pa-item-summary').textContent).toContain('强化先验降低演示数据需求。');
    expect(document.querySelector('.pa-summary-label').textContent).toBe('AI 摘要');
    expect(document.querySelector('.pa-freshness').textContent).toContain('最新');
    expect(document.querySelector('[data-slug="physical-ai-cn-photonics"] .pa-empty').textContent).toBe('该源暂无可用资讯。');
    expect(document.querySelector('[data-slug="physical-ai-sec-8k"] .pa-empty').textContent).toBe('暂无 SEC 申报记录，请在信息源中查看状态。');
  });

  it('escapes html in titles and summaries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      items: [{ ...baseItem, title: '<script>alert("x")</script>', ai_summary: { one_liner: '<img src=x onerror=alert(1)>' } }],
    })));
    await renderPhysicalAI({});
    await vi.waitFor(() => expect(document.querySelector('.pa-item-title')).not.toBeNull());
    expect(document.querySelector('.pa-grid script')).toBeNull();
    expect(document.querySelector('.pa-grid img')).toBeNull();
    expect(document.querySelector('.pa-item-title').textContent).toContain('<script>');
  });

  it('shows an error state with a working retry', async () => {
    failSlugs.add('physical-ai-arxiv');
    await renderPhysicalAI({});
    await vi.waitFor(() => expect(document.querySelector('.pa-retry')).not.toBeNull());
    expect(document.querySelector('.pa-error').textContent).toContain('boom');

    failSlugs.delete('physical-ai-arxiv');
    document.querySelector('.pa-retry').click();
    await vi.waitFor(() => expect(document.querySelector('.pa-item-title')).not.toBeNull());
    expect(document.querySelector('.pa-error')).toBeNull();
    expect(fetch.mock.calls.filter(([url]) => url === sectionUrl('physical-ai-arxiv')).length).toBeGreaterThanOrEqual(2);
  });
});
