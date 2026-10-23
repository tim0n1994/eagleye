/**
 * Round 1.1 — /sources 🔴停摆 badge field selection (source health bookkeeping).
 *
 * Lane contract («标红读的是正确字段»):
 *   The ">48h" red badge must key off a field that dup-only fetch rounds
 *   actually refresh. Both render consumers share one helper —
 *   js/modules/pages/sources.js isStaleSource (used by renderSources at
 *   sources.js:72 and re-imported by the digest day view, digest.js:11/193/209)
 *   — and /api/sources carries every sources.* column via `SELECT s.*`
 *   (server/routes/sources.js:21, R0-09 comment :58-60), so the render layer
 *   has both `last_success_at` and `last_fetched_at` available per row.
 *
 * Round 1.1 semantic ruling (四种情形), for context:
 *   1) success with new items      → consecutive_empty=0, last_success_at
 *                                    refreshed, health 'healthy'
 *   2) success, all items deduped  → NOT an empty round: last_success_at is
 *                                    still refreshed (the source is alive),
 *                                    consecutive_empty unchanged
 *   3) success, zero items         → consecutive_empty +1
 *   4) fetch error                 → last_error_class recorded, health
 *                                    'failing' (streak untouched)
 *   This file pins the render-layer consequence of ruling 2: after a dup-only
 *   round the source must NOT be red. `last_fetched_at` is refreshed only by
 *   rounds with output (base.js updateSourceCount; hasOutput excludes
 *   cross-day duplicates), so a source whose every round is dup-only keeps a
 *   frozen `last_fetched_at` — a badge reading that field false-flags it red
 *   after 48h. Observed instance: the 2026-10-20 16:00–16:01 CST cross-day
 *   probe jobs (hacker-news duplicates=21, techmeme duplicates=5).
 *
 *   Accepted fix shapes (field-level, implementation-agnostic): read
 *   `last_success_at`, falling back to `last_fetched_at` when `last_success_at`
 *   is NULL — rows whose runtime writer has not fired yet (e.g. sources added
 *   after migration 037 backfilled the column) must not flash red on deploy
 *   night. "NULL counts as even older" is preserved when both fields are NULL.
 *   On unfixed code (badge reads last_fetched_at only, sources.js:35 at
 *   d4a8e9b) the dup-only assertions below fail — the RED gate for this lane.
 *
 * Time control: TZ pinned to Asia/Shanghai (production service timezone,
 * restored afterwards); the clock is faked to 2026-10-20 01:00 CST
 * (= 2026-10-19T17:00:00Z, the daily pipeline moment) and passed explicitly
 * to isStaleSource(src, nowMs), so nothing depends on the real wall clock.
 * Naive SQLite datetime strings ("YYYY-MM-DD HH:MM:SS", UTC — what
 * /api/sources actually returns) must parse as UTC: a local-time parse
 * drifts 8h in Asia/Shanghai and misjudges the 48h boundary.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// js/**/*.js gets browser-only eslint globals; import node:process explicitly
// so the TZ pin below stays lint-clean (unlike referencing a bare `process`).
import process from 'node:process';

vi.mock('../pages/shared.js', async importOriginal => ({
  ...await importOriginal(),
  fetchJSON: vi.fn(),
}));
vi.mock('../i18n.js', () => ({ getLanguage: () => 'en', t: key => key }));
vi.mock('../router.js', () => ({ router: { onCleanup: vi.fn() } }));

import { fetchJSON } from '../pages/shared.js';
import { isStaleSource, renderSources } from '../pages/sources.js';

const PREV_TZ = process.env.TZ;
process.env.TZ = 'Asia/Shanghai'; // production service timezone (01:00 CST scheduler)

// Faked now: 2026-10-20 01:00 CST = 2026-10-19 17:00 UTC — never the real clock.
const NOW_MS = Date.parse('2026-10-19T17:00:00Z');
const HOUR_MS = 3600 * 1000;
const isoFromNow = (hours) => new Date(NOW_MS - hours * HOUR_MS).toISOString();
// SQLite datetime('now') shape: "YYYY-MM-DD HH:MM:SS", UTC, no zone marker.
const sqliteFromNow = (hours) =>
  new Date(NOW_MS - hours * HOUR_MS).toISOString().slice(0, 19).replace('T', ' ');

const src = (fields) => ({ is_active: 1, ...fields });

function hasStaleMark(el) {
  if (!el) return false;
  if (el.textContent && el.textContent.includes('🔴')) return true;
  if (/(stale|red)/i.test(String(el.className))) return true;
  return Boolean(el.querySelector('.stale, .source-stale, .stale-badge, .badge-red'));
}

describe('R1.1 stale badge reads a field that dup-only rounds refresh', () => {
  describe('dup-only rounds must not flag a source red (RED on unfixed code)', () => {
    it('fresh last_success_at (ruling 2) + 72h-old last_fetched_at → NOT stale', () => {
      // last_fetched_at frozen at the last round that had output (72h ago);
      // every round since was dup-only, each refreshing last_success_at (2h ago).
      // The badge currently reads last_fetched_at (sources.js) → false red.
      const s = src({
        slug: 'all-dups',
        last_success_at: isoFromNow(2),
        last_fetched_at: isoFromNow(72),
        consecutive_empty: 0, // ruling 2: dup-only rounds leave the streak alone
        health_status: 'healthy',
      });
      expect(isStaleSource(s, NOW_MS)).toBe(false);
    });

    it('same dup-only shape with SQLite naive-UTC strings (production /api/sources row) → NOT stale', () => {
      const s = src({
        slug: 'all-dups-sqlite',
        last_success_at: sqliteFromNow(2),  // '2026-10-19 15:00:00'
        last_fetched_at: sqliteFromNow(72), // '2026-10-16 17:00:00'
        consecutive_empty: 0,
        health_status: 'healthy',
      });
      expect(isStaleSource(s, NOW_MS)).toBe(false);
    });

    it('naive last_success_at parses as UTC, not local CST: now−41h stays fresh', () => {
      // '2026-10-18 00:00:00' = now−41h UTC → inside the 48h window. A fix
      // that parses the naive string as Asia/Shanghai local time sees now−49h
      // and false-flags red — this pins the UTC normalization for the new field
      // (same drift guard the D4 badge test applies to last_fetched_at).
      const s = src({
        slug: 'sqlite-drift',
        last_success_at: '2026-10-18 00:00:00',
        last_fetched_at: sqliteFromNow(72),
      });
      expect(isStaleSource(s, NOW_MS)).toBe(false);
    });
  });

  describe('/sources card rendering applies the field to the badge', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      document.body.innerHTML = '<div id="pageContent"></div>';
      window.history.replaceState({}, '', '/');
      // renderSources calls isStaleSource(src) without an explicit now — fake
      // the clock so the rendered badge is judged at the pinned pipeline time.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW_MS);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('dup-only source renders without the stale badge; genuinely stale source keeps it', async () => {
      fetchJSON.mockResolvedValue({
        sources: [
          { id: 1, slug: 'all-dups', label: 'DupOnly Source', is_active: 1,
            today_items: 0, total_items: 50,
            last_success_at: isoFromNow(2), last_fetched_at: isoFromNow(72),
            consecutive_empty: 0, health_status: 'healthy' },
          { id: 2, slug: 'dead-week', label: 'Dead Week', is_active: 1,
            today_items: 0, total_items: 60,
            last_success_at: isoFromNow(24 * 7), last_fetched_at: isoFromNow(24 * 7) },
        ],
      });
      await renderSources({});

      const cardFor = (label) => [...document.querySelectorAll('.source-card')]
        .find(card => card.textContent.includes(label));

      // RED on unfixed code: last_fetched_at is 72h old → badge rendered today.
      expect(hasStaleMark(cardFor('DupOnly Source'))).toBe(false);
      // Green anchor: no successful output of any kind for 7d → badge stays.
      expect(hasStaleMark(cardFor('Dead Week'))).toBe(true);
    });
  });

  describe('anchors that must stay green before and after the fix', () => {
    it('genuinely stale on both fields (7d) → still red', () => {
      const s = src({ slug: 'dead-week',
        last_success_at: isoFromNow(24 * 7), last_fetched_at: isoFromNow(24 * 7) });
      expect(isStaleSource(s, NOW_MS)).toBe(true);
    });

    it('healthy source, both fields 6h old → not red', () => {
      const s = src({ slug: 'healthy',
        last_success_at: isoFromNow(6), last_fetched_at: isoFromNow(6) });
      expect(isStaleSource(s, NOW_MS)).toBe(false);
    });

    it('dup-only round with last_fetched_at still inside the 48h window (30h) → not red', () => {
      const s = src({ slug: 'dups-inside-window',
        last_success_at: isoFromNow(2), last_fetched_at: isoFromNow(30) });
      expect(isStaleSource(s, NOW_MS)).toBe(false);
    });

    it('exactly 48h since the freshness field is still fresh (strictly-greater)', () => {
      const s = src({ slug: 'exact-48h',
        last_success_at: isoFromNow(48), last_fetched_at: isoFromNow(48) });
      expect(isStaleSource(s, NOW_MS)).toBe(false);
    });

    it('is_active=0 is never flagged red', () => {
      const s = src({ slug: 'disabled', is_active: 0,
        last_success_at: isoFromNow(24 * 30), last_fetched_at: isoFromNow(24 * 30) });
      expect(isStaleSource(s, NOW_MS)).toBe(false);
    });

    it('NULL last_success_at falls back to last_fetched_at: fetched 6h ago → not red', () => {
      // Deploy-transition rows: last_success_at has had no runtime writer
      // since migration 037's one-shot backfill, while last_fetched_at is
      // fresh — switching the badge must not flash these red on deploy night.
      const s = src({ slug: 'null-success-fresh-fetched',
        last_success_at: null, last_fetched_at: isoFromNow(6) });
      expect(isStaleSource(s, NOW_MS)).toBe(false);
    });

    it('both fields NULL → red (NULL counts as even older)', () => {
      const s = src({ slug: 'never-seen', last_success_at: null, last_fetched_at: null });
      expect(isStaleSource(s, NOW_MS)).toBe(true);
    });
  });
});

afterAll(() => {
  if (PREV_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = PREV_TZ;
});
