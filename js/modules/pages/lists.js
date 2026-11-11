/**
 * Eagleye — lists page module
 *
 * Saved items, story clusters and the watchlist.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml } from '../utils.js';
import { formatNumber, t } from '../i18n.js';
import { API_BASE, fetchJSON, getItemDisplayTitle, pickZh, renderItemCard, showError, showLoader } from './shared.js';
import { readerError, xt } from '../i18n/reader-extra.js';


// ─── Saved Items (Watchlist / bookmarks) ─────────────────

export async function renderSaved(_params) {
  const container = $('#pageContent');
  showLoader(container, xt('reader.loading_saved'));

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
          <span class="page-description subtle">${t('saved.count', { n: formatNumber(items.length) })}</span>
          <div style="margin-top:8px;display:flex;gap:8px">
            <button class="action-btn" id="exportSavedBtn">${xt('reader.export_json')}</button>
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
    showError(container, readerError(err.message));
  }
}

// ─── Stories (cross-source event clusters, PRD-3) ───────

export async function renderStories(_params) {
  const container = $('#pageContent');
  showLoader(container, xt('reader.loading_stories'));

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
      const alphaStr = st.best_alpha ? formatNumber(Math.round(st.best_alpha * 100)) : '—';
      // List the member items collapsed (source + title), rep first.
      const members = (st.items || [])
        .slice()
        .sort((a, b) => (b.alpha_score || 0) - (a.alpha_score || 0))
        .slice(0, 6)
        .map(it => {
          const ttl = escapeHtml(getItemDisplayTitle(it).slice(0, 90));
          const src = escapeHtml(pickZh(it.source_label, it.source_label_zh) || '');
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
            ${formatNumber(data.total)} ${t('stories.total_label')} · ${formatNumber(data.cross_source_count)} ${t('stories.cross_label')} · ${xt('reader.window_' + sinceDays + 'd')}
          </span>
        </div>
        <div class="stories-grid">
          ${stories.map(storyCard).join('')}
        </div>
      </section>
    `;
  } catch (err) {
      showError(container, readerError(err.message));
  }
}

// Subscription page uses the same dated evidence view as discovery.
export async function renderWatchlist(params) {
  const location = window.location.href;
  const module = await import('./radar.js');
  if (window.location.href === location) return module.renderRadarFollowing(params);
}
