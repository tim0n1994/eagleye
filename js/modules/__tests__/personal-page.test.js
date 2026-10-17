import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderForYou } from '../pages/personal.js';
import { setLanguage } from '../i18n.js';

vi.mock('../router.js', () => ({ router: { onCleanup: vi.fn() } }));

describe('For-You metric presentation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
    document.body.innerHTML = '<main id="pageContent"></main>';
    window.history.replaceState({}, '', '/for-you?days=7');
    vi.stubGlobal('fetch', vi.fn(async url => ({
      ok: true,
      json: async () => String(url).includes('/for-you?') ? {
        items: [0.9, 0.7, 0.4].map((alpha, index) => ({
          id: `item-${index}`, title: `Item ${index}`, alpha_score: alpha,
          signal_type: 'model_release', source_slug: 'hacker-news', source_label: 'HN',
          canonical_url: `https://example.com/${index}`, relevance: alpha,
          published_at: ['2026-09-08T10:00:00Z', '2026-09-06T12:00:00Z', '2026-09-04T12:00:00Z'][index],
        })),
        profile: {},
      } : { profile: { types: {}, entities: [] } },
    })));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it.each([
    ['en', 'High-Alpha share (≥ 0.70)', 'Alpha Priority Distribution', 'Freshness Distribution'],
    ['zh', '高 Alpha 占比（≥ 0.70）', 'Alpha 优先级分布', '新鲜度分布'],
  ])('renders truthful ranking metrics and one freshness block in %s', async (language, shareLabel, heatmapLabel, freshnessLabel) => {
    setLanguage(language);
    await renderForYou({});

    const page = document.getElementById('pageContent');
    expect(page.querySelectorAll('.fy-card')).toHaveLength(3);
    const share = [...page.querySelectorAll('.metric-stat')].find(stat => stat.textContent.includes(shareLabel));
    expect(share).toBeDefined();
    expect(share.querySelector('.metric-stat-value').textContent).toBe('67%');
    expect(page.textContent).toContain(heatmapLabel);
    expect(page.textContent).toContain(language === 'zh' ? 'Alpha 用于排列阅读优先级' : 'Alpha ranks reading priority');
    expect(page.textContent).not.toMatch(/Confidence|Cross-Val|置信|交叉验证/);
    const activity = page.querySelector('#readingHeatmap');
    expect(activity.textContent).toContain(language === 'zh' ? '按日阅读记录尚不可用。' : 'Daily reading history is not available yet.');
    expect(activity.querySelectorAll('[title], svg')).toHaveLength(0);
    expect([...page.querySelectorAll('h3')].filter(heading => heading.textContent === freshnessLabel)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith('/api/for-you?sinceDays=7&limit=60');
  });
});
