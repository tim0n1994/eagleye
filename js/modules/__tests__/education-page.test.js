import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderEducation } from '../pages/education.js';
import { setLanguage } from '../i18n.js';

const response = data => ({ ok: true, json: async () => data });
const data = {
  items: [{ id: 'one', title: 'AI tutor helps students', title_zh: 'AI 助教帮助学生', url: 'https://example.com/one', source_label: 'Example', published_at: '2026-11-01T00:00:00Z', category: 'learning_product' }],
  categories: [{ key: 'learning_product', count: 1 }, { key: 'research', count: 2 }],
  stats: { total: 1 },
};

beforeEach(() => {
  setLanguage('zh');
  window.history.replaceState(null, '', '/ai-education?category=learning_product&days=90');
  document.body.innerHTML = '<main id="pageContent"></main>';
  vi.stubGlobal('fetch', vi.fn(async () => response(data)));
});

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('AI education page', () => {
  it('requests the chosen category and time range, with source-linked localized results', async () => {
    await renderEducation();
    const query = new URL(fetch.mock.calls[0][0], 'https://example.com').searchParams;
    expect(query.get('category')).toBe('learning_product');
    expect(query.get('days')).toBe('90');
    expect(document.querySelector('.education-item h3 a').textContent).toContain('AI 助教帮助学生');
    expect(document.querySelector('.education-item h3 a').href).toBe('https://example.com/one');
    expect(document.querySelector('.education-item-meta').textContent).toContain('Example');
    const research = new URL([...document.querySelectorAll('.education-filters a')].find(a => a.textContent.includes('研究')).href);
    expect(research.searchParams.get('days')).toBe('90');
    expect(research.searchParams.get('category')).toBe('research');
  });

  it('offers a retry on failure and does not turn unsafe URLs into links', async () => {
    fetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response({ ...data, items: [{ ...data.items[0], url: 'javascript:alert(1)' }] }));
    await renderEducation();
    expect(document.querySelector('[role="alert"]').textContent).toContain('暂时无法加载');
    document.querySelector('#educationRetry').click();
    await vi.waitFor(() => expect(document.querySelector('.education-item h3')).not.toBeNull());
    expect(document.querySelector('.education-item h3 a')).toBeNull();
  });
});
