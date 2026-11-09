/**
 * Eagleye — search page module
 *
 * Global search and the discover page.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml } from '../utils.js';
import { getLanguage, t } from '../i18n.js';
import { API_BASE, fetchJSON, markItemSeen, pickZh } from './shared.js';


// ─── Global Search ──────────────────────────────────────

export async function renderSearch(params) {
  const container = $('#pageContent');
  const query = params?.q || new URLSearchParams(window.location.search).get('q') || '';

  container.innerHTML =
    `<section class="page-section">` +
    `<div class="page-header"><h2 class="page-title">${t('search.title')}</h2>` +
    `<div class="search-box"><input type="text" id="globalSearchInput" placeholder="${escapeAttr(t('search.placeholder'))}" value="${escapeAttr(query)}" />` +
    `<button id="globalSearchBtn" class="action-btn">🔍 ${t('search.button')}</button></div></div>` +
    `<div id="searchResults"></div></section>`;

  const input = container.querySelector('#globalSearchInput');
  const btn = container.querySelector('#globalSearchBtn');
  const resultsEl = container.querySelector('#searchResults');

  const doSearch = async () => {
    const q = input.value.trim();
    if (q.length < 2) { resultsEl.innerHTML = `<p class="subtle">${t('search.min_chars')}</p>`; return; }
    resultsEl.innerHTML = `<p class="subtle">${t('common.loading')}</p>`;
    try {
      // Search items + topics + entities in parallel.
      const [itemData, topicData, entityData] = await Promise.all([
        fetchJSON(`${API_BASE}/search?q=${encodeURIComponent(q)}&limit=30`),
        fetchJSON(`${API_BASE}/topics`).catch(() => ({ topics: [] })),
        fetchJSON(`${API_BASE}/entities/momentum?window=30d&limit=100`).catch(() => ({ entities: [] })),
      ]);
      const items = itemData.items || [];
      const ql = q.toLowerCase();
      const matchingTopics = (topicData.topics || []).filter(tp => {
        const name = (tp.name || '').toLowerCase();
        const slug = (tp.slug || '').toLowerCase();
        return name.includes(ql) || slug.includes(ql);
      }).slice(0, 5);
      const matchingEntities = (entityData.entities || []).filter(e => {
        const name = (e.name || '').toLowerCase();
        const slug = (e.slug || '').toLowerCase();
        return name.includes(ql) || slug.includes(ql);
      }).slice(0, 5);

      if (items.length === 0 && matchingTopics.length === 0 && matchingEntities.length === 0) {
        resultsEl.innerHTML = `<p class="subtle">${escapeHtml(t('search.no_results', { q }))}</p>`;
        return;
      }

      let html = '';
      // Topics section
      if (matchingTopics.length > 0) {
        html += `<div class="metrics-block"><h3 class="metrics-block-title">${getLanguage() === 'zh' ? '主题' : 'Topics'}</h3><ul class="story-members">` +
          matchingTopics.map(tp => `<li class="story-member"><span class="story-member-src">topic</span>` +
            `<a href="/topics/${escapeAttr(tp.slug)}">${escapeHtml(pickZh(tp.name, tp.name_zh) || tp.slug)}</a></li>`).join('') +
          `</ul></div>`;
      }
      // Entities section
      if (matchingEntities.length > 0) {
        html += `<div class="metrics-block"><h3 class="metrics-block-title">${getLanguage() === 'zh' ? '实体' : 'Entities'}</h3><ul class="story-members">` +
          matchingEntities.map(e => `<li class="story-member"><span class="story-member-src">${escapeHtml(e.type || '')}</span>` +
            `<a href="/trajectory/${escapeAttr(e.slug)}">${escapeHtml(e.name)}</a></li>`).join('') +
          `</ul></div>`;
      }
      // Items section
      if (items.length > 0) {
        html += `<div class="metrics-block"><h3 class="metrics-block-title">${getLanguage() === 'zh' ? '条目' : 'Items'} (${items.length})</h3><ul class="story-members">` +
          items.map(it => {
            const ttl = escapeHtml((it.title_zh || it.title || '').slice(0, 100));
            const ol = it.one_liner_zh ? `<span class="search-ctx">${escapeHtml(it.one_liner_zh.slice(0, 80))}</span>` : '';
            return `<li class="story-member"><span class="story-member-src">${escapeHtml(it.source_label || '')}</span>` +
              `<a href="${escapeAttr(it.canonical_url || '#')}" target="_blank" rel="noopener" data-seen-id="${escapeAttr(it.id)}">${ttl}</a> ${ol}</li>`;
          }).join('') + `</ul></div>`;
      }
      resultsEl.innerHTML = html;
      resultsEl.querySelectorAll('[data-seen-id]').forEach(a => {
        a.addEventListener('click', () => markItemSeen(a.dataset.seenId));
      });
    } catch (err) { resultsEl.innerHTML = `<p class="subtle">${escapeHtml(err.message)}</p>`; }
  };

  btn.addEventListener('click', doSearch);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  if (query) doSearch();
}

// Compatibility export; the radar module is loaded only when visited.
export async function renderDiscover(params) {
  const location = window.location.href;
  const module = await import('./radar.js');
  if (window.location.href === location) return module.renderRadarDiscover(params);
}
