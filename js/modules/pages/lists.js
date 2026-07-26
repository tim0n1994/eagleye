/**
 * Eagleye — lists page module
 *
 * Saved items, story clusters and the watchlist.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml } from '../utils.js';
import { getLanguage, t } from '../i18n.js';
import { API_BASE, fetchJSON, pickZh, renderItemCard, showError, showLoader } from './shared.js';


// ─── Saved Items (Watchlist / bookmarks) ─────────────────

export async function renderSaved(_params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING SAVED...' : t('common.loading'));

  try {
    const data = await fetchJSON(`${API_BASE}/saved`);
    const items = data.items || [];

    if (items.length === 0) {
      container.innerHTML = `
        <section class="page-section">
          <div class="page-header">
            <h2 class="page-title">${t('saved.title')}</h2>
            <p class="page-description">${t('saved.subtitle')}</p>
          </div>
          <div class="empty-state">
            <p>${t('saved.empty')}</p>
          </div>
        </section>
      `;
      return;
    }

    container.innerHTML = `
      <section class="page-section">
        <div class="page-header">
          <h2 class="page-title">${t('saved.title')}</h2>
          <p class="page-description">${t('saved.subtitle')}</p>
          <span class="page-description subtle">${t('saved.count', { n: items.length })}</span>
          <div style="margin-top:8px;display:flex;gap:8px">
            <button class="action-btn" id="exportSavedBtn">⬇ ${getLanguage() === 'zh' ? '导出 JSON' : 'Export JSON'}</button>
          </div>
        </div>
        <div class="signals-grid" id="savedGrid">
          ${items.map(it => renderItemCard(it)).join('')}
        </div>
      </section>
    `;

    // Wire export button: download saved items as JSON.
    const exportBtn = container.querySelector('#exportSavedBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'eagleye-saved.json';
        a.click();
        URL.revokeObjectURL(url);
      });
    }

    // Wire unsave buttons. Each saved card gets a bookmark toggle so users can
    // remove items directly from this page without leaving.
    container.querySelectorAll('.saved-toggle').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const id = btn.dataset.itemId;
        if (!id) return;
        try {
          await fetch(`${API_BASE}/items/${encodeURIComponent(id)}/save`, { method: 'GET' });
          // Re-render the list without the removed item (cheap: just refetch).
          renderSaved(_params);
        } catch (err) {
          console.warn('Unsave failed:', err.message);
        }
      });
    });
  } catch (err) {
    showError(container, err.message);
  }
}

// ─── Stories (cross-source event clusters, PRD-3) ───────

export async function renderStories(_params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING STORIES...' : t('common.loading'));

  try {
    // Default to a 7-day window so the page surfaces recent multi-source events.
    const sinceDays = _params?.sinceDays || 7;
    const data = await fetchJSON(`${API_BASE}/stories?sinceDays=${encodeURIComponent(sinceDays)}&limit=100`);
    const stories = data.stories || [];

    if (stories.length === 0) {
      container.innerHTML = `
        <section class="page-section">
          <div class="page-header">
            <h2 class="page-title">${t('stories.title')}</h2>
            <p class="page-description">${t('stories.subtitle')}</p>
          </div>
          <div class="empty-state"><p>${t('stories.empty')}</p></div>
        </section>
      `;
      return;
    }

    const storyCard = (st) => {
      const rep = st.representative || {};
      const repTitle = pickZh(rep.title, rep.title_zh) || rep.title || '';
      const srcChips = (st.sources || []).map(s => `<span class="story-src">${escapeHtml(s)}</span>`).join('');
      const crossBadge = st.cross_source ? `<span class="story-cross">★ ${t('stories.cross_source')}</span>` : '';
      const alphaStr = st.best_alpha ? (st.best_alpha * 100).toFixed(0) : '—';
      // List the member items collapsed (source + title), rep first.
      const members = (st.items || [])
        .slice()
        .sort((a, b) => (b.alpha_score || 0) - (a.alpha_score || 0))
        .slice(0, 6)
        .map(it => {
          const ttl = escapeHtml((it.title || '').slice(0, 90));
          const src = escapeHtml(it.source_label || '');
          const href = escapeAttr(it.canonical_url || '#');
          return `<li class="story-member"><span class="story-member-src">${src}</span><a href="${href}" target="_blank" rel="noopener">${ttl}</a></li>`;
        })
        .join('');
      return `
        <article class="story-card">
          <div class="story-card-head">
            <span class="story-count">${t('stories.count', { n: st.count })}</span>
            ${crossBadge}
            <span class="story-alpha">α ${alphaStr}</span>
          </div>
          <h4 class="story-title">${escapeHtml(repTitle)}</h4>
          <div class="story-sources">${srcChips}</div>
          <ul class="story-members">${members}</ul>
        </article>
      `;
    };

    container.innerHTML = `
      <section class="page-section">
        <div class="page-header">
          <h2 class="page-title">${t('stories.title')}</h2>
          <p class="page-description">${t('stories.subtitle')}</p>
          <span class="page-description subtle">
            ${data.total} ${t('stories.total_label')} · ${data.cross_source_count} ${t('stories.cross_label')} · ${sinceDays}d
          </span>
        </div>
        <div class="stories-grid">
          ${stories.map(storyCard).join('')}
        </div>
      </section>
    `;
  } catch (err) {
    showError(container, err.message);
  }
}

// ─── Watchlist (PRD-4: subscription hub) ────────────────

export async function renderWatchlist(_params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING WATCHLIST...' : t('common.loading'));

  try {
    const [wlData, feedData] = await Promise.all([
      fetchJSON(`${API_BASE}/watchlist`).catch(() => ({ subs: [] })),
      fetchJSON(`${API_BASE}/watchlist/feed?sinceDays=7&limit=80`).catch(() => ({ items: [] })),
    ]);
    const subs = wlData.subs || [];
    const items = feedData.items || [];

    const subChip = (s) => {
      const icon = s.kind === 'entity' ? '📌' : '📡';
      const href = s.kind === 'entity' ? `/trajectory/${encodeURIComponent(s.value)}` : `/signals?type=${encodeURIComponent(s.value)}`;
      return `<span class="wl-chip">${icon} <a href="${href}">${escapeHtml(s.label || s.value)}</a>` +
        `<button class="wl-remove" data-kind="${escapeAttr(s.kind)}" data-value="${escapeAttr(s.value)}" title="${escapeAttr(t('watchlist.remove'))}">×</button>` +
        `</span>`;
    };

    const itemRow = (it) =>
      `<li class="story-member">` +
      `<span class="story-member-src">${escapeHtml(it.source_label || '')}</span>` +
      `<a href="${escapeAttr(it.canonical_url || '#')}" target="_blank" rel="noopener">${escapeHtml((it.title || '').slice(0, 100))}</a>` +
      `</li>`;

    // Build body conditionally to avoid deeply-nested template literals (which
    // are fragile to parse and read poorly).
    let bodyHtml;
    if (subs.length === 0) {
      bodyHtml = `<div class="metrics-block"><p class="subtle">${t('watchlist.empty')}</p></div>`;
    } else {
      const feedHtml = items.length === 0
        ? `<p class="subtle">${t('watchlist.no_feed')}</p>`
        : `<ul class="story-members">${items.map(itemRow).join('')}</ul>`;
      bodyHtml =
        `<div class="metrics-block">` +
        `<h3 class="metrics-block-title">${t('watchlist.subscriptions')} (${subs.length})</h3>` +
        `<div class="wl-chips">${subs.map(subChip).join('')}</div>` +
        `</div>` +
        `<div class="metrics-block">` +
        `<h3 class="metrics-block-title">${t('watchlist.feed')} (${items.length})</h3>` +
        feedHtml +
        `</div>`;
    }

    container.innerHTML =
      `<section class="page-section">` +
      `<div class="page-header">` +
      `<h2 class="page-title">${t('watchlist.title')}</h2>` +
      `<p class="page-description">${t('watchlist.subtitle')}</p>` +
      (subs.length > 0 ? `<a href="/watchlist/feed.xml" class="action-link" target="_blank" rel="noopener" style="font-size:12px">📡 RSS feed for your watchlist</a>` : '') +
      `</div>` +
      bodyHtml +
      `</section>`;

    // Wire remove buttons.
    container.querySelectorAll('.wl-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        const kind = btn.dataset.kind;
        const value = btn.dataset.value;
        try {
          await fetch(`${API_BASE}/watchlist`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind, value, add: false }),
          });
          renderWatchlist(_params); // refresh
        } catch (err) {
          console.warn('Watchlist remove failed:', err.message);
        }
      });
    });
  } catch (err) {
    showError(container, err.message);
  }
}
