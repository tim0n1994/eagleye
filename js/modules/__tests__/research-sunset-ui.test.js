/**
 * Research module sunset — frontend contract (CTO option C, 2026-10-21).
 *
 * The research feature was retired: 58650a7 removed the backend (routes,
 * services, job registration) and the diagnosis (research-module-diagnosis.md
 * §4) found six dead research buttons plus a dead API client surface still
 * shipping in the frontend. These tests pin the sunset contract per the
 * checklist, one section per site:
 *
 *   1. js/modules/pages/signals.js:376  — signal detail pane Deep Research button
 *   2. js/modules/ui.js:259-262         — createItemRow research-btn (t('common.deep_research'))
 *   3. js/modules/pages/papers.js:112   — paper card mini-action research-btn
 *   4. js/modules/pages/shared.js:353   — renderItemCard action-btn research-btn (label :327)
 *   5. js/modules/pages/shared.js:430   — renderItemMiniCard mini-action research-btn (label :402)
 *   6. js/modules/pages/topics.js:217   — topic-research-btn (+ its :274-293 click wiring)
 *   7. js/modules/api.js:59-87          — fetchResearch / triggerItemResearch / chatItemResearch
 *
 * RED against the pre-sunset HEAD: every "must not render" assertion fails
 * because the dead buttons still render and the dead clients are still exported.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderSignalDetail } from '../pages/signals.js';
import { renderPapers } from '../pages/papers.js';
import { renderTopicDetailPage } from '../pages/topics.js';
import { renderItemCard, renderItemMiniCard } from '../pages/shared.js';
import { UI } from '../ui.js';
import { API } from '../api.js';
import { setLanguage } from '../i18n.js';
import { router } from '../router.js';

const respond = data => ({ ok: true, json: async () => data });

const itemFixture = () => ({
  id: 'item-1',
  title: 'Test Item With A Plain Title',
  canonical_url: 'https://example.com/article',
  source_label: 'github',
  source_slug: 'github',
  url: 'https://example.com/article',
  summary: 'A plain summary.',
  published_at: '2026-10-01T00:00:00Z',
  created_at: '2026-10-01T00:00:00Z',
  popularity: { stars: 42 },
  topics: [],
  tags: [],
});

const signalFixture = () => ({
  item_id: 'sig-1',
  title: 'Signal One With A Plain Title',
  signal_type: 'new_paper',
  alpha_score: 0.7,
  entities: [],
  topics: [],
});

const paperFixture = () => ({
  id: 'paper-1',
  title: 'Attention Mechanics Revisited',
  canonical_url: 'https://arxiv.org/abs/0000.0000',
  source_label: 'arxiv',
  published_at: '2026-10-01T00:00:00Z',
});

// ─── 1. signals.js:376 — signal detail pane ────────────────────────────────

describe('signals detail pane no longer offers Deep Research (signals.js:376)', () => {
  beforeEach(() => {
    router._runCleanups();
    setLanguage('en');
    window.history.replaceState(null, '', '/signals');
    document.body.innerHTML = '<main id="pageContent"></main>';
    vi.stubGlobal('fetch', vi.fn(async url => {
      if (url === '/api/signal-types') return respond({ types: [] });
      if (url === '/api/signals/sig-1') return respond({ signal: signalFixture() });
      if (url.startsWith('/api/signals?')) return respond({ signals: [] });
      throw new Error(`Unexpected request: ${url}`);
    }));
  });

  afterEach(() => {
    router._runCleanups();
    vi.unstubAllGlobals();
  });

  it('renders the pane without a research button or Deep Research label', async () => {
    await renderSignalDetail({ id: 'sig-1' });
    const pane = document.querySelector('.signal-detail-inner');
    expect(pane, 'signal detail pane rendered (fixture sanity)').toBeTruthy();
    expect(pane.querySelector('.research-btn'), 'signal-action-btn research-btn must be gone').toBeNull();
    expect(pane.textContent, 'Deep Research label must be gone').not.toContain('Deep Research');
  });
});

// ─── 2. ui.js:259-262 — createItemRow ──────────────────────────────────────

describe('UI.createItemRow no longer offers research (ui.js:259-262)', () => {
  beforeEach(() => {
    setLanguage('en');
    document.body.innerHTML = `
      <div id="itemsGrid"></div>
      <div id="categoryList"></div>
      <div id="lastUpdated"></div>
      <div id="searchInput"></div>
      <div id="researchModal" style="display:none;"></div>
      <div id="researchTitle"></div>
      <div id="researchBody"></div>
      <div id="graphOverlay"></div>
      <div id="graphCanvas"></div>
      <button id="showGraph"></button>
      <button id="closeGraph"></button>
      <button id="syncNow"></button>
    `;
    UI.cacheDom();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('builds a row without the research button', () => {
    const row = UI.createItemRow(itemFixture(), '');
    expect(row.className, 'row rendered (fixture sanity)').toContain('item-row');
    expect(row.querySelector('.research-btn'), 'createItemRow research-btn must be gone').toBeNull();
    expect(row.textContent, 'deep_research label must be gone').not.toContain('Deep Research');
    expect(row.querySelector('a[target="_blank"]'), 'original-source link still rendered').toBeTruthy();
  });
});

// ─── 3. papers.js:112 — paper card mini-action ─────────────────────────────

describe('papers page no longer offers research (papers.js:112)', () => {
  beforeEach(() => {
    setLanguage('en');
    window.history.replaceState(null, '', '/papers');
    document.body.innerHTML = '<main id="pageContent"></main>';
    vi.stubGlobal('fetch', vi.fn(async url => {
      if (url === '/api/papers?source=all&limit=80') {
        return respond({ papers: [paperFixture()], sources: [], stats: { total: 1 } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders paper cards without a research action', async () => {
    await renderPapers({});
    const card = document.querySelector('.paper-card');
    expect(card, 'paper card rendered (fixture sanity)').toBeTruthy();
    expect(card.querySelector('.research-btn'), 'paper card research-btn must be gone').toBeNull();
    expect(card.textContent, 'Research label must be gone').not.toContain('Research');
  });
});

// ─── 4 + 5. shared.js:353 / :430 — card renderers ──────────────────────────

describe('shared card renderers no longer offer research (shared.js:353, :430)', () => {
  beforeEach(() => {
    setLanguage('en');
  });

  it('renderItemCard omits the research action (en labels)', () => {
    const html = renderItemCard(itemFixture());
    expect(html, 'info-card rendered (fixture sanity)').toContain('info-card');
    expect(html, 'action-btn research-btn must be gone').not.toContain('research-btn');
    expect(html, 'Deep Research label must be gone').not.toContain('Deep Research');
    expect(html, 'original-source link still rendered').toContain('action-link');
  });

  it('renderItemCard omits the research action (zh label 深度研究)', () => {
    setLanguage('zh');
    const html = renderItemCard(itemFixture());
    expect(html, '深度研究 label must be gone').not.toContain('深度研究');
    expect(html).not.toContain('research-btn');
  });

  it('renderItemMiniCard omits the research action (en labels)', () => {
    const html = renderItemMiniCard(itemFixture());
    expect(html, 'mini-card rendered (fixture sanity)').toContain('mini-card');
    expect(html, 'mini-action research-btn must be gone').not.toContain('research-btn');
    expect(html, 'Research label must be gone').not.toContain('Research');
    expect(html, 'source link still rendered').toContain('mini-action-link');
  });

  it('renderItemMiniCard omits the research action (zh label 研究)', () => {
    setLanguage('zh');
    const html = renderItemMiniCard(itemFixture());
    expect(html, '研究 label must be gone').not.toContain('研究');
    expect(html).not.toContain('research-btn');
  });
});

// ─── 6. topics.js:217 (+ :274-293 wiring) — topic detail ───────────────────

describe('topic detail page no longer offers research (topics.js:217, :274-293)', () => {
  beforeEach(() => {
    setLanguage('en');
    window.history.replaceState(null, '', '/topics/test-topic');
    document.body.innerHTML = '<main id="pageContent"></main>';
    vi.stubGlobal('fetch', vi.fn(async url => {
      if (url === '/api/topics/test-topic') {
        return respond({
          topic: { name: 'Test Topic', description: 'd', item_count: 1, growth_score: 1.5, status: 'active' },
          items: [itemFixture()],
        });
      }
      if (url === '/api/topics/test-topic/timeline') return respond({ timeline: [] });
      if (url === '/api/topics/test-topic/graph') return respond({ nodes: [] });
      throw new Error(`Unexpected request: ${url}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders topic actions without the research-this-topic button or its wiring', async () => {
    await renderTopicDetailPage({ slug: 'test-topic' });
    const actions = document.querySelector('.topic-detail-actions');
    expect(actions, 'topic detail header rendered (fixture sanity)').toBeTruthy();
    expect(document.querySelector('.topic-research-btn'), 'topic-research-btn must be gone').toBeNull();
    expect(document.querySelector('#pageContent .research-btn'), 'item-card research buttons must be gone too').toBeNull();
    expect(document.querySelector('#pageContent').textContent, 'Research this topic label must be gone').not.toContain('Research this topic');
    expect(actions.querySelector('a[href="/api/topics/test-topic/feed.xml"]'), 'RSS link still rendered').toBeTruthy();
  });
});

// ─── 7. api.js:59-87 — dead research clients ───────────────────────────────

describe('API client surface no longer exposes research clients (api.js:59-87)', () => {
  it('drops fetchResearch / triggerItemResearch / chatItemResearch from the exported API', () => {
    // Sanity that the module imported and the live surface is intact.
    expect(typeof API.fetchClassifiedItems).toBe('function');
    expect(API, 'fetchResearch (api.js:59) must be removed').not.toHaveProperty('fetchResearch');
    expect(API, 'triggerItemResearch (api.js:73) must be removed').not.toHaveProperty('triggerItemResearch');
    expect(API, 'chatItemResearch (api.js:80) must be removed').not.toHaveProperty('chatItemResearch');
  });
});
