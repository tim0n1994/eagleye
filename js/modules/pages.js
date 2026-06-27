/**
 * Eagleye — Page Components
 *
 * Render functions for each OrangeBot page.
 * Each function receives params and renders into the main content area.
 */

import { $, escapeHtml, escapeAttr, timeAgo, localDateStr } from './utils.js';
import { KnowledgeGraph } from './graph-viz.js';
import { renderToolBySlug } from './tools.js';
import { t, getLanguage } from './i18n.js';
import { API } from './api.js';
import { progressiveDateFeed, progressiveSourceFeed } from './progressive.js';

// ─── Utility ────────────────────────────────────────────

export function showLoader(container, msg = 'LOADING...') {
  container.innerHTML = `<div class="page-loading"><div class="spinner"></div><span>${msg}</span></div>`;
}

export function showError(container, msg) {
  container.innerHTML = `<div class="page-error">⚠ ${escapeHtml(msg)}</div>`;
}

const API_BASE = '/api';

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function renderMarkdownLite(md) {
  const safe = escapeHtml(String(md || '').trim());
  if (!safe) return `<p>${escapeHtml(t('common.empty'))}</p>`;

  const html = safe
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>');

  return `<div class="research-markdown"><p>${html}</p></div>`;
}

function getResearchChatState(itemId) {
  const root = /** @type {any} */ (window);
  if (!root.__researchChatState) root.__researchChatState = {};
  if (!root.__researchChatState[itemId]) root.__researchChatState[itemId] = [];
  return root.__researchChatState[itemId];
}

function localizedDate(d, opts) {
  try {
    return d.toLocaleDateString(getLanguage() === 'zh' ? 'zh-CN' : 'en-US', opts);
  } catch {
    return d.toLocaleDateString('en-US', opts);
  }
}

function tagHref(tag) {
  return `/tags/${encodeURIComponent(tag?.slug || tag?.name || '')}`;
}

/**
 * Cache of sources (slug, label, icon, total, today) for the source tab nav.
 * Refreshed on first use; invalidated when language changes (UI re-renders anyway).
 */
let _sourcesCache = null;
async function getSourcesCached() {
  if (_sourcesCache) return _sourcesCache;
  try {
    const data = await fetchJSON(`${API_BASE}/sources`);
    _sourcesCache = data.sources || [];
  } catch {
    _sourcesCache = [];
  }
  return _sourcesCache;
}

const SOURCE_ICON = {
  'x-following': '𝕏',
  'hacker-news': '🟧', 'github-trending': '🐙', 'product-hunt': '🚀', 'hugging-face': '🤗',
  'techmeme': '📰', 'solidot': '🪨', 'startup-archive': '📦',
  'app-store-rank': '📱', 'app-store-trend': '📱',
  'physical-ai-arxiv': '📄', 'physical-ai-humanoid': '🤖',
  'physical-ai-cn-photonics': '🔬', 'v2ex': '💬', 'lobsters': '🦞',
};

const SOURCE_ORDER_PRIORITY = new Map([
  ['x-following', 0],
  ['hacker-news', 1],
  ['github-trending', 2],
  ['hugging-face', 3],
  ['product-hunt', 4],
]);

/**
 * Pick a localized field: returns the *_zh variant if current language is zh
 * and the value exists, otherwise falls back to the English/default field.
 * Use this for any content field that has a translated counterpart.
 */
function pickZh(enVal, zhVal) {
  if (getLanguage() === 'zh' && zhVal && typeof zhVal === 'string' && zhVal.trim()) {
    return zhVal;
  }
  return enVal;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function isLowSignalTitle(title) {
  const text = String(title || '').trim();
  if (!text || text === '[No Title]') return true;
  if (/^@[a-zA-Z0-9_]+\s+posted$/i.test(text)) return true;
  if (/^@[a-zA-Z0-9_]+\s*发帖$/u.test(text)) return true;
  if (/^tweet by @[a-zA-Z0-9_]+$/i.test(text)) return true;
  return false;
}

function buildFallbackTitle(item) {
  const sourceSlug = String(item?.source_slug || '').toLowerCase();
  const author = firstText(item?.author, item?.source_payload?.handle ? `@${item.source_payload.handle}` : '');
  const raw = firstText(item?.content_text, item?.original_summary, item?.title);
  const cleaned = raw
    .replace(/\s+/g, ' ')
    .replace(/^@\w+[:：-]\s*/u, '')
    .replace(/^Quote\s+/i, '')
    .trim();
  if (!cleaned) return firstText(item?.title, item?.canonical_url, 'Untitled');
  const snippet = cleaned.length > 42 ? `${cleaned.slice(0, 41)}…` : cleaned;
  if (sourceSlug === 'x-following' && author) return `${author}：${snippet}`;
  return snippet;
}

function getItemDisplayTitle(item) {
  const summary = item?.ai_summary || {};
  const zhTitle = firstText(summary.ai_title_zh, item?.title_zh, summary.title_zh);
  const enTitle = firstText(summary.ai_title, item?.title);
  const localized = firstText(pickZh(enTitle, zhTitle), zhTitle, enTitle);
  if (!isLowSignalTitle(localized)) return localized;
  return buildFallbackTitle(item);
}

function getItemResearchTitle(item) {
  const summary = item?.ai_summary || {};
  return firstText(
    pickZh(summary.ai_title || item?.title, summary.ai_title_zh || item?.title_zh),
    getItemDisplayTitle(item),
    item?.title
  );
}

function orderedSourceEntries(bySourceMap, sources) {
  const orderedSources = [...(sources || [])].sort((a, b) => {
    const aPriority = SOURCE_ORDER_PRIORITY.get(a.slug) ?? 99;
    const bPriority = SOURCE_ORDER_PRIORITY.get(b.slug) ?? 99;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return String(a.label || a.slug || '').localeCompare(String(b.label || b.slug || ''), 'zh-Hans-CN');
  });
  const usedKeys = new Set();
  const entries = [];

  for (const source of orderedSources) {
    const candidates = [source.label, source.label_zh, source.slug].filter(Boolean);
    const key = candidates.find(k => Object.prototype.hasOwnProperty.call(bySourceMap, k));
    if (!key) continue;
    usedKeys.add(key);
    entries.push([source.label, bySourceMap[key] || [], source]);
  }

  for (const [key, items] of Object.entries(bySourceMap || {})) {
    if (!usedKeys.has(key)) entries.push([key, items, null]);
  }

  return entries;
}

function sourceIcon(slug, fallback) {
  if (fallback) return fallback;
  if (!slug) return '📡';
  const key = String(slug).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return SOURCE_ICON[key] || '📡';
}

function sourceNavState() {
  try {
    return localStorage.getItem('eagleye-source-nav-collapsed') === '1';
  } catch {
    return false;
  }
}

function setSourceNavState(collapsed) {
  try {
    localStorage.setItem('eagleye-source-nav-collapsed', collapsed ? '1' : '0');
  } catch {
    // ignore
  }
}

/**
 * Render the horizontal collapsible source nav. Returns HTML string.
 * Pass `currentSlug` to highlight the active source, or null for the index page.
 */
export function renderSourceNav(currentSlug) {
  const collapsed = sourceNavState();
  const label = collapsed ? t('sources.nav_expand') : t('sources.nav_collapse');
  const allLabel = t('sources.tab_all');
  const chev = '<span class="chev">▾</span>';

  return `
    <nav class="sources-tab-nav ${collapsed ? 'collapsed' : ''}" id="sourcesTabNav" aria-label="${escapeAttr(t('sources.title'))}">
      <div class="sources-tab-nav-inner">
        <button class="sources-tab-nav-toggle" id="sourcesTabNavToggle" type="button" aria-expanded="${!collapsed}" title="${escapeAttr(label)}">
          ${label}${chev}
        </button>
        <div class="sources-tab-nav-list" id="sourcesTabNavList" role="tablist">
          <a href="/sources" class="sources-tab-pill ${!currentSlug ? 'active' : ''}" role="tab" aria-selected="${!currentSlug}">
            <span class="sources-tab-pill-icon">📚</span>
            <span>${allLabel}</span>
          </a>
          ${/* source pills are rendered by hydrateSourceNavPills() to keep this synchronous */
            ''}
        </div>
      </div>
    </nav>
  `;
}

/**
 * Async: fetch sources list and inject the per-source pills into the nav.
 * Also wires the collapse toggle. Safe to call multiple times.
 */
export async function hydrateSourceNavPills() {
  const list = document.getElementById('sourcesTabNavList');
  const nav = document.getElementById('sourcesTabNav');
  const toggle = document.getElementById('sourcesTabNavToggle');
  if (!list || !nav) return;

  if (toggle && !toggle.dataset.wired) {
    toggle.dataset.wired = '1';
    toggle.addEventListener('click', () => {
      const collapsed = nav.classList.toggle('collapsed');
      setSourceNavState(collapsed);
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.setAttribute('title', collapsed ? t('sources.nav_expand') : t('sources.nav_collapse'));
      toggle.firstChild.textContent = (collapsed ? t('sources.nav_expand') : t('sources.nav_collapse'));
    });
  }

  // Build pills from the cached list
  const sources = await getSourcesCached();
  if (!sources.length) return;

  const currentSlug = (window.location.pathname.match(/^\/sources\/(.+)$/) || [])[1] || null;
  const allLink = list.querySelector('a[href="/sources"]');
  if (allLink) {
    allLink.classList.toggle('active', !currentSlug);
    allLink.setAttribute('aria-selected', String(!currentSlug));
  }

  const pillsHtml = sources.map(s => {
    const slug = escapeAttr(s.slug);
    const isActive = currentSlug === s.slug;
    const total = s.total_items || 0;
    const today = s.today_items || 0;
    const icon = sourceIcon(s.slug);
    const label = escapeHtml(pickZh(s.label, s.label_zh) || s.slug);
    const countLabel = today > 0
      ? `${today} · ${total}`
      : `${total}`;
    return `
      <a href="/sources/${slug}" class="sources-tab-pill ${isActive ? 'active' : ''}" role="tab" aria-selected="${isActive}" title="${escapeAttr(t('sources.jump_to'))}: ${label}">
        <span class="sources-tab-pill-icon">${icon}</span>
        <span>${label}</span>
        <span class="sources-tab-pill-count">${countLabel}</span>
      </a>
    `;
  }).join('');

  if (allLink) {
    allLink.insertAdjacentHTML('afterend', pillsHtml);
  } else {
    list.innerHTML = pillsHtml;
  }
}

// ─── Home / News ─────────────────────────────────────────

export async function renderHome(params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING SIGNALS...' : t('common.loading'));

try {
      const queryDate = params?.date || new URLSearchParams(window.location.search).get('date');
      const today = queryDate || localDateStr();
      const isToday = today === localDateStr();

      // Fetch sources to get full list (14 sources)
     const srcData = await fetchJSON(`${API_BASE}/sources`);
     const allSources = srcData.sources || [];
     _sourcesCache = allSources;

     // Fetch today's items (initial batch: 60, progressive loading picks up the rest)
     let data = await fetchJSON(`${API_BASE}/items?date=${today}&limit=60`);

     // If no items for today, try getting most recent date with data
     let displayDate = today;
     let dateIsToday = isToday;
     if ((data.items || []).length === 0 && !queryDate) {
       // Try yesterday
       const yesterday = new Date();
       yesterday.setDate(yesterday.getDate() - 1);
       const yesterdayStr = localDateStr(yesterday);
       data = await fetchJSON(`${API_BASE}/items?date=${yesterdayStr}&limit=60`);
       displayDate = yesterdayStr;
       dateIsToday = false;
     }

     // Build by_source map from items (items come with source_label)
     const bySourceMap = {};
     for (const item of data.items || []) {
       const src = item.source_label || 'Other';
       if (!bySourceMap[src]) bySourceMap[src] = [];
       bySourceMap[src].push(item);
     }

     // Build label-to-slug map including _zh variants so anchor nav and section headers
     // can show the localized name regardless of which language the user picks.
     const labelToObj = {};
     for (const s of allSources) {
       labelToObj[s.label] = s;
       if (s.label_zh) labelToObj[s.label_zh] = s;
     }

     // Ensure all sources appear, even empty today
     for (const src of allSources) {
       const label = src.label;
       if (!(label in bySourceMap)) {
         bySourceMap[label] = [];
       }
     }

      const html = `
       <section class="page-section">
         <div class="issue-header">
          <div class="issue-meta">
            <span class="issue-number">ISSUE #${displayDate}</span>
            <span class="issue-date">${new Date(displayDate.slice(0,4)+'-'+displayDate.slice(4,6)+'-'+displayDate.slice(6,8)).toLocaleDateString(getLanguage() === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' })}${dateIsToday ? ` (${t('home.today')})` : ''}</span>
          </div>
          <div class="issue-nav">
            <button class="nav-btn" onclick="window.__changeDate(-1)">← PREV</button>
            <button class="nav-btn" onclick="window.__changeDate(1)">NEXT →</button>
          </div>
        </div>

         <div class="hero-banner">
           <div class="hero-content">
             <h2 class="hero-title">EAGLEYE</h2>
             <p class="hero-subtitle">${t('brand.tagline')} Radar</p>
             <div class="hero-stats">
               <span class="hero-stat">${Object.keys(bySourceMap).length} SOURCES</span>
               <span class="hero-stat">${Object.values(bySourceMap).reduce((sum, arr) => sum + arr.length, 0)} SIGNALS</span>
             </div>
           </div>
         </div>

        <div class="search-wrap search-wrap-full">
          <input type="text" class="search-input-hero" id="heroSearchInput" placeholder="${escapeAttr(t('common.search_ph'))}" autocomplete="off">
        </div>

         <div class="section-anchor-nav" id="sectionNav">
           ${orderedSourceEntries(bySourceMap, allSources).map(([src, _items, sourceObjFromOrder]) => {
             const sourceObj = sourceObjFromOrder || labelToObj[src];
             const slug = sourceObj ? sourceObj.slug : '';
             const displayName = sourceObj ? pickZh(sourceObj.label, sourceObj.label_zh) : src;
             return `<a href="/sources/${escapeAttr(slug)}" class="anchor-link">${escapeHtml(displayName)}</a>`;
           }).join('')}
         </div>

         <div class="items-by-source">
           ${orderedSourceEntries(bySourceMap, allSources).map(([source, items, sourceObjFromOrder]) => {
             const sourceObj = sourceObjFromOrder || labelToObj[source];
             const displayName = sourceObj ? pickZh(sourceObj.label, sourceObj.label_zh) : source;
             return `
             <section id="section-${escapeAttr(source)}" class="source-section">
               <div class="source-section-header">
                 <h3 class="source-section-title">${escapeHtml(displayName)}</h3>
                 <span class="source-section-count">${items.length} ITEMS</span>
               </div>
               <div class="feed-list">
                 ${items.map(item => renderItemMiniCard(item)).join('')}
               </div>
             </section>
           `;}).join('')}
         </div>
      </section>
    `;

    container.innerHTML = html;
    
    // Wire search input on homepage
    const heroSearchInput = /** @type {HTMLInputElement | null} */ (document.getElementById('heroSearchInput'));
    if (heroSearchInput) {
      heroSearchInput.addEventListener('input', () => {
        const q = heroSearchInput.value.trim().toLowerCase();
        const cards = container.querySelectorAll('.info-card');
        cards.forEach(card => {
          const title = card.querySelector('.card-title')?.textContent?.toLowerCase() || '';
          const summary = card.querySelector('.card-summary')?.textContent?.toLowerCase() || '';
          const src = card.querySelector('.card-source')?.textContent?.toLowerCase() || '';
          const oneLiner = card.querySelector('.card-one-liner')?.textContent?.toLowerCase() || '';
          const visible = !q || title.includes(q) || summary.includes(q) || src.includes(q) || oneLiner.includes(q);
          card.style.display = visible ? '' : 'none';
          // Highlight matching text
          const titleEl = card.querySelector('.card-title a') || card.querySelector('.card-title');
          if (visible && q && titleEl) {
            if (titleEl.dataset.original === undefined) titleEl.dataset.original = titleEl.innerHTML;
            const originalHtml = titleEl.dataset.original;
            const r = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
            titleEl.innerHTML = originalHtml.replace(r, '<mark style="background:var(--accent); color:#000; padding:0 2px;">$1</mark>');
          } else if (titleEl && titleEl.dataset.original !== undefined) {
            titleEl.innerHTML = titleEl.dataset.original;
          }
        });
        // Update visible counts for source sections
        container.querySelectorAll('.source-section').forEach(section => {
          const cards = section.querySelectorAll('.info-card');
          const visible = Array.from(cards).filter(c => c.style.display !== 'none').length;
          const countEl = section.querySelector('.source-section-count');
          if (countEl) countEl.textContent = `${visible} ITEMS`;
        });
      }, { passive: true });
    }

    // Sticky section nav behavior
    const sections = container.querySelectorAll('.source-section');
    const nav = container.querySelector('#sectionNav');
    if (nav && sections.length > 0) {
      window.addEventListener('scroll', () => {
        let current = '';
        sections.forEach(sec => {
          const top = sec.getBoundingClientRect().top;
          if (top < 200) current = sec.id;
        });
        nav.querySelectorAll('.anchor-link').forEach(a => {
          a.classList.toggle('active', a.getAttribute('href') === `#${current}`);
        });
      }, { passive: true });
    }

    /** @type {any} */ (window).__changeDate = (delta) => {
      // Parse current date from URL or use today
      const queryDate = new URLSearchParams(window.location.search).get('date')
        || params?.date
        || localDateStr();
      const d = new Date(queryDate.slice(0,4)+'-'+queryDate.slice(4,6)+'-'+queryDate.slice(6,8));
      d.setDate(d.getDate() + delta);
      const newDate = localDateStr(d);
      if ((/** @type {any} */ (window)).__router) {
        (/** @type {any} */ (window)).__router.navigate(`/news/${newDate}`);
      }
    };

    // Progressive loading: append more items as user scrolls
    const feedContainer = container.querySelector('.items-by-source');
    if (feedContainer) {
      progressiveDateFeed({
        container: feedContainer,
        date: displayDate,
        batchSize: 40,
        renderItem: (item) => {
          const src = item.source_label || 'Other';
          let section = feedContainer.querySelector(`#section-${CSS.escape(src)}`);
          if (!section) {
            const wrapper = document.createElement('section');
            wrapper.id = `section-${CSS.escape(src)}`;
            wrapper.className = 'source-section';
            wrapper.innerHTML = `<div class="source-section-header"><h3 class="source-section-title">${escapeHtml(src)}</h3><span class="source-section-count">0 ITEMS</span></div><div class="feed-list"></div>`;
            feedContainer.appendChild(wrapper);
            section = wrapper;
          }
          const list = section.querySelector('.feed-list');
          if (list) {
            const count = section.querySelector('.source-section-count');
            const currentCount = list.querySelectorAll('.mini-card').length + 1;
            if (count) count.textContent = `${currentCount} ITEMS`;
          }
          return `<div>${renderItemMiniCard(item)}</div>`;
        },
      });
    }
  } catch (err) {
    showError(container, err.message);
  }
}

// ─── Item Card ────────────────────────────────────────────

export function renderItemCard(item) {
  const payload = item.source_payload || {};
  const popularity = item.popularity || {};
  const summary = item.ai_summary || {};

  const stars = popularity.stars ? `<span class="meta-chip">★ ${popularity.stars}</span>` : '';
  const points = popularity.points ? `<span class="meta-chip">▲ ${popularity.points}</span>` : '';
  const comments = popularity.comments ? `<span class="meta-chip">💬 ${popularity.comments}</span>` : '';
  const upvotes = popularity.upvotes ? `<span class="meta-chip">👍 ${popularity.upvotes}</span>` : '';
  const forks = popularity.forks ? `<span class="meta-chip">⑂ ${popularity.forks}</span>` : '';
  const language = payload.language ? `<span class="meta-chip lang-chip">${payload.language}</span>` : '';

  const topics = (item.topics || []).map(t =>
    `<a href="/topics/${escapeAttr(t.slug)}" class="topic-tag">${escapeHtml(pickZh(t.name, t.name_zh))}</a>`
  ).join('');

  const tagChips = (item.tags || []).map(tag =>
    `<a href="${escapeAttr(tagHref(tag))}" class="tag-chip">#${escapeHtml(tag.name)}</a>`
  ).join(' ');

  // Localized content
  const title = getItemDisplayTitle(item);
  const oneLiner = pickZh(summary.one_liner, summary.one_liner_zh);
  const shortSummary = pickZh(summary.short_summary, summary.short_summary_zh);
  let keyPointsArr;
  try {
    const kps = typeof summary.key_points === 'string' ? JSON.parse(summary.key_points) : summary.key_points;
    const kpsZh = typeof summary.key_points_zh === 'string' ? JSON.parse(summary.key_points_zh) : summary.key_points_zh;
    keyPointsArr = pickZh(kps, kpsZh);
    if (!Array.isArray(keyPointsArr)) keyPointsArr = [];
  } catch { keyPointsArr = []; }

  const deployable = payload.stars >= 5000 ? 'deployable' : (payload.stars >= 1000 ? 'maybe' : 'no');
  const deployLabel = deployable === 'deployable' ? (getLanguage() === 'zh' ? '一键部署' : '1-Click Deploy') : (deployable === 'maybe' ? (getLanguage() === 'zh' ? '部署分析' : 'Deploy Analysis') : '');
  const showDeploy = deployable !== 'no';
  const researchLabel = getLanguage() === 'zh' ? '深度研究' : 'Deep Research';
  const originalLabel = getLanguage() === 'zh' ? '原文' : 'Original';
  const confidenceLabel = getLanguage() === 'zh' ? 'AI 置信度' : 'AI Confidence';

  return `
    <article class="info-card">
      <div class="card-header">
        <span class="card-source">${escapeHtml(item.source_label || '')}</span>
        <div class="card-meta-right">
          ${language}${stars}${points}${comments}${upvotes}${forks}
        </div>
      </div>
      <h4 class="card-title">
        <a href="${escapeAttr(item.canonical_url || '#')}" target="_blank" rel="noopener">
          ${escapeHtml(title)}
        </a>
      </h4>
      ${oneLiner ? `<p class="card-one-liner">${escapeHtml(oneLiner)}</p>` : ''}
      ${shortSummary ? `<p class="card-summary">${escapeHtml(shortSummary)}</p>` : ''}
      ${keyPointsArr.length > 0
        ? `<ul class="card-key-points">${keyPointsArr.map(kp => `<li>${escapeHtml(kp)}</li>`).join('')}</ul>`
        : ''}
      <div class="card-topics">${topics}</div>
      ${tagChips ? `<div class="card-tags">${tagChips}</div>` : ''}
      <div class="card-actions">
        <button class="action-btn research-btn" data-item-id="${escapeAttr(item.id)}" data-title="${escapeAttr(getItemResearchTitle(item))}">
          🔍 ${escapeHtml(researchLabel)}
        </button>
        ${showDeploy ? `<button class="action-btn deploy-btn" data-item-id="${escapeAttr(item.id)}">🚀 ${escapeHtml(deployLabel)}</button>` : ''}
        <a href="${escapeAttr(item.canonical_url || '#')}" target="_blank" rel="noopener" class="action-link">
          ${escapeHtml(originalLabel)} ↗
        </a>
        <span class="card-time">${item.published_at ? timeAgo(item.published_at) : timeAgo(item.created_at)}</span>
      </div>
      ${summary.confidence ? `<div class="card-confidence">${escapeHtml(confidenceLabel)}: ${(summary.confidence * 100).toFixed(0)}%</div>` : ''}
    </article>
  `;
}

/**
 * Compact feed row: one line per item, dense and scannable.
 * Used in source detail and digest pages for fast browsing.
 */
export function renderItemRow(item) {
  const payload = item.source_payload || {};
  const popularity = item.popularity || {};
  const summary = item.ai_summary || {};

  const rankChip = popularity.points
    ? `<span class="feed-rank">▲ ${popularity.points}</span>`
    : popularity.stars
    ? `<span class="feed-rank">★ ${popularity.stars}</span>`
    : `<span class="feed-rank feed-rank-num">#${item.importance || 5}</span>`;
  const commentChip = popularity.comments ? `<span class="feed-meta">💬 ${popularity.comments}</span>` : '';
  const timeChip = `<span class="feed-time">${item.published_at ? timeAgo(item.published_at) : timeAgo(item.created_at)}</span>`;

  const title = getItemDisplayTitle(item);
  const oneLinerText = pickZh(
    summary.one_liner || summary.short_summary,
    summary.one_liner_zh || summary.short_summary_zh
  );
  const oneLiner = oneLinerText
    ? `<span class="feed-oneliner">${escapeHtml(oneLinerText)}</span>`
    : '';
  const topics = (item.topics || []).slice(0, 2).map(t =>
    `<a href="/topics/${escapeAttr(t.slug)}" class="feed-topic">${escapeHtml(pickZh(t.name, t.name_zh))}</a>`
  ).join('');

  const researchLabel = getLanguage() === 'zh' ? '研究' : 'Research';
  const originalLabel = getLanguage() === 'zh' ? '原文' : 'Source';

  return `
    <article class="feed-row">
      <div class="feed-row-rank">${rankChip}</div>
      <div class="feed-row-main">
        <h4 class="feed-row-title">
          <a href="${escapeAttr(item.canonical_url || '#')}" target="_blank" rel="noopener">${escapeHtml(title)}</a>
        </h4>
        ${oneLiner ? `<div class="feed-row-sub">${oneLiner}</div>` : ''}
      </div>
      <div class="feed-row-meta">
        ${commentChip}${topics}${timeChip}
        <button class="feed-btn research-btn" data-item-id="${escapeAttr(item.id)}" data-title="${escapeAttr(getItemResearchTitle(item))}" title="${escapeAttr(researchLabel)}">🔍</button>
        <a class="feed-btn feed-btn-link" href="${escapeAttr(item.canonical_url || '#')}" target="_blank" rel="noopener" title="${escapeAttr(originalLabel)}">↗</a>
      </div>
    </article>
  `;
}

/**
 * Compact mini card for source detail 3-column grid.
 * Shows key info in a small card ~2 feed-rows tall.
 */
export function renderItemMiniCard(item) {
  const popularity = item.popularity || {};
  const summary = item.ai_summary || {};
  const isXFollowing = item.source_slug === 'x-following';

  const rankChip = popularity.points
    ? `<span class="mini-rank">▲ ${popularity.points}</span>`
    : popularity.stars
    ? `<span class="mini-rank">★ ${popularity.stars}</span>`
    : popularity.upvotes
    ? `<span class="mini-rank">👍 ${popularity.upvotes}</span>`
    : '';

  const commentChip = popularity.comments ? `<span class="mini-meta">💬 ${popularity.comments}</span>` : '';
  const timeChip = `<span class="mini-time">${item.published_at ? timeAgo(item.published_at) : timeAgo(item.created_at)}</span>`;

  const title = getItemDisplayTitle(item);
  const oneLinerText = pickZh(
    summary.one_liner || summary.short_summary,
    summary.one_liner_zh || summary.short_summary_zh
  );
  const oneLiner = !isXFollowing && oneLinerText
    ? `<p class="mini-oneliner">${escapeHtml(oneLinerText)}</p>`
    : '';

  const topics = (item.topics || []).slice(0, 3).map(t =>
    `<a href="/topics/${escapeAttr(t.slug)}" class="mini-topic">${escapeHtml(pickZh(t.name, t.name_zh))}</a>`
  ).join('');

  const researchLabel = getLanguage() === 'zh' ? '研究' : 'Research';
  const originalLabel = getLanguage() === 'zh' ? '原文' : 'Source';
  const lang = item.source_payload?.language || item.language ? `<span class="mini-lang">${escapeHtml(item.source_payload?.language || item.language || '')}</span>` : '';

  return `
    <article class="mini-card${isXFollowing ? ' mini-card-x' : ''}">
      <div class="mini-card-top">
        <h4 class="mini-title${isXFollowing ? ' mini-title-x' : ''}">
          <a href="${escapeAttr(item.canonical_url || '#')}" target="_blank" rel="noopener">${escapeHtml(title)}</a>
        </h4>
        ${oneLiner}
      </div>
      <div class="mini-card-mid">
        <span class="mini-source">${escapeHtml(item.source_label || '')}</span>
        ${lang}
        ${rankChip}
        ${commentChip}
        ${timeChip}
      </div>
      ${topics ? `<div class="mini-card-bottom">${topics}</div>` : ''}
      <div class="mini-card-actions">
        <button class="mini-action research-btn" data-item-id="${escapeAttr(item.id)}" data-title="${escapeAttr(getItemResearchTitle(item))}">🔍 ${escapeHtml(researchLabel)}</button>
        <a class="mini-action mini-action-link" href="${escapeAttr(item.canonical_url || '#')}" target="_blank" rel="noopener">${escapeHtml(originalLabel)} ↗</a>
      </div>
    </article>
  `;
}

// ─── Daily Digest ────────────────────────────────────────

export async function renderDigest(_params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING DIGEST...' : t('common.loading'));

  try {
    // Fetch daily coverage data
    let dateCoverage = {};
    try {
      const coverageData = await fetchJSON(`${API_BASE}/digest/coverage`);
      if (coverageData.coverage) {
        dateCoverage = coverageData.coverage;
      }
    } catch (_e) { /* ignore coverage fetch errors */ }

    const dates = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = localDateStr(d);
      dates.push({
        dateStr,
        label: i === 0 ? t('digest.today') : i === 1 ? t('digest.yesterday') : t('digest.days_ago', { n: i }),
        display: localizedDate(d, { month: 'short', day: 'numeric' }),
        count: dateCoverage[dateStr] || 0,
      });
    }

    const html = `
      <section class="page-section">
        <div class="page-header">
          <h2 class="page-title">${t('digest.title')}</h2>
          <p class="page-description">${t('digest.subtitle')}</p>
        </div>
        <div class="digest-tabs">
          <a href="/digest" class="digest-tab active">${t('digest.title')}</a>
          <a href="/topics" class="digest-tab">${t('nav.topics')}</a>
          <a href="/sources" class="digest-tab">${t('nav.sources')}</a>
        </div>
        <div class="digest-list">
          ${dates.map(d => `
            <a href="/digest/${d.dateStr}" class="digest-item">
              <span class="digest-date">${d.dateStr}</span>
              <span class="digest-label">${d.label}</span>
              <span class="digest-display">${d.display}</span>
              <span class="digest-count">${d.count > 0 ? d.count : '—'}</span>
              <span class="digest-arrow">→</span>
            </a>
          `).join('')}
        </div>
      </section>
    `;

    container.innerHTML = html;
  } catch (err) {
    showError(container, err.message);
  }
}

export async function renderDigestDate(params) {
  const container = $('#pageContent');
  const date = params?.slug || params?.date || window.location.pathname.replace('/digest/', '').split('?')[0];
  showLoader(container, `${t('common.loading')} ${date}...`);

  try {
    const sources = await getSourcesCached();
    const data = await fetchJSON(`${API_BASE}/digest?date=${date}`);

    // Build prev/next dates
    const d = new Date(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8));
    const prevDate = localDateStr(new Date(d.getTime() - 86400000));
    const nextDate = localDateStr(new Date(d.getTime() + 86400000));
    const displayDate = localizedDate(d, { year: 'numeric', month: 'long', day: 'numeric' });

    const html = `
      <section class="page-section">
        <div class="page-header">
          <div class="digest-nav">
            <button class="nav-btn" onclick="window.location.href='/digest/${prevDate}'">← PREV</button>
            <a href="/digest" class="nav-link">← ${t('digest.title')}</a>
            <h2 class="page-title">${t('digest.title')} / ${date}</h2>
            <span class="digest-date-label">${displayDate}</span>
            <button class="nav-btn" onclick="window.location.href='/digest/${nextDate}'">NEXT →</button>
          </div>
        </div>
        ${data.digest ? `
          <div class="digest-summary">
            <h3>${escapeHtml(data.digest.headline || '')}</h3>
            <p>${escapeHtml(data.digest.executive_summary || '')}</p>
          </div>
        ` : ''}
        <div class="items-by-source">
          ${orderedSourceEntries(data.by_source || {}, sources).map(([source, items, sourceObjFromOrder]) => {
            // Find a representative item's source_label to map to label_zh via sources cache
            const firstItem = items[0] || {};
            const slug = firstItem.source_slug;
            const cached = sourceObjFromOrder || (slug ? _sourcesCache.find(s => s.slug === slug) : null);
            const displayName = cached ? pickZh(cached.label, cached.label_zh) : (firstItem.source_label || source);
            return `
            <section class="source-section">
              <div class="source-section-header">
                <h3 class="source-section-title">${escapeHtml(displayName)}</h3>
                <span class="source-section-count">${items.length} ITEMS</span>
              </div>
              <div class="feed-list">
                ${items.map(item => renderItemMiniCard(item)).join('')}
              </div>
            </section>
          `;}).join('')}
        </div>
      </section>
    `;

    container.innerHTML = html;
  } catch (err) {
    showError(container, err.message);
  }
}

// ─── Sources ──────────────────────────────────────────────

export async function renderSources(_params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING SOURCES...' : t('common.loading'));

  try {
    const data = await fetchJSON(`${API_BASE}/sources`);
    _sourcesCache = data.sources || [];

    const html = `
      <section class="page-section">
        ${renderSourceNav(null)}
        <div class="page-header">
          <h2 class="page-title">${t('sources.title')}</h2>
          <p class="page-description">${t('sources.subtitle')}</p>
        </div>
        <div class="sources-grid">
          ${(data.sources || []).map(src => {
            const icon = sourceIcon(src.slug);
            const statsParts = [];
            if (src.today_items > 0) {
              statsParts.push(`<span class="source-stat">📡 ${src.today_items}</span>`);
            }
            statsParts.push(`<span class="source-stat">📊 ${src.total_items || 0}</span>`);
            // Source quality badge from source_profiles (noise_rate)
            let qualityBadge = '';
            if (src.noise_rate != null) {
              const pct = Math.round(src.noise_rate * 100);
              const dot = pct < 10 ? '🟢' : pct < 30 ? '🟡' : '🔴';
              const label = src.source_type === 'noisy' ? t('signals.noisy') :
                            src.source_type === 'early_signal' ? t('signals.early_signal') :
                            src.source_type === 'originator' ? t('signals.originator') :
                            t('signals.amplifier');
              qualityBadge = `<span class="source-stat" title="${t('signals.noise_rate')}: ${pct}%">${dot} ${escapeHtml(label)} ${pct}%</span>`;
            }
            return `
            <a href="/sources/${escapeAttr(src.slug)}" class="source-card">
              <div class="source-card-header">
                <span class="source-name">${icon} ${escapeHtml(pickZh(src.label, src.label_zh))}</span>
                <span class="source-connector-type">${escapeHtml(src.connector_type || 'rss')}</span>
              </div>
              <p class="source-description">${escapeHtml(pickZh(src.description, src.description_zh) || '')}</p>
              <div class="source-stats">
                ${statsParts.join('')}
                ${qualityBadge}
              </div>
              ${(src.feed_url || src.homepage_url) ? `
              <div class="source-links">
                ${src.homepage_url ? `<span class="source-link-label">🌐</span><span class="source-link-url">${escapeHtml(src.homepage_url)}</span>` : ''}
                ${src.feed_url ? `<span class="source-link-label">📡</span><span class="source-link-url">${escapeHtml(src.feed_url)}</span>` : ''}
              </div>` : ''}
            </a>
          `;}).join('')}
        </div>
      </section>
    `;

    container.innerHTML = html;
    await hydrateSourceNavPills();
  } catch (err) {
    showError(container, err.message);
  }
}

export async function renderSourceDetail(params) {
  const container = $('#pageContent');
  const slug = params?.slug || '';
  showLoader(container, `${t('common.loading')} ${slug}...`);

  try {
    const data = await fetchJSON(`${API_BASE}/source/${slug}`);
    const src = data.source || {};
    const items = data.items || [];

    const icon = sourceIcon(src.slug);
    const homepageLink = src.homepage_url
      ? `<a href="${escapeAttr(src.homepage_url)}" target="_blank" rel="noopener" class="source-meta-link">${t('sources.visit')}</a>`
      : '';
    const feedLink = src.feed_url
      ? `<a href="/rss-proxy?url=${encodeURIComponent(src.feed_url)}" class="source-meta-link">${t('sources.feed')}</a>`
      : '';
    const desc = src.description ? `<span class="source-meta-desc">${escapeHtml(pickZh(src.description, src.description_zh))}</span>` : '';

    const html = `
      <section class="page-section">
        ${renderSourceNav(slug)}
        <div class="source-detail-bar">
          <span class="source-detail-icon">${icon}</span>
          <span class="source-detail-name">${escapeHtml(pickZh(src.label, src.label_zh) || slug)}</span>
          <span class="source-detail-count" id="sourceItemCount">${t('sources.items_count', { n: items.length })}</span>
          ${desc}
          <span class="source-detail-actions">${homepageLink}${feedLink}</span>
        </div>
        <div class="source-items-grid" id="sourceItemsGrid">
          ${items.map(item => renderItemMiniCard(item)).join('')}
          ${items.length === 0 ? `<p class="empty-state">${t('sources.no_items')}</p>` : ''}
        </div>
      </section>
    `;

    container.innerHTML = html;
    await hydrateSourceNavPills();

    // Progressive loading for source detail
    const grid = container.querySelector('#sourceItemsGrid');
    if (grid && items.length >= 30) {
      progressiveSourceFeed({
        container: grid,
        sourceSlug: slug,
        batchSize: 40,
        renderItem: (item) => {
          const countEl = document.getElementById('sourceItemCount');
          if (countEl) {
            const current = grid.querySelectorAll('.mini-card').length + 1;
            countEl.textContent = `${current} ITEMS`;
          }
          return `<div>${renderItemMiniCard(item)}</div>`;
        },
      });
    }
  } catch (err) {
    showError(container, err.message);
  }
}

export async function renderResearchPage(params) {
  const container = $('#pageContent');
  const itemId = params?.id || window.location.pathname.replace('/research/', '').split('?')[0];
  showLoader(container, getLanguage() === 'zh' ? '正在载入研究页...' : 'LOADING RESEARCH...');

  if (!itemId) {
    showError(container, getLanguage() === 'zh' ? '缺少 item id' : 'Missing item id');
    return;
  }

  try {
    const data = await API.fetchItem(itemId);
    const item = data.item || {};
    const summary = item.ai_summary || {};
    const deploy = data.deploy || {};
    const title = getItemDisplayTitle(item);
    const oneLiner = pickZh(summary.one_liner, summary.one_liner_zh);
    const shortSummary = pickZh(summary.short_summary, summary.short_summary_zh);
    const whyItMatters = pickZh(summary.why_it_matters, summary.why_it_matters_zh);

    let keyPoints = [];
    try {
      const en = typeof summary.key_points === 'string' ? JSON.parse(summary.key_points) : summary.key_points;
      const zh = typeof summary.key_points_zh === 'string' ? JSON.parse(summary.key_points_zh) : summary.key_points_zh;
      keyPoints = pickZh(en, zh);
      if (!Array.isArray(keyPoints)) keyPoints = [];
    } catch {
      keyPoints = [];
    }

    const topicLinks = (item.topics || []).map((topic) =>
      `<a href="/topics/${escapeAttr(topic.slug)}" class="research-topic-chip">${escapeHtml(pickZh(topic.name, topic.name_zh) || topic.slug)}</a>`
    ).join('');
    const tagLinks = (item.tags || []).map((tag) =>
      `<span class="research-tag-chip">${escapeHtml(tag.name || tag.slug || '')}</span>`
    ).join('');
    const deployBadge = deploy?.eligibility
      ? `<span class="research-deploy-badge research-deploy-${escapeAttr(deploy.eligibility)}">${escapeHtml(deploy.eligibility)}</span>`
      : '';

    container.innerHTML = `
      <section class="page-section research-page">
        <div class="page-header research-page-header">
          <div class="research-page-meta">
            <a href="/news" class="research-back-link">← ${escapeHtml(t('nav.news'))}</a>
            <span class="research-source-pill">${escapeHtml(item.source_label || '')}</span>
            ${deployBadge}
          </div>
          <h2 class="page-title">${escapeHtml(title)}</h2>
          <p class="page-description">${escapeHtml(getLanguage() === 'zh' ? '围绕单条信号的研究、追问与上下文整理。' : 'Signal-specific research, follow-up chat, and context synthesis.')}</p>
        </div>

        <div class="research-page-grid">
          <div class="research-main-col">
            <section class="research-summary-card">
              <div class="research-summary-top">
                <div class="research-summary-source">${escapeHtml(item.source_label || '')}</div>
                <div class="research-summary-time">${escapeHtml(item.published_at ? timeAgo(item.published_at) : timeAgo(item.created_at))}</div>
              </div>
              ${oneLiner ? `<p class="research-one-liner">${escapeHtml(oneLiner)}</p>` : ''}
              ${shortSummary ? `<p class="research-short-summary">${escapeHtml(shortSummary)}</p>` : ''}
              ${keyPoints.length ? `<ul class="research-key-points">${keyPoints.map((point) => `<li>${escapeHtml(point)}</li>`).join('')}</ul>` : ''}
              ${whyItMatters ? `<p class="research-why">${escapeHtml(whyItMatters)}</p>` : ''}
              <div class="research-summary-links">
                <a href="${escapeAttr(item.canonical_url || '#')}" target="_blank" rel="noopener" class="action-link">${escapeHtml(getLanguage() === 'zh' ? '打开原文' : 'Open Original')} ↗</a>
              </div>
            </section>

            <section class="research-report-card">
              <div class="research-card-head">
                <h3>${escapeHtml(t('research.title'))}</h3>
                <button class="action-btn" id="researchRefreshBtn">${escapeHtml(getLanguage() === 'zh' ? '重新研究' : 'Refresh')}</button>
              </div>
              <div id="researchReportBody" class="research-report-body">
                <div class="page-loading"><div class="spinner"></div><span>${escapeHtml(getLanguage() === 'zh' ? '正在生成研究报告...' : 'Generating research report...')}</span></div>
              </div>
            </section>
          </div>

          <aside class="research-side-col">
            <section class="research-context-card">
              <div class="research-card-head">
                <h3>${escapeHtml(getLanguage() === 'zh' ? '上下文' : 'Context')}</h3>
              </div>
              ${topicLinks ? `<div class="research-chip-row">${topicLinks}</div>` : ''}
              ${tagLinks ? `<div class="research-chip-row">${tagLinks}</div>` : ''}
              <div class="research-context-meta">
                <div><label>ID</label><span class="mono">${escapeHtml(item.id || '')}</span></div>
                <div><label>Source</label><span>${escapeHtml(item.source_slug || '')}</span></div>
                <div><label>URL</label><span class="mono">${escapeHtml((item.canonical_url || '').slice(0, 80) || '—')}</span></div>
              </div>
            </section>

            <section class="research-chat-card">
              <div class="research-card-head">
                <h3>${escapeHtml(getLanguage() === 'zh' ? '研究对话' : 'Research Chat')}</h3>
              </div>
              <div id="researchChatMessages" class="research-chat-messages"></div>
              <form id="researchChatForm" class="research-chat-form">
                <textarea id="researchChatInput" class="research-chat-input" rows="4" placeholder="${escapeAttr(getLanguage() === 'zh' ? '继续追问这条信息的背景、风险、机会、后续跟踪点…' : 'Ask follow-up questions about context, risks, opportunities, and what to track next...')}"></textarea>
                <div class="research-chat-actions">
                  <span id="researchChatStatus" class="research-chat-status">${escapeHtml(getLanguage() === 'zh' ? '就绪' : 'Ready')}</span>
                  <button type="submit" class="action-btn primary" id="researchChatSendBtn">${escapeHtml(getLanguage() === 'zh' ? '发送' : 'Send')}</button>
                </div>
              </form>
            </section>
          </aside>
        </div>
      </section>
    `;

    const reportBody = $('#researchReportBody');
    const refreshBtn = $('#researchRefreshBtn');
    const chatMessages = $('#researchChatMessages');
    const chatForm = $('#researchChatForm');
    const chatInput = /** @type {HTMLTextAreaElement | null} */ ($('#researchChatInput'));
    const chatStatus = $('#researchChatStatus');
    const chatSendBtn = $('#researchChatSendBtn');
    const history = getResearchChatState(itemId);

    function renderChatMessages() {
      if (!chatMessages) return;
      if (!history.length) {
        chatMessages.innerHTML = `<div class="research-chat-empty">${escapeHtml(getLanguage() === 'zh' ? '研究报告生成后，可以继续追问这条信号。' : 'Once the report is ready, you can continue the discussion here.')}</div>`;
        return;
      }
      chatMessages.innerHTML = history.map((turn) => `
        <div class="research-chat-msg research-chat-${escapeAttr(turn.role || 'assistant')}">
          <div class="research-chat-role">${escapeHtml(turn.role === 'user' ? (getLanguage() === 'zh' ? '你' : 'You') : 'LLM')}</div>
          <div class="research-chat-bubble">${turn.role === 'assistant' ? renderMarkdownLite(turn.content) : `<p>${escapeHtml(turn.content)}</p>`}</div>
        </div>
      `).join('');
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    async function loadResearch(force = false) {
      if (!reportBody) return;
      reportBody.innerHTML = `<div class="page-loading"><div class="spinner"></div><span>${escapeHtml(force ? (getLanguage() === 'zh' ? '正在重新生成研究报告...' : 'Refreshing research report...') : (getLanguage() === 'zh' ? '正在生成研究报告...' : 'Generating research report...'))}</span></div>`;
      if (refreshBtn) refreshBtn.setAttribute('disabled', 'disabled');
      try {
        const result = await API.triggerItemResearch(itemId, force);
        const report = result.report?.report_markdown || result.report?.content || '';
        reportBody.innerHTML = renderMarkdownLite(report || (getLanguage() === 'zh' ? '研究报告为空。' : 'Research report is empty.'));
      } catch (err) {
        reportBody.innerHTML = `<div class="page-error">⚠ ${escapeHtml(err.message)}</div>`;
      } finally {
        if (refreshBtn) refreshBtn.removeAttribute('disabled');
      }
    }

    renderChatMessages();
    loadResearch(false);

    refreshBtn?.addEventListener('click', async () => {
      await loadResearch(true);
    });

    chatForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const question = String(chatInput?.value || '').trim();
      if (!question) return;

      history.push({ role: 'user', content: question });
      renderChatMessages();
      if (chatInput) chatInput.value = '';
      if (chatStatus) chatStatus.textContent = getLanguage() === 'zh' ? '思考中…' : 'Thinking...';
      if (chatSendBtn) chatSendBtn.setAttribute('disabled', 'disabled');

      try {
        const result = await API.chatItemResearch(
          itemId,
          question,
          history.slice(-8).map((turn) => ({ role: turn.role, content: turn.content })),
        );
        history.push({ role: 'assistant', content: result.answer || (getLanguage() === 'zh' ? '没有返回内容。' : 'No answer returned.') });
        if (chatStatus) chatStatus.textContent = getLanguage() === 'zh' ? '就绪' : 'Ready';
      } catch (err) {
        history.push({
          role: 'assistant',
          content: getLanguage() === 'zh'
            ? `现有上下文不足或研究对话失败：${err.message}`
            : `Research chat failed: ${err.message}`,
        });
        if (chatStatus) chatStatus.textContent = getLanguage() === 'zh' ? '失败' : 'Failed';
      } finally {
        renderChatMessages();
        if (chatSendBtn) chatSendBtn.removeAttribute('disabled');
      }
    });
  } catch (err) {
    showError(container, err.message);
  }
}

// ─── Topics ────────────────────────────────────────────────

export async function renderTopics(_params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING TOPICS...' : t('common.loading'));

  try {
    const data = await fetchJSON(`${API_BASE}/topics`);

    const html = `
      <section class="page-section topics-layout">
        <div class="page-header">
          <h2 class="page-title">${t('topics.title')}</h2>
          <a href="/kg3d" class="nav-link" style="margin-left:12px;">🧠 3D \u77E5\u8BC6\u56FE\u8C31</a>
          <p class="page-description">${t('topics.subtitle')}</p>
        </div>
        <div class="topics-three-col">
          <div class="topics-tree">
            <h3 class="col-title">${t('topics.title')}</h3>
            <div class="topic-list">
              ${(data.topics || []).map(t => `
                <a href="/topics/${escapeAttr(t.slug)}" class="topic-list-item">
                  <span class="topic-name">${escapeHtml(pickZh(t.name, t.name_zh))}</span>
                  <span class="topic-count">${t.item_count || 0}</span>
                </a>
              `).join('')}
            </div>
          </div>
          <div class="topics-graph">
            <h3 class="col-title">${t('header.graph_attr')}</h3>
            <div id="topicGraphContainer" class="topic-graph-viz">
              <p class="graph-placeholder">${t('common.connecting_graph')}</p>
            </div>
          </div>
          <div class="topics-detail" id="topicDetail">
            <h3 class="col-title">${t('topics.title')}</h3>
            <p class="detail-placeholder">${t('topics.detail_subtitle')}</p>
          </div>
        </div>
      </section>
    `;

    container.innerHTML = html;

    // Initialize knowledge graph with full data
    const graphContainer = container.querySelector('#topicGraphContainer');
    const graph = new KnowledgeGraph('topicGraphContainer');

    // Load full graph data
    try {
      const graphData = await fetchJSON('/api/graph/full');
      graph.init(graphData);
    } catch (err) {
      graphContainer.innerHTML = `<p class="graph-placeholder">Graph data unavailable: ${err.message}</p>`;
    }

    // Store graph instance for resize handling
    container._topicGraph = graph;

    // Set up click handler for topic list items
    container.querySelectorAll('.topic-list-item').forEach(el => {
      el.addEventListener('click', async (e) => {
        e.preventDefault();
        const slug = el.getAttribute('href').replace('/topics/', '');
        const detail = container.querySelector('#topicDetail');
        detail.innerHTML = '<div class="spinner"></div><p>Loading...</p>';

        try {
          const topicData = await fetchJSON(`/api/topics/${slug}`);
          renderTopicDetail(detail, topicData);

          // Highlight selected
          container.querySelectorAll('.topic-list-item').forEach(i => i.classList.remove('active'));
          el.classList.add('active');

          // Load topic-specific graph neighborhood
          try {
            const neighborhood = await fetchJSON(`/api/topics/${slug}/graph`);
            if (neighborhood.nodes && neighborhood.nodes.length > 0) {
              graph.update(neighborhood);
            }
          } catch (err) {
            console.warn('Topic graph neighborhood unavailable:', err.message);
          }
        } catch (err) {
          detail.innerHTML = `<p class="error">Error: ${err.message}</p>`;
        }
      });
    });

    // Handle window resize
    const resizeHandler = () => {
      if (container._topicGraph) {
        container._topicGraph.resize();
      }
    };
    window.addEventListener('resize', resizeHandler);

  } catch (err) {
    showError(container, err.message);
  }
}

function renderTopicDetail(container, data) {
  const topic = data.topic || {};
  const items = data.items || [];
  const neighbors = data.neighbors || [];

  const html = `
    <div class="topic-detail-header">
      <h4>${escapeHtml(pickZh(topic.name, topic.name_zh) || '')}</h4>
      ${topic.description ? `<p>${escapeHtml(pickZh(topic.description, topic.description_zh))}</p>` : ''}
      <div class="topic-detail-meta">
        <span>${t('topics.items', { n: topic.item_count || 0 })}</span>
        <span>Children: ${topic.child_count || 0}</span>
        <span>Growth: ${(topic.growth_score || 0).toFixed(2)}</span>
      </div>
    </div>
    <div class="topic-detail-items">
      <h5>${t('topics.recent_items')}</h5>
      ${items.map(item => `
        <div class="topic-item-row">
          <a href="${escapeAttr(item.canonical_url || '#')}" target="_blank">${escapeHtml(getItemDisplayTitle(item) || '')}</a>
          <span class="topic-item-source">${escapeHtml(item.source_label || '')}</span>
          <span class="topic-item-relevance">${(item.relevance || 0).toFixed(2)}</span>
        </div>
      `).join('')}
      ${items.length === 0 ? `<p class="empty">${t('common.empty')}</p>` : ''}
    </div>
    <div class="topic-detail-neighbors">
      <h5>${t('topics.related_topics')} (${neighbors.length})</h5>
      ${neighbors.map(n => `
        <div class="neighbor-row">
          <span class="neighbor-edge">${escapeHtml(n.edge_type)}</span>
          <span class="neighbor-weight">w: ${(n.weight || 1).toFixed(1)}</span>
        </div>
      `).join('')}
    </div>
  `;

  container.innerHTML = html;
}

export async function renderTopicDetailPage(params) {
  const container = $('#pageContent');
  const slug = params?.slug || '';
  showLoader(container, `${t('common.loading')} ${slug}...`);

  try {
    const topicData = await fetchJSON(`/api/topics/${slug}`);
    const topic = topicData.topic || {};
    const items = topicData.items || [];

    const html = `
      <section class="page-section">
        <div class="page-header">
          <h2 class="page-title">${t('topics.title')} / ${escapeHtml(pickZh(topic.name, topic.name_zh) || slug)}</h2>
          <a href="/topics" class="nav-link">← ${t('nav.topics')}</a>
        </div>
        <div class="topic-full-detail">
          <div class="topic-info">
            <p class="topic-description">${escapeHtml(pickZh(topic.description, topic.description_zh) || '')}</p>
            <div class="topic-meta-grid">
              <div class="meta-item"><label>Status</label><span>${escapeHtml(topic.status || 'active')}</span></div>
              <div class="meta-item"><label>Items</label><span>${topic.item_count || 0}</span></div>
              <div class="meta-item"><label>Growth</label><span>${(topic.growth_score || 0).toFixed(2)}</span></div>
              <div class="meta-item"><label>Auto-generated</label><span>${topic.auto_generated ? t('topics.auto_yes') : t('topics.auto_no')}</span></div>
            </div>
          </div>
          <div class="topic-graph-section">
            <h3>${t('header.graph_attr')}</h3>
            <div id="topicDetailGraph" class="topic-graph-viz" style="height:350px;"></div>
          </div>
          <div class="topic-items" style="margin-top:24px;">
            <h3>${t('topics.recent_items')}</h3>
            ${items.map(item => renderItemCard(item)).join('')}
            ${items.length === 0 ? `<p class="empty">${t('common.empty')}</p>` : ''}
          </div>
        </div>
      </section>
    `;

    container.innerHTML = html;

    // Initialize topic-specific graph
    try {
      const neighborhood = await fetchJSON(`/api/topics/${slug}/graph`);
      if (neighborhood.nodes && neighborhood.nodes.length > 0) {
        const detailGraph = new KnowledgeGraph('topicDetailGraph');
        detailGraph.init(neighborhood);
      }
    } catch (err) {
      console.warn('Topic detail graph unavailable:', err.message);
    }
  } catch (err) {
    showError(container, err.message);
  }
}

// ─── Signal Inbox ─────────────────────────────────────────

async function loadSignalTypes() {
  try {
    const data = await fetchJSON(`${API_BASE}/signal-types`);
    return data.types || [];
  } catch { return []; }
}

export async function renderSignals(_params) {
  const container = $('#pageContent');
  showLoader(container, 'LOADING SIGNALS...');

  try {
    const typesData = await loadSignalTypes();
    const selectedType = _params?.type || 'all';

    // "All" shows the last 7 days (digest_date >= today-7) so users see the
    // broader picture instead of just today's 200-cap. Specific types hit the
    // same 7-day window for consistency — otherwise the sidebar counts
    // (today_count > 1000) would never match the visible list.
    const url = selectedType === 'all'
      ? `${API_BASE}/signals?sinceDays=7&limit=2000`
      : `${API_BASE}/signals?type=${encodeURIComponent(selectedType)}&sinceDays=7&limit=2000`;
    const signalData = await fetchJSON(url);

    const signals = signalData.signals || [];
    const total = signalData.total || signals.length;
    const date = signalData.date || '';
    const fallback = signalData.fallback || false;

    const filteredSignals = signals;

    const html = `
      <section class="page-section signals-layout">
        <div class="signals-left">
          <div class="signals-type-filter">
            <h3 class="signals-filter-title">SIGNAL TYPES</h3>
            <a href="/signals" class="signal-type-item ${selectedType === 'all' ? 'active' : ''}">
              <span class="st-icon">🔄</span>
              <span class="st-name">All Signals</span>
              <span class="st-count">${signals.length}</span>
            </a>
            ${typesData.map(t => `
              <a href="/signals?type=${escapeAttr(t.slug)}" class="signal-type-item ${selectedType === t.slug ? 'active' : ''}">
                <span class="st-icon">${escapeHtml(t.icon || '📡')}</span>
                <span class="st-name">${escapeHtml(pickZh(t.name, t.name_zh))}</span>
                <span class="st-count">${t.today_count || signals.filter(s => s.signal_type === t.slug).length}</span>
              </a>
            `).join('')}
          </div>
        </div>
        <div class="signals-mid" id="signalsMid">
          ${filteredSignals.length === 0 ? `<p class="empty-state">No signals yet. Run enrichment to generate signal scores.</p>` : ''}
          ${filteredSignals.map(s => {
            const st = typesData.find(t => t.slug === s.signal_type) || {};
            return `
              <article class="signal-card" data-signal-id="${escapeAttr(s.item_id)}">
                <div class="signal-card-top">
                  <span class="signal-type-badge" data-type="${escapeAttr(s.signal_type)}">${escapeHtml(st.icon || '📡')} ${escapeHtml(pickZh(st.name, st.name_zh) || s.signal_type)}</span>
                  <span class="signal-alpha" title="Alpha Score">${(s.alpha_score * 100).toFixed(0)}</span>
                </div>
                <h4 class="signal-card-title">
                  <a href="${escapeAttr(s.canonical_url || '#')}" target="_blank" rel="noopener">${escapeHtml(s.ai_title || s.title || '')}</a>
                </h4>
                ${s.one_liner || s.short_summary ? `<p class="signal-card-oneliner">${escapeHtml(s.one_liner || s.short_summary || '')}</p>` : ''}
                <div class="signal-card-meta">
                  <span class="signal-source">${escapeHtml(s.source_label || '')}</span>
                  <span class="signal-scores">
                    N:${(s.novelty_score * 100).toFixed(0)} V:${(s.velocity_score * 100).toFixed(0)} CS:${(s.cross_source_score * 100).toFixed(0)} SQ:${(s.source_quality_score * 100).toFixed(0)}
                  </span>
                </div>
              </article>`;
          }).join('')}
        </div>
        <div class="signals-right" id="signalsDetail">
          <div class="signals-detail-placeholder">
            <h3>Signal Detail</h3>
            <p>Click a signal card to view evidence chain and actions</p>
          </div>
        </div>
      </section>
    `;

    container.innerHTML = html;

    // Click handler for signal cards
    container.querySelectorAll('.signal-card').forEach(card => {
      card.addEventListener('click', async (e) => {
        const itemId = card.dataset.signalId;
        const detail = $('#signalsDetail');
        if (!detail || !itemId) return;

        detail.innerHTML = '<div class="spinner"></div>';
        container.querySelectorAll('.signal-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');

        try {
          const data = await fetchJSON(`${API_BASE}/signals/${encodeURIComponent(itemId)}`);
          renderSignalDetailPane(detail, data.signal || data, typesData);
        } catch (err) {
          detail.innerHTML = `<p class="error">Error: ${err.message}</p>`;
        }
      });
    });

    // Auto-select first signal
    const firstCard = container.querySelector('.signal-card');
    if (firstCard) firstCard.click();

  } catch (err) {
    showError(container, err.message);
  }
}

function renderSignalDetailPane(container, signal, typesData) {
  const st = typesData?.find(t => t.slug === signal.signal_type) || {};
  const entities = signal.entities || [];
  const topics = signal.topics || [];

  container.innerHTML = `
    <div class="signal-detail-inner">
      <div class="signal-detail-header">
        <span class="signal-type-badge large" data-type="${escapeAttr(signal.signal_type)}">${escapeHtml(st.icon || '📡')} ${escapeHtml(pickZh(st.name, st.name_zh) || signal.signal_type)}</span>
        <span class="signal-alpha large">Alpha: ${(signal.alpha_score * 100).toFixed(0)}</span>
      </div>
      <h3 class="signal-detail-title">
        <a href="${escapeAttr(signal.canonical_url || '#')}" target="_blank" rel="noopener">${escapeHtml(signal.ai_title || signal.title || '')}</a>
      </h3>
      ${signal.short_summary || signal.one_liner ? `<p class="signal-detail-summary">${escapeHtml(signal.short_summary || signal.one_liner)}</p>` : ''}

      <div class="signal-score-breakdown">
        <h4>Score Breakdown</h4>
        <div class="score-bars">
          <div class="score-row"><span>Novelty</span><span class="score-bar-wrap"><span class="score-bar" style="width:${(signal.novelty_score * 100).toFixed(0)}%"></span></span><span>${(signal.novelty_score * 100).toFixed(0)}</span></div>
          <div class="score-row"><span>Velocity</span><span class="score-bar-wrap"><span class="score-bar" style="width:${(signal.velocity_score * 100).toFixed(0)}%"></span></span><span>${(signal.velocity_score * 100).toFixed(0)}</span></div>
          <div class="score-row"><span>Cross-Source</span><span class="score-bar-wrap"><span class="score-bar" style="width:${(signal.cross_source_score * 100).toFixed(0)}%"></span></span><span>${(signal.cross_source_score * 100).toFixed(0)}</span></div>
          <div class="score-row"><span>Source Quality</span><span class="score-bar-wrap"><span class="score-bar" style="width:${(signal.source_quality_score * 100).toFixed(0)}%"></span></span><span>${(signal.source_quality_score * 100).toFixed(0)}</span></div>
          <div class="score-row"><span>Thesis Match</span><span class="score-bar-wrap"><span class="score-bar thesis" style="width:${(signal.thesis_match_score * 100).toFixed(0)}%"></span></span><span>${(signal.thesis_match_score * 100).toFixed(0)}</span></div>
          <div class="score-row penalty"><span>Consensus Penalty</span><span class="score-bar-wrap"><span class="score-bar penalty" style="width:${(signal.consensus_penalty * 100).toFixed(0)}%"></span></span><span>-${(signal.consensus_penalty * 100).toFixed(0)}</span></div>
        </div>
      </div>

      ${signal.evidence_summary ? `<div class="signal-evidence"><h4>Why</h4><p>${escapeHtml(signal.evidence_summary)}</p></div>` : ''}

      ${entities.length > 0 ? `
        <div class="signal-entities"><h4>Entities</h4>
          ${entities.map(e => {
            const surge = e.zscore != null && e.zscore > 1.5;
            const mom = e.zscore != null ? ` <small class="${surge ? 'entity-surge' : 'entity-mom'}" title="${t('signals.velocity_zscore')}: ${e.zscore}">${surge ? '🔥' : '↑'}${e.zscore.toFixed(1)}</small>` : '';
            return `<span class="entity-chip">${escapeHtml(e.name)} <small>${escapeHtml(e.type)}</small>${mom}</span>`;
          }).join(' ')}
        </div>` : ''}

      ${topics.length > 0 ? `
        <div class="signal-topics"><h4>Topics</h4>
          ${topics.map(t => `<a href="/topics/${escapeAttr(t.slug)}" class="topic-chip">${escapeHtml(t.name)}</a>`).join(' ')}
        </div>` : ''}

      <div class="signal-actions">
        <button class="signal-action-btn research-btn" data-item-id="${escapeAttr(signal.item_id)}">🔍 Deep Research</button>
      </div>

      <div class="signal-meta-footer">
        <span>Source: ${escapeHtml(signal.source_label || '')}</span>
        <span>Published: ${new Date(signal.published_at).toLocaleDateString()}</span>
        <span>Score: ${signal.score || 0}</span>
      </div>
    </div>
  `;
}

export async function renderSignalDetail(params) {
  const container = $('#pageContent');
  const itemId = params?.id || params?.slug || '';

  showLoader(container, `LOADING SIGNAL ${itemId}...`);

  try {
    const data = await fetchJSON(`${API_BASE}/signals/${encodeURIComponent(itemId)}`);
    const signal = data.signal || {};
    const typesData = await loadSignalTypes();

    const st = typesData.find(t => t.slug === signal.signal_type) || {};

    const html = `
      <section class="page-section signal-detail-page">
        <div class="page-header">
          <h2 class="page-title">Signal / ${escapeHtml(pickZh(st.name, st.name_zh) || signal.signal_type || '')}</h2>
          <a href="/signals" class="nav-link">← Signals</a>
        </div>
        <div id="signalDetailFull" class="signal-detail-full"></div>
      </section>
    `;

    container.innerHTML = html;

    const detailEl = container.querySelector('#signalDetailFull');
    if (detailEl) renderSignalDetailPane(detailEl, signal, typesData);

  } catch (err) {
    showError(container, err.message);
  }
}

// ─── Papers ────────────────────────────────────────────────

export async function renderPapers(_params) {
  const container = $('#pageContent');
  showLoader(container, getLanguage() === 'zh' ? '正在加载论文流...' : 'LOADING PAPERS...');

  try {
    const url = new URL(window.location.href);
    const currentSource = url.searchParams.get('source') || 'all';
    const data = await fetchJSON(`${API_BASE}/papers?source=${encodeURIComponent(currentSource)}&limit=80`);
    const papers = data.papers || [];
    const sources = data.sources || [];
    const stats = data.stats || {};

    const sourceTabs = [
      { slug: 'all', label: t('papers.all'), count: stats.total || 0 },
      ...sources.map(s => ({ slug: s.slug, label: s.label, count: s.count || 0 })),
    ];

    const renderSourceTab = (source) => {
      const href = source.slug === 'all' ? '/papers' : `/papers?source=${encodeURIComponent(source.slug)}`;
      const active = source.slug === currentSource;
      return `
        <a class="sources-tab-pill ${active ? 'active' : ''}" href="${href}">
          <span class="sources-tab-pill-icon">${source.slug === 'all' ? '📚' : '📄'}</span>
          <span>${escapeHtml(source.label)}</span>
          <span class="sources-tab-pill-count">${source.count}</span>
        </a>
      `;
    };

    const renderPaper = (paper) => {
      const title = pickZh(paper.title, paper.title_zh);
      const oneLiner = pickZh(paper.one_liner_zh || paper.short_summary_zh, paper.one_liner_zh || paper.short_summary_zh);
      const authors = (paper.authors || []).slice(0, 5).join(', ');
      const categories = (paper.categories || []).slice(0, 4).map(cat => `<span class="mini-topic">${escapeHtml(cat)}</span>`).join('');
      const tags = (paper.tags || []).slice(0, 6).map(tag =>
        `<a href="${escapeAttr(tagHref(tag))}" class="tag-chip">#${escapeHtml(tag.name)}</a>`
      ).join(' ');
      const pdf = paper.pdf_url
        ? `<a class="mini-action mini-action-link" href="${escapeAttr(paper.pdf_url)}" target="_blank" rel="noopener">PDF ↗</a>`
        : '';
      return `
        <article class="mini-card paper-card">
          <div class="mini-card-top">
            <h4 class="mini-title">
              <a href="${escapeAttr(paper.canonical_url || '#')}" target="_blank" rel="noopener">${escapeHtml(title)}</a>
            </h4>
            ${oneLiner ? `<p class="mini-oneliner">${escapeHtml(oneLiner)}</p>` : ''}
          </div>
          <div class="mini-card-mid">
            <span class="mini-source">${escapeHtml(paper.source_label || '')}</span>
            ${paper.provider ? `<span class="mini-lang">${escapeHtml(paper.provider)}</span>` : ''}
            ${paper.published_at ? `<span class="mini-time">${timeAgo(paper.published_at)}</span>` : ''}
          </div>
          ${authors ? `<p class="paper-authors">${escapeHtml(authors)}</p>` : ''}
          ${categories ? `<div class="mini-card-bottom">${categories}</div>` : ''}
          ${tags ? `<div class="card-tags paper-tags">${tags}</div>` : ''}
          <div class="mini-card-actions">
            <button class="mini-action research-btn" data-item-id="${escapeAttr(paper.id)}" data-title="${escapeAttr(title)}">🔍 ${escapeHtml(getLanguage() === 'zh' ? '研究' : 'Research')}</button>
            ${pdf}
            <a class="mini-action mini-action-link" href="${escapeAttr(paper.canonical_url || '#')}" target="_blank" rel="noopener">${escapeHtml(getLanguage() === 'zh' ? '原文' : 'Source')} ↗</a>
          </div>
        </article>
      `;
    };

    container.innerHTML = `
      <section class="page-section papers-page">
        <div class="page-header">
          <h2 class="page-title">📄 ${t('papers.title')}</h2>
          <p class="page-description">${t('papers.subtitle')}</p>
        </div>

        <div class="source-stats">
          <div class="stat-card"><span class="stat-value">${stats.total || 0}</span><span class="stat-label">${t('papers.all')}</span></div>
          <div class="stat-card"><span class="stat-value">${stats.with_pdf || 0}</span><span class="stat-label">${t('papers.with_pdf')}</span></div>
          <div class="stat-card"><span class="stat-value">${stats.tagged || 0}</span><span class="stat-label">${t('papers.tagged')}</span></div>
        </div>

        <nav class="sources-tab-nav papers-source-nav" aria-label="${escapeAttr(t('papers.title'))}">
          <div class="sources-tab-nav-inner">
            <div class="sources-tab-nav-list" role="tablist">
              ${sourceTabs.map(renderSourceTab).join('')}
            </div>
          </div>
        </nav>

        ${papers.length
          ? `<div class="feed-list papers-list">${papers.map(renderPaper).join('')}</div>`
          : `<p class="empty-state">${escapeHtml(t('papers.empty'))}</p>`}
      </section>
    `;
  } catch (err) {
    showError(container, err.message);
  }
}

// ─── Physical AI ──────────────────────────────────────────

export async function renderPhysicalAI(_params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING PHYSICAL AI BRIEF...' : t('common.loading'));

  const sections = [
    { id: 'arxiv-papers', title: 'ARXIV · PHYSICAL AI PAPERS', icon: '📄', api: '/api/items?source=physical-ai-arxiv&limit=10', schedule: 'Syncs every 6 hours from arXiv.org' },
    { id: 'humanoid-news', title: 'HUMANOID · COMPANY NEWS', icon: '🤖', api: '/api/items?source=physical-ai-humanoid&limit=10', schedule: 'Syncs continuously from 4 RSS feeds' },
    { id: 'cn-photonics', title: 'CN PHOTONICS · 公告流', icon: '🔬', api: '/api/items?source=physical-ai-cn-photonics&limit=10', schedule: 'Syncs every hour from CN announcements' },
  ];

  const html = `
    <section class="page-section">
      <div class="page-header">
        <h2 class="page-title">${t('physical.title')}</h2>
        <p class="page-description">${t('physical.subtitle')}</p>
      </div>
      <div class="physical-ai-grid">
        ${sections.map(sec => `
          <div class="physical-section" id="${sec.id}">
            <div class="physical-header">
              <span class="physical-icon">${sec.icon}</span>
              <h3>${sec.title}</h3>
            </div>
            <p class="physical-schedule-text">${escapeHtml(sec.schedule)}</p>
            <div class="physical-items" data-api="${escapeAttr(sec.api)}">
              <div class="spinner"></div>
              <p class="physical-loading">${t('common.loading')} ${escapeHtml(sec.title)}...</p>
            </div>
          </div>
        `).join('')}
      </div>
    </section>
  `;

  container.innerHTML = html;

  // Fetch each section's data
  container.querySelectorAll('.physical-items').forEach(async (el) => {
    try {
      const data = await fetchJSON(el.dataset.api);
      const items = data.items || [];
      if (items.length === 0) {
        const section = sections.find(s => s.api === el.dataset.api);
        el.innerHTML = `<p class="empty-state">${escapeHtml(section?.schedule || t('physical.empty'))}</p>`;
        return;
      }
      el.innerHTML = items.map(item => `
        <div class="physical-item">
          <a href="${escapeAttr(item.canonical_url || '#')}" target="_blank" class="physical-item-title">${escapeHtml(item.title || '')}</a>
          ${item.published_at ? `<span class="physical-item-date">${timeAgo(item.published_at)}</span>` : ''}
        </div>
      `).join('');
    } catch (err) {
      el.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
    }
  });
}

// ─── Tools ─────────────────────────────────────────────────

export function renderTools(_params) {
  const container = $('#pageContent');

  const categories = [
    { name: 'Image Tools', icon: '🖼️', tools: ['Image Compressor', 'Image Resizer', 'Image Converter', 'HEIC to JPG', 'Image Cropper', 'Screenshot Beautify'] },
    { name: 'Video & Audio', icon: '🎬', tools: ['Video Compressor', 'Video to GIF', 'Audio Compressor', 'Media Converter', 'Audio Extractor', 'Voice Recorder'] },
    { name: 'Developer Tools', icon: '⚙️', tools: ['JSON Formatter', 'Code Minifier', 'Base64 Encoder', 'QR Generator', 'Color Picker'] },
    { name: 'Documents & Utility', icon: '📄', tools: ['PDF Compressor', 'Unit Converter', 'Timezone Converter', 'ZIP Creator', 'Markdown Preview', 'LaTeX Preview'] },
    { name: 'Finance', icon: '💰', tools: ['Mortgage Calculator', 'HELOC Calculator', 'Leverage Calculator'] },
    { name: 'More Tools', icon: '🔧', tools: ['Chronograph', '2FA Authenticator', 'Password Generator', 'App Stats', 'UTM Generator', 'IP Lookup', 'Peepbo'] },
  ];

  const html = `
    <section class="page-section">
      <div class="page-header">
        <h2 class="page-title">${t('tools.title')}</h2>
        <p class="page-description">${t('tools.subtitle')}</p>
      </div>
      <div class="tool-catalog">
        ${categories.map(cat => `
          <div class="tool-category">
            <h3 class="tool-category-title"><span class="tool-cat-icon">${cat.icon}</span> ${cat.name}</h3>
            <div class="tool-grid">
              ${cat.tools.map(tool => `
                <a href="/tools/${tool.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}" class="tool-card">
                  <span class="tool-name">${escapeHtml(tool)}</span>
                  <span class="tool-badge">LOCAL</span>
                </a>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </section>
  `;

  container.innerHTML = html;
}

// ─── Tool Detail ────────────────────────────────────────────

export function renderToolDetail(params) {
  const container = $('#pageContent');
  const slug = params?.slug || '';
  renderToolBySlug(slug, container);
}

// ─── Skill Detail ──────────────────────────────────────────

export async function renderSkillDetail(params) {
  const container = $('#pageContent');
  const skillId = params?.slug || params?.id || '';

  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING SKILL...' : t('common.loading'));

  try {
    let skillData = null;
    try {
      const res = await fetch('/api/skills/' + encodeURIComponent(skillId));
      const json = await res.json();
      skillData = json.skill;      } catch {
      // Fallback: try looking up by slug
    }

    if (!skillData) {
      const notFound = getLanguage() === 'zh' ? '未找到技能。' : 'Skill not found.';
      container.innerHTML = `<section class="page-section"><div class="page-header"><h2 class="page-title">${t('skills.title')}</h2><a href="/skills" class="nav-link">← ${t('skills.title')}</a></div><p>${notFound}</p></section>`;
      return;
    }

    const html = `
      <section class="page-section">
        <div class="page-header">
          <h2 class="page-title">${t('skills.title')} / ${escapeHtml(skillData.name)}</h2>
          <a href="/skills" class="nav-link">← ${t('skills.title')}</a>
        </div>
        <div class="skill-detail">
          <div class="skill-detail-header">
            <div class="skill-name-big">${escapeHtml(skillData.name)}</div>
            <div class="skill-meta">
              <span class="skill-category-tag">${escapeHtml(skillData.category)}</span>
              <span class="skill-stars">★ ${skillData.stars?.toLocaleString() || 0}</span>
              <span class="skill-installs">📦 ${skillData.installs || 'N/A'}</span>
              <span class="skill-author">👤 ${escapeHtml(skillData.author || t('skills.unknown_author'))}</span>
            </div>
            <p class="skill-description">${escapeHtml(skillData.description || '')}</p>
            <div class="skill-tags">
              ${(skillData.tags || []).map(t => `<span class="skill-tag">${escapeHtml(t)}</span>`).join('')}
            </div>
            <div class="skill-install-code">
              <code>${escapeHtml(skillData.install_command || 'claude add ' + skillData.slug || 'N/A')}</code>
              <button class="copy-btn" onclick="navigator.clipboard.writeText('${escapeAttr(skillData.install_command || '')}')">Copy</button>
            </div>
          </div>
          <div class="skill-detail-repo">
            ${skillData.repo_url ? `<p>Repository: <a href="${escapeAttr(skillData.repo_url)}" target="_blank" rel="noopener">${escapeHtml(skillData.repo_name || skillData.repo_url)}</a></p>` : ''}
            ${skillData.repo_owner ? `<p>Author: ${escapeHtml(skillData.repo_owner)}</p>` : ''}
          </div>
        </div>
      </section>
    `;

    container.innerHTML = html;
  } catch (err) {
    showError(container, err.message);
  }
}

// ─── Skills ────────────────────────────────────────────────

export async function renderSkills(params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING SKILLS...' : t('common.loading'));

  try {
    // Fetch skills from API
    const category = params?.cat || '';
    const url = '/api/skills?limit=200' + (category ? '&category=' + encodeURIComponent(category) : '');
    const data = await fetch(url).then(r => r.json());
    const skills = data.skills || [];
    const stats = data.stats || {};

    const allCategories = data.categories || [
      'Frontend', 'Backend', 'AI & Machine Learning', 'Automation', 'Architecture',
      'Testing', 'Security', 'DevOps', 'Data', 'API', 'CLI Tools', 'Documentation',
      'Performance', 'Code Quality', 'Mobile', 'Cloud', 'Database', 'Design Systems',
      'Content', 'Research', 'Media', 'Finance', 'Browser', 'Full Stack',
    ];

    const html = `
      <section class="page-section">
        <div class="page-header">
          <h2 class="page-title">${t('skills.title')}</h2>
          <p class="page-description">${t('skills.subtitle')}</p>
          <div class="skills-toolbar">
            <input type="text" class="search-input" id="skillsSearch" placeholder="${escapeAttr(t('skills.search_ph'))}" autocomplete="off">
            <div class="skills-sort">
              <select class="sort-select" id="skillsSort">
                <option value="installs">Weekly Installs</option>
                <option value="stars">GitHub Stars</option>
                <option value="name">Name</option>
                <option value="category">Category</option>
              </select>
            </div>
          </div>
        </div>
        <div class="skills-categories">
          <a href="/skills" class="skill-category-chip ${category === '' ? 'active' : ''}">${t('skills.all')}</a>
          ${allCategories.map(cat => `
            <a href="/skills?cat=${encodeURIComponent(cat)}" class="skill-category-chip ${category === cat ? 'active' : ''}">${escapeHtml(cat)}</a>
          `).join('')}
        </div>
        <div class="skills-grid">
          ${skills.map(skill => `
            <a href="/skills/${escapeAttr(skill.id)}" class="skill-card">
              <div class="skill-card-header">
                <span class="skill-card-name">${escapeHtml(skill.name)}</span>
                <span class="skill-card-category">${escapeHtml(skill.category)}</span>
              </div>
              <p class="skill-card-desc">${escapeHtml(skill.description || '').slice(0, 120)}</p>
              <div class="skill-card-footer">
                <span class="skill-card-stars">★ ${skill.stars?.toLocaleString() || 0}</span>
                <span class="skill-card-installs">📦 ${skill.installs || '0'}</span>
                <span class="skill-card-author">${escapeHtml(skill.author || '')}</span>
              </div>
              <div class="skill-card-tags">
                ${(skill.tags || []).slice(0, 3).map(t => `<span class="skill-tag-mini">${escapeHtml(t)}</span>`).join('')}
              </div>
            </a>
          `).join('')}
          ${skills.length === 0 ? `<p class="empty-state">${t('common.empty')}</p>` : ''}
        </div>
      </section>
    `;

    container.innerHTML = html;

    // Wire search
    const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById('skillsSearch'));
    document.getElementById('skillsSort');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim();
        if (q.length > 1) {
          window.location.href = '/skills?search=' + encodeURIComponent(q);
        }
      });
    }
  } catch (err) {
    showError(container, err.message);
  }
}

// ─── Intelligence Analysis ───────────────────────────────────────

export async function renderIntelligence(_params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING INTELLIGENCE METRICS...' : t('common.loading'));

  try {
    const [momentum, metrics] = await Promise.all([
      fetchJSON(`${API_BASE}/entities/momentum?window=7d&limit=20`).catch(() => ({ entities: [] })),
      fetchJSON(`${API_BASE}/metrics`).catch(() => ({})),
    ]);
    const entities = momentum.entities || [];
    const maxZ = entities.length > 0 ? Math.max(...entities.map(e => e.zscore || 0), 0.1) : 1;

    const entityRows = entities.length > 0
      ? entities.map((e, i) => {
          const barWidth = Math.max(3, Math.min(100, ((e.zscore || 0) / maxZ) * 100));
          const surge = (e.zscore || 0) > 1.5;
          return `
            <div class="momentum-row">
              <span class="momentum-rank">${i + 1}</span>
              <span class="momentum-name">${escapeHtml(e.name)} <small>${escapeHtml(e.type || '')}</small></span>
              <span class="momentum-bar"><span class="momentum-fill ${surge ? 'surge' : ''}" style="width:${barWidth}%"></span></span>
              <span class="momentum-stats">
                <span title="${t('signals.mentions')}">💬 ${e.mention_count || 0}</span>
                <span title="${t('signals.sources')}">📡 ${e.unique_sources || 0}</span>
                <span class="${surge ? 'entity-surge' : ''}" title="${t('signals.velocity_zscore')}">↑${(e.zscore || 0).toFixed(1)}</span>
              </span>
            </div>`;
        }).join('')
      : `<div class="empty-state"><p>${t('signals.no_momentum_data')}</p></div>`;

    const html = `
      <section class="page-section">
        <div class="page-header">
          <h2 class="page-title">${t('intel.title')}</h2>
          <p class="page-description">${t('signals.trending_subtitle')}</p>
        </div>
        <div class="intel-grid">
          <div class="intel-card">
            <h3>${t('signals.trending_entities')} <small>7d</small></h3>
            <div class="momentum-list">${entityRows}</div>
          </div>
          ${(metrics?.enrichment || metrics?.graph) ? `
          <div class="intel-card">
            <h3>${t('signals.system_metrics')}</h3>
            <div class="metric-rows">
              ${metrics.enrichment ? `<div class="metric-row"><span>${t('signals.enriched_items')}</span><strong>${metrics.enrichment.enriched || 0}</strong></div>` : ''}
              ${metrics.graph ? `<div class="metric-row"><span>${t('signals.graph_edges')}</span><strong>${metrics.graph.edges || 0}</strong></div>` : ''}
              ${metrics.graph ? `<div class="metric-row"><span>${t('signals.entities_count')}</span><strong>${metrics.graph.entities || 0}</strong></div>` : ''}
            </div>
          </div>` : ''}
        </div>
      </section>
    `;
    container.innerHTML = html;
  } catch (err) {
    showError(container, err.message);
  }
}

// ─── Industry Metrics ───────────────────────────────────────────────

export async function renderIndustryMetrics(_params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING INDUSTRY METRICS...' : t('common.loading'));

  try {
    const html = `
      <section class="page-section">
        <div class="page-header">
          <h2 class="page-title">${t('industry.title')}</h2>
          <p class="page-description">${t('industry.subtitle')}</p>
        </div>
        <div class="empty-state">
          <p>This page will show sector analysis, competitive coverage, and source diversity over time.</p>
          <p class="subtle">APIs: /api/industry, /api/coverage</p>
        </div>
      </section>
    `;
    container.innerHTML = html;
  } catch (err) {
    showError(container, err.message);
  }
}

// ─── Settings (LLM endpoint + runtime config) ───────────────────────

const SAMPLE_PASTE = `Provider:  🌐 AliCloud SG
Upstream:  https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions
Protocol:  OpenAI Chat Completions
Local Endpoint:
  Base URL:           http://127.0.0.1:3458/v1
  Chat URL:           http://127.0.0.1:3458/v1/chat/completions
  Models URL:         http://127.0.0.1:3458/v1/models
  API Key:             test
  Model:               qwq-plus

curl:
  curl http://127.0.0.1:3458/v1/chat/completions \\
    -H 'Authorization: Bearer test' \\
    -H 'Content-Type: application/json' \\
    -d '{"model":"qwq-plus","messages":[{"role":"user","content":"hi"}],"stream":false}'`;

export async function renderSettings(_params) {
  const container = $('#pageContent');
  const sampleText = SAMPLE_PASTE;
  const directSubtitle = getLanguage() === 'zh' ? '适用于 OpenAI 兼容接口' : 'For OpenAI-compatible endpoints';
  const pasteSubtitle = getLanguage() === 'zh' ? '自动识别 key/value、JSON、curl 三种格式' : 'Auto-detects key/value, JSON, and curl';
  const providerSelect = getLanguage() === 'zh'
    ? '<option value="openai">openai (OpenAI Chat Completions 兼容)</option><option value="gemini">gemini</option><option value="claude">claude</option>'
    : '<option value="openai">openai (OpenAI Chat Completions compatible)</option><option value="gemini">gemini</option><option value="claude">claude</option>';
  const step1 = getLanguage() === 'zh' ? '点击上方的' : 'Hit';
  const step1b = getLanguage() === 'zh' ? '以确认接口正常。' : ' above to confirm the API answers.';
  const step2 = getLanguage() === 'zh' ? '打开首页 — 当日信号将自动 enrichment。' : "Open the homepage — today's signals will start to enrich.";
  const step3 = getLanguage() === 'zh' ? '或手动批量运行：' : 'Or run a batch manually:';
  const step4 = getLanguage() === 'zh' ? '然后触发每日简报：' : 'Then trigger a daily digest:';

  container.innerHTML = `
    <section class="page-section">
      <div class="page-header">
        <h2 class="page-title">${t('settings.title')}</h2>
        <p class="page-description">${t('settings.subtitle')}</p>
      </div>

      <div class="settings-grid">
        <div class="settings-card">
          <div class="settings-card-header">
            <span class="settings-card-title">${t('settings.current')}</span>
            <span class="settings-card-badge" id="llmStatusBadge">…</span>
          </div>
          <div class="settings-card-body" id="llmCurrent">
            <div class="empty-state">${getLanguage() === 'zh' ? '加载中…' : 'Loading…'}</div>
          </div>
          <div class="settings-card-actions">
            <button class="action-btn" id="llmTestBtn">${t('settings.test')}</button>
            <button class="action-btn" id="llmResetBtn">${t('settings.reset')}</button>
            <span class="action-link" id="llmTestResult"></span>
          </div>
        </div>

        <div class="settings-card">
          <div class="settings-card-header">
            <span class="settings-card-title">${t('settings.paste')}</span>
            <span class="settings-card-sub">${pasteSubtitle}</span>
          </div>
          <div class="settings-card-body">
            <textarea id="llmPaste" class="settings-paste" rows="14" spellcheck="false" placeholder="${escapeAttr(sampleText)}"></textarea>
            <div class="settings-preview" id="llmPreview" hidden></div>
          </div>
          <div class="settings-card-actions">
            <button class="action-btn primary" id="llmParseBtn">${t('settings.parse')}</button>
            <button class="action-btn primary" id="llmSaveBtn" disabled>${t('settings.save_activate')}</button>
            <button class="action-btn" id="llmLoadSampleBtn">${t('settings.load_sample')}</button>
            <button class="action-btn" id="llmClearBtn">${getLanguage() === 'zh' ? '清空' : 'CLEAR'}</button>
            <span class="action-link" id="llmSaveResult"></span>
          </div>
        </div>

        <div class="settings-card">
          <div class="settings-card-header">
            <span class="settings-card-title">${t('settings.direct')}</span>
            <span class="settings-card-sub">${directSubtitle}</span>
          </div>
          <div class="settings-card-body">
            <div class="form-row">
              <label for="llmProvider">${t('settings.fields_provider')}</label>
              <select id="llmProvider" class="form-input">
                ${providerSelect}
              </select>
            </div>
            <div class="form-row">
              <label for="llmBaseUrl">${t('settings.fields_base_url')}</label>
              <input id="llmBaseUrl" class="form-input" type="text" placeholder="http://127.0.0.1:3458/v1">
            </div>
            <div class="form-row">
              <label for="llmApiKey">${t('settings.fields_api_key')}</label>
              <input id="llmApiKey" class="form-input" type="password" placeholder="Bearer token or sk-…">
            </div>
            <div class="form-row">
              <label for="llmModel">${t('settings.fields_model')}</label>
              <input id="llmModel" class="form-input" type="text" placeholder="qwq-plus">
            </div>
          </div>
          <div class="settings-card-actions">
            <button class="action-btn primary" id="llmSaveFieldsBtn">${t('settings.save_fields')}</button>
            <span class="action-link" id="llmFieldsResult"></span>
          </div>
        </div>

        <div class="settings-card">
          <div class="settings-card-header">
            <span class="settings-card-title">${t('settings.after')}</span>
          </div>
          <div class="settings-card-body">
            <ol class="settings-steps">
              <li>${step1} <code>${t('settings.test')}</code> ${step1b}</li>
              <li>${step2}</li>
              <li>${step3}
                <pre class="settings-code">curl -X POST 'http://127.0.0.1:3001/api/enrich?batch=1600&amp;background=true'</pre>
              </li>
              <li>${step4}
                <pre class="settings-code">curl -X POST 'http://127.0.0.1:3001/api/digest/build?background=true'</pre>
              </li>
            </ol>
          </div>
        </div>

        <div class="settings-card settings-card-wide">
          <div class="settings-card-header">
            <span class="settings-card-title">${t('ops.title')}</span>
            <span class="settings-card-sub">${t('ops.subtitle')}</span>
          </div>
          <div class="settings-card-body">
            <div class="ops-grid">
              <div class="op-row" data-op-row="sync">
                <div class="op-info">
                  <div class="op-name"><span class="op-name-zh">抓取所有信息源</span><span class="op-name-sep">·</span><span class="op-name-en">SYNC ALL SOURCES</span></div>
                  <div class="op-desc">${t('ops.sync_desc')}</div>
                  <div class="op-stream" data-op-stream="sync" hidden></div>
                </div>
                <div class="op-actions">
                  <button class="action-btn primary" data-op="sync">▶ ${t('ops.sync')}</button>
                  <button class="action-btn danger op-stop" data-op-stop="sync" hidden>${t('ops.stop')}</button>
                </div>
              </div>
              <div class="op-row" data-op-row="enrich">
                <div class="op-info">
                  <div class="op-name"><span class="op-name-zh">AI 摘要批量</span><span class="op-name-sep">·</span><span class="op-name-en">ENRICH ITEMS</span></div>
                  <div class="op-desc">${t('ops.enrich_desc')}</div>
                  <div class="op-stream" data-op-stream="enrich" hidden></div>
                </div>
                <div class="op-actions">
                  <button class="action-btn primary" data-op="enrich">▶ ${t('ops.enrich')}</button>
                  <button class="action-btn danger op-stop" data-op-stop="enrich" hidden>${t('ops.stop')}</button>
                </div>
              </div>
              <div class="op-row" data-op-row="digest">
                <div class="op-info">
                  <div class="op-name"><span class="op-name-zh">生成每日简报</span><span class="op-name-sep">·</span><span class="op-name-en">BUILD DIGEST</span></div>
                  <div class="op-desc">${t('ops.digest_desc')}</div>
                  <div class="op-stream" data-op-stream="digest" hidden></div>
                </div>
                <div class="op-actions">
                  <button class="action-btn primary" data-op="digest">▶ ${t('ops.digest')}</button>
                  <button class="action-btn danger op-stop" data-op-stop="digest" hidden>${t('ops.stop')}</button>
                </div>
              </div>
              <div class="op-row" data-op-row="pipeline">
                <div class="op-info">
                  <div class="op-name"><span class="op-name-zh">完整流水线</span><span class="op-name-sep">·</span><span class="op-name-en">FULL PIPELINE</span></div>
                  <div class="op-desc">${t('ops.pipeline_desc')}</div>
                  <div class="op-stream" data-op-stream="pipeline" hidden></div>
                </div>
                <div class="op-actions">
                  <button class="action-btn primary" data-op="pipeline">▶ ${t('ops.pipeline')}</button>
                  <button class="action-btn danger op-stop" data-op-stop="pipeline" hidden>${t('ops.stop')}</button>
                </div>
              </div>
            </div>
            <div class="xconfig-card">
              <div class="xconfig-header">
                <div class="xconfig-title">${t('xconfig.title')}</div>
                <div class="xconfig-sub">${t('xconfig.subtitle')}</div>
              </div>
              <textarea class="form-input xconfig-textarea" id="xConfigTextarea" rows="6" placeholder="elonmusk&#10;sama&#10;paulg&#10;karpathy"></textarea>
              <div class="xconfig-actions">
                <button class="action-btn primary" id="xConfigSaveBtn">${t('xconfig.save')}</button>
                <span class="action-link" id="xConfigResult"></span>
              </div>
            </div>
            <div class="xconfig-card">
              <div class="xconfig-header">
                <div class="xconfig-title">${t('xconfig.blocklist_title')}</div>
                <div class="xconfig-sub">${t('xconfig.blocklist_subtitle')}</div>
              </div>
              <textarea class="form-input xconfig-textarea" id="xBlocklistTextarea" rows="4" placeholder="${t('xconfig.blocklist_ph')}"></textarea>
              <div class="xconfig-actions">
                <button class="action-btn primary" id="xBlocklistSaveBtn">${t('xconfig.save_blocklist')}</button>
                <button class="action-btn" id="xCleanupBtn">${t('xconfig.cleanup')}</button>
                <span class="action-link" id="xBlocklistResult"></span>
              </div>
            </div>
            <div class="ops-jobs">
              <h4 class="ops-jobs-title">${t('ops.jobs')}</h4>
              <div class="op-jobs-body" id="opJobsBody">
                <p class="empty-state">${getLanguage() === 'zh' ? '加载中…' : 'Loading…'}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;

  await refreshLLMStatus();
  wireSettingsHandlers();
}

async function refreshLLMStatus() {
  const card = document.getElementById('llmCurrent');
  const badge = document.getElementById('llmStatusBadge');
  if (!card || !badge) return;

  try {
    const res = await fetch('/api/settings/llm');
    const data = await res.json();
    if (!data || !data.config) throw new Error('No config returned');

    const cfg = data.config;
    const active = data.active || {};
    const sourceLabel = cfg.source === 'env' ? 'ENV FALLBACK' : (cfg.source || 'RUNTIME');

    badge.textContent = `${(active.provider || cfg.provider).toUpperCase()} · ${sourceLabel}`;
    badge.className = 'settings-card-badge ' + (active.provider === 'none' ? 'warn' : 'ok');

    card.innerHTML = `
      <div class="kv-grid">
        <div class="kv"><label>Provider</label><span>${escapeHtml(active.provider || cfg.provider)}</span></div>
        <div class="kv"><label>Model</label><span>${escapeHtml(active.model || cfg.model || '—')}</span></div>
        <div class="kv"><label>Base URL</label><span class="mono">${escapeHtml(cfg.base_url || active.base_url || '—')}</span></div>
        <div class="kv"><label>API Key</label><span class="mono">${escapeHtml(cfg.api_key || '••••')}</span></div>
        <div class="kv"><label>Source</label><span>${escapeHtml(cfg.source || 'env')}</span></div>
        <div class="kv"><label>Updated</label><span class="mono">${escapeHtml(cfg.updated_at || '—')}</span></div>
      </div>
    `;

    // Pre-fill the manual fields if the parsed config has values
    const fProvider = document.getElementById('llmProvider');
    const fBase = document.getElementById('llmBaseUrl');
    const fKey = document.getElementById('llmApiKey');
    const fModel = document.getElementById('llmModel');
    if (fProvider && cfg.provider) fProvider.value = cfg.provider;
    if (fBase && cfg.base_url) fBase.value = cfg.base_url;
    if (fModel && cfg.model) fModel.value = cfg.model;
  } catch (err) {
    badge.textContent = t('common.error_cap');
    badge.className = 'settings-card-badge error';
    const failedToLoad = getLanguage() === 'zh' ? `加载失败: ${escapeHtml(err.message)}` : `Failed to load: ${escapeHtml(err.message)}`;
    card.innerHTML = `<div class="empty-state">${failedToLoad}</div>`;
  }
}

let _lastParsedConfig = null;

function wireSettingsHandlers() {
  const $ = (id) => document.getElementById(id);

  $('llmLoadSampleBtn')?.addEventListener('click', () => {
    const ta = $('llmPaste');
    if (ta) { ta.value = SAMPLE_PASTE; ta.focus(); }
  });

  $('llmClearBtn')?.addEventListener('click', () => {
    const ta = $('llmPaste'); if (ta) ta.value = '';
    const pv = $('llmPreview'); if (pv) { pv.hidden = true; pv.innerHTML = ''; }
    _lastParsedConfig = null;
    const btn = $('llmSaveBtn'); if (btn) btn.disabled = true;
  });

  $('llmParseBtn')?.addEventListener('click', async () => {
    const text = $('llmPaste')?.value || '';
    const pv = $('llmPreview');
    const saveBtn = $('llmSaveBtn');
    if (!text.trim()) {
      pv.hidden = false;
      const emptyPaste = getLanguage() === 'zh' ? '<div class="settings-warn">请先粘贴接口配置。</div>' : '<div class="settings-warn">Paste your endpoint config first.</div>';
      pv.innerHTML = emptyPaste;
      return;
    }
    try {
      const res = await fetch('/api/settings/llm/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pasted: text }),
      });
      const data = await res.json();
      if (data.status === 'parse_error' || data.error) {
        _lastParsedConfig = null;
        saveBtn.disabled = true;
        pv.hidden = false;
        pv.innerHTML = `<div class="settings-warn">${t('settings.parse_failed', { msg: escapeHtml(data.error || (getLanguage() === 'zh' ? '解析失败' : 'Parse failed')) })}</div>`;
        return;
      }
      _lastParsedConfig = data;
      saveBtn.disabled = false;
      pv.hidden = false;
      const parsedLabel = getLanguage() === 'zh' ? `✓ 已解析 — 确认后点击 <strong>${escapeHtml(t('settings.save_activate'))}</strong>` : `✓ Parsed — review and click <strong>${escapeHtml(t('settings.save_activate'))}</strong>`;
      pv.innerHTML = `
        <div class="settings-ok">${parsedLabel}</div>
        <div class="kv-grid">
          <div class="kv"><label>${t('settings.fields_provider')}</label><span>${escapeHtml(data.provider)}</span></div>
          <div class="kv"><label>${t('settings.fields_model')}</label><span>${escapeHtml(data.model)}</span></div>
          <div class="kv"><label>${t('settings.fields_base_url')}</label><span class="mono">${escapeHtml(data.base_url)}</span></div>
          <div class="kv"><label>${t('settings.fields_api_key')}</label><span class="mono">${escapeHtml(data.masked?.api_key || '••••')}</span></div>
        </div>
      `;
    } catch (err) {
      pv.hidden = false;
      pv.innerHTML = `<div class="settings-warn">⚠ ${escapeHtml(err.message)}</div>`;
    }
  });

  $('llmSaveBtn')?.addEventListener('click', async () => {
    if (!_lastParsedConfig) return;
    const out = $('llmSaveResult');
    out.textContent = t('settings.saving');
    try {
      const res = await fetch('/api/settings/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pasted: $('llmPaste').value }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || (getLanguage() === 'zh' ? '保存失败' : 'Save failed'));
      const savedMsg = getLanguage() === 'zh' ? '✓ 已保存并启用。' : '✓ Saved & activated.';
      out.textContent = savedMsg;
      await refreshLLMStatus();
    } catch (err) {
      out.textContent = '⚠ ' + err.message;
    }
  });

  $('llmSaveFieldsBtn')?.addEventListener('click', async () => {
    const cfg = {
      provider: $('llmProvider')?.value || '',
      base_url: $('llmBaseUrl')?.value || '',
      api_key: $('llmApiKey')?.value || '',
      model: $('llmModel')?.value || '',
    };
    const out = $('llmFieldsResult');
    out.textContent = t('settings.saving');
    try {
      const res = await fetch('/api/settings/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: cfg }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || (getLanguage() === 'zh' ? '保存失败' : 'Save failed'));
      const savedMsg = getLanguage() === 'zh' ? '✓ 已保存并启用。' : '✓ Saved & activated.';
      out.textContent = savedMsg;
      await refreshLLMStatus();
    } catch (err) {
      out.textContent = '⚠ ' + err.message;
    }
  });

  $('llmTestBtn')?.addEventListener('click', async () => {
    const out = $('llmTestResult');
    out.textContent = getLanguage() === 'zh' ? '测试中…' : 'Testing…';
    try {
      const res = await fetch('/api/settings/llm/test', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        out.textContent = `✓ ${data.latent_ms || data.latency_ms}ms — "${(data.sample || '').slice(0, 40)}"`;
      } else {
        out.textContent = '⚠ ' + (data.message || (getLanguage() === 'zh' ? '测试失败' : 'Test failed'));
      }
    } catch (err) {
      out.textContent = '⚠ ' + err.message;
    }
  });

  $('llmResetBtn')?.addEventListener('click', async () => {
    const confirmMsg = getLanguage() === 'zh' ? '确定重置为 .env 默认值吗？粘贴的配置将被清除。' : 'Reset to .env defaults? Your pasted config will be cleared.';
    if (!confirm(confirmMsg)) return;
    const out = $('llmTestResult');
    out.textContent = getLanguage() === 'zh' ? '重置中…' : 'Resetting…';
    try {
      const res = await fetch('/api/settings/llm', { method: 'DELETE' });
      if (!res.ok) throw new Error(getLanguage() === 'zh' ? '重置失败' : 'Reset failed');
      const okMsg = getLanguage() === 'zh' ? '✓ 已重置为 .env 默认值。' : '✓ Reset to .env defaults.';
      out.textContent = okMsg;
      await refreshLLMStatus();
    } catch (err) {
      out.textContent = '⚠ ' + err.message;
    }
  });

  // ── Operations card wiring ──
  const opJobsBody = $('opJobsBody');
  const OP_LABELS = {
    sync: getLanguage() === 'zh' ? '抓取信息源' : 'Sync sources',
    enrich: getLanguage() === 'zh' ? 'AI 摘要' : 'Enrich items',
    digest: getLanguage() === 'zh' ? '生成简报' : 'Build digest',
    pipeline: getLanguage() === 'zh' ? '完整流水线' : 'Full pipeline',
    xsync: getLanguage() === 'zh' ? 'X 同步' : 'X sync',
  };
  // Map each op to its running job_id so we can poll/cancel
  const opJobMap = {};

  function showStream(op, html, isError = false) {
    const el = document.querySelector(`[data-op-stream="${op}"]`);
    if (!el) return;
    el.hidden = false;
    el.className = 'op-stream ' + (isError ? 'op-stream-error' : 'op-stream-ok');
    el.innerHTML = html;
  }

  function hideStream(op) {
    const el = document.querySelector(`[data-op-stream="${op}"]`);
    if (el) { el.hidden = true; el.innerHTML = ''; }
  }

  function setOpRunning(op, running) {
    const row = document.querySelector(`[data-op-row="${op}"]`);
    if (!row) return;
    const startBtn = row.querySelector('[data-op]');
    const stopBtn = row.querySelector('[data-op-stop]');
    if (startBtn) startBtn.disabled = !!running;
    if (stopBtn) stopBtn.hidden = !running;
  }

  function shortJobId(id) {
    return id ? id.slice(0, 8) : '—';
  }

  function parseJobResult(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return String(raw);
    }
  }

  async function readJSONOnce(res) {
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  }

  function formatSourceResults(results) {
    if (!Array.isArray(results) || results.length === 0) return '';
    return results.slice(-6).map(r => {
      const suffix = r.error ? `error: ${escapeHtml(r.error)}` : `${r.items || 0} items`;
      return `${escapeHtml(r.source || 'unknown')}: ${suffix}`;
    }).join('<br>');
  }

  function summarizeStagePayload(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const parts = [];
    if (payload.phase === 'fetching') {
      parts.push(`source ${payload.completed_sources ?? payload.current_index ?? 0}/${payload.total_sources || '?'}`);
      if (payload.current_source) parts.push(escapeHtml(payload.current_source));
      const items = (payload.results || []).reduce((sum, r) => sum + (Number(r.items) || 0), 0);
      parts.push(`${items} items`);
      if (payload.heartbeat !== undefined) parts.push(`tick ${payload.heartbeat}`);
    } else if (payload.phase === 'enriching' || payload.phase === 'scoring') {
      parts.push(`processed ${payload.processed || 0}/${payload.total || 0}`);
      parts.push(`enriched ${payload.enriched || 0}`);
      parts.push(`failed ${payload.failed || 0}`);
      if (payload.entities !== undefined) parts.push(`entities ${payload.entities}`);
      if (payload.topics !== undefined) parts.push(`topics ${payload.topics}`);
    } else if (payload.phase === 'translating') {
      parts.push(`processed ${payload.processed || 0}/${payload.total || 0}`);
      parts.push(`translated ${payload.translated || 0}`);
      parts.push(`failed ${payload.failed || 0}`);
      parts.push(`remaining ${payload.remaining ?? '—'}`);
    } else if (Array.isArray(payload.fetch)) {
      const items = payload.fetch.reduce((sum, r) => sum + (Number(r.items) || 0), 0);
      parts.push(`${payload.fetch.length} sources`);
      parts.push(`${items} items`);
    } else if (payload.phase === 'enriching' || payload.phase === 'enriching' || payload.phase === 'scoring') {
      parts.push(`processed ${payload.processed || 0}/${payload.total || 0}`);
      parts.push(`enriched ${payload.enriched || 0}`);
      parts.push(`failed ${payload.failed || 0}`);
      if (payload.entities !== undefined) parts.push(`entities ${payload.entities}`);
      if (payload.topics !== undefined) parts.push(`topics ${payload.topics}`);
    } else {
      if (payload.message) parts.push(escapeHtml(payload.message));
      if (payload.error) parts.push(`error: ${escapeHtml(payload.error)}`);
      if (payload.date) parts.push(`date ${escapeHtml(payload.date)}`);
      if (payload.sources) parts.push(escapeHtml(payload.sources));
    }
    return parts.filter(Boolean).join(' · ');
  }

  function summarizeStageResult(result) {
    if (!result || typeof result !== 'object') return '';
    if (Array.isArray(result.fetch)) {
      // Show all sources with item counts, paper sources first
      const paperSources = new Set(['hugging-face', 'arxiv-ai', 'physical-ai-arxiv', 'physical-ai-cn-photonics']);
      const sorted = [...result.fetch].sort((a, b) => {
        const aPaper = paperSources.has(a.source) ? -1 : 0;
        const bPaper = paperSources.has(b.source) ? -1 : 0;
        return aPaper - bPaper || (b.items || 0) - (a.items || 0);
      });
      return `<span class="job-mini-result-list">${sorted.map(r => `<span class="source-line ${(r.items||0)>0?'has-items':''}">${escapeHtml(r.source || 'unknown')}: ${r.items || 0}</span>`).join('<br>')}</span>`;
    }
    if (result.enriched !== undefined) return `enriched ${result.enriched}/${result.total || 0} · failed ${result.failed || 0}`;
    if (result.translated !== undefined) return `translated ${result.translated}/${result.total || 0} · remaining ${result.remaining ?? '—'}`;
    if (result.nodes !== undefined || result.edges !== undefined) return `nodes ${result.nodes || 0} · edges ${result.edges || 0}`;
    if (result.domains !== undefined) return `${result.domains} 领域 · ${result.topics || 0} 方向 · ${result.uniqueTags || result.tags || 0} 标签`;
    if (result.extract || result.embed || result.topics) {
      return `extract ${result.extract?.total || 0} · embed ${result.embed?.embedded || 0} · topics ${result.topics?.topics_discovered || 0}`;
    }
    if (result.generated !== undefined) return result.generated ? '已生成' : '无摘要';
    if (result.edges_updated !== undefined) return `edges ${result.edges_updated} · scores ${result.scores_updated}`;
    if (result.sources !== undefined) return `${result.sources}`;
    return escapeHtml(JSON.stringify(result).slice(0, 120));
  }

  function formatPipelineProgress(parsed) {
    const stages = Array.isArray(parsed.stages) ? parsed.stages : [];
    if (stages.length === 0) return escapeHtml(JSON.stringify(parsed).slice(0, 500));
    const current = parsed.current_stage || '';
    const rows = stages.map(stage => {
      const status = stage.status || 'pending';
      const detail = summarizeStagePayload(stage.detail) || summarizeStageResult(stage.result);
      const label = getLanguage() === 'zh' ? (stage.label_zh || stage.label || stage.key) : (stage.label || stage.key);
      const elapsed = stage.started_at && status === 'running'
        ? `${Math.max(0, Math.round((Date.now() - new Date(stage.started_at).getTime()) / 1000))}s`
        : '';
      const statusText = elapsed ? `${status} · ${elapsed}` : status;
      return `
        <div class="pipeline-stage pipeline-stage-${escapeAttr(status)} ${stage.key === current ? 'active' : ''}">
          <span class="pipeline-stage-label">${escapeHtml(label)}</span>
          <span class="pipeline-stage-status">${escapeHtml(statusText)}</span>
          ${detail ? `<span class="pipeline-stage-detail">${detail}</span>` : ''}
        </div>
      `;
    }).join('');
    return `<div class="pipeline-progress">${rows}</div>`;
  }

  function formatJobResult(job) {
    const parsed = parseJobResult(job?.result);
    if (!parsed) return '—';
    if (typeof parsed === 'string') return escapeHtml(parsed.slice(0, 500));

    if (parsed.pipeline === true) {
      return formatPipelineProgress(parsed);
    }

    if (parsed.phase === 'translating') {
      const lines = [
        `Translating ${parsed.processed || 0}/${parsed.total || 0}`,
        `Translated: ${parsed.translated || 0}, failed: ${parsed.failed || 0}`,
        `Remaining: ${parsed.remaining ?? '—'}`,
      ];
      if (parsed.batch_items || parsed.workers) {
        lines.push(`Batch: ${parsed.batch_items || '—'}, workers: ${parsed.workers || '—'}`);
      }
      return lines.join('<br>');
    }

    const fetchResults = parsed.fetch || parsed.results;
    if (Array.isArray(fetchResults)) {
      const totalSources = parsed.total_sources || fetchResults.length;
      const doneSources = fetchResults.length;
      const totalItems = fetchResults.reduce((sum, r) => sum + (r.items || 0), 0);
      const parts = [];
      if (parsed.phase === 'fetching') {
        parts.push(`Fetching ${escapeHtml(parsed.current_source || '')} (${parsed.current_index || doneSources}/${totalSources || '?'})`);
      } else if (parsed.phase === 'enriching') {
        parts.push(`Fetch complete: ${doneSources}/${totalSources || doneSources} sources, ${totalItems} items. Enriching…`);
      } else {
        parts.push(`Sources: ${doneSources}/${totalSources || doneSources}, items: ${totalItems}`);
      }
      const details = formatSourceResults(fetchResults);
      if (details) parts.push(`<span class="job-mini-result-list">${details}</span>`);
      if (parsed.enrich) {
        parts.push(`Enriched: ${parsed.enrich.enriched || 0}/${parsed.enrich.total || 0}`);
      }
      return parts.join('<br>');
    }

    return escapeHtml(JSON.stringify(parsed).slice(0, 500));
  }

  async function pollJob(op, jobId, startMs) {
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        const data = await readJSONOnce(res);
        const job = data?.job;
        if (!job) return true; // done
        const elapsed = Math.round((Date.now() - startMs) / 1000);
        const status = (job.status || '').toLowerCase();
        const result = formatJobResult(job);
        if (status === 'running') {
          showStream(op, `${t('ops.stream_running', { elapsed })}<br><span class="job-mini-result">${result}</span>`);
          return false;
        }
        if (status === 'completed') {
          showStream(op, `${t('ops.stream_done', { elapsed })}<br><span class="job-mini-result">${result}</span>`);
          setOpRunning(op, false);
          opJobMap[op] = null;
          refreshOpJobs();
          return true;
        }
        if (status === 'cancelled') {
          showStream(op, `${t('ops.stream_cancelled', { elapsed })}<br><span class="job-mini-result">${result}</span>`);
          setOpRunning(op, false);
          opJobMap[op] = null;
          refreshOpJobs();
          return true;
        }
        if (status === 'failed') {
          showStream(op, `${t('ops.stream_failed', { elapsed })}<br><span class="job-mini-error">${escapeHtml(job.error || '—')}</span>`, true);
          setOpRunning(op, false);
          opJobMap[op] = null;
          refreshOpJobs();
          return true;
        }
        // still queued
        showStream(op, `⏳ Queued ${shortJobId(jobId)}…`);
        return false;
      } catch (err) {
        showStream(op, `⚠ ${err.message}`, true);
        return true;
      }
    };
    // poll every 1.5s until done
    while (!(await tick())) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  async function runOp(op) {
    setOpRunning(op, true);
    const startMs = Date.now();
    showStream(op, `${OP_LABELS[op]}: ${t('ops.running')}`);
    try {
      let res;
      if (op === 'sync') {
        res = await fetch('/api/sync', { method: 'POST' });
      } else if (op === 'enrich') {
        res = await fetch('/api/enrich?background=true', { method: 'POST' });
      } else if (op === 'digest') {
        res = await fetch('/api/digest/build?background=true', { method: 'POST' });
      } else if (op === 'pipeline') {
        res = await fetch('/api/pipeline', { method: 'POST' });
      } else {
        throw new Error('unknown op');
      }
      if (!res) throw new Error('no response');
      const data = await readJSONOnce(res);
      if (!res.ok) throw new Error(data.message || data.error || `${op} failed`);
      const jobId = data.job_id;
      if (jobId) {
        opJobMap[op] = jobId;
        showStream(op, `⏳ ${shortJobId(jobId)}: ${t('ops.running')}`);
        await pollJob(op, jobId, startMs);
      } else {
        showStream(op, t('ops.done', { msg: data.message || 'ok' }));
        setOpRunning(op, false);
        setTimeout(refreshOpJobs, 800);
      }
    } catch (err) {
      showStream(op, t('ops.failed', { msg: err.message }), true);
      setOpRunning(op, false);
    }
  }

  async function stopOp(op) {
    const jobId = opJobMap[op];
    if (!jobId) return;
    const stopBtn = document.querySelector(`[data-op-stop="${op}"]`);
    if (stopBtn) {
      stopBtn.disabled = true;
      stopBtn.textContent = t('ops.cancelling');
    }
    try {
      await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    } catch (err) {
      console.warn('cancel failed:', err.message);
    }
    // pollJob will pick up the cancelled status and update UI
  }

  async function refreshOpJobs() {
    if (!opJobsBody) return;
    try {
      const res = await fetch('/api/jobs?limit=8');
      const data = await res.json();
      const jobs = data.jobs || [];
      if (jobs.length === 0) {
        opJobsBody.innerHTML = `<p class="empty-state">${getLanguage() === 'zh' ? '暂无任务' : 'No jobs yet'}</p>`;
        return;
      }
      opJobsBody.innerHTML = jobs.map(j => {
        const jobType = (j.job_type || '').replace(/-/g, ' ').toUpperCase();
        const status = (j.status || '').toLowerCase();
        const statusClass = status === 'completed' ? 'job-done' : status === 'failed' ? 'job-failed' : status === 'cancelled' ? 'job-cancelled' : status === 'running' ? 'job-running' : 'job-queued';
        const startedAt = j.started_at || j.created_at || '';
        const result = j.result ? formatJobResult(j) : '';
        const error = j.error || '';
        return `<div class="job-row">
          <span class="job-type">${escapeHtml(jobType)}</span>
          <span class="job-status ${statusClass}">${escapeHtml(j.status || '')}</span>
          <span class="job-time">${escapeHtml(startedAt)}</span>
          ${result ? `<span class="job-result">${result}</span>` : ''}
          ${error ? `<span class="job-error">${escapeHtml(error.slice(0, 80))}</span>` : ''}
        </div>`;
      }).join('');
    } catch (err) {
      opJobsBody.innerHTML = `<p class="empty-state">⚠ ${err.message}</p>`;
    }
  }

  document.querySelectorAll('[data-op]').forEach(btn => {
    btn.addEventListener('click', () => runOp(btn.dataset.op));
  });
  document.querySelectorAll('[data-op-stop]').forEach(btn => {
    btn.addEventListener('click', () => stopOp(btn.dataset.opStop));
  });

  // ── X Following config wiring ──
  const xConfigTextarea = $('xConfigTextarea');
  const xConfigResult = $('xConfigResult');
  const xBlocklistTextarea = $('xBlocklistTextarea');
  const xBlocklistResult = $('xBlocklistResult');
  async function loadXConfig() {
    try {
      const res = await fetch('/api/settings/x-following');
      const data = await res.json();
      const users = data?.config?.users?.length ? data.config.users : (data?.env_users || []);
      if (xConfigTextarea) xConfigTextarea.value = users.join('\n');
      if (xBlocklistTextarea && Array.isArray(data?.blocklist)) xBlocklistTextarea.value = data.blocklist.join('\n');
    } catch (err) {
      if (xConfigResult) xConfigResult.textContent = t('xconfig.load_error', { msg: err.message });
    }
  }
  $('xConfigSaveBtn')?.addEventListener('click', async () => {
    if (!xConfigTextarea) return;
    const users = xConfigTextarea.value.split(/[\n,]/).map(s => s.trim().replace(/^@/, '')).filter(Boolean);
    try {
      const res = await fetch('/api/settings/x-following', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ users }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'save failed');
      if (xConfigResult) xConfigResult.textContent = t('xconfig.saved', { n: data.saved });
    } catch (err) {
      if (xConfigResult) xConfigResult.textContent = '✗ ' + err.message;
    }
  });
  // ── X Following blocklist wiring ──
  $('xBlocklistSaveBtn')?.addEventListener('click', async () => {
    if (!xBlocklistTextarea) return;
    const blocked = xBlocklistTextarea.value.split(/[\n,]/).map(s => s.trim().replace(/^@/, '')).filter(Boolean);
    try {
      const res = await fetch('/api/settings/x-following', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocked_users: blocked }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'save failed');
      if (xBlocklistResult) xBlocklistResult.textContent = t('xconfig.blocklist_saved', { n: data.blocked_saved ?? 0 });
    } catch (err) {
      if (xBlocklistResult) xBlocklistResult.textContent = '✗ ' + err.message;
    }
  });
  $('xCleanupBtn')?.addEventListener('click', async () => {
    if (xBlocklistResult) xBlocklistResult.textContent = '⏳ ' + t('xconfig.cleanup_running');
    try {
      const res = await fetch('/api/settings/x-following/cleanup', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'cleanup failed');
      if (xBlocklistResult) xBlocklistResult.textContent = t('xconfig.cleanup_done', { n: data.purged ?? 0 });
    } catch (err) {
      if (xBlocklistResult) xBlocklistResult.textContent = '✗ ' + err.message;
    }
  });
  loadXConfig();

  refreshOpJobs();
  // Poll jobs panel every 5s
  setInterval(refreshOpJobs, 5000);
}

// ─── Tags ──────────────────────────────────────────────────

export async function renderTags(_params) {
  const container = $('#pageContent');
  showLoader(container, 'Loading tags...');

  try {
    const data = await fetchJSON(`${API_BASE}/tags`);

    const html = `
      <section class="page-section tags-layout">
        <div class="page-header">
          <h2 class="page-title">🏷️ ${t('nav.tags') || 'Tags'}</h2>
          <p class="page-description">LLM-auto-generated Chinese tags aggregating feed items</p>
        </div>
        <div class="tags-grid">
          ${(data.tags || []).map(tag => `
            <a href="${escapeAttr(tagHref(tag))}" class="tag-card">
              <span class="tag-card-name">${escapeHtml(tag.name || tag.name_zh)}</span>
              <span class="tag-card-count">${tag.item_count || 0} items</span>
            </a>
          `).join('')}
        </div>
      </section>
    `;
    container.innerHTML = html;
  } catch (err) {
    showError(container, err.message);
  }
}

export async function renderTagDetail(params) {
  const container = $('#pageContent');
  const slug = decodeURIComponent(params?.slug || '');
  showLoader(container, `${t('common.loading')} ${slug}...`);

  try {
    const data = await fetchJSON(`${API_BASE}/tags/${encodeURIComponent(slug)}`);
    const tag = data.tag || {};
    const items = data.items || [];
    const graph = data.graph || {};
    const parents = graph.parents || [];
    const related = graph.related || [];
    const tagName = tag.name || tag.name_zh || slug;

    const graphNodes = [
      ...parents.map((parent, index) => ({
        id: `parent:${parent.id || index}`,
        label: parent.label_zh || parent.slug || '',
        type: parent.kind || 'concept',
      })),
      { id: `tag:${tag.id}`, label: tagName, type: 'tag' },
      ...related.slice(0, 8).map((rel, index) => ({
        id: `related:${rel.slug || index}`,
        label: rel.label_zh || rel.slug || '',
        type: 'related',
      })),
    ];
    const graphEdges = [
      ...parents.map((parent, index) => ({
        source: `tag:${tag.id}`,
        target: `parent:${parent.id || index}`,
        type: parent.edge_type || 'primary_parent',
        weight: parent.weight || 1,
      })),
      ...related.slice(0, 8).map((rel, index) => ({
        source: `tag:${tag.id}`,
        target: `related:${rel.slug || index}`,
        type: 'tag_cooccur',
        weight: rel.shared_items || 1,
      })),
    ];

    const html = `
      <section class="page-section tag-detail-page">
        <div class="page-header">
          <h2 class="page-title">🏷️ ${escapeHtml(tagName)}</h2>
          <a href="/tags" class="nav-link">← ${escapeHtml(t('nav.tags') || 'Tags')}</a>
          <a href="/kg3d" class="nav-link" style="margin-left:12px;">🧠 3D ${getLanguage() === 'zh' ? '知识图谱' : 'KG'}</a>
        </div>
        <div class="topic-full-detail">
          <div class="topic-info">
            <p class="topic-description">${escapeHtml(getLanguage() === 'zh' ? '由 LLM 从 feed 和论文中抽取的中文知识原子。' : 'LLM-extracted knowledge atom from feeds and papers.')}</p>
            <div class="topic-meta-grid">
              <div class="meta-item"><label>Items</label><span>${tag.item_count || 0}</span></div>
              <div class="meta-item"><label>Parents</label><span>${parents.length}</span></div>
              <div class="meta-item"><label>Related</label><span>${related.length}</span></div>
              <div class="meta-item"><label>Type</label><span>${escapeHtml(tag.type || 'tag')}</span></div>
            </div>
          </div>

          <div class="topic-graph-section">
            <h3>${t('header.graph_attr')}</h3>
            <div id="tagDetailGraph" class="topic-graph-viz" style="height:350px;"></div>
            <div class="tag-graph-fallback">
              <div>
                <h4>${getLanguage() === 'zh' ? '上位概念' : 'Parents'}</h4>
                ${parents.length ? parents.map(parent => `
                  <span class="tag-chip tag-parent-chip">${escapeHtml(parent.label_zh || parent.slug || '')}</span>
                `).join('') : `<span class="subtle">${getLanguage() === 'zh' ? '暂无上位概念' : 'No parent concepts yet'}</span>`}
              </div>
              <div>
                <h4>${getLanguage() === 'zh' ? '共现标签' : 'Related tags'}</h4>
                ${related.length ? related.map(rel => `
                  <a href="${escapeAttr(tagHref({ slug: rel.slug, name: rel.label_zh }))}" class="tag-chip">#${escapeHtml(rel.label_zh || rel.slug || '')} · ${rel.shared_items}</a>
                `).join('') : `<span class="subtle">${getLanguage() === 'zh' ? '暂无共现标签' : 'No related tags yet'}</span>`}
              </div>
            </div>
          </div>

          <div class="topic-items" style="margin-top:24px;">
            <h3>${t('topics.recent_items')}</h3>
            <div class="feed-list">
              ${items.map(item => renderItemMiniCard(item)).join('')}
            </div>
            ${items.length === 0 ? `<p class="empty-state">${getLanguage() === 'zh' ? '暂无最近条目。' : 'No recent items found.'}</p>` : ''}
          </div>
        </div>
      </section>
    `;
    container.innerHTML = html;

    try {
      if (graphNodes.length > 1 && graphEdges.length > 0) {
        const detailGraph = new KnowledgeGraph('tagDetailGraph');
        detailGraph.init({ nodes: graphNodes, edges: graphEdges });
      } else {
        const graphEl = document.getElementById('tagDetailGraph');
        if (graphEl) graphEl.innerHTML = `<p class="graph-placeholder">${t('common.graph_void')}</p>`;
      }
    } catch (err) {
      console.warn('Tag detail graph unavailable:', err.message);
      const graphEl = document.getElementById('tagDetailGraph');
      if (graphEl) graphEl.innerHTML = `<p class="graph-placeholder">${escapeHtml(err.message)}</p>`;
    }
  } catch (err) {
    showError(container, err.message);
  }
}
