/**
 * Eagleye — search page module
 *
 * Global search and the discover page.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml } from '../utils.js';
import { getLanguage, t } from '../i18n.js';
import { API_BASE, fetchJSON, markItemSeen, pickZh, showError, showLoader } from './shared.js';


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
        resultsEl.innerHTML = `<p class="subtle">${t('search.no_results', { q })}</p>`;
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

// ─── Entity Discovery (/discover) ───────────────────────

export async function renderDiscover(_params) {
  const container = $('#pageContent');
  const zh = getLanguage() === 'zh';
  const urlParams = new URLSearchParams(window.location.search);
  const selectedType = urlParams.get('type') || '';
  const sort = urlParams.get('sort') || 'acceleration';

  showLoader(container, zh ? '加载…' : 'LOADING...');

  try {
    const data = await fetchJSON(`${API_BASE}/entities/momentum?window=30d&sort=${encodeURIComponent(sort)}&limit=100`);
    const entities = data.entities || [];

    // Collect unique entity types for the filter.
    const types = [...new Set(entities.map(e => e.type).filter(Boolean))].sort();
    const filtered = selectedType ? entities.filter(e => e.type === selectedType) : entities;

    const typeTabs = types.map(ty => {
      const params = new URLSearchParams();
      if (ty) params.set('type', ty);
      if (sort !== 'acceleration') params.set('sort', sort);
      const qs = params.toString();
      return `<a href="/discover${qs ? '?' + qs : ''}" class="range-tab ${selectedType === ty ? 'active' : ''}">${escapeHtml(ty)}</a>`;
    }).join('');
    const allParams = new URLSearchParams();
    if (sort !== 'acceleration') allParams.set('sort', sort);
    const allQs = allParams.toString();

    const sortTabs = ['acceleration', 'growth', 'burst', 'zscore'].map(s => {
      const params = new URLSearchParams();
      if (selectedType) params.set('type', selectedType);
      if (s !== 'acceleration') params.set('sort', s);
      const qs = params.toString();
      return `<a href="/discover${qs ? '?' + qs : ''}" class="range-tab ${sort === s ? 'active' : ''}">${s}</a>`;
    }).join(' ');

    const entityCard = (e) => {
      const a = e.acceleration || 0;
      const g = e.growth_rate || 0;
      const b = e.burst_score || 0;
      const z = e.zscore || 0;
      const m = e.mention_count || 0;
      return `<div style="background:var(--bg-card);border:1px solid var(--rule);border-radius:var(--radius);padding:14px 16px;display:flex;flex-direction:column;gap:6px">` +
        `<div style="display:flex;align-items:center;gap:8px">` +
        `<a href="/trajectory/${escapeAttr(e.slug)}" style="color:var(--fg);text-decoration:none;font-weight:600;font-size:14px">${escapeHtml(e.name)}</a>` +
        `<span style="font-size:10px;color:var(--fg-mute);text-transform:uppercase;letter-spacing:0.1em">${escapeHtml(e.type || '')}</span>` +
        `</div>` +
        `<div style="display:flex;gap:12px;font-size:11px;font-family:var(--font-mono);color:var(--fg-mute)">` +
        `<span title="mentions">💬 ${m}</span>` +
        (a > 0 ? `<span class="entity-accel">⚡${a.toFixed(1)}</span>` : '') +
        (b > 0 ? `<span class="entity-burst">💥${b.toFixed(1)}</span>` : '') +
        (g > 0 ? `<span class="entity-growth">📈${(g * 100).toFixed(0)}%</span>` : '') +
        `<span title="z-score">↑${z.toFixed(1)}</span>` +
        `</div></div>`;
    };

    container.innerHTML =
      `<section class="page-section">` +
      `<div class="page-header">` +
      `<h2 class="page-title">${zh ? '🔍 实体发现' : '🔍 Entity Discovery'}</h2>` +
      `<p class="page-description">${zh ? '按类型和动量指标浏览所有追踪实体' : 'Browse all tracked entities by type and momentum metric'}</p>` +
      `</div>` +
      `<div class="range-tabs" style="margin:8px 0"><span class="subtle" style="margin-right:8px;font-size:11px">${zh ? '类型' : 'Type'}:</span>` +
      `<a href="/discover${allQs ? '?' + allQs : ''}" class="range-tab ${!selectedType ? 'active' : ''}">${zh ? '全部' : 'All'}</a>${typeTabs}</div>` +
      `<div class="range-tabs" style="margin:4px 0 12px"><span class="subtle" style="margin-right:8px;font-size:11px">${zh ? '排序' : 'Sort'}:</span>${sortTabs}</div>` +
      `${(() => {
        // Entity type distribution bars.
        const typeDist = {};
        for (const e of entities) { if (e.type) typeDist[e.type] = (typeDist[e.type] || 0) + 1; }
        const typeEntries = Object.entries(typeDist).sort((a, b) => b[1] - a[1]);
        if (typeEntries.length < 2) return '';
        const maxType = Math.max(1, ...typeEntries.map(([, c]) => c));
        return '<div class="metrics-block" style="margin-bottom:16px"><h3 class="metrics-block-title">' + (zh ? '类型分布' : 'Type Distribution') + '</h3><ul class="metrics-bars">' +
          typeEntries.map(([ty, count]) => {
            const pct = Math.round((count / maxType) * 100);
            const params = new URLSearchParams();
            if (ty) params.set('type', ty);
            if (sort !== 'acceleration') params.set('sort', sort);
            const qs = params.toString();
            return '<div class="metrics-bar-row"><span class="metrics-bar-label"><a href="/discover' + (qs ? '?' + qs : '') + '" style="color:inherit;text-decoration:none">' + escapeHtml(ty) + '</a></span>' +
              '<div class="metrics-bar"><div class="metrics-bar-fill" style="width:' + pct + '%"></div></div>' +
              '<span class="metrics-bar-pct">' + count + '</span></div>';
          }).join('') + '</ul></div>';
      })()}` +
      `<p class="subtle" style="margin-bottom:12px">${filtered.length} ${zh ? '个实体' : 'entities'}${selectedType ? ' (' + escapeHtml(selectedType) + ')' : ''}</p>` +
      `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px">` +
      filtered.slice(0, 60).map(entityCard).join('') +
      `</div></section>`;
  } catch (err) {
    showError(container, err.message);
  }
}
