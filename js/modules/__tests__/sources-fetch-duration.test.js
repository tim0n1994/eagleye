/**
 * Round 2 · ⑤ /sources 页展示每源抓取耗时 — 测试作者·耗时
 *
 * 契约（CTO 方案第⑤项："…/sources 页展示"）：
 *   /api/sources 行带 sources.last_fetch_duration_ms（整数毫秒，成功轮与
 *   失败轮都会写，见 server/services/__tests__/fetch-duration-summary.test.js）
 *   时，/sources 页卡片必须把耗时渲染成人类可读的统计项：
 *     - 4200ms  → "4.2s" / "4.2 s" / "4s" / "4200ms" 皆可（秒保留 ~1 位小数
 *                 或毫秒原样，不强制格式）；
 *     - 19000ms → "19s" / "19.0s" / "19000ms" 皆可；
 *     - null/undefined（从未测量，迁移后老行默认 NULL）→ 不渲染耗时项，
 *       页面其余统计照常，不得崩溃。
 *
 *   展示标记惯例（刻意宽松，与 D4 stale badge 测试同风格）：卡片里存在
 *   .source-stat（或 class 含 "duration"）的元素，其文本含 ⏱ 或
 *   "duration"/"耗时" 关键词（或 class 提示 duration），且带上面的数值。
 *   未修复代码完全不渲染耗时项 → 断言失败（RED）。
 *
 * 时间控制：时钟钉死 2026-10-20 01:00 Asia/Shanghai（= 2026-10-19T17:00Z，
 * 与服务端契约测试同一时刻），不依赖真实时钟。
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../pages/shared.js', async importOriginal => ({
  ...await importOriginal(),
  fetchJSON: vi.fn(),
}));
vi.mock('../i18n.js', () => ({ getLanguage: () => 'en', t: key => key }));
vi.mock('../router.js', () => ({ router: { onCleanup: vi.fn() } }));

import { fetchJSON } from '../pages/shared.js';
import { renderSources } from '../pages/sources.js';

const PREV_TZ = process.env.TZ;
process.env.TZ = 'Asia/Shanghai'; // 生产服务时区（01:00 CST pipeline）

// now = 2026-10-20 01:00 CST = 2026-10-19 17:00 UTC（钉死，非真实时钟）
const NOW = new Date('2026-10-19T17:00:00Z');

const SOURCES = [
  { id: 1, slug: 'fast-feed', label: 'Fast Feed', is_active: 1,
    today_items: 5, total_items: 90, last_fetched_at: '2026-10-19 16:30:00',
    last_fetch_duration_ms: 4200, trend: [] }, // 期望渲染 ~4.2s
  { id: 2, slug: 'slow-crawl', label: 'Slow Crawl', is_active: 1,
    today_items: 0, total_items: 120, last_fetched_at: '2026-10-19 16:00:00',
    last_fetch_duration_ms: 19000, trend: [] }, // 期望渲染 ~19s
  { id: 3, slug: 'never-measured', label: 'Never Measured', is_active: 1,
    today_items: 0, total_items: 45, last_fetched_at: '2026-10-19 15:00:00',
    last_fetch_duration_ms: null, trend: [] }, // 迁移后老行默认 NULL → 不渲染耗时项
  { id: 4, slug: 'legacy-payload', label: 'Legacy Payload', is_active: 1,
    today_items: 1, total_items: 30, last_fetched_at: '2026-10-19 16:45:00',
    trend: [] }, // 字段缺失（老 API payload）→ 同上，不渲染、不崩溃
];

// 数值匹配（宽松）：接受 "4.2s" / "4.2 s" / "4s" / "4200ms" 等
const DUR_4200 = /4[.,]2?\s*s\b|4200\s*ms/i;
const DUR_19000 = /19([.,]0?)?\s*s\b|19000\s*ms/i;

function durationStats(card) {
  if (!card) return [];
  return [...card.querySelectorAll('.source-stat, [class*="duration"]')]
    .filter(el => /⏱/.test(el.textContent) || /duration|耗时/i.test(el.textContent) || /duration/i.test(String(el.className)));
}

const cardFor = (label) => [...document.querySelectorAll('.source-card')]
  .find(card => card.textContent.includes(label));

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="pageContent"></div>';
  window.history.replaceState({}, '', '/');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  if (PREV_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = PREV_TZ;
});

describe('Round2 ⑤ — /sources 页展示每源抓取耗时', () => {
  it('renders a human-readable duration stat per source card from last_fetch_duration_ms', async () => {
    fetchJSON.mockResolvedValue({ sources: SOURCES });
    await renderSources({});

    const fast = cardFor('Fast Feed');
    expect(fast, '夹具自检：卡片已渲染').toBeDefined();
    expect(
      durationStats(fast).some(el => DUR_4200.test(el.textContent)),
      '4200ms 必须以人类可读形式展示（如 "⏱ 4.2s"；接受 4.2s/4s/4200ms）'
    ).toBe(true);

    const slow = cardFor('Slow Crawl');
    expect(
      durationStats(slow).some(el => DUR_19000.test(el.textContent)),
      '19000ms 必须以人类可读形式展示（接受 19s/19.0s/19000ms）'
    ).toBe(true);
  });

  it('renders no duration stat for null / missing last_fetch_duration_ms, without breaking the page', async () => {
    fetchJSON.mockResolvedValue({ sources: SOURCES });
    await renderSources({});

    // NULL（迁移后老行默认）与字段缺失（老 payload）都不渲染耗时项
    expect(durationStats(cardFor('Never Measured'))).toHaveLength(0);
    expect(durationStats(cardFor('Legacy Payload'))).toHaveLength(0);

    // 页面完整：4 张卡都在，常规统计未被破坏
    expect(document.querySelectorAll('.source-card')).toHaveLength(SOURCES.length);
    const fast = cardFor('Fast Feed');
    expect(fast.textContent).toMatch(/5\s+today/i);
    expect(fast.textContent).toMatch(/📊\s*90/);
  });
});
