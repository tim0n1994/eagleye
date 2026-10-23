/**
 * D4 stale-source red badge on /sources and the digest day view
 * (Round 1 decisions, ops scope).
 *
 * Contract under test:
 *   A source that is enabled (is_active, the only kind /api/sources returns)
 *   and whose last_fetched_at is older than 48h — or null, which counts as
 *   even older — must be flagged red wherever sources are surfaced:
 *     - the /sources page cards (js/modules/pages/sources.js renderSources)
 *     - the digest day view per-source sections (js/modules/pages/digest.js
 *       renderDigestDate), keyed off the sources cache (/api/sources rows
 *       already carry last_fetched_at via SELECT s.*).
 *
 *   Boundary semantics: strictly greater than 48h => red; exactly 48h is
 *   still fresh; null last_fetched_at is always red.
 *
 *   Stale marking convention for implementers (kept loose on purpose):
 *   the fixture accepts a 🔴 emoji in the rendered text OR a class/element
 *   hinting staleness ("stale"/"red" in the class name, or a descendant
 *   .stale/.source-stale/.stale-badge/.badge-red). On the unfixed code both
 *   pages render no stale marker at all, so the red assertions fail.
 *
 * Time control: the fixture pins the clock to 2026-10-20 01:00
 * Asia/Shanghai (= 2026-10-19T17:00:00Z) — the exact time the daily
 * pipeline fires — with faked now, so nothing depends on the real wall
 * clock. The two 01:00 CST boundary fixtures required by the brief are
 * Within Window (last fetch 47h ago — must stay unflagged) and
 * Stale Source (last fetch 49h ago — must be flagged).
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
import { renderDigestDate } from '../pages/digest.js';

const PREV_TZ = process.env.TZ;
process.env.TZ = 'Asia/Shanghai'; // production service timezone (01:00 CST scheduler)

// now = 2026-10-20 01:00 CST = 2026-10-19 17:00 UTC (faked, never the real clock)
const NOW = new Date('2026-10-19T17:00:00Z');
const HOUR_MS = 3600 * 1000;
const isoFromNow = (hours) => new Date(NOW.getTime() - hours * HOUR_MS).toISOString();

const SOURCES = [
  { id: 1, slug: 'fresh-today', label: 'Fresh Today', is_active: 1,
    today_items: 3, total_items: 90, last_fetched_at: isoFromNow(6) },
  // 01:00 CST boundary fixture #2: 49h since last successful fetch -> red
  { id: 2, slug: 'stale-49h', label: 'Stale Source', is_active: 1,
    today_items: 0, total_items: 120, last_fetched_at: isoFromNow(49) },
  // 01:00 CST boundary fixture #1: 47h since last successful fetch -> still fresh
  { id: 3, slug: 'within-47h', label: 'Within Window', is_active: 1,
    today_items: 0, total_items: 45, last_fetched_at: isoFromNow(47) },
  { id: 4, slug: 'never-fetched', label: 'Never Fetched', is_active: 1,
    today_items: 0, total_items: 30, last_fetched_at: null },
  { id: 5, slug: 'exactly-48h', label: 'Exact Boundary', is_active: 1,
    today_items: 0, total_items: 20, last_fetched_at: isoFromNow(48) },
  // SQLite datetime('now') format — "YYYY-MM-DD HH:MM:SS", UTC, no zone
  // marker — is what production /api/sources actually returns. These cover
  // lastFetchedMs()'s normalization branch: a naive local-time parse in
  // TZ=Asia/Shanghai would drift 8h and misjudge the boundary.
  { id: 6, slug: 'sqlite-fresh-41h', label: 'SQLite Fresh', is_active: 1,
    today_items: 0, total_items: 25, last_fetched_at: '2026-10-18 00:00:00' }, // now−41h UTC
  { id: 7, slug: 'sqlite-stale-49h', label: 'SQLite Stale', is_active: 1,
    today_items: 0, total_items: 35, last_fetched_at: '2026-10-17 16:00:00' }, // now−49h UTC
];

const digestItem = (slug, sourceLabel, title) => ({
  id: `${slug}-item-1`,
  title,
  source_label: sourceLabel,
  source_slug: slug,
  digest_date: '2026-10-19',
  canonical_url: `https://example.com/${slug}/1`,
});

function hasStaleMark(el) {
  if (!el) return false;
  if (el.textContent && el.textContent.includes('🔴')) return true;
  if (/(stale|red)/i.test(String(el.className))) return true;
  return Boolean(el.querySelector('.stale, .source-stale, .stale-badge, .badge-red'));
}

const cardFor = (label) => [...document.querySelectorAll('.source-card')]
  .find(card => card.textContent.includes(label));

const sectionFor = (label) => [...document.querySelectorAll('.source-section')]
  .find(section => section.textContent.includes(label));

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

describe('D4 stale-source red badge', () => {
  describe('/sources page (renderSources)', () => {
    it('flags sources with last_fetched_at older than 48h or null; 47h and exactly 48h stay fresh', async () => {
      fetchJSON.mockResolvedValue({ sources: SOURCES });
      await renderSources({});

      // must be red: 49h at the 01:00 CST boundary (currently renders 🟡 — nothing keys off last_fetched_at)
      expect(hasStaleMark(cardFor('Stale Source'))).toBe(true);
      // must be red: null last_fetched_at counts as even older
      expect(hasStaleMark(cardFor('Never Fetched'))).toBe(true);
      // must stay fresh: 47h at the 01:00 CST boundary
      expect(hasStaleMark(cardFor('Within Window'))).toBe(false);
      // must stay fresh: exactly 48h is not "older than 48h"
      expect(hasStaleMark(cardFor('Exact Boundary'))).toBe(false);
      // must stay fresh: fetched 6h ago
      expect(hasStaleMark(cardFor('Fresh Today'))).toBe(false);
    });

    it('parses SQLite datetime("YYYY-MM-DD HH:MM:SS") last_fetched_at as UTC (production /api/sources shape)', async () => {
      fetchJSON.mockResolvedValue({ sources: SOURCES });
      await renderSources({});

      // '2026-10-18 00:00:00' = now−41h UTC → fresh. A regression that drops
      // the UTC normalization would parse it as local CST (= now−49h) and
      // wrongly flag it red — this assertion catches that drift.
      expect(hasStaleMark(cardFor('SQLite Fresh'))).toBe(false);
      // '2026-10-17 16:00:00' = now−49h UTC → red.
      expect(hasStaleMark(cardFor('SQLite Stale'))).toBe(true);
    });
  });

  describe('digest day view (renderDigestDate)', () => {
    it('flags stale sources in the per-source sections based on the sources cache', async () => {
      fetchJSON.mockImplementation(async (url) => {
        if (url === '/api/sources') return { sources: SOURCES };
        if (url.startsWith('/api/digest?')) {
          return {
            digest: null,
            by_source: {
              'Stale Source': [digestItem('stale-49h', 'Stale Source', 'Stale fixture note')],
              'Fresh Today': [digestItem('fresh-today', 'Fresh Today', 'Fresh fixture note')],
            },
          };
        }
        if (url === '/api/digest/coverage') return { coverage: {} };
        return {};
      });

      await renderDigestDate({ slug: '2026-10-19' });

      expect(hasStaleMark(sectionFor('Stale Source'))).toBe(true);
      expect(hasStaleMark(sectionFor('Fresh Today'))).toBe(false);
    });
  });
});
