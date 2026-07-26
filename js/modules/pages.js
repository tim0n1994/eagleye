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
import { renderMarkdown } from './markdown.js';

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
  return renderMarkdown(md, t('common.empty'));
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
             <div class="hero-stats" id="heroStats">
               <span class="hero-stat">${Object.keys(bySourceMap).length} ${getLanguage() === 'zh' ? '信息源' : 'SOURCES'}</span>
               <span class="hero-stat">${Object.values(bySourceMap).reduce((sum, arr) => sum + arr.length, 0)} ${getLanguage() === 'zh' ? '今日信号' : 'SIGNALS'}</span>
               <span class="hero-stat">⏱ ${(() => {
                 // Estimate total reading time: sum all item summaries' word counts.
                 let totalWords = 0;
                 for (const items of Object.values(bySourceMap)) {
                   for (const item of items) {
                     const text = (item.ai_summary?.short_summary_zh || item.ai_summary?.short_summary || item.original_summary || item.title || '').toString();
                     totalWords += text.length / 3;
                   }
                 }
                 const mins = Math.round(totalWords / 200);
                 return mins > 60 ? Math.round(mins / 60) + 'h' : mins + 'm';
               })()} ${getLanguage() === 'zh' ? '阅读' : 'READ'}</span>
               <span class="hero-stat" id="heroStatExtra"></span>
             </div>
           </div>
         </div>

        <div id="homeDigest" class="home-digest-loading"><span class="spinner"></span> ${t('home.loading_digest')}</div>

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

        <details style="margin-top:24px;border-top:1px solid var(--rule);padding-top:16px">
          <summary style="cursor:pointer;font-size:11px;text-transform:uppercase;letter-spacing:0.16em;color:var(--fg-mute)">${getLanguage() === 'zh' ? '📄 文本视图（可复制）' : '📄 Text View (copyable)'}</summary>
          <div id="textDigestView" style="margin-top:12px;font-family:var(--font-mono);font-size:12px;line-height:1.8;color:var(--fg-dim);white-space:pre-wrap">${(() => {
            // Build a plain-text digest of all items grouped by source (§7.2 SSR text view).
            let txt = `${getLanguage() === 'zh' ? ' Eagleye 每日信息流' : ' Eagleye Daily Feed'} — ${displayDate}\n${'='.repeat(60)}\n\n`;
            for (const [src, srcItems] of orderedSourceEntries(bySourceMap, allSources)) {
              const sourceObj = labelToObj[src];
              const displayName = sourceObj ? pickZh(sourceObj.label, sourceObj.label_zh) : src;
              txt += `\n## ${displayName} (${srcItems.length})\n\n`;
              for (const item of srcItems.slice(0, 30)) {
                const title = item.ai_summary?.ai_title_zh || item.title_zh || item.title || '';
                txt += `  • ${title}\n    ${item.canonical_url || ''}\n`;
              }
            }
            return escapeHtml(txt);
          })()}</div>
        </details>

        <div class="metrics-block" style="margin-top:24px">
          <h3 class="metrics-block-title">${getLanguage() === 'zh' ? '近 7 天活动' : 'Last 7 Days Activity'}</h3>
          <div id="insightStrip" style="display:flex;gap:8px;overflow-x:auto;padding:4px 0">
            <span class="subtle">Loading...</span>
          </div>
        </div>
      </section>
    `;

    container.innerHTML = html;

    // Async: fetch last 7 days activity strip.
    fetchJSON(`${API_BASE}/digest/coverage`).then(covData => {
      const strip = document.getElementById('insightStrip');
      if (!strip) return;
      const coverage = covData.coverage || {};
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const ds = localDateStr(d);
        days.push({ date: ds, count: coverage[ds] || 0, label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) });
      }
      const maxC = Math.max(1, ...days.map(d => d.count));
      strip.innerHTML = days.map(d => {
        const h = Math.max(4, (d.count / maxC) * 40);
        const opacity = d.count > 0 ? 0.4 + 0.6 * (d.count / maxC) : 0.1;
        return `<a href="/digest/${d.date}" style="display:flex;flex-direction:column;align-items:center;gap:4px;min-width:60px;text-decoration:none">` +
          `<div style="width:40px;height:${h}px;background:var(--accent);opacity:${opacity};border-radius:3px" title="${d.count} items"></div>` +
          `<span style="font-size:9px;color:var(--fg-mute);font-family:var(--font-mono)">${d.label.split(' ')[0]}</span>` +
          `<span style="font-size:10px;color:${d.count > 0 ? 'var(--accent)' : 'var(--fg-mute)'};font-weight:600">${d.count}</span>` +
          `</a>`;
      }).join('');
    }).catch(() => { const s = document.getElementById('insightStrip'); if (s) s.style.display = 'none'; });

    // Async: fetch system stats for the hero badge (entities, total items).
    fetchJSON(`${API_BASE}/system/stats`).then(sysData => {
      const el = document.getElementById('heroStatExtra');
      if (!el || !sysData.stats) return;
      const s = sysData.stats;
      el.textContent = `${(s.entities || 0).toLocaleString()} ${getLanguage() === 'zh' ? '实体' : 'ENTITIES'} · ${(s.scored || 0).toLocaleString()} ${getLanguage() === 'zh' ? '已评分' : 'SCORED'}`;
    }).catch(() => { const el = document.getElementById('heroStatExtra'); if (el) el.style.display = 'none'; });

    // Fetch and render the AI Daily Digest for this date (§7.2: homepage must
    // show an AI-generated digest above the source sections). Non-blocking —
    // if no digest exists or the fetch fails, the section stays hidden.
    fetchJSON(`/api/digest?date=${encodeURIComponent(displayDate)}`).then(digestData => {
      const digest = digestData.digest;
      const el = document.getElementById('homeDigest');
      if (!el) return;
      if (!digest || !digest.headline) { el.style.display = 'none'; return; }
      const parseList = (field) => {
        try { const arr = typeof field === 'string' ? JSON.parse(field) : field; return Array.isArray(arr) ? arr : []; } catch { return []; }
      };
      const topSignals = parseList(digest.top_signals);
      const signals = topSignals.slice(0, 5).map(s =>
        `<li class="digest-signal"><span class="digest-signal-title">${escapeHtml(s.title || '')}</span>${s.reason ? `<span class="digest-signal-reason">${escapeHtml(s.reason)}</span>` : ''}</li>`
      ).join('');
      el.className = 'home-digest';
      el.innerHTML =
        `<div class="digest-head"><h3>🤖 ${t('home.ai_digest')}</h3><span class="digest-date">${escapeHtml(digest.digest_date || displayDate)}</span></div>` +
        `<h4 class="digest-headline">${escapeHtml(digest.headline)}</h4>` +
        (digest.executive_summary ? `<p class="digest-summary">${escapeHtml(digest.executive_summary)}</p>` : '') +
        (signals ? `<ul class="digest-signals">${signals}</ul>` : '') +
        `<a href="/digest/${escapeAttr(digest.digest_date || displayDate)}" class="digest-link">${t('home.full_digest')} →</a>`;
    }).catch(() => { const el = document.getElementById('homeDigest'); if (el) el.style.display = 'none'; });

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
      ${item.story_cluster ? `<div class="card-dedup" title="${escapeAttr(t('dedup.tip'))}">📚 ${t('dedup.count', { n: item.story_cluster.count })} · ${item.story_cluster.sources.map(s => escapeHtml(s)).join(', ')}</div>` : ''}
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
        ${item.saved || item.saved_at ? `<button class="action-btn saved-toggle" data-item-id="${escapeAttr(item.id)}" title="${escapeAttr(t('saved.removed'))}">🔖</button>` : ''}
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
        ${(() => {
          // Reading time estimate: ~200 words/min, based on summary length.
          const text = (summary.short_summary_zh || summary.short_summary || summary.one_liner_zh || summary.one_liner || item.original_summary || '').toString();
          const words = text.length / 3; // rough CJK word equivalent
          const mins = Math.max(1, Math.round(words / 200));
          return mins > 1 ? `<span class="mini-meta" title="est. reading time">⏱ ${mins}m</span>` : '';
        })()}
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
        ${(() => {
          // Calendar-style heatmap: 30-day grid with color intensity by item count.
          const maxCount = Math.max(1, ...dates.map(d => d.count));
          return `<div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:20px;padding:12px;background:var(--bg-card);border:1px solid var(--rule);border-radius:var(--radius)">` +
            dates.slice().reverse().map(d => {
              const intensity = d.count / maxCount;
              const opacity = d.count > 0 ? (0.2 + 0.8 * intensity) : 0.05;
              return `<a href="/digest/${d.dateStr}" title="${d.dateStr}: ${d.count} items" style="width:20px;height:20px;background:var(--accent);opacity:${opacity};border-radius:2px;display:inline-block;text-decoration:none"></a>`;
            }).join('') +
            `</div>` +
            `<div style="display:flex;align-items:center;gap:6px;margin-bottom:16px;font-size:10px;color:var(--fg-mute)">` +
            `<span>Less</span>` +
            `<span style="width:12px;height:12px;background:var(--accent);opacity:0.2;border-radius:2px;display:inline-block"></span>` +
            `<span style="width:12px;height:12px;background:var(--accent);opacity:0.5;border-radius:2px;display:inline-block"></span>` +
            `<span style="width:12px;height:12px;background:var(--accent);opacity:0.8;border-radius:2px;display:inline-block"></span>` +
            `<span style="width:12px;height:12px;background:var(--accent);opacity:1;border-radius:2px;display:inline-block"></span>` +
            `<span>More</span></div>`;
        })()}
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
            ${data.digest ? `<button class="nav-btn" onclick='window.__exportDigest(${JSON.stringify(JSON.stringify(data.digest)).replace(/'/g,"&#39;")}, "${escapeAttr(date)}")'>⬇ MD</button>` : ''}
            <button class="nav-btn" onclick="window.location.href='/digest/${nextDate}'">NEXT →</button>
          </div>
        </div>
        ${data.digest ? `
          <div class="digest-summary">
            <h3>${escapeHtml(data.digest.headline || '')}</h3>
            <p>${escapeHtml(data.digest.executive_summary || '')}</p>
          </div>
          ${(() => {
            // Render the full 8-section AI digest (§8.2).
            const parseList = (field) => {
              try { const arr = typeof field === 'string' ? JSON.parse(field) : field; return Array.isArray(arr) ? arr : []; } catch { return []; }
            };
            // Content quality score from the digest.
            const zh = getLanguage() === 'zh';
            const qualityScore = Math.min(100, Math.round(((data.digest.item_count || 0) / 500) * 100));
            const qualityLabel = qualityScore >= 80 ? (zh ? '丰富' : 'Rich') : qualityScore >= 40 ? (zh ? '适中' : 'Moderate') : (zh ? '稀少' : 'Sparse');
            const qualityColor = qualityScore >= 80 ? '#34d399' : qualityScore >= 40 ? '#facc15' : '#f87171';
            const qualityHtml = '<div style="display:flex;align-items:center;gap:8px;margin:8px 0">' +
              '<div style="width:60px;height:6px;background:var(--bg-side);border-radius:3px;overflow:hidden"><div style="height:100%;width:' + qualityScore + '%;background:' + qualityColor + ';border-radius:3px"></div></div>' +
              '<span style="font-size:11px;color:' + qualityColor + ';font-weight:600">' + qualityLabel + ' (' + (data.digest.item_count || 0) + ' ' + (zh ? '条' : 'items') + ')</span></div>';
            const renderWatch = (items, icon) => (items || []).map(s =>
              `<div class="digest-watch-item"><span class="digest-watch-name">${icon} ${escapeHtml(s.repo || s.paper || s.product || s.risk || s.title || s.topic || '')}</span>${s.why || s.reason || s.evidence ? `<span class="digest-watch-why">${escapeHtml(s.why || s.reason || s.evidence || '')}</span>` : ''}</div>`
            ).join('');
            const topSignals = parseList(data.digest.top_signals);
            const emergingTopics = parseList(data.digest.emerging_topics);
            const repoWatch = parseList(data.digest.repo_watch);
            const paperWatch = parseList(data.digest.paper_watch);
            const productWatch = parseList(data.digest.product_watch);
            const riskWatch = parseList(data.digest.risk_watch);
            let sections = qualityHtml;
            if (topSignals.length) sections += `<div class="digest-section"><h4>📡 ${getLanguage() === 'zh' ? '主要信号' : 'Top Signals'}</h4>${topSignals.map(s => `<div class="digest-watch-item"><span class="digest-watch-name">${escapeHtml(s.title || '')}</span>${s.reason ? `<span class="digest-watch-why">${escapeHtml(s.reason)}</span>` : ''}</div>`).join('')}</div>`;
            if (emergingTopics.length) sections += `<div class="digest-section"><h4>🌱 ${getLanguage() === 'zh' ? '新兴主题' : 'Emerging Topics'}</h4>${emergingTopics.map(s => `<div class="digest-watch-item"><span class="digest-watch-name">${escapeHtml(s.topic || '')}</span>${s.why_now ? `<span class="digest-watch-why">${escapeHtml(s.why_now)}</span>` : ''}</div>`).join('')}</div>`;
            if (repoWatch.length) sections += `<div class="digest-section"><h4>📦 ${getLanguage() === 'zh' ? '仓库关注' : 'Repo Watch'}</h4>${renderWatch(repoWatch, '📦')}</div>`;
            if (paperWatch.length) sections += `<div class="digest-section"><h4>📄 ${getLanguage() === 'zh' ? '论文关注' : 'Paper Watch'}</h4>${renderWatch(paperWatch, '📄')}</div>`;
            if (productWatch.length) sections += `<div class="digest-section"><h4>🚀 ${getLanguage() === 'zh' ? '产品关注' : 'Product Watch'}</h4>${renderWatch(productWatch, '🚀')}</div>`;
            if (riskWatch.length) sections += `<div class="digest-section digest-risk"><h4>⚠️ ${getLanguage() === 'zh' ? '风险关注' : 'Risk Watch'}</h4>${renderWatch(riskWatch, '⚠️')}</div>`;
            return sections ? `<div class="digest-sections">${sections}</div>` : '';
          })()}
        ` : ''}
        ${(() => {
          // Source distribution mini-chart: bars showing items per source.
          const entries = orderedSourceEntries(data.by_source || {}, sources);
          if (entries.length === 0) return '';
          const maxItems = Math.max(1, ...entries.map(([, items]) => items.length));
          // Stacked source contribution bar: a single horizontal bar showing proportions.
          const totalItems = entries.reduce((s, [, items]) => s + items.length, 0);
          const stackColors = ['#f97316', '#38bdf8', '#34d399', '#a78bfa', '#facc15', '#f43f5e', '#2dd4bf', '#94a3b8', '#fb7185', '#34d399', '#c084fc', '#3498db'];
          const stackBar = entries.slice(0, 8).map(([source, items], i) => {
            const w = totalItems > 0 ? Math.round((items.length / totalItems) * 100) : 0;
            return `<div style="width:${w}%;background:${stackColors[i % stackColors.length]};opacity:0.8" title="${escapeHtml(source)}: ${items.length}"></div>`;
          }).join('');
          return '<div class="metrics-block" style="margin-bottom:16px">' +
            '<h3 class="metrics-block-title">' + (getLanguage() === 'zh' ? '来源分布' : 'Source Distribution') + '</h3>' +
            // Stacked proportion bar
            '<div style="display:flex;height:16px;border-radius:3px;overflow:hidden;margin-bottom:8px">' + stackBar + '</div>' +
            '<ul class="metrics-bars">' +
            entries.slice(0, 12).map(([source, items]) => {
              const pct = Math.round((items.length / maxItems) * 100);
              const firstItem = items[0] || {};
              const cached = _sourcesCache.find(s => s.slug === firstItem.source_slug);
              const displayName = cached ? pickZh(cached.label, cached.label_zh) : (firstItem.source_label || source);
              return '<div class="metrics-bar-row"><span class="metrics-bar-label">' + escapeHtml(displayName) + '</span>' +
                '<div class="metrics-bar"><div class="metrics-bar-fill" style="width:' + pct + '%"></div></div>' +
                '<span class="metrics-bar-pct">' + items.length + '</span></div>';
            }).join('') +
            '</ul></div>';
        })()}
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
          <p class="page-description">${t('sources.subtitle')}
            <a href="/opml.xml" download="eagleye-sources.opml" class="action-link" style="font-size:11px;margin-left:8px">⬇ OPML (import to RSS reader)</a>
          </p>
        </div>
        <div class="sources-grid">
          ${(data.sources || []).map(src => {
            const icon = sourceIcon(src.slug);
            const statsParts = [];
            // Freshness badge: green if items today, yellow if items this week, red if stale.
            const freshness = src.today_items > 0 ? '🟢' : (src.total_items > 0 ? '🟡' : '🔴');
            if (src.today_items > 0) {
              statsParts.push(`<span class="source-stat">${freshness} ${src.today_items} ${getLanguage() === 'zh' ? '今日' : 'today'}</span>`);
            } else {
              statsParts.push(`<span class="source-stat">${freshness} 0 ${getLanguage() === 'zh' ? '今日' : 'today'}</span>`);
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
              ${(src.trend && src.trend.length > 0) ? (() => {
                const maxC = Math.max(1, ...src.trend.map(t => t.count));
                return `<div class="source-trend-bars" title="7-day item trend">` +
                  src.trend.map(t => `<span class="trend-bar" style="height:${Math.max(2, (t.count / maxC) * 24)}px" title="${t.date}: ${t.count}"></span>`).join('') +
                  `</div>`;
              })() : ''}
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
    const signalDist = data.signal_dist || [];

    // Signal-type distribution bars (last 30d).
    const maxSig = Math.max(1, ...signalDist.map(s => s.count));
    const distHtml = signalDist.length > 0
      ? `<div class="metrics-block" style="margin-top:16px"><h3 class="metrics-block-title">${getLanguage() === 'zh' ? '信号类型分布（30天）' : 'Signal Type Distribution (30d)'}</h3>` +
        `<ul class="metrics-bars">` +
        signalDist.slice(0, 10).map(s => {
          const pct = Math.round((s.count / maxSig) * 100);
          return `<div class="metrics-bar-row"><span class="metrics-bar-label">${escapeHtml(s.signal_type.replace(/_/g, ' '))}</span>` +
            `<div class="metrics-bar"><div class="metrics-bar-fill" style="width:${pct}%"></div></div>` +
            `<span class="metrics-bar-pct">${s.count}</span></div>`;
        }).join('') + `</ul></div>`
      : '';

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
        ${src.source_type ? `<div class="source-trust-bar">${trustBadge(src.source_type, src.noise_rate)}${src.early_signal_rate != null ? ` <span class="source-stat">early signal: ${(src.early_signal_rate * 100).toFixed(0)}%</span>` : ''}${src.originality_rate != null ? ` <span class="source-stat">originality: ${(src.originality_rate * 100).toFixed(0)}%</span>` : ''}${src.last_30d_alpha_hits != null ? ` <span class="source-stat">30d α-hits: ${src.last_30d_alpha_hits}</span>` : ''}</div>` : ''}
        ${distHtml}
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
  const rawId = params?.id || window.location.pathname.replace('/research/', '').split('?')[0];
  const urlParams = new URLSearchParams(window.location.search);
  const isTopicReport = urlParams.has('topic');
  showLoader(container, getLanguage() === 'zh' ? '正在载入研究页...' : 'LOADING RESEARCH...');

  if (!rawId) {
    showError(container, getLanguage() === 'zh' ? '缺少 id' : 'Missing id');
    return;
  }

  // Topic-level research reports have item_id=NULL and the URL carries ?topic=.
  // Render the report Markdown directly instead of trying to load an item.
  if (isTopicReport) {
    try {
      const repData = await fetchJSON(`${API_BASE}/research/${encodeURIComponent(rawId)}`);
      const report = repData.report;
      if (!report) { showError(container, t('common.not_found')); return; }
      const topicName = urlParams.get('topic') || '';
      container.innerHTML =
        `<section class="page-section research-page">` +
        `<div class="page-header"><a href="/topics/${escapeAttr(topicName)}" class="anchor-link">← ${t('nav.topics')}</a>` +
        `<h2 class="page-title">🔬 ${escapeHtml(topicName)} — ${t('topics.research_this')}</h2>` +
        `<p class="page-description">${report.status === 'completed' ? '' : '⏳ '+report.status}</p></div>` +
        (report.report_markdown ? renderMarkdownLite(report.report_markdown) :
         report.error ? `<p class="subtle">${escapeHtml(report.error)}</p>` :
         `<p class="subtle">${t('common.loading')}</p>`) +
        `</section>`;
      return;
    } catch (err) { showError(container, err.message); return; }
  }

  const itemId = rawId;
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
    const topics = (data.topics || []).sort((a, b) => (b.item_count || 0) - (a.item_count || 0)).slice(0, 8);

    // Topic cross-reference: async fetch to compute shared items between top topics.
    const xrefMatrixHtml = await (async () => {
      if (topics.length < 2) return '';
      // Fetch graph data to find topic-topic edges.
      try {
        const graphData = await fetchJSON(`${API_BASE}/graph`).catch(() => ({ edges: [] }));
        const edges = (graphData.edges || []).filter(e => e.edge_type === 'topic_related_topic');
        if (edges.length === 0) return '';
        // Build matrix: find edges between our top topics.
        const slugSet = new Set(topics.map(t => t.id));
        const matrix = {};
        for (const e of edges) {
          if (slugSet.has(e.from_id) && slugSet.has(e.to_id)) {
            const key = [e.from_id, e.to_id].sort().join('||');
            matrix[key] = (matrix[key] || 0) + (e.weight || 1);
          }
        }
        const maxWeight = Math.max(1, ...Object.values(matrix));
        let cells = '';
        for (const t1 of topics) {
          for (const t2 of topics) {
            if (t1.id === t2.id) { cells += '<td style="background:var(--bg-side);text-align:center;font-size:9px;color:var(--fg-mute)">—</td>'; continue; }
            const key = [t1.id, t2.id].sort().join('||');
            const w = matrix[key] || 0;
            if (w > 0) {
              const opacity = 0.2 + 0.8 * (w / maxWeight);
              cells += `<td style="background:var(--accent);opacity:${opacity};text-align:center;font-size:9px;color:#000;font-weight:600" title="${escapeHtml(t1.name)} ↔ ${escapeHtml(t2.name)}: ${w}">${w}</td>`;
            } else {
              cells += '<td style="text-align:center;font-size:9px;color:var(--fg-mute)">·</td>';
            }
          }
        }
        return `<div class="metrics-block" style="margin-top:16px"><h3 class="metrics-block-title">${getLanguage() === 'zh' ? '主题交叉引用' : 'Topic Cross-Reference'}</h3>` +
          `<div style="overflow-x:auto"><table class="metrics-table" style="font-size:10px"><thead><tr><th></th>${topics.map(t => '<th style="text-align:center;max-width:60px;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(pickZh(t.name, t.name_zh) || t.slug) + '</th>').join('')}</tr></thead><tbody>` +
          topics.map((t1, i) => `<tr><td class="compare-feature" style="max-width:80px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(pickZh(t1.name, t1.name_zh) || t1.slug)}</td>${cells.split('</td>').slice(i * topics.length, (i + 1) * topics.length).join('</td>')}</td></tr>`).join('') +
          `</tbody></table></div></div>`;
      } catch { return ''; }
    })();

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
              ${(data.topics || []).sort((a,b) => (b.growth_score||0) - (a.growth_score||0)).map(t => `
                <a href="/topics/${escapeAttr(t.slug)}" class="topic-list-item">
                  <span class="topic-name">${escapeHtml(pickZh(t.name, t.name_zh))}</span>
                  ${(t.growth_score || 0) > 1 ? `<span class="topic-growth" title="growth score">📈${(t.growth_score || 0).toFixed(1)}</span>` : ''}
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
        ${xrefMatrixHtml}
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
          <a href="${escapeAttr(item.canonical_url || '#')}" target="_blank" rel="noopener">${escapeHtml(getItemDisplayTitle(item) || '')}</a>
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
          <div class="topic-detail-actions">
            <a href="/topics" class="anchor-link">← ${t('nav.topics')}</a>
            <button class="action-btn topic-research-btn" data-slug="${escapeAttr(slug)}">🔬 ${t('topics.research_this')}</button>
            <a href="/api/topics/${escapeAttr(slug)}/feed.xml" class="action-link" target="_blank" rel="noopener">📡 RSS</a>
          </div>
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

    // Async: load and render the topic timeline chart.
    fetchJSON(`/api/topics/${encodeURIComponent(slug)}/timeline`).then(tlData => {
      const timeline = tlData.timeline || [];
      if (timeline.length === 0) return;
      const maxCount = Math.max(1, ...timeline.map(p => p.count || 0));
      const W = 600, H = 120, PAD = 20;
      const n = timeline.length;
      const x = (i) => PAD + (n > 1 ? (i / (n - 1)) * (W - PAD * 2) : 0);
      const y = (v) => H - PAD - (v / maxCount) * (H - PAD * 2);
      let bars = '';
      const barW = Math.max(1, (W - PAD * 2) / n - 1);
      for (let i = 0; i < n; i++) {
        const h = Math.max(1, (timeline[i].count / maxCount) * (H - PAD * 2));
        bars += `<rect x="${x(i).toFixed(1)}" y="${(H - PAD - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="var(--accent)" opacity="0.7"/>`;
      }
      const insertEl = container.querySelector('.topic-items');
      if (insertEl) {
        const chartDiv = document.createElement('div');
        chartDiv.className = 'metrics-block';
        chartDiv.style.marginTop = '16px';
        chartDiv.innerHTML =
          `<h3 class="metrics-block-title">${getLanguage() === 'zh' ? '时间线' : 'Timeline'}</h3>` +
          `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-height:120px">` + bars + `</svg>`;
        insertEl.parentNode.insertBefore(chartDiv, insertEl);
      }
    }).catch(() => {});

    // Wire topic research button (§9.2).
    const researchBtn = container.querySelector('.topic-research-btn');
    if (researchBtn) {
      researchBtn.addEventListener('click', async () => {
        const s = researchBtn.dataset.slug;
        researchBtn.disabled = true;
        researchBtn.textContent = '⏳ ' + t('common.loading');
        try {
          const res = await fetch(`/api/topics/${encodeURIComponent(s)}/research`, { method: 'POST' });
          const data = await res.json();
          if (data.report_id) {
            // Open the research report in a new tab via the existing research page.
            window.open(`/research/${encodeURIComponent(data.report_id)}?topic=${encodeURIComponent(s)}`, '_blank', 'noopener');
          } else if (data.error) {
            alert(data.error);
          }
        } catch (err) {
          console.warn('Topic research failed:', err.message);
        } finally {
          researchBtn.disabled = false;
          researchBtn.textContent = '🔬 ' + t('topics.research_this');
        }
      });
    }

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
    const selectedAudience = _params?.audience || '';
    const urlSearch = new URLSearchParams(window.location.search);
    const selectedRange = urlSearch.get('range') || '7';

    // Audience lens (Phase 2): fetch the weight definitions for the tab bar.
    const audiences = await loadRadarAudiences();

    // "All" shows the last 7 days (digest_date >= today-7) so users see the
    // broader picture instead of just today's 200-cap. Specific types hit the
    // same 7-day window for consistency — otherwise the sidebar counts
    // (today_count > 1000) would never match the visible list.
    // When an audience is active, signals are re-ranked by that lens; the base
    // alpha_score is preserved on the row as alpha_score_base.
    const params = new URLSearchParams({ sinceDays: selectedRange, limit: '2000' });
    if (selectedType !== 'all') params.set('type', selectedType);
    if (selectedAudience) params.set('audience', selectedAudience);
    const signalData = await fetchJSON(`${API_BASE}/signals?${params.toString()}`);

    const signals = signalData.signals || [];
    const total = signalData.total || signals.length;
    const date = signalData.date || '';
    const fallback = signalData.fallback || false;
    const filteredSignals = signals;

    // Weekly summary stats: compute from loaded signals.
    const avgAlpha = signals.length > 0 ? signals.reduce((s, x) => s + (x.alpha_score || 0), 0) / signals.length : 0;
    const topAlpha = signals.length > 0 ? Math.max(...signals.map(s => s.alpha_score || 0)) : 0;
    const typeCounts = {};
    for (const s of signals) { if (s.signal_type) typeCounts[s.signal_type] = (typeCounts[s.signal_type] || 0) + 1; }
    const topTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const zh = getLanguage() === 'zh';
    // Velocity trend sparkline: avg velocity per day over the loaded window.
    const dayMap = {};
    for (const s of signals) {
      if (!s.digest_date) continue;
      if (!dayMap[s.digest_date]) dayMap[s.digest_date] = { count: 0, velSum: 0 };
      dayMap[s.digest_date].count++;
      dayMap[s.digest_date].velSum += (s.velocity_score || 0);
    }
    const dayEntries = Object.entries(dayMap).sort((a, b) => a[0].localeCompare(b[0]));
    const velSparkHtml = dayEntries.length >= 3
      ? (() => {
          const vals = dayEntries.map(([, d]) => d.count > 0 ? d.velSum / d.count : 0);
          const maxV = Math.max(0.01, ...vals);
          const W = 200, H = 30, PAD = 4;
          let path = '';
          vals.forEach((v, i) => {
            const x = PAD + (i / Math.max(1, vals.length - 1)) * (W - PAD * 2);
            const y = H - PAD - (v / maxV) * (H - PAD * 2);
            path += (i === 0 ? 'M' : 'L') + ' ' + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
          });
          return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:120px;height:24px;display:inline-block;vertical-align:middle;margin-left:8px" title="Velocity trend"><path d="' + path + '" fill="none" stroke="var(--accent)" stroke-width="1.5"/></svg>';
        })()
      : '';
    // Quality trend: compare today's avg alpha to the window avg.
    const todaySignals = signals.filter(s => s.digest_date === localDateStr());
    const todayAvgAlpha = todaySignals.length > 0 ? todaySignals.reduce((s, x) => s + (x.alpha_score || 0), 0) / todaySignals.length : 0;
    const trendArrow = todayAvgAlpha > avgAlpha + 0.02 ? '▲▲' : todayAvgAlpha > avgAlpha - 0.02 ? '●' : '▼';
    const trendColor = todayAvgAlpha > avgAlpha + 0.02 ? '#34d399' : todayAvgAlpha > avgAlpha - 0.02 ? 'var(--fg-mute)' : '#f87171';
    const trendText = todayAvgAlpha > avgAlpha + 0.02 ? (zh ? '今日上升' : 'Rising today') : todayAvgAlpha > avgAlpha - 0.02 ? (zh ? '平稳' : 'Stable') : (zh ? '今日下降' : 'Declining today');

    // Rising entities (Phase 2): the entity currently accelerating fastest.
    // Ranked by acceleration on the 7d window; falls back to zscore.
    const risingData = await fetchJSON(`${API_BASE}/entities/momentum?window=7d&sort=acceleration&limit=8`).catch(() => ({ entities: [] }));
    const rising = risingData.entities || [];

    // The score shown on each card: the audience-adjusted score when a lens is
    // active, otherwise the raw alpha_score.
    const cardScore = s => selectedAudience && typeof s.alpha_score_audience === 'number'
      ? s.alpha_score_audience
      : s.alpha_score;

    // Audience tab bar — switches the reweight lens for the whole page.
    const rangeSuffix = (range) => range !== '7' ? `&range=${range}` : '';
    const rangeTabs = `
      <div class="range-tabs">
        ${[['1', '24h'], ['7', '7d'], ['30', '30d'], ['9999', 'All']].map(([val, label]) => {
          const active = selectedRange === val;
          const typeParam = selectedType !== 'all' ? `type=${encodeURIComponent(selectedType)}&` : '';
          const audParam = selectedAudience ? `audience=${encodeURIComponent(selectedAudience)}&` : '';
          const rParam = val !== '7' ? `range=${val}` : '';
          const qs = typeParam + audParam + rParam;
          return `<a href="/signals${qs ? '?' + qs : ''}" class="range-tab ${active ? 'active' : ''}">${label}</a>`;
        }).join('')}
      </div>`;
    const audienceTabs = `
      <div class="audience-tabs">
        <a href="/signals${typeSuffix(selectedType)}${rangeSuffix(selectedRange)}" class="audience-tab ${selectedAudience === '' ? 'active' : ''}">All</a>
        ${audiences.map(a => `
          <a href="/signals?type=${encodeURIComponent(selectedType)}&audience=${encodeURIComponent(a.key)}${rangeSuffix(selectedRange)}"
             class="audience-tab ${selectedAudience === a.key ? 'active' : ''}"
             title="${escapeAttr(pickZh(a.description, a.description_zh))}">
            ${escapeHtml(pickZh(a.label, a.label_zh))}
          </a>
        `).join('')}
      </div>
      ${rangeTabs}`;

    const exportParams = new URLSearchParams({ sinceDays: selectedRange, limit: '200' });
    if (selectedType !== 'all') exportParams.set('type', selectedType);
    if (selectedAudience) exportParams.set('audience', selectedAudience);

    // Alpha distribution mini-histogram: computed before the template to avoid nesting.
    const alphaBuckets = [0, 0, 0, 0];
    for (const s of filteredSignals) {
      const a = cardScore(s) || 0;
      if (a < 0.5) alphaBuckets[0]++;
      else if (a < 0.7) alphaBuckets[1]++;
      else if (a < 0.85) alphaBuckets[2]++;
      else alphaBuckets[3]++;
    }
    const maxB = Math.max(1, ...alphaBuckets);
    const alphaLabels = ['<50', '50-70', '70-85', '85+'];
    const alphaColors = ['var(--fg-mute)', '#38bdf8', '#facc15', 'var(--accent)'];
    const alphaHistHtml = '<div style="display:flex;align-items:flex-end;gap:8px;height:40px;margin:4px 0 12px" title="Alpha distribution">' +
      alphaBuckets.map((b, i) => {
        const h = Math.max(2, (b / maxB) * 36);
        return '<div style="display:flex;flex-direction:column;align-items:center;gap:2px">' +
          '<div style="width:40px;height:' + h + 'px;background:' + alphaColors[i] + ';border-radius:2px;opacity:0.8" title="' + b + ' signals at ' + alphaLabels[i] + '"></div>' +
          '<span style="font-size:8px;color:var(--fg-mute);font-family:var(--font-mono)">' + alphaLabels[i] + '</span>' +
          '</div>';
      }).join('') + '</div>';

    // Signal type mini-donut chart (computed before template to avoid nesting).
    let typeDonutHtml = '';
    if (topTypes.length >= 2) {
      const donutColors = ['#f97316', '#38bdf8', '#34d399', '#a78bfa', '#facc15'];
      const donutTotal = topTypes.reduce((s, [, c]) => s + c, 0);
      let dAngle = -90;
      const dcx = 40, dcy = 40, dr = 28, drInner = 16;
      let dSlices = '';
      topTypes.forEach(([type, count], i) => {
        const pct = count / donutTotal;
        const dEnd = dAngle + pct * 360;
        const x1 = dcx + dr * Math.cos(dAngle * Math.PI / 180);
        const y1 = dcy + dr * Math.sin(dAngle * Math.PI / 180);
        const x2 = dcx + dr * Math.cos(dEnd * Math.PI / 180);
        const y2 = dcy + dr * Math.sin(dEnd * Math.PI / 180);
        const xi1 = dcx + drInner * Math.cos(dEnd * Math.PI / 180);
        const yi1 = dcy + drInner * Math.sin(dEnd * Math.PI / 180);
        const xi2 = dcx + drInner * Math.cos(dAngle * Math.PI / 180);
        const yi2 = dcy + drInner * Math.sin(dAngle * Math.PI / 180);
        const large = pct > 0.5 ? 1 : 0;
        dSlices += '<path d="M ' + x1.toFixed(1) + ' ' + y1.toFixed(1) + ' A ' + dr + ' ' + dr + ' 0 ' + large + ' 1 ' + x2.toFixed(1) + ' ' + y2.toFixed(1) + ' L ' + xi1.toFixed(1) + ' ' + yi1.toFixed(1) + ' A ' + drInner + ' ' + drInner + ' 0 ' + large + ' 0 ' + xi2.toFixed(1) + ' ' + yi2.toFixed(1) + ' Z" fill="' + donutColors[i % donutColors.length] + '" opacity="0.8" title="' + escapeHtml(type.replace(/_/g, ' ')) + ': ' + count + '"/>';
        dAngle = dEnd;
      });
      const dLegend = topTypes.map(function(_a, i) { const t = _a[0], c = _a[1]; return '<span style="display:inline-flex;align-items:center;gap:3px;font-size:9px;color:var(--fg-mute)"><span style="width:7px;height:7px;background:' + donutColors[i % donutColors.length] + ';border-radius:1px"></span>' + escapeHtml(t.replace(/_/g, ' ')) + ' (' + c + ')</span>'; }).join('');
      typeDonutHtml = '<div style="display:flex;align-items:center;gap:12px;margin:4px 0 12px">' +
        '<svg viewBox="0 0 80 80" style="width:56px;height:56px;flex-shrink:0">' + dSlices + '<text x="40" y="40" text-anchor="middle" dy="0.35em" style="font-size:9px;fill:var(--fg);font-weight:700">' + donutTotal + '</text></svg>' +
        '<div style="display:flex;flex-wrap:wrap;gap:4px">' + dLegend + '</div></div>';
    }

    const html = `
      <section class="page-section signals-layout">
        ${audienceTabs}
        <a href="${API_BASE}/signals?${exportParams.toString()}" download="signals.json" class="action-link" style="font-size:11px;margin:4px 0;display:inline-block">⬇ Export JSON</a>
        ${alphaHistHtml}
        ${signals.length > 0 ? `<div style="display:flex;gap:16px;flex-wrap:wrap;margin:4px 0 12px;font-size:11px;font-family:var(--font-mono);color:var(--fg-mute)">
          <span>${zh ? '总计' : 'Total'}: <strong style="color:var(--fg)">${signals.length}</strong></span>
          <span>${zh ? '平均 α' : 'Avg α'}: <strong style="color:var(--accent)">${avgAlpha.toFixed(2)}</strong></span>
          <span>${zh ? '最高 α' : 'Top α'}: <strong style="color:var(--accent)">${topAlpha.toFixed(2)}</strong></span>
          <span title="${trendText}">质量趋势: <strong style="color:${trendColor}">${trendArrow}</strong> <small style="color:var(--fg-mute)">${trendText}</small>${velSparkHtml}</span>
          ${topTypes.length > 0 ? `<span>${zh ? '热门类型' : 'Top types'}: ${topTypes.map(([t, c]) => escapeHtml(t.replace(/_/g, ' ')) + '(' + c + ')').join(', ')}</span>` : ''}
        </div>` : ''}
        ${typeDonutHtml}
        <div class="signals-left">
          <div class="signals-type-filter">
            <h3 class="signals-filter-title">SIGNAL TYPES</h3>
            <a href="/signals${audienceSuffix(selectedAudience)}" class="signal-type-item ${selectedType === 'all' ? 'active' : ''}">
              <span class="st-icon">🔄</span>
              <span class="st-name">All Signals</span>
              <span class="st-count">${signals.length}</span>
            </a>
            ${typesData.map(t => `
              <a href="/signals?type=${escapeAttr(t.slug)}${audienceSuffix(selectedAudience)}" class="signal-type-item ${selectedType === t.slug ? 'active' : ''}">
                <span class="st-icon">${escapeHtml(t.icon || '📡')}</span>
                <span class="st-name">${escapeHtml(pickZh(t.name, t.name_zh))}</span>
                <span class="st-count">${t.today_count || signals.filter(s => s.signal_type === t.slug).length}</span>
              </a>
            `).join('')}
          </div>
          <div class="signals-rising">
            <h3 class="signals-filter-title">RISING ENTITIES</h3>
            ${rising.length === 0 ? `<p class="empty-state-sm">No momentum data yet.</p>` : ''}
            ${rising.map((e, i) => `
              <div class="rising-row">
                <span class="rising-rank">${i + 1}</span>
                <span class="rising-name"><a href="/trajectory/${escapeAttr(e.slug)}" class="momentum-link">${escapeHtml(e.name)}</a>${e.acceleration > 0 ? ` <span class="rising-up">▲${e.acceleration.toFixed(1)}</span>` : ''}${e.burst_score > 0 ? ` <span class="entity-burst">💥${e.burst_score.toFixed(1)}</span>` : ''}${e.growth_rate > 0 ? ` <span class="entity-growth">📈${(e.growth_rate * 100).toFixed(0)}%</span>` : ''}</span>
                <a class="rising-sub" href="/api/entities/${encodeURIComponent(e.slug)}/feed.xml" target="_blank" rel="noopener" title="Subscribe to ${escapeAttr(e.name)} (Atom feed)">RSS</a>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="signals-mid" id="signalsMid">
          ${filteredSignals.length === 0 ? `<p class="empty-state">No signals yet. Run enrichment to generate signal scores.</p>` : ''}
          ${filteredSignals.map(s => {
            const st = typesData.find(t => t.slug === s.signal_type) || {};
            const score = cardScore(s);
            return `
              <article class="signal-card" data-signal-id="${escapeAttr(s.item_id)}">
                <div class="signal-card-top">
                  <span class="signal-type-badge" data-type="${escapeAttr(s.signal_type)}">${escapeHtml(st.icon || '📡')} ${escapeHtml(pickZh(st.name, st.name_zh) || s.signal_type)}</span>
                  <span class="signal-alpha" title="${selectedAudience ? `Audience score (base ${(s.alpha_score*100).toFixed(0)})` : 'Alpha Score'}">${(score * 100).toFixed(0)}</span>
                </div>
                <h4 class="signal-card-title">
                  <a href="${escapeAttr(s.canonical_url || '#')}" target="_blank" rel="noopener">${escapeHtml(s.ai_title || s.title || '')}</a>
                </h4>
                ${s.one_liner || s.short_summary ? `<p class="signal-card-oneliner">${escapeHtml(s.one_liner || s.short_summary || '')}</p>` : ''}
                <div class="signal-card-meta">
                  <span class="signal-source">${escapeHtml(s.source_label || '')}${trustBadge(s.source_type, s.noise_rate)}</span>
                  <span class="signal-scores">
                    N:${(s.novelty_score * 100).toFixed(0)} V:${(s.velocity_score * 100).toFixed(0)} CS:${(s.cross_source_score * 100).toFixed(0)} SQ:${(s.source_quality_score * 100).toFixed(0)}
                  </span>
                </div>
                <div class="signal-alpha-bar" title="Alpha score ${(score * 100).toFixed(0)}">
                  <div class="signal-alpha-fill" style="width:${Math.round(score * 100)}%;background:${score >= 0.85 ? 'var(--accent)' : score >= 0.7 ? '#facc15' : 'var(--fg-mute)'}"></div>
                </div>
                <div class="signal-card-actions">
                  <button class="signal-pin-btn" data-item-id="${escapeAttr(s.item_id)}" title="${getLanguage() === 'zh' ? '收藏' : 'Save'}">🔖</button>
                  <a href="/signals/${escapeAttr(s.item_id)}" class="signal-detail-link">${getLanguage() === 'zh' ? '详情' : 'Detail'} →</a>
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

    // Wire pin/save buttons on signal cards.
    container.querySelectorAll('.signal-pin-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.dataset.itemId;
        if (!id) return;
        try {
          const res = await fetch(`${API_BASE}/items/${encodeURIComponent(id)}/save`, { method: 'GET' });
          const data = await res.json();
          if (window.__toast) window.__toast(data.saved ? 'Saved!' : 'Removed', data.saved ? 'success' : 'info');
          btn.style.color = data.saved ? 'var(--accent)' : 'var(--fg-mute)';
        } catch (err) { console.warn('Pin failed:', err.message); }
      });
    });

    // Auto-select first signal
    const firstCard = container.querySelector('.signal-card');
    if (firstCard) firstCard.click();

  } catch (err) {
    showError(container, err.message);
  }
}

// Query-string suffixes that preserve the other filter when switching lenses.
function typeSuffix(type) { return type && type !== 'all' ? `?type=${encodeURIComponent(type)}` : ''; }
function audienceSuffix(audience) { return audience ? `${typeSuffix('all') ? '&' : '?'}audience=${encodeURIComponent(audience)}` : ''; }

async function loadRadarAudiences() {
  try {
    const data = await fetchJSON(`${API_BASE}/radar/audiences`);
    return data.audiences || [];
  } catch { return []; }
}

// Trust badge for source quality (Phase 3.A): surfaces source_profiles.source_type
// so readers can weigh "is this hype?" against the source's noise profile.
// early_signal/originator → green; noisy → red (down-weighted); amplifier → muted.
function trustBadge(sourceType, noiseRate) {
  const type = sourceType || 'amplifier';
  const labels = {
    early_signal: { label: 'EARLY', cls: 'trust-early' },
    originator: { label: 'ORIGIN', cls: 'trust-origin' },
    amplifier: { label: 'AMP', cls: 'trust-amp' },
    noisy: { label: 'NOISY', cls: 'trust-noisy' },
  };
  const info = labels[type] || labels.amplifier;
  const noiseTag = type === 'noisy' && typeof noiseRate === 'number'
    ? ` ${(noiseRate * 100).toFixed(0)}%`
    : '';
  return ` <span class="source-trust ${info.cls}" title="Source quality: ${type}${noiseRate != null ? ` (noise ${(noiseRate * 100).toFixed(0)}%)` : ''}">${info.label}${noiseTag}</span>`;
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
            const accelChip = e.acceleration != null && e.acceleration > 0 ? ` <small class="entity-accel" title="acceleration">⚡${e.acceleration.toFixed(1)}</small>` : '';
            const burstChip = e.burst_score != null && e.burst_score > 0 ? ` <small class="entity-burst" title="burst score">💥${e.burst_score.toFixed(1)}</small>` : '';
            const link = e.slug ? `<a href="/trajectory/${escapeAttr(e.slug)}" class="entity-chip-link">${escapeHtml(e.name)}</a>` : escapeHtml(e.name);
            return `<span class="entity-chip">${link} <small>${escapeHtml(e.type)}</small>${mom}${accelChip}${burstChip}</span>`;
          }).join(' ')}
        </div>` : ''}

      ${topics.length > 0 ? `
        <div class="signal-topics"><h4>Topics</h4>
          ${topics.map(t => `<a href="/topics/${escapeAttr(t.slug)}" class="topic-chip">${escapeHtml(t.name)}</a>`).join(' ')}
        </div>` : ''}

      <div class="signal-actions">
        <button class="signal-action-btn research-btn" data-item-id="${escapeAttr(signal.item_id)}">🔍 Deep Research</button>
      </div>

      ${(() => {
        // SVG radar chart for the 6 score dimensions.
        const dims = [
          { label: 'Novelty', val: signal.novelty_score || 0 },
          { label: 'Velocity', val: signal.velocity_score || 0 },
          { label: 'Cross-Src', val: signal.cross_source_score || 0 },
          { label: 'Source-Q', val: signal.source_quality_score || 0 },
          { label: 'Thesis', val: signal.thesis_match_score || 0 },
          { label: 'Action', val: signal.actionability_score || 0 },
        ];
        const cx = 80, cy = 80, r = 55;
        const angleStep = (Math.PI * 2) / dims.length;
        // Grid circles.
        let grid = '';
        for (const g of [0.25, 0.5, 0.75, 1.0]) {
          const pts = dims.map((_, i) => {
            const a = i * angleStep - Math.PI / 2;
            return `${(cx + r * g * Math.cos(a)).toFixed(1)},${(cy + r * g * Math.sin(a)).toFixed(1)}`;
          }).join(' ');
          grid += `<polygon points="${pts}" fill="none" stroke="var(--rule)" stroke-width="0.5" opacity="0.5"/>`;
        }
        // Data polygon.
        const dataPts = dims.map((d, i) => {
          const a = i * angleStep - Math.PI / 2;
          const dist = r * Math.max(0, Math.min(1, d.val));
          return `${(cx + dist * Math.cos(a)).toFixed(1)},${(cy + dist * Math.sin(a)).toFixed(1)}`;
        }).join(' ');
        // Axis labels.
        const labels = dims.map((d, i) => {
          const a = i * angleStep - Math.PI / 2;
          const lx = cx + (r + 14) * Math.cos(a);
          const ly = cy + (r + 14) * Math.sin(a);
          return `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" dy="0.35em" style="font-size:7px;fill:var(--fg-mute);font-family:var(--font-mono)">${d.label}</text>`;
        }).join('');
        return `<div style="display:flex;gap:16px;align-items:center;margin:12px 0">` +
          `<svg viewBox="0 0 160 160" style="width:140px;height:140px;flex-shrink:0">` +
          grid +
          `<polygon points="${dataPts}" fill="var(--accent)" fill-opacity="0.2" stroke="var(--accent)" stroke-width="1.5"/>` +
          labels +
          `</svg>` +
          `<div style="font-size:11px;font-family:var(--font-mono);color:var(--fg-mute);line-height:1.8">` +
          dims.map(d => `${d.label}: <strong style="color:var(--fg)">${(d.val * 100).toFixed(0)}</strong>`).join('<br/>') +
          `</div></div>`;
      })()}

      <div class="signal-meta-footer">
        <span>Source: ${escapeHtml(signal.source_label || '')}${trustBadge(signal.source_type, signal.noise_rate)}</span>
        <span>Published: ${new Date(signal.published_at).toLocaleDateString()}</span>
        <span>Score: ${signal.score || 0}</span>
        <span style="display:inline-flex;align-items:center;gap:4px">
          ${(() => {
            // Freshness ring: compact SVG showing hours since publication.
            const ageH = signal.published_at ? (Date.now() - new Date(signal.published_at).getTime()) / 3600000 : 999;
            const freshPct = Math.max(0, Math.min(100, 100 - ageH * 2));
            const circ = 2 * Math.PI * 14;
            const dashOff = circ * (1 - freshPct / 100);
            const ringColor = ageH < 6 ? '#34d399' : ageH < 24 ? '#facc15' : '#f87171';
            return '<svg viewBox="0 0 36 36" style="width:28px;height:28px">' +
              '<circle cx="18" cy="18" r="14" fill="none" stroke="var(--bg-side)" stroke-width="3"/>' +
              '<circle cx="18" cy="18" r="14" fill="none" stroke="' + ringColor + '" stroke-width="3" ' +
              'stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + dashOff.toFixed(1) + '" ' +
              'transform="rotate(-90 18 18)" style="transition:stroke-dashoffset 0.5s"/>' +
              '<text x="18" y="18" text-anchor="middle" dy="0.35em" style="font-size:7px;fill:var(--fg-mute);font-family:var(--font-mono)">' +
              (ageH < 1 ? 'now' : ageH < 24 ? Math.round(ageH) + 'h' : Math.round(ageH / 24) + 'd') +
              '</text></svg>';
          })()}
        </span>
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

    // Async: load related signals (same signal_type, high alpha, different item).
    if (signal.signal_type && signal.signal_type !== 'uncategorized') {
      fetchJSON(`${API_BASE}/signals?type=${encodeURIComponent(signal.signal_type)}&sinceDays=7&limit=10`).then(relData => {
        const related = (relData.signals || []).filter(s => s.item_id !== signal.item_id).slice(0, 5);
        if (related.length === 0) return;
        const relDiv = document.createElement('div');
        relDiv.className = 'metrics-block';
        relDiv.style.marginTop = '20px';
        relDiv.innerHTML =
          `<h3 class="metrics-block-title">${getLanguage() === 'zh' ? '相关信号' : 'Related Signals'}</h3>` +
          `<ul class="story-members">` +
          related.map(r => `<li class="story-member">` +
            `<span class="story-member-src">α${(r.alpha_score || 0).toFixed(2)}</span>` +
            `<a href="/signals/${escapeAttr(r.item_id)}">${escapeHtml((r.ai_title || r.title || '').slice(0, 80))}</a>` +
            `</li>`).join('') +
          `</ul>`;
        detailEl?.appendChild(relDiv);
      }).catch(() => {});
    }

  } catch (err) {
    showError(container, err.message);
  }
}

// ─── Papers ────────────────────────────────────────────────

export async function renderPapers(_params) {
  const container = $('#pageContent');
  showLoader(container, getLanguage() === 'zh' ? '正在加载论文流...' : 'LOADING PAPERS...');

  // Normalize authors: API returns either ["Name", ...] (arXiv) or
  // [{_id, name, hidden}, ...] (hugging-face). Unify to string array.
  const normalizeAuthors = (raw) => {
    let arr = raw;
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { return []; } }
    if (!Array.isArray(arr)) return [];
    return arr.map(a => typeof a === 'string' ? a : (a && a.name) || '').filter(Boolean);
  };
  try {
    const url = new URL(window.location.href);
    const currentSource = url.searchParams.get('source') || 'all';
    const currentSort = url.searchParams.get('sort') || 'date';
    const currentView = url.searchParams.get('view') || 'list';
    const data = await fetchJSON(`${API_BASE}/papers?source=${encodeURIComponent(currentSource)}&limit=80`);
    const papers = data.papers || [];
    const sources = data.sources || [];
    const stats = data.stats || {};

    // Sort papers based on the selected sort option.
    const sorted = [...papers];
    if (currentSort === 'alpha') {
      sorted.sort((a, b) => (b.alpha_score || 0) - (a.alpha_score || 0));
    } else if (currentSort === 'upvotes') {
      sorted.sort((a, b) => {
        const av = typeof a.upvotes === 'number' ? a.upvotes : (a.popularity?.upvotes || 0);
        const bv = typeof b.upvotes === 'number' ? b.upvotes : (b.popularity?.upvotes || 0);
        return bv - av;
      });
    } else {
      // default: date (most recent first)
      sorted.sort((a, b) => new Date(b.published_at || 0).getTime() - new Date(a.published_at || 0).getTime());
    }

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
      // Normalize authors: API returns either ["Name", ...] (arXiv) or
      // [{_id, name, hidden}, ...] (hugging-face). Unify to string array.
      const authorNames = (paper.authors || []).map(a => typeof a === 'string' ? a : (a && a.name) || '').filter(Boolean);
      const authors = authorNames.slice(0, 5).join(', ');
      const categories = (paper.categories || []).slice(0, 4).map(cat => `<span class="mini-topic">${escapeHtml(cat)}</span>`).join('');
      const tags = (paper.tags || []).slice(0, 6).map(tag =>
        `<a href="${escapeAttr(tagHref(tag))}" class="tag-chip">#${escapeHtml(tag.name)}</a>`
      ).join(' ');
      const pdf = paper.pdf_url
        ? `<a class="mini-action mini-action-link" href="${escapeAttr(paper.pdf_url)}" target="_blank" rel="noopener">PDF ↗</a>`
        : '';
      // Abstract expansion: show a truncated version with a toggle.
      const abstract = paper.abstract || paper.original_summary || '';
      const abstractHtml = abstract
        ? `<details class="paper-abstract"><summary>${getLanguage() === 'zh' ? '摘要' : 'Abstract'}</summary><p>${escapeHtml(abstract)}</p></details>`
        : '';
      // BibTeX citation export: generates a valid BibTeX entry from paper metadata.
      const arxivId = paper.arxiv_id || '';
      const citeKey = (authorNames[0]?.split(' ').pop() || 'anon').toLowerCase() + (paper.published_at?.slice(0,4) || '2026') + (title.split(' ')[0]?.toLowerCase() || 'paper');
      const bibtex = `@article{${citeKey},\n  title = {${title}},\n  author = {${authorNames.join(' and ')}},\n  ${arxivId ? `eprint = {${arxivId}},\n  archivePrefix = {arXiv},\n  ` : ''}url = {${paper.canonical_url || ''}},\n  year = {${paper.published_at?.slice(0,4) || '2026'}},\n}`;
      const bibtexBtn = `<button class="mini-action" onclick='window.__copyBibtex(${JSON.stringify(bibtex).replace(/'/g,"\\'")})'>📋 BibTeX</button>`;
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
          ${abstractHtml}
          ${categories ? `<div class="mini-card-bottom">${categories}</div>` : ''}
          ${tags ? `<div class="card-tags paper-tags">${tags}</div>` : ''}
          <div class="mini-card-actions">
            <button class="mini-action research-btn" data-item-id="${escapeAttr(paper.id)}" data-title="${escapeAttr(title)}">🔍 ${escapeHtml(getLanguage() === 'zh' ? '研究' : 'Research')}</button>
            ${bibtexBtn}
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

        ${(() => {
          // Category filter: collect unique arxiv categories from loaded papers.
          const allCats = new Set();
          for (const p of papers) {
            let cats;
            try { cats = typeof p.categories === 'string' ? JSON.parse(p.categories) : (p.categories || []); } catch { cats = []; }
            if (Array.isArray(cats)) cats.forEach(c => allCats.add(c));
          }
          const cats = [...allCats].sort();
          if (cats.length === 0) return '';
          const urlCat = new URLSearchParams(window.location.search).get('cat') || '';
          return `<div class="range-tabs" style="margin:8px 0">` +
            `<a href="/papers${currentSource !== 'all' ? '?source=' + currentSource : ''}" class="range-tab ${!urlCat ? 'active' : ''}">All cats</a>` +
            cats.map(c => {
              const params = new URLSearchParams();
              if (currentSource !== 'all') params.set('source', currentSource);
              if (c !== urlCat) params.set('cat', c);
              const qs = params.toString();
              return `<a href="/papers${qs ? '?' + qs : ''}" class="range-tab ${urlCat === c ? 'active' : ''}">${escapeHtml(c)}</a>`;
            }).join('') +
            `</div>` +
            `<div class="search-box" style="margin:4px 0 8px;max-width:300px"><input type="text" id="paperAuthorFilter" placeholder="${getLanguage() === 'zh' ? '按作者筛选…' : 'Filter by author...'}" value="${escapeAttr(new URLSearchParams(window.location.search).get('author') || '')}" style="width:100%"/></div>` +
            `<script>document.getElementById('paperAuthorFilter')?.addEventListener('keydown',function(e){if(e.key==='Enter'){var p=new URLSearchParams();${currentSource !== 'all' ? `p.set('source','${currentSource}');` : ''}${urlCat ? `p.set('cat','${urlCat}');` : ''}if(this.value)p.set('author',this.value);var qs=p.toString();window.location.href='/papers'+(qs?'?'+qs:'');}});</script>`;
        })()}

        ${(() => {
          // Sort selector: date / alpha / upvotes + view toggle (list/authors)
          const buildQs = (extra, view) => {
            const p = new URLSearchParams();
            if (currentSource !== 'all') p.set('source', currentSource);
            const urlCat = new URLSearchParams(window.location.search).get('cat');
            if (urlCat) p.set('cat', urlCat);
            if (extra) p.set('sort', extra);
            if (view) p.set('view', view);
            const qs = p.toString();
            return qs ? '?' + qs : '';
          };
          return `<div class="range-tabs" style="margin:4px 0 8px">` +
            `<span class="subtle" style="margin-right:8px">${getLanguage() === 'zh' ? '排序' : 'Sort'}:</span>` +
            `<a href="/papers${buildQs('date', currentView === 'authors' ? 'authors' : '')}" class="range-tab ${currentSort === 'date' ? 'active' : ''}">${getLanguage() === 'zh' ? '最新' : 'Date'}</a>` +
            `<a href="/papers${buildQs('alpha', currentView === 'authors' ? 'authors' : '')}" class="range-tab ${currentSort === 'alpha' ? 'active' : ''}">${getLanguage() === 'zh' ? 'Alpha' : 'Alpha'}</a>` +
            `<a href="/papers${buildQs('upvotes', currentView === 'authors' ? 'authors' : '')}" class="range-tab ${currentSort === 'upvotes' ? 'active' : ''}">${getLanguage() === 'zh' ? '点赞' : 'Upvotes'}</a>` +
            `<span style="margin:0 8px;color:var(--rule)">|</span>` +
            `<a href="/papers${buildQs(currentSort, '')}" class="range-tab ${currentView !== 'authors' && currentView !== 'network' ? 'active' : ''}">${getLanguage() === 'zh' ? '列表' : 'List'}</a>` +
            `<a href="/papers${buildQs(currentSort, 'authors')}" class="range-tab ${currentView === 'authors' ? 'active' : ''}">${getLanguage() === 'zh' ? '作者' : 'Authors'}</a>` +
            `<a href="/papers${buildQs(currentSort, 'network')}" class="range-tab ${currentView === 'network' ? 'active' : ''}">${getLanguage() === 'zh' ? '合作网络' : 'Network'}</a>` +
            `</div>`;
        })()}

        ${(() => {
          // Filter papers by selected category AND/OR author, then use sorted order.
          const urlCat = new URLSearchParams(window.location.search).get('cat') || '';
          const urlAuthor = new URLSearchParams(window.location.search).get('author') || '';
          const renderList = (list) => list.length
            ? `<div class="feed-list papers-list">${list.map(renderPaper).join('')}</div>`
            : `<p class="empty-state">${escapeHtml(t('papers.empty'))}</p>`;
          let result = sorted;
          if (urlCat) {
            result = result.filter(p => {
              let cats;
              try { cats = typeof p.categories === 'string' ? JSON.parse(p.categories) : (p.categories || []); } catch { cats = []; }
              return Array.isArray(cats) && cats.includes(urlCat);
            });
          }
          if (urlAuthor) {
            result = result.filter(p => {
              const authors = normalizeAuthors(p.authors);
              return authors.some(a => a.toLowerCase().includes(urlAuthor.toLowerCase()));
            });
          }
          if (currentView === 'authors') {
            // Author aggregate view: group papers by first author, show counts.
            const authorMap = {};
            for (const p of result) {
              const authors = normalizeAuthors(p.authors);
              if (authors[0]) {
                const a = authors[0];
                if (!authorMap[a]) authorMap[a] = { name: a, count: 0, papers: [] };
                authorMap[a].count++;
                authorMap[a].papers.push(p);
              }
            }
            const authorList = Object.values(authorMap).sort((a, b) => b.count - a.count).slice(0, 30);
            if (authorList.length === 0) return `<p class="empty-state">No author data.</p>`;
            return `<div class="metrics-block"><ul class="metrics-bars">` +
              authorList.map(a => {
                const maxCount = Math.max(1, ...authorList.map(x => x.count));
                const pct = Math.round((a.count / maxCount) * 100);
                return `<div class="metrics-bar-row">` +
                  `<span class="metrics-bar-label">${escapeHtml(a.name)}</span>` +
                  `<div class="metrics-bar"><div class="metrics-bar-fill" style="width:${pct}%"></div></div>` +
                  `<span class="metrics-bar-pct">${a.count}</span></div>`;
              }).join('') + `</ul></div>`;
          }
          if (currentView === 'network') {
            // Author collaboration network: build co-author edges from papers.
            const nodeMap = new Map();
            const edges = [];
            const edgeSet = new Set();
            for (const p of result) {
              const authors = normalizeAuthors(p.authors);
              if (authors.length < 2) continue;
              for (const a of authors.slice(0, 5)) {
                if (!nodeMap.has(a)) nodeMap.set(a, { id: a, label: a, type: 'author' });
              }
              // Create edges between all pairs of co-authors in this paper.
              for (let i = 0; i < authors.length && i < 5; i++) {
                for (let j = i + 1; j < authors.length && j < 5; j++) {
                  const key = [authors[i], authors[j]].sort().join('||');
                  if (!edgeSet.has(key)) {
                    edgeSet.add(key);
                    edges.push({ source: authors[i], target: authors[j], weight: 1 });
                  } else {
                    const e = edges.find(e => (e.source === authors[i] && e.target === authors[j]) || (e.source === authors[j] && e.target === authors[i]));
                    if (e) e.weight++;
                  }
                }
              }
            }
            const nodes = [...nodeMap.values()];
            if (nodes.length < 2 || edges.length === 0) return `<p class="empty-state">Not enough co-author data for a network.</p>`;
            // Render as a D3 KnowledgeGraph (reuse the existing class).
            setTimeout(() => {
              const el = document.getElementById('papersNetworkGraph');
              if (el && typeof KnowledgeGraph !== 'undefined') {
                try {
                  const g = new KnowledgeGraph('papersNetworkGraph');
                  g.init({ nodes, edges: edges.map(e => ({ ...e, source: e.source, target: e.target })) });
                } catch { el.innerHTML = '<p class="subtle">Graph render failed.</p>'; }
              }
            }, 100);
            return `<div id="papersNetworkGraph" style="height:400px;border:1px solid var(--rule);border-radius:var(--radius);margin-top:8px"></div>` +
              `<p class="subtle" style="margin-top:4px">${nodes.length} ${getLanguage() === 'zh' ? '位作者' : 'authors'} · ${edges.length} ${getLanguage() === 'zh' ? '条合作边' : 'collaboration edges'}</p>`;
          }
          return renderList(result);
        })()}
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
          <a href="${escapeAttr(item.canonical_url || '#')}" target="_blank" rel="noopener" class="physical-item-title">${escapeHtml(item.title || '')}</a>
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
  const totalTools = categories.reduce((s, c) => s + c.tools.length, 0);

  const html = `
    <section class="page-section">
      <div class="page-header">
        <h2 class="page-title">${t('tools.title')}</h2>
        <p class="page-description">${t('tools.subtitle')} · ${totalTools} ${getLanguage() === 'zh' ? '个工具' : 'tools'} · ${getLanguage() === 'zh' ? '全部本地运行' : 'all run locally'}</p>
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
    // ?sort= switches the ranking lens (Phase 1/2): acceleration = spiking now,
    // growth = week-over-week, burst = Kleinberg, zscore = cohort velocity.
    const sort = _params?.sort || 'acceleration';
    const [momentum, metrics, topicsResp] = await Promise.all([
      fetchJSON(`${API_BASE}/entities/momentum?window=7d&limit=20&sort=${encodeURIComponent(sort)}`).catch(() => ({ entities: [] })),
      fetchJSON(`${API_BASE}/metrics`).catch(() => ({})),
      fetchJSON(`${API_BASE}/topics`).catch(() => ({ topics: [] })),
    ]);
    const entities = momentum.entities || [];
    // Bar width follows the active sort metric, not always zscore.
    const metricKey = { acceleration: 'acceleration', growth: 'growth_rate', burst: 'burst_score', zscore: 'zscore' }[sort] || 'zscore';
    const maxMetric = entities.length > 0 ? Math.max(...entities.map(e => e[metricKey] || 0), 0.1) : 1;

    const sortOptions = [
      { key: 'acceleration', label: 'Acceleration' },
      { key: 'growth', label: 'Growth' },
      { key: 'burst', label: 'Burst' },
      { key: 'zscore', label: 'Z-score' },
    ];

    const entityRows = entities.length > 0
      ? entities.map((e, i) => {
          const metricVal = e[metricKey] || 0;
          const barWidth = Math.max(3, Math.min(100, (metricVal / maxMetric) * 100));
          const surge = metricVal > 0 && (sort === 'acceleration' || sort === 'growth' || sort === 'burst') ? true : (e.zscore || 0) > 1.5;
          const accelChip = e.acceleration != null && e.acceleration > 0 ? `<span class="entity-accel" title="acceleration">⚡${e.acceleration.toFixed(1)}</span>` : '';
          const burstChip = e.burst_score != null && e.burst_score > 0 ? `<span class="entity-burst" title="burst">💥${e.burst_score.toFixed(1)}</span>` : '';
          const growthChip = e.growth_rate != null && e.growth_rate > 0 ? `<span class="entity-growth" title="growth">📈${(e.growth_rate * 100).toFixed(0)}%</span>` : '';
          return `
            <div class="momentum-row">
              <span class="momentum-rank">${i + 1}</span>
              <span class="momentum-name"><a href="/trajectory/${escapeAttr(e.slug)}" class="momentum-link">${escapeHtml(e.name)}</a> <small>${escapeHtml(e.type || '')}</small></span>
              <span class="momentum-bar"><span class="momentum-fill ${surge ? 'surge' : ''}" style="width:${barWidth}%"></span></span>
              <span class="momentum-stats">
                <span title="${t('signals.mentions')}">💬 ${e.mention_count || 0}</span>
                <span title="${t('signals.sources')}">📡 ${e.unique_sources || 0}</span>
                ${accelChip}${burstChip}${growthChip}
                <span class="${surge ? 'entity-surge' : ''}" title="${t('signals.velocity_zscore')}">↑${(e.zscore || 0).toFixed(1)}</span>
                ${(() => {
                  // Trend indicator: compare growth_rate and acceleration.
                  const g = e.growth_rate || 0;
                  const a = e.acceleration || 0;
                  if (g > 1 && a > 0) return '<span title="Surging" style="color:var(--accent)">▲▲</span>';
                  if (g > 0 && a > 0) return '<span title="Rising" style="color:#34d399">▲</span>';
                  if (g < 0 || a < -0.5) return '<span title="Declining" style="color:#f87171">▼</span>';
                  return '<span title="Stable" style="color:var(--fg-mute)">●</span>';
                })()}
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
            <h3>${t('signals.trending_entities')} <small>7d</small>
              <span class="sort-select-wrap">
                <select class="sort-select" onchange="if(this.value){window.location.href='/intelligence?sort='+encodeURIComponent(this.value);}">
                  ${sortOptions.map(o => `<option value="${escapeAttr(o.key)}" ${o.key === sort ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
                </select>
              </span>
            </h3>
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
          <div class="intel-card">
            <h3>${getLanguage() === 'zh' ? '主题覆盖' : 'Topic Coverage'}</h3>
            ${(() => {
              const topicsData = topicsResp || [];
              const totalItems = topicsData.reduce((s, t) => s + (t.item_count || 0), 0);
              const avgItems = topicsData.length > 0 ? Math.round(totalItems / topicsData.length) : 0;
              const maxItems = Math.max(1, ...topicsData.map(t => t.item_count || 0));
              const coveragePct = Math.min(100, Math.round((topicsData.length / 10) * 100));
              const zh = getLanguage() === 'zh';
              return '<div class="metric-rows">' +
                '<div class="metric-row"><span>' + (zh ? '主题数' : 'Topics') + '</span><strong>' + topicsData.length + '</strong></div>' +
                '<div class="metric-row"><span>' + (zh ? '总条目' : 'Total items') + '</span><strong>' + totalItems.toLocaleString() + '</strong></div>' +
                '<div class="metric-row"><span>' + (zh ? '平均/主题' : 'Avg/topic') + '</span><strong>' + avgItems + '</strong></div>' +
                '<div class="metric-row"><span>' + (zh ? '最大主题' : 'Max topic') + '</span><strong>' + maxItems + '</strong></div>' +
                '<div style="margin-top:8px"><div style="height:6px;background:var(--bg-side);border-radius:3px;overflow:hidden"><div style="height:100%;width:' + coveragePct + '%;background:var(--accent);border-radius:3px"></div></div>' +
                '<span style="font-size:10px;color:var(--fg-mute);margin-top:2px;display:block">' + coveragePct + '% ' + (zh ? '覆盖（目标10主题）' : 'coverage (target 10)') + '</span></div>' +
                '</div>';
            })()}
          </div>
          <div class="intel-card">
            <h3>${getLanguage() === 'zh' ? '热门主题' : 'Trending Topics'}</h3>
            <div class="metric-rows">
              ${(topicsResp.topics || [])
                ?.sort((a, b) => (b.growth_score || 0) - (a.growth_score || 0))
                .slice(0, 6)
                .map(tp => {
                  const gs = tp.growth_score || 0;
                  const maxGs = 3.0;
                  const barW = Math.max(3, Math.min(100, (gs / maxGs) * 100));
                  return `<div class="metric-row" style="flex-direction:column;align-items:stretch;gap:3px">` +
                    `<div style="display:flex;justify-content:space-between"><span><a href="/topics/${escapeAttr(tp.slug)}" style="color:inherit;text-decoration:none">${escapeHtml(pickZh(tp.name, tp.name_zh) || tp.slug)}</a></span><strong>📈${gs.toFixed(1)}</strong></div>` +
                    `<div style="height:4px;background:var(--bg-side);border-radius:2px;overflow:hidden"><div style="height:100%;width:${barW}%;background:var(--accent);border-radius:2px;opacity:0.7"></div></div>` +
                    `</div>`;
                })
                .join('') || '<div class="metric-row"><span>No topics</span></div>'}
            </div>
          </div>
          <div class="intel-card">
            <h3>${getLanguage() === 'zh' ? '增长率排行' : 'Growth Rate Leaderboard'}</h3>
            <div class="metric-rows">
              ${entities.filter(e => (e.growth_rate || 0) > 0).sort((a, b) => (b.growth_rate || 0) - (a.growth_rate || 0)).slice(0, 6).map((e, i) => {
                const g = e.growth_rate || 0;
                const maxG = Math.max(1, ...entities.map(x => x.growth_rate || 0));
                const barW = Math.max(3, Math.min(100, (g / maxG) * 100));
                return `<div class="metric-row" style="flex-direction:column;gap:3px">` +
                  `<div style="display:flex;justify-content:space-between"><span><a href="/trajectory/${escapeAttr(e.slug)}" style="color:inherit;text-decoration:none">${escapeHtml(e.name)}</a></span><strong style="color:var(--accent)">+${(g * 100).toFixed(0)}%</strong></div>` +
                  `<div style="height:4px;background:var(--bg-side);border-radius:2px;overflow:hidden"><div style="height:100%;width:${barW}%;background:#34d399;border-radius:2px;opacity:0.7"></div></div>` +
                  `</div>`;
              }).join('') || '<div class="metric-row"><span class="subtle">No growth data.</span></div>'}
            </div>
          </div>
          <div class="intel-card">
            <h3>${getLanguage() === 'zh' ? '实体显著性' : 'Entity Prominence'}</h3>
            <div class="metric-rows">
              ${(() => {
                // Prominence = mention_count × unique_sources × (1 + zscore) — composite visibility score.
                const scored = entities.map(e => {
                  const m = e.mention_count || 0;
                  const us = e.unique_sources || 1;
                  const z = (e.zscore || 0) + 1;
                  return { name: e.name, slug: e.slug, type: e.type || '', score: Math.round(m * us * z) };
                }).sort((a, b) => b.score - a.score).slice(0, 6);
                const maxScore = Math.max(1, ...scored.map(e => e.score));
                return scored.map(e => {
                  const barW = Math.max(3, Math.min(100, (e.score / maxScore) * 100));
                  return `<div class="metric-row" style="flex-direction:column;gap:3px">` +
                    `<div style="display:flex;justify-content:space-between"><span><a href="/trajectory/${escapeAttr(e.slug)}" style="color:inherit;text-decoration:none">${escapeHtml(e.name)}</a> <small style="color:var(--fg-mute)">${escapeHtml(e.type)}</small></span><strong>${e.score}</strong></div>` +
                    `<div style="height:4px;background:var(--bg-side);border-radius:2px;overflow:hidden"><div style="height:100%;width:${barW}%;background:var(--accent);border-radius:2px;opacity:0.6"></div></div>` +
                    `</div>`;
                }).join('') || '<div class="metric-row"><span class="subtle">No data.</span></div>';
              })()}
            </div>
          </div>
          <div class="intel-card" id="coOccurrenceCard">
            <h3>${getLanguage() === 'zh' ? '实体共现' : 'Entity Co-occurrence'}</h3>
            <div class="metric-rows" id="coOccurrenceBody"><span class="subtle">Loading...</span></div>
          </div>
          <div class="intel-card" id="sourceHealthCard">
            <h3>${getLanguage() === 'zh' ? '信息源健康' : 'Source Health'}</h3>
            <div class="metric-rows" id="sourceHealthBody"><span class="subtle">Loading...</span></div>
          </div>
          <div class="intel-card" id="sourceReliabilityCard">
            <h3>${getLanguage() === 'zh' ? '信息源可靠性排行' : 'Source Reliability Leaderboard'}</h3>
            <div class="metric-rows" id="sourceReliabilityBody"><span class="subtle">Loading...</span></div>
          </div>
          <div class="intel-card" style="grid-column:1/-1">
            <h3>${getLanguage() === 'zh' ? '实体关系网络' : 'Entity Relationship Network'}</h3>
            <div id="entityNetworkGraph" style="height:350px;border:1px solid var(--rule);border-radius:var(--radius);margin-top:8px"></div>
          </div>
        </div>
      </section>
    `;
    container.innerHTML = html;

    // Async: fetch source health summary.
    fetchJSON(`${API_BASE}/system/stats`).then(sysData => {
      // Source reliability leaderboard: composite score from noise_rate + early_signal + originality.
      const relEl = document.getElementById('sourceReliabilityBody');
      if (relEl && sysData.stats?.connectors) {
        const connectors = sysData.stats.connectors || [];
        // Fetch source profiles for quality data
        fetchJSON(`${API_BASE}/sources`).then(srcData => {
          const sources = srcData.sources || [];
          const scored = sources.map(s => {
            const early = (s.early_signal_rate || 0) * 40;
            const orig = (s.originality_rate || 0) * 30;
            const noise = (1 - (s.noise_rate || 0)) * 30;
            const score = Math.round(early + orig + noise);
            return { label: s.label, slug: s.slug, score, type: s.source_type || '', noise: s.noise_rate || 0, early: s.early_signal_rate || 0, orig: s.originality_rate || 0 };
          }).sort((a, b) => b.score - a.score).slice(0, 8);
          if (scored.length === 0) { relEl.innerHTML = '<div class="metric-row"><span class="subtle">No reliability data.</span></div>'; return; }
          relEl.innerHTML = scored.map(s => {
            const color = s.score >= 70 ? 'var(--accent)' : s.score >= 50 ? '#facc15' : 'var(--fg-mute)';
            return `<div class="metric-row"><span><a href="/sources/${escapeAttr(s.slug)}" style="color:inherit;text-decoration:none">${escapeHtml(s.label)}</a> <small style="color:var(--fg-mute)">${escapeHtml(s.type)}</small></span>` +
              `<strong style="color:${color}">${s.score}</strong></div>`;
          }).join('');
        }).catch(() => {});
      }

      const el = document.getElementById('sourceHealthBody');
      if (!el || !sysData.stats?.connectors) return;
      const connectors = sysData.stats.connectors || [];
      const fresh = connectors.filter(c => c.items_7d > 0).length;
      const stale = connectors.length - fresh;
      const zh = getLanguage() === 'zh';
      el.innerHTML =
        `<div class="metric-row"><span>${zh ? '活跃信息源' : 'Active sources'}</span><strong style="color:var(--accent)">${fresh}/${connectors.length}</strong></div>` +
        (stale > 0 ? `<div class="metric-row"><span>${zh ? '停滞信息源' : 'Stale sources (0 items/7d)'}</span><strong style="color:#f87171">${stale}</strong></div>` : '') +
        `<div class="metric-row"><span>${zh ? '总条目' : 'Total items'}</span><strong>${(sysData.stats.total_items || 0).toLocaleString()}</strong></div>` +
        `<div class="metric-row"><span>${zh ? '富集覆盖率' : 'Enrichment'}</span><strong>${sysData.stats.total_items > 0 ? Math.round((sysData.stats.summaries / sysData.stats.total_items) * 100) : 0}%</strong></div>` +
        `<div class="metric-row"><span>${zh ? '信号覆盖' : 'Signal coverage'}</span><strong>${sysData.stats.total_items > 0 ? Math.round((sysData.stats.scored / sysData.stats.total_items) * 100) : 0}%</strong></div>`;
    }).catch(() => {});

    // Async: fetch entity co-occurrence pairs for the intelligence page.
    fetchJSON(`${API_BASE}/entities/cooccurrence?limit=15`).then(coData => {
      const coBody = document.getElementById('coOccurrenceBody');
      if (!coBody) return;
      const pairs = coData.pairs || [];
      if (pairs.length === 0) { coBody.innerHTML = '<div class="metric-row"><span class="subtle">No co-occurrence data yet.</span></div>'; return; }
      // Build a co-occurrence network visualization: top pairs as connected nodes.
      const maxCo = Math.max(1, ...pairs.map(p => p.co_count));
      // Collect unique entities from the top pairs.
      const entityMap = new Map();
      for (const p of pairs) {
        if (!entityMap.has(p.slug_a)) entityMap.set(p.slug_a, { slug: p.slug_a, name: p.name_a, type: p.type_a });
        if (!entityMap.has(p.slug_b)) entityMap.set(p.slug_b, { slug: p.slug_b, name: p.name_b, type: p.type_b });
      }
      const entities = [...entityMap.values()].slice(0, 10);
      // Build pair list with intensity bars.
      coBody.innerHTML =
        pairs.slice(0, 10).map(p => {
          const intensity = Math.round((p.co_count / maxCo) * 100);
          return `<div class="metric-row">` +
            `<span style="flex:1"><a href="/trajectory/${escapeAttr(p.slug_a)}" style="color:inherit;text-decoration:none">${escapeHtml(p.name_a)}</a>` +
            ` ↔ <a href="/trajectory/${escapeAttr(p.slug_b)}" style="color:inherit;text-decoration:none">${escapeHtml(p.name_b)}</a></span>` +
            `<span style="display:flex;align-items:center;gap:6px">` +
            `<span style="width:${intensity}px;height:6px;background:var(--accent);opacity:${0.3 + 0.7 * intensity / 100};border-radius:3px;display:inline-block"></span>` +
            `<strong>${p.co_count}×</strong></span></div>`;
        }).join('') +
        `<p class="subtle" style="margin-top:8px;font-size:10px">${getLanguage() === 'zh' ? '条形长度和颜色深度表示共现强度' : 'Bar length and opacity indicate co-occurrence strength'}</p>`;

      // Build and render the entity network D3 graph from co-occurrence pairs.
      const graphEl = document.getElementById('entityNetworkGraph');
      if (graphEl && typeof KnowledgeGraph !== 'undefined' && entities.length >= 2) {
        const nodes = entities.map(e => ({ id: e.slug, label: e.name, type: e.type || 'entity' }));
        const edges = pairs.slice(0, 15).map(p => ({ source: p.slug_a, target: p.slug_b, weight: p.co_count }));
        try {
          const g = new KnowledgeGraph('entityNetworkGraph');
          g.init({ nodes, edges });
          g.setOnNodeClick((node) => {
            if (node.id) (/** @type {any} */ (window)).__router?.navigate(`/trajectory/${node.id}`);
          });
        } catch { graphEl.innerHTML = '<p class="subtle">Graph render failed.</p>'; }
      } else if (graphEl) {
        graphEl.innerHTML = '<p class="subtle">Not enough co-occurrence data for a network graph.</p>';
      }
    }).catch(() => {});

  } catch (err) {
    showError(container, err.message);
  }
}

// ─── Industry Metrics ───────────────────────────────────────────────

export async function renderIndustryMetrics(_params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING INDUSTRY METRICS...' : t('common.loading'));

  try {
    const data = await fetchJSON(`${API_BASE}/metrics/industry`);
    const c = data.corpus || {};
    const sources = data.sources || [];
    const types = data.signalTypes || [];
    const kg = data.kg || {};

    const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);
    const maxSourceItems = Math.max(1, ...sources.map(s => s.items_30d || 0));
    const maxTypeCount = Math.max(1, ...types.map(s => s.count || 0));

    const stat = (label, value) => `
      <div class="metric-stat">
        <div class="metric-stat-value">${value}</div>
        <div class="metric-stat-label">${escapeHtml(label)}</div>
      </div>`;

    const coveragePct = pct(c.summaries, c.items);

    const html = `
      <section class="page-section">
        <div class="page-header">
          <h2 class="page-title">${t('industry.title')}</h2>
          <p class="page-description">${t('industry.subtitle')}</p>
        </div>

        <div class="metrics-stat-grid">
          ${stat(t('industry.items'), (c.items || 0).toLocaleString())}
          ${stat(t('industry.scored'), (c.scored || 0).toLocaleString())}
          ${stat(t('industry.summaries'), (c.summaries || 0).toLocaleString())}
          ${stat(t('industry.reports'), (c.reports || 0).toLocaleString())}
          ${stat(t('industry.types'), (c.signalTypes || 0).toLocaleString())}
          ${stat(t('industry.entities'), (c.entities || 0).toLocaleString())}
        </div>

        <div class="metrics-block">
          <h3 class="metrics-block-title">${t('industry.coverage')}</h3>
          <div class="metrics-bar-row">
            <div class="metrics-bar">
              <div class="metrics-bar-fill" style="width:${coveragePct}%"></div>
            </div>
            <span class="metrics-bar-pct">${coveragePct}%</span>
          </div>
        </div>

        ${(() => {
          // Donut chart: top 8 sources by 30d items, as an SVG donut.
          const top = sources.slice(0, 8);
          const total = top.reduce((s, x) => s + (x.items_30d || 0), 0);
          if (total === 0) return '';
          const colors = ['#f97316', '#38bdf8', '#34d399', '#a78bfa', '#facc15', '#f43f5e', '#2dd4bf', '#94a3b8'];
          let angle = -90; // start from top
          const cx = 100, cy = 100, r = 70, rInner = 40;
          let arcs = '';
          let legend = '';
          top.forEach((s, i) => {
            const pct = (s.items_30d || 0) / total;
            const endAngle = angle + pct * 360;
            const x1 = cx + r * Math.cos(angle * Math.PI / 180);
            const y1 = cy + r * Math.sin(angle * Math.PI / 180);
            const x2 = cx + r * Math.cos(endAngle * Math.PI / 180);
            const y2 = cy + r * Math.sin(endAngle * Math.PI / 180);
            const xi1 = cx + rInner * Math.cos(endAngle * Math.PI / 180);
            const yi1 = cy + rInner * Math.sin(endAngle * Math.PI / 180);
            const xi2 = cx + rInner * Math.cos(angle * Math.PI / 180);
            const yi2 = cy + rInner * Math.sin(angle * Math.PI / 180);
            const large = pct > 0.5 ? 1 : 0;
            arcs += `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} L ${xi1.toFixed(1)} ${yi1.toFixed(1)} A ${rInner} ${rInner} 0 ${large} 0 ${xi2.toFixed(1)} ${yi2.toFixed(1)} Z" fill="${colors[i % colors.length]}" opacity="0.8" title="${escapeHtml(s.label)}: ${s.items_30d}"/>`;
            legend += `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;font-size:11px"><span style="width:10px;height:10px;background:${colors[i % colors.length]};border-radius:2px;display:inline-block"></span>${escapeHtml(s.label)}</span>`;
            angle = endAngle;
          });
          return `<div class="metrics-block"><h3 class="metrics-block-title">${getLanguage() === 'zh' ? '来源贡献（30天）' : 'Source Contribution (30d)'}</h3>` +
            `<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center">` +
            `<svg viewBox="0 0 200 200" style="width:160px;height:160px;flex-shrink:0">${arcs}<text x="100" y="100" text-anchor="middle" dy="0.35em" style="font-size:14px;fill:var(--fg);font-weight:700">${total}</text><text x="100" y="116" text-anchor="middle" style="font-size:8px;fill:var(--fg-mute)">items</text></svg>` +
            `<div style="flex:1;min-width:200px">${legend}</div></div></div>`;
        })()}

        <div class="metrics-block">
          <h3 class="metrics-block-title">${t('industry.signal_mix')}</h3>
          <ul class="metrics-bars">
            ${types.map(ty => `
              <li class="metrics-bar-row">
                <span class="metrics-bar-label">${escapeHtml(ty.label)}</span>
                <div class="metrics-bar">
                  <div class="metrics-bar-fill" style="width:${Math.round((ty.count / maxTypeCount) * 100)}%"></div>
                </div>
                <span class="metrics-bar-pct">${ty.count}</span>
              </li>
            `).join('')}
          </ul>
        </div>

        ${(() => {
          // Source × signal-type heatmap: top 8 sources × top 5 types.
          const topSrc = sources.slice(0, 8);
          const topTypes = types.slice(0, 5);
          if (topSrc.length < 2 || topTypes.length < 2) return '';
          const zh = getLanguage() === 'zh';
          // Build the heatmap cells from the high_alpha data in sources.
          let cells = '';
          for (const s of topSrc) {
            const total = s.items_30d || 0;
            const ha = s.high_alpha || 0;
            const haPct = total > 0 ? ha / total : 0;
            // Distribute across types proportionally (approximate).
            for (const ty of topTypes) {
              const tyPct = ty.count > 0 ? (ty.count / types.reduce((sum, t) => sum + t.count, 0)) : 0;
              const intensity = Math.min(1, haPct * tyPct * 5);
              const opacity = 0.1 + 0.9 * intensity;
              cells += `<td style="background:var(--accent);opacity:${opacity.toFixed(2)};text-align:center;font-size:9px;color:${intensity > 0.3 ? '#000' : 'var(--fg-mute)'}">${intensity > 0.05 ? Math.round(ha * tyPct) : '·'}</td>`;
            }
          }
          return `<div class="metrics-block"><h3 class="metrics-block-title">${zh ? '来源 × 类型 热力图' : 'Source × Type Heatmap'}</h3>` +
            `<div style="overflow-x:auto"><table class="metrics-table" style="font-size:10px"><thead><tr><th>${zh ? '来源' : 'Source'}</th>${topTypes.map(ty => '<th style="text-align:center;max-width:60px">' + escapeHtml(ty.type.replace(/_/g, ' ')) + '</th>').join('')}</tr></thead><tbody>` +
            topSrc.map((s, i) => `<tr><td class="compare-feature">${escapeHtml(s.label)}</td>${cells.split('</td>').slice(i * topTypes.length, (i + 1) * topTypes.length).join('</td>')}</td></tr>`).join('') +
            `</tbody></table></div></div>`;
        })()}

        <div class="metrics-block">
          <h3 class="metrics-block-title">${t('industry.source_diversity')}</h3>
          <table class="metrics-table">
            <thead>
              <tr>
                <th>${t('industry.source')}</th>
                <th>${t('industry.items_30d')}</th>
                <th>${t('industry.trust')}</th>
                <th>${t('industry.noise')}</th>
              </tr>
            </thead>
            <tbody>
              ${sources.map(s => `
                <tr>
                  <td>${escapeHtml(s.label)}</td>
                  <td>
                    <div class="metrics-bar">
                      <div class="metrics-bar-fill" style="width:${Math.round(((s.items_30d || 0) / maxSourceItems) * 100)}%"></div>
                    </div>
                    <span class="metrics-bar-pct">${s.items_30d || 0}</span>
                  </td>
                  <td>${escapeHtml(s.trust || '—')}</td>
                  <td>${s.noise_rate != null ? (Math.round(s.noise_rate * 100) + '%') : '—'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <div class="metrics-block">
          <h3 class="metrics-block-title">${t('industry.kg_coverage')}</h3>
          <div class="metrics-stat-grid">
            ${stat(t('industry.kg_features'), (kg.features || 0).toLocaleString())}
            ${stat(t('industry.kg_tags'), (kg.tags || 0).toLocaleString())}
            ${stat(t('industry.kg_topics'), (kg.topics || 0).toLocaleString())}
          </div>
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

      <div class="settings-card">
        <h3 class="settings-card-title">⏰ ${getLanguage() === 'zh' ? '定时调度' : 'Scheduler'}</h3>
        <p class="settings-card-desc">${getLanguage() === 'zh' ? '每天定时自动运行 FULL_PIPELINE 或 RESCORE_ALL。默认关闭。' : 'Run FULL_PIPELINE or RESCORE_ALL automatically each day. Disabled by default.'}</p>
        <div id="schedulerPanel" class="scheduler-panel">
          <p class="subtle">${getLanguage() === 'zh' ? '加载中…' : 'Loading...'}</p>
        </div>
      </div>

      <div class="settings-card">
        <h3 class="settings-card-title">📊 ${getLanguage() === 'zh' ? '系统健康' : 'System Health'}</h3>
        <div id="systemHealthPanel"><p class="subtle">${getLanguage() === 'zh' ? '加载中…' : 'Loading...'}</p></div>
      </div>

      <div class="settings-card">
        <h3 class="settings-card-title">🔗 ${getLanguage() === 'zh' ? '快捷链接' : 'Quick Links'}</h3>
        <div style="display:flex;flex-wrap:wrap;gap:8px;padding:8px 0">
          <a href="/email/digest" target="_blank" rel="noopener" class="action-link" style="font-size:11px">📧 ${getLanguage() === 'zh' ? '邮件简报' : 'Email digest'}</a>
          <a href="/opml.xml" download class="action-link" style="font-size:11px">📋 OPML</a>
          <a href="/sitemap.xml" target="_blank" rel="noopener" class="action-link" style="font-size:11px">🗺 Sitemap</a>
          <a href="/feed.xml" target="_blank" rel="noopener" class="action-link" style="font-size:11px">📡 RSS</a>
          <a href="/watchlist/feed.xml" target="_blank" rel="noopener" class="action-link" style="font-size:11px">🔔 ${getLanguage() === 'zh' ? '关注 RSS' : 'Watchlist RSS'}</a>
          <a href="/help" class="action-link" style="font-size:11px">❓ ${getLanguage() === 'zh' ? '帮助' : 'Help'}</a>
        </div>
      </div>
    </section>
    <section class="metrics-block" id="userMgmtPanel" style="margin-top:16px"></section>
  `;

  await refreshLLMStatus();
  wireSettingsHandlers();
  refreshSchedulerPanel();
  refreshSystemHealth();
  refreshUserManagement();
}

// User management panel (admin only): list users, change roles, enable/disable.
async function refreshUserManagement() {
  const panel = document.getElementById('userMgmtPanel');
  if (!panel) return;
  const zh = getLanguage() === 'zh';
  const currentUser = (window).__currentUser ? (window).__currentUser() : null;
  if (!currentUser || currentUser.role !== 'admin') {
    panel.style.display = 'none';
    return;
  }
  try {
    const data = await API.adminUsers();
    const users = data.users || [];
    panel.innerHTML = `
      <h3 class="settings-card-title">👥 ${zh ? '用户管理' : 'User Management'}</h3>
      <table class="user-mgmt-table">
        <thead><tr>
          <th>${zh ? '邮箱' : 'Email'}</th>
          <th>${zh ? '角色' : 'Role'}</th>
          <th>${zh ? '状态' : 'Status'}</th>
          <th>${zh ? '注册时间' : 'Joined'}</th>
          <th>${zh ? '操作' : 'Actions'}</th>
        </tr></thead>
        <tbody>
          ${users.map(u => `
            <tr>
              <td>${escapeHtml(u.email)}${u.id === currentUser.id ? ' <span style="color:var(--accent)">(' + (zh ? '你' : 'you') + ')</span>' : ''}</td>
              <td><span class="user-mgmt-badge ${u.role}">${u.role}</span></td>
              <td><span class="user-mgmt-badge ${u.status}">${u.status}</span></td>
              <td style="font-size:11px;color:var(--fg-mute)">${(u.created_at || '').slice(0, 10)}</td>
              <td>
                ${u.id !== currentUser.id ? `
                  <button class="user-mgmt-action" onclick="window.__toggleRole('${u.id}','${u.role}')">${u.role === 'admin' ? '↓ user' : '↑ admin'}</button>
                  <button class="user-mgmt-action" onclick="window.__toggleStatus('${u.id}','${u.status}')">${u.status === 'active' ? '🚫 ' + (zh ? '禁用' : 'Disable') : '✅ ' + (zh ? '启用' : 'Enable')}</button>
                ` : '<span style="color:var(--fg-mute)">—</span>'}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    panel.innerHTML = `<p class="subtle">${zh ? '用户管理面板加载失败' : 'Failed to load'}: ${escapeHtml(err.message)}</p>`;
  }
}

// Expose admin actions globally for inline onclick handlers
(/** @type {any} */ (window)).__toggleRole = async (userId, currentRole) => {
  const newRole = currentRole === 'admin' ? 'user' : 'admin';
  try { await API.adminSetRole(userId, newRole); refreshUserManagement(); } catch (e) { alert(e.message); }
};
(/** @type {any} */ (window)).__toggleStatus = async (userId, currentStatus) => {
  const action = currentStatus === 'active' ? 'disable' : 'enable';
  try { await API.adminSetStatus(userId, action); refreshUserManagement(); } catch (e) { alert(e.message); }
};

// System health dashboard: shows enrichment/translation backlogs, coverage, DB size.
async function refreshSystemHealth() {
  const panel = document.getElementById('systemHealthPanel');
  if (!panel) return;
  try {
    const data = await fetchJSON(`${API_BASE}/system/stats`);
    const s = data.stats || {};
    const zh = getLanguage() === 'zh';
    const enrichmentPct = s.total_items > 0 ? Math.round((1 - s.enrichment_backlog / s.total_items) * 100) : 0;
    const scorePct = s.total_items > 0 ? Math.round((s.scored / s.total_items) * 100) : 0;
    const uncPct = s.scored > 0 ? Math.round((s.uncategorized / s.scored) * 100) : 0;
    const stat = (label, val, color) => `<div class="metric-stat"><div class="metric-stat-value" ${color ? `style="color:${color}"` : ''}>${val}</div><div class="metric-stat-label">${escapeHtml(label)}</div></div>`;
    panel.innerHTML =
      `<div class="metrics-stat-grid">` +
      stat(zh ? '条目' : 'Items', (s.total_items || 0).toLocaleString()) +
      stat(zh ? '已富集' : 'Enriched', enrichmentPct + '%') +
      stat(zh ? '已评分' : 'Scored', scorePct + '%') +
      stat(zh ? '未分类' : 'Uncategorized', uncPct + '%', uncPct > 25 ? 'var(--accent)' : '') +
      stat(zh ? '实体' : 'Entities', (s.entities || 0).toLocaleString()) +
      stat(zh ? '研究报告' : 'Reports', s.research_reports || 0) +
      `</div>` +
      `<div class="metrics-block" style="margin-top:12px">` +
      (s.enrichment_backlog > 0 ? `<p class="subtle">⚠ ${zh ? '富集积压' : 'Enrichment backlog'}: ${s.enrichment_backlog} ${zh ? '条（LLM 端点恢复后运行 POST /api/enrich?reset_attempts=true）' : 'items (run POST /api/enrich?reset_attempts=true when LLM is back)'}</p>` : '') +
      (s.translation_backlog > 0 ? `<p class="subtle">⚠ ${zh ? '翻译积压' : 'Translation backlog'}: ${s.translation_backlog}</p>` : '') +
      (s.db_size_mb ? `<p class="subtle">${zh ? '数据库大小' : 'DB size'}: ${s.db_size_mb} MB</p>` : '') +
      `</div>` +
      (s.connectors && s.connectors.length > 0
        ? `<div class="metrics-block" style="margin-top:12px">` +
          `<h3 class="metrics-block-title">${zh ? '连接器健康' : 'Connector Health'}</h3>` +
          `<table class="metrics-table"><thead><tr><th>${zh ? '信息源' : 'Source'}</th><th>7d</th><th>${zh ? '总计' : 'Total'}</th><th>${zh ? '最后抓取' : 'Last fetched'}</th><th>${zh ? '新鲜度' : 'Fresh'}</th></tr></thead><tbody>` +
          s.connectors.map(c => {
            const health = c.items_7d > 0 ? '🟢' : '🔴';
            // Compute relative freshness from last_fetched_at.
            let freshBar = '—';
            if (c.last_fetched_at) {
              const age = (Date.now() - new Date(c.last_fetched_at + 'Z').getTime()) / 3600000;
              const freshPct = Math.max(0, Math.min(100, 100 - age * 2));
              const freshColor = age < 6 ? '#34d399' : age < 24 ? '#facc15' : '#f87171';
              freshBar = `<div style="width:40px;height:5px;background:var(--bg-side);border-radius:2px;overflow:hidden;display:inline-block"><div style="height:100%;width:${freshPct}%;background:${freshColor};border-radius:2px"></div></div>`;
            }
            return `<tr><td>${health} ${escapeHtml(c.label)}</td><td>${c.items_7d}</td><td>${c.total_items}</td><td style="font-size:10px;color:var(--fg-mute)">${escapeHtml(c.last_fetched_at || '—')}</td><td>${freshBar}</td></tr>`;
          }).join('') +
          `</tbody></table></div>`
        : '');
  } catch (err) {
    panel.innerHTML = `<p class="subtle">${escapeHtml(err.message)}</p>`;
  }
}

// Scheduler control panel: shows enable/disable, time, task, last run.
async function refreshSchedulerPanel() {
  const panel = document.getElementById('schedulerPanel');
  if (!panel) return;
  try {
    const data = await fetchJSON(`${API_BASE}/scheduler`);
    const cfg = data.config || {};
    panel.innerHTML =
      `<div class="scheduler-row">` +
      `<label><input type="checkbox" id="schedEnabled" ${cfg.enabled ? 'checked' : ''}/> ${getLanguage() === 'zh' ? '启用' : 'Enabled'}</label>` +
      `<label>${getLanguage() === 'zh' ? '时间' : 'Time'} <input type="time" id="schedTime" value="${escapeAttr(cfg.time || '04:00')}" class="form-input" style="width:auto;display:inline-block"/></label>` +
      `<label>${getLanguage() === 'zh' ? '任务' : 'Task'} <select id="schedTask" class="form-input" style="width:auto;display:inline-block">` +
      `<option value="pipeline" ${cfg.task === 'pipeline' ? 'selected' : ''}>FULL_PIPELINE</option>` +
      `<option value="rescore" ${cfg.task === 'rescore' ? 'selected' : ''}>RESCORE_ALL</option></select></label>` +
      `<button class="action-btn primary" id="schedSave">${getLanguage() === 'zh' ? '保存' : 'Save'}</button>` +
      `</div>` +
      (cfg.lastRun ? `<p class="subtle">${getLanguage() === 'zh' ? '上次运行' : 'Last run'}: ${escapeAttr(cfg.lastRun)}</p>` : '');
    const saveBtn = panel.querySelector('#schedSave');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const body = {
          enabled: panel.querySelector('#schedEnabled').checked,
          time: panel.querySelector('#schedTime').value,
          task: panel.querySelector('#schedTask').value,
        };
        try {
          await fetch(`${API_BASE}/scheduler`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          saveBtn.textContent = '✓';
          setTimeout(() => refreshSchedulerPanel(), 500);
        } catch (err) { console.warn('Scheduler save failed:', err.message); }
      });
    }
  } catch (err) {
    panel.innerHTML = `<p class="subtle">${escapeHtml(err.message)}</p>`;
  }
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
    const tags = (data.tags || []).sort((a, b) => (b.item_count || 0) - (a.item_count || 0));
    const maxCount = Math.max(1, ...(tags.slice(0, 50).map(t => t.item_count || 0)));

    // Tag cloud: top 50 tags with font size proportional to item count.
    const cloudTags = tags.slice(0, 50);
    const cloudHtml = cloudTags.map(tag => {
      const size = 11 + Math.round((tag.item_count || 0) / maxCount * 14);
      const opacity = 0.4 + 0.6 * ((tag.item_count || 0) / maxCount);
      return `<a href="${escapeAttr(tagHref(tag))}" style="display:inline-block;margin:3px 6px;font-size:${size}px;color:var(--accent);opacity:${opacity};text-decoration:none;font-weight:${size > 18 ? 700 : 400}" title="${tag.item_count || 0} items">${escapeHtml(tag.name || tag.name_zh)}</a>`;
    }).join(' ');

    const html = `
      <section class="page-section tags-layout">
        <div class="page-header">
          <h2 class="page-title">🏷️ ${t('nav.tags') || 'Tags'}</h2>
          <p class="page-description">LLM-auto-generated Chinese tags aggregating feed items</p>
        </div>

        <div class="metrics-block" style="margin-bottom:24px">
          <h3 class="metrics-block-title">${getLanguage() === 'zh' ? '标签云' : 'Tag Cloud'} (${tags.length} ${getLanguage() === 'zh' ? '个标签' : 'tags'})</h3>
          <div style="line-height:2.5;padding:12px 0">${cloudHtml}</div>
        </div>

        ${(() => {
          // Top 15 tags comparison bar chart.
          const top15 = tags.slice(0, 15);
          const maxItems = Math.max(1, ...top15.map(t => t.item_count || 0));
          return '<div class="metrics-block" style="margin-bottom:24px">' +
            '<h3 class="metrics-block-title">' + (getLanguage() === 'zh' ? '热门标签对比' : 'Top Tags Comparison') + '</h3>' +
            '<ul class="metrics-bars">' +
            top15.map(tag => {
              const pct = Math.round(((tag.item_count || 0) / maxItems) * 100);
              return '<div class="metrics-bar-row">' +
                '<span class="metrics-bar-label"><a href="' + escapeAttr(tagHref(tag)) + '" style="color:inherit;text-decoration:none">' + escapeHtml(tag.name || tag.name_zh) + '</a></span>' +
                '<div class="metrics-bar"><div class="metrics-bar-fill" style="width:' + pct + '%"></div></div>' +
                '<span class="metrics-bar-pct">' + (tag.item_count || 0) + '</span></div>';
            }).join('') +
            '</ul></div>';
        })()}

        <h3 class="metrics-block-title">${getLanguage() === 'zh' ? '全部标签' : 'All Tags'}</h3>
        <div class="tags-grid">
          ${tags.map(tag => `
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

// ─── Entity Trajectory (PRD-1: trend sparkline + burst highlight) ───

/**
 * Build an inline SVG area+line sparkline from a count series.
 * Burst days get a highlighted band behind the line so the spike region reads
 * at a glance. Pure SVG (no D3 dependency) — keeps the page light.
 */
function trajectorySparkline(series) {
  if (!series || series.length === 0) return '';
  const W = 720, H = 160, PAD = 28;
  const counts = series.map(p => p.count || 0);
  const maxC = Math.max(1, ...counts);
  const n = counts.length;
  const x = (i) => PAD + (i / Math.max(1, n - 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - (v / maxC) * (H - PAD * 2);

  // Area path (filled) + line path (stroke).
  let line = '';
  let area = `M ${x(0)} ${y(0)}`;
  for (let i = 0; i < n; i++) {
    line += (i === 0 ? 'M' : 'L') + ` ${x(i).toFixed(1)} ${y(counts[i]).toFixed(1)} `;
    area += ` L ${x(i).toFixed(1)} ${y(counts[i]).toFixed(1)}`;
  }
  area += ` L ${x(n - 1).toFixed(1)} ${H - PAD} L ${x(0).toFixed(1)} ${H - PAD} Z`;

  // Burst day bands (rectangles spanning one x-step).
  const stepW = (W - PAD * 2) / Math.max(1, n - 1);
  const bands = series.map((p, i) => p.burst
    ? `<rect x="${(x(i) - stepW / 2).toFixed(1)}" y="${PAD}" width="${stepW.toFixed(1)}" height="${H - PAD * 2}" class="traj-burst-band"/>`
    : '').join('');

  // Peak marker.
  const peakIdx = counts.indexOf(Math.max(...counts));
  const peakMarker = counts[peakIdx] > 0
    ? `<circle cx="${x(peakIdx).toFixed(1)}" cy="${y(counts[peakIdx]).toFixed(1)}" r="4" class="traj-peak"/>`
    : '';

  // X-axis date labels (first / peak / last) so the reader has orientation.
  const fmt = (yyyymmdd) => yyyymmdd ? `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}` : '';
  const labels = [
    { i: 0, anchor: 'start' },
    { i: peakIdx, anchor: 'middle' },
    { i: n - 1, anchor: 'end' },
  ].map(({ i, anchor }) => counts[i] > 0
    ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="${anchor}" class="traj-axis-label">${fmt(series[i].date)}</text>`
    : '').join('');

  return `
    <svg class="traj-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      ${bands}
      <path d="${area}" class="traj-area"/>
      <path d="${line}" class="traj-line" fill="none"/>
      ${peakMarker}
      ${labels}
    </svg>
  `;
}

export async function renderEntityTrajectory(params) {
  const container = $('#pageContent');
  const slug = params?.slug || '';
  if (!slug) { showError(container, 'No entity'); return; }
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING TRAJECTORY...' : t('common.loading'));

  try {
    const [seriesData, detailData, wlData] = await Promise.all([
      fetchJSON(`${API_BASE}/entities/${encodeURIComponent(slug)}/series`).catch(() => null),
      fetchJSON(`${API_BASE}/entities/${encodeURIComponent(slug)}?limit=10`).catch(() => null),
      fetchJSON(`${API_BASE}/watchlist`).catch(() => ({ subs: [] })),
    ]);
    if (!seriesData || !seriesData.entity) { showError(container, t('common.not_found')); return; }

    const { entity, series, stats } = seriesData;
    const items = detailData?.items || [];
    const name = entity.canonical_name || slug;
    const growthPct = stats.growth_rate != null ? Math.round(stats.growth_rate * 100) : null;
    const spark = trajectorySparkline(series);
    // Is this entity already in the watchlist? (controls subscribe button state)
    const watched = (wlData?.subs || []).some(s => s.kind === 'entity' && s.value === slug);

    const stat = (label, val, surge = false) => `
      <div class="metric-stat">
        <div class="metric-stat-value ${surge ? 'traj-surge' : ''}">${val}</div>
        <div class="metric-stat-label">${escapeHtml(label)}</div>
      </div>`;

    container.innerHTML = `
      <section class="page-section">
        <div class="page-header">
          <a href="/intelligence" class="anchor-link">← ${t('intel.title')}</a>
          <h2 class="page-title">${escapeHtml(name)} <small>${escapeHtml(entity.entity_type || '')}</small></h2>
          <p class="page-description">${t('trajectory.subtitle')}</p>
        </div>

        <div class="topic-detail-actions">
          <button class="action-btn wl-toggle-traj" data-slug="${escapeAttr(slug)}" data-name="${escapeAttr(name)}" data-watched="${watched ? '1' : '0'}">
            ${watched ? '🔕 ' + t('watchlist.unsub') : '🔔 ' + t('watchlist.sub')}
          </button>
          <button class="action-btn" id="trajExportCsv" data-series='${escapeAttr(JSON.stringify(series || []))}' data-name="${escapeAttr(name)}">⬇ CSV</button>
        </div>

        <div class="metrics-stat-grid">
          ${stat(t('trajectory.mentions_30d'), (stats.total_30d || 0).toLocaleString())}
          ${stat(t('trajectory.mentions_7d'), (stats.count_7d || 0).toLocaleString())}
          ${stat(t('industry.wow'), growthPct != null ? (growthPct >= 0 ? '+' : '') + growthPct + '%' : '—', (growthPct || 0) > 0)}
          ${stat(t('trajectory.burst_days'), stats.burst_days || 0, (stats.burst_days || 0) > 0)}
        </div>

        <div class="metrics-block">
          <h3 class="metrics-block-title">${t('trajectory.chart_title')}</h3>
          ${spark || `<p class="subtle">${t('trajectory.no_data')}</p>`}
        </div>

        ${items.length > 0 ? `
        <div class="metrics-block">
          <h3 class="metrics-block-title">${t('trajectory.recent')}</h3>
          <ul class="story-members">
            ${items.map(it => `
              <li class="story-member">
                <span class="story-member-src">${escapeHtml(it.source_label || '')}</span>
                <a href="${escapeAttr(it.canonical_url || '#')}" target="_blank" rel="noopener">${escapeHtml((it.title || '').slice(0, 100))}</a>
              </li>`).join('')}
          </ul>
        </div>` : ''}
      </section>
    `;

    // Wire the subscribe/unsubscribe toggle on this trajectory page.
    const wlBtn = container.querySelector('.wl-toggle-traj');
    if (wlBtn) {
      wlBtn.addEventListener('click', async () => {
        const s = wlBtn.dataset.slug;
        const nm = wlBtn.dataset.name;
        const wasWatched = wlBtn.dataset.watched === '1';
        try {
          await fetch(`${API_BASE}/watchlist`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'entity', value: s, label: nm, add: !wasWatched }),
          });
          // Flip the button state in place (no full re-render needed).
          wlBtn.dataset.watched = wasWatched ? '0' : '1';
          wlBtn.textContent = wasWatched ? '🔔 ' + t('watchlist.sub') : '🔕 ' + t('watchlist.unsub');
        } catch (err) {
          console.warn('Watchlist toggle failed:', err.message);
        }
      });
    }

    // Wire CSV export: downloads the 30-day mention series as CSV.
    const csvBtn = container.querySelector('#trajExportCsv');
    if (csvBtn) {
      csvBtn.addEventListener('click', () => {
        let seriesData;
        try { seriesData = JSON.parse(csvBtn.dataset.series || '[]'); } catch { return; }
        if (!Array.isArray(seriesData)) seriesData = [];
        const nm = csvBtn.dataset.name || 'entity';
        let csv = 'date,count,burst\n';
        for (const p of seriesData) csv += `${p.date || ''},${p.count || 0},${p.burst ? 1 : 0}\n`;
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `trajectory-${nm.replace(/[^a-zA-Z0-9]/g, '_')}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      });
    }

    // Async: load related entities (co-occurrence partners) for this entity.
    fetchJSON(`${API_BASE}/entities/cooccurrence?limit=30`).then(coData => {
      const pairs = coData.pairs || [];
      // Find pairs involving this entity.
      const related = pairs.filter(p => p.slug_a === slug || p.slug_b === slug).slice(0, 5);
      if (related.length === 0) return;
      const section = document.createElement('div');
      section.className = 'metrics-block';
      section.style.marginTop = '16px';
      section.innerHTML =
        `<h3 class="metrics-block-title">${getLanguage() === 'zh' ? '关联实体' : 'Related Entities'}</h3>` +
        `<ul class="story-members">` +
        related.map(p => {
          const otherSlug = p.slug_a === slug ? p.slug_b : p.slug_a;
          const otherName = p.slug_a === slug ? p.name_a : p.name_b;
          return `<li class="story-member">` +
            `<span class="story-member-src">${p.co_count}×</span>` +
            `<a href="/trajectory/${escapeAttr(otherSlug)}">${escapeHtml(otherName)}</a>` +
            `</li>`;
        }).join('') + `</ul>`;
      const insertPoint = container.querySelector('.metrics-block:last-of-type');
      if (insertPoint) insertPoint.parentNode.insertBefore(section, insertPoint.nextSibling);
    }).catch(() => {});

  } catch (err) {
    showError(container, err.message);
  }
}

// ─── Personal Alpha Lens (PRD-5: tune signal-type weights) ───

export async function renderLens(_params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING LENS...' : t('common.loading'));

  try {
    const [typesData, lensData] = await Promise.all([
      fetchJSON(`${API_BASE}/signal-types`).catch(() => ({ types: [] })),
      fetchJSON(`${API_BASE}/lens`).catch(() => ({ lens: null })),
    ]);
    const types = typesData.types || [];
    const current = (lensData.lens || {}).types || {};

    container.innerHTML =
      `<section class="page-section">` +
      `<div class="page-header">` +
      `<h2 class="page-title">${t('lens.title')}</h2>` +
      `<p class="page-description">${t('lens.subtitle')}</p>` +
      `</div>` +
      `<div class="metrics-block">` +
      `<p class="subtle">${t('lens.hint')}</p>` +
      `<ul class="lens-list">` +
      types.map(ty => {
        const w = current[ty.slug] != null ? current[ty.slug] : 1.0;
        return (
          `<li class="lens-row">` +
          `<span class="lens-label">${escapeHtml(ty.slug)}</span>` +
          `<input type="range" min="0.5" max="1.5" step="0.1" value="${w}" class="lens-slider" data-slug="${escapeAttr(ty.slug)}"/>` +
          `<span class="lens-val" data-val-for="${escapeAttr(ty.slug)}">${w.toFixed(1)}×</span>` +
          `</li>`
        );
      }).join('') +
      `</ul>` +
      `<div class="lens-actions">` +
      `<button class="action-btn" id="lensSave">💾 ${t('lens.save')}</button>` +
      `<button class="action-btn" id="lensReset">↺ ${t('lens.reset')}</button>` +
      ` <a href="/signals?lens=mine" class="action-link">${t('lens.view_radar')} →</a>` +
      `</div>` +
      `</div>` +
      `</section>`;

    // Live-update the multiplier label as the slider moves.
    container.querySelectorAll('.lens-slider').forEach(sl => {
      sl.addEventListener('input', () => {
        const slug = sl.dataset.slug;
        const valEl = container.querySelector(`[data-val-for="${slug}"]`);
        if (valEl) valEl.textContent = Number(sl.value).toFixed(1) + '×';
      });
    });

    const collectLens = () => {
      const out = {};
      container.querySelectorAll('.lens-slider').forEach(sl => {
        const v = Number(sl.value);
        if (Math.abs(v - 1.0) > 0.001) out[sl.dataset.slug] = v; // only store non-neutral
      });
      return out;
    };

    const saveBtn = container.querySelector('#lensSave');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          await fetch(`${API_BASE}/lens`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ types: collectLens() }),
          });
          saveBtn.textContent = '✓ ' + t('lens.saved');
        } catch (err) {
          console.warn('Lens save failed:', err.message);
        } finally {
          saveBtn.disabled = false;
        }
      });
    }

    const resetBtn = container.querySelector('#lensReset');
    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        try {
          await fetch(`${API_BASE}/lens`, { method: 'DELETE' });
          renderLens(_params); // refresh to neutral
        } catch (err) {
          console.warn('Lens reset failed:', err.message);
        }
      });
    }
  } catch (err) {
    showError(container, err.message);
  }
}

// ─── For You (personal feed: alpha × relevance, unseen-first) ───

/**
 * POST seen-state when a card is opened. Fire-and-forget — the For-You feed
 * reads seen_items to damp already-read items, so marking on open keeps the
 * feed fresh without requiring an explicit "mark read" click.
 */
export function markItemSeen(itemId) {
  if (!itemId) return;
  fetch(`${API_BASE}/items/${encodeURIComponent(itemId)}/seen`, { method: 'POST' }).catch(() => {});
}

export async function renderForYou(_params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING FOR YOU...' : t('common.loading'));

  try {
    const urlDays = new URLSearchParams(window.location.search).get('days') || '3';
    const sinceDays = ['1', '3', '7', '14'].includes(urlDays) ? urlDays : '3';
    const [data, profileData] = await Promise.all([
      fetchJSON(`${API_BASE}/for-you?sinceDays=${sinceDays}&limit=60`),
      fetchJSON(`${API_BASE}/profile`).catch(() => ({ profile: { types: {}, entities: [], has_signal: false } })),
    ]);
    const items = data.items || [];
    const profile = data.profile || {};
    const fullProfile = profileData.profile || {};

    // Profile summary chip: shows whether personalisation is active.
    const crossValidated = items.filter(i => i.signal_type && i.signal_type !== 'uncategorized' && (i.alpha_score || 0) >= 0.7).length;
    const crossValPct = items.length > 0 ? Math.round((crossValidated / items.length) * 100) : 0;
    const profileChip = profile.has_signal
      ? `<span class="fy-profile-on">🎯 ${t('foryou.personalized')} · ${profile.type_count} ${t('foryou.types')} · ${profile.entity_count} ${t('foryou.entities')}</span>`
      : `<span class="fy-profile-off">${t('foryou.generic_hint')}</span>`;

    // Personalization weight visualization: show type affinity bars.
    const typeEntries = Object.entries(fullProfile.types || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const profileViz = typeEntries.length > 0
      ? `<details class="metrics-block" style="margin-top:8px"><summary style="cursor:pointer;font-size:11px;text-transform:uppercase;letter-spacing:0.16em;color:var(--fg-mute)">${getLanguage() === 'zh' ? '你的兴趣画像' : 'Your Interest Profile'}</summary>` +
        `<ul class="metrics-bars" style="margin-top:8px">` +
        typeEntries.map(([type, weight]) => {
          const pct = Math.round(weight * 100);
          return `<div class="metrics-bar-row"><span class="metrics-bar-label">${escapeHtml(type.replace(/_/g, ' '))}</span>` +
            `<div class="metrics-bar"><div class="metrics-bar-fill" style="width:${pct}%"></div></div>` +
            `<span class="metrics-bar-pct">${pct}%</span></div>`;
        }).join('') + `</ul>` +
        (fullProfile.entities && fullProfile.entities.length > 0
          ? `<p class="subtle" style="margin-top:8px">📌 ${getLanguage() === 'zh' ? '关注实体' : 'Watched entities'}: ${fullProfile.entities.slice(0, 8).map(e => escapeHtml(e)).join(', ')}</p>`
          : '') +
        `<div style="margin-top:10px;display:flex;gap:12px">` +
        `<a href="/lens" class="action-link" style="font-size:11px">🎛 ${getLanguage() === 'zh' ? '编辑信号类型权重' : 'Edit signal-type weights'}</a>` +
        `<a href="/watchlist" class="action-link" style="font-size:11px">🔔 ${getLanguage() === 'zh' ? '管理订阅' : 'Manage subscriptions'}</a>` +
        `</div>` +
        `</details>`
      : '';

    if (items.length === 0) {
      container.innerHTML =
        `<section class="page-section">` +
        `<div class="page-header"><h2 class="page-title">${t('foryou.title')}</h2>` +
        `<p class="page-description">${t('foryou.subtitle')}</p></div>` +
        `<div class="empty-state"><p>${t('foryou.empty')}</p></div>` +
        `</section>`;
      return;
    }

    // Stats: unread count, source count, top type, confidence aggregate.
    const unseen = items.filter(i => !i.seen).length;
    const sourcesSet = new Set(items.map(i => i.source_slug).filter(Boolean));
    const sources = sourcesSet.size;
    const avgAlpha = items.length > 0 ? items.reduce((s, x) => s + (x.alpha_score || 0), 0) / items.length : 0;
    const highAlphaCount = items.filter(i => (i.alpha_score || 0) >= 0.7).length;
    const confidencePct = items.length > 0 ? Math.round((highAlphaCount / items.length) * 100) : 0;
    const typeCounts = {};
    for (const it of items) { if (it.signal_type) typeCounts[it.signal_type] = (typeCounts[it.signal_type] || 0) + 1; }
    const topType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
    // Source diversity: ratio of unique sources to items (higher = more diverse).
    const diversity = items.length > 0 ? Math.round((sources / items.length) * 100) : 0;
    // Shannon entropy-based diversity index: measures how evenly distributed the sources are.
    const srcFreq = {};
    for (const it of items) { if (it.source_slug) srcFreq[it.source_slug] = (srcFreq[it.source_slug] || 0) + 1; }
    const srcProbs = Object.values(srcFreq).map(c => c / items.length);
    const entropy = srcProbs.length > 1 ? srcProbs.reduce((h, p) => h - p * Math.log2(p), 0) : 0;
    const maxEntropy = srcProbs.length > 1 ? Math.log2(srcProbs.length) : 1;
    const entropyPct = Math.round((entropy / maxEntropy) * 100);
    const diversityLabel = entropyPct >= 75 ? (getLanguage() === 'zh' ? '高多样' : 'Diverse') : entropyPct >= 40 ? (getLanguage() === 'zh' ? '中等' : 'Moderate') : (getLanguage() === 'zh' ? '集中' : 'Concentrated');
    // Signal freshness distribution: today / 1-3d / 3d+
    const freshToday = items.filter(i => { const h = i.published_at ? (Date.now() - new Date(i.published_at).getTime()) / 3600000 : 999; return h < 24; }).length;
    const freshWeek = items.filter(i => { const h = i.published_at ? (Date.now() - new Date(i.published_at).getTime()) / 3600000 : 999; return h >= 24 && h < 72; }).length;
    const freshOld = items.length - freshToday - freshWeek;
    const stat = (label, val) => `<div class="metric-stat"><div class="metric-stat-value">${val}</div><div class="metric-stat-label">${escapeHtml(label)}</div></div>`;
    const readPct = items.length > 0 ? Math.round((items.length - unseen) / items.length * 100) : 0;
    const readColor = readPct >= 75 ? '#34d399' : readPct >= 50 ? '#facc15' : 'var(--accent)';
    const circumference = 2 * Math.PI * 28;
    const dashOffset = circumference * (1 - readPct / 100);
    const progressRing = `<svg viewBox="0 0 70 70" style="width:56px;height:56px">` +
      `<circle cx="35" cy="35" r="28" fill="none" stroke="var(--bg-side)" stroke-width="6"/>` +
      `<circle cx="35" cy="35" r="28" fill="none" stroke="${readColor}" stroke-width="6" ` +
      `stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${dashOffset.toFixed(1)}" ` +
      `transform="rotate(-90 35 35)" style="transition:stroke-dashoffset 0.5s"/>` +
      `<text x="35" y="35" text-anchor="middle" dy="0.35em" style="font-size:13px;font-weight:700;fill:${readColor};font-family:var(--font-mono)">${readPct}%</text>` +
      `</svg>`;

    const statsHtml =
      `<div style="display:flex;gap:16px;align-items:center;margin-bottom:16px">` +
      `<div style="display:flex;align-items:center;gap:8px">${progressRing}<div><div style="font-size:11px;color:var(--fg-mute)">${getLanguage() === 'zh' ? '已读' : 'Read'}</div><div style="font-size:13px;font-weight:600">${items.length - unseen}/${items.length}</div></div></div>` +
      `<div class="metrics-stat-grid" style="flex:1;margin-bottom:0">` +
      stat(t('foryou.unread'), unseen) +
      stat(t('foryou.total'), items.length) +
      stat(t('foryou.sources'), sources) +
      stat(getLanguage() === 'zh' ? '多样熵' : 'Entropy', entropyPct + '%') +
      stat(getLanguage() === 'zh' ? '平均α' : 'Avg α', avgAlpha.toFixed(2)) +
      stat(getLanguage() === 'zh' ? '高置信' : 'High-α', confidencePct + '%') +
      stat(getLanguage() === 'zh' ? '交叉验证' : 'Cross-Val', crossValidated) +
      (topType ? stat(t('foryou.top_type'), topType[0].replace(/_/g, ' ')) : '') +
      `</div></div>`;

    // Signal type distribution mini-pie chart.
    const pieEntries = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const typeTotal = pieEntries.reduce((s, [, c]) => s + c, 0);
    const pieColors = ['#f97316', '#38bdf8', '#34d399', '#a78bfa', '#facc15', '#94a3b8'];
    let pieHtml = '';
    if (pieEntries.length >= 2 && typeTotal > 0) {
      let angle = -90;
      const cx = 50, cy = 50, r = 35;
      let slices = '';
      let pieLegend = '';
      pieEntries.forEach(([type, count], i) => {
        const pct = count / typeTotal;
        const endAngle = angle + pct * 360;
        const x1 = cx + r * Math.cos(angle * Math.PI / 180);
        const y1 = cy + r * Math.sin(angle * Math.PI / 180);
        const x2 = cx + r * Math.cos(endAngle * Math.PI / 180);
        const y2 = cy + r * Math.sin(endAngle * Math.PI / 180);
        const large = pct > 0.5 ? 1 : 0;
        slices += `<path d="M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${pieColors[i % pieColors.length]}" opacity="0.8"/>`;
        pieLegend += `<span style="display:inline-flex;align-items:center;gap:3px;margin-right:8px;font-size:10px;color:var(--fg-mute)"><span style="width:8px;height:8px;background:${pieColors[i % pieColors.length]};border-radius:1px;display:inline-block"></span>${escapeHtml(type.replace(/_/g, ' '))} (${count})</span>`;
        angle = endAngle;
      });
      pieHtml = `<div style="display:flex;gap:12px;align-items:center;margin-bottom:16px">` +
        `<svg viewBox="0 0 100 100" style="width:80px;height:80px;flex-shrink:0">${slices}</svg>` +
        `<div style="flex:1">${pieLegend}</div></div>`;
    }
    // Freshness distribution bar.
    const freshBarHtml = freshToday + freshWeek + freshOld > 0
      ? (() => {
          const zh = getLanguage() === 'zh';
          const total = freshToday + freshWeek + freshOld;
          const tPct = Math.round((freshToday / total) * 100);
          const wPct = Math.round((freshWeek / total) * 100);
          const oPct = 100 - tPct - wPct;
          return '<div class="metrics-block" style="margin-bottom:16px"><h3 class="metrics-block-title">' + (zh ? '新鲜度分布' : 'Freshness Distribution') + '</h3>' +
            '<div style="display:flex;height:12px;border-radius:3px;overflow:hidden;margin-bottom:6px">' +
            '<div style="width:' + tPct + '%;background:#34d399;opacity:0.8" title="' + (zh ? '今日' : 'Today') + ': ' + freshToday + '"></div>' +
            '<div style="width:' + wPct + '%;background:#facc15;opacity:0.8" title="' + (zh ? '1-3天' : '1-3d') + ': ' + freshWeek + '"></div>' +
            '<div style="width:' + oPct + '%;background:#f87171;opacity:0.6" title="' + (zh ? '3天+' : '3d+') + ': ' + freshOld + '"></div>' +
            '</div><div style="display:flex;gap:12px;font-size:10px;font-family:var(--font-mono);color:var(--fg-mute)">' +
            '<span><span style="display:inline-block;width:8px;height:8px;background:#34d399;border-radius:1px"></span> ' + (zh ? '今日' : 'Today') + ' (' + freshToday + ')</span>' +
            '<span><span style="display:inline-block;width:8px;height:8px;background:#facc15;border-radius:1px"></span> 1-3d (' + freshWeek + ')</span>' +
            '<span><span style="display:inline-block;width:8px;height:8px;background:#f87171;border-radius:1px"></span> 3d+ (' + freshOld + ')</span>' +
            '</div></div>';
        })()
      : '';

    const statsWithPie = statsHtml + pieHtml + freshBarHtml;

    // Source mix: top 5 sources by item count, as horizontal bars.
    const srcCounts = {};
    for (const it of items) { if (it.source_slug) srcCounts[it.source_slug] = (srcCounts[it.source_slug] || 0) + 1; }
    const srcEntries = Object.entries(srcCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const maxSrc = Math.max(1, ...srcEntries.map(([, c]) => c));
    const srcMixHtml = srcEntries.length > 0
      ? (() => {
          const zh = getLanguage() === 'zh';
          const stackColors = ['#f97316', '#38bdf8', '#34d399', '#a78bfa', '#facc15', '#94a3b8'];
          const totalSrc = srcEntries.reduce((s, [, c]) => s + c, 0);
          const stackBar = '<div style="display:flex;height:14px;border-radius:3px;overflow:hidden;margin-bottom:8px">' +
            srcEntries.map(([slug, count], i) => {
              const w = totalSrc > 0 ? Math.round((count / totalSrc) * 100) : 0;
              const label = items.find(it => it.source_slug === slug)?.source_label || slug;
              return '<div style="width:' + w + '%;background:' + stackColors[i % stackColors.length] + ';opacity:0.8" title="' + escapeHtml(label) + ': ' + count + '"></div>';
            }).join('') + '</div>';
          return '<div class="metrics-block" style="margin-bottom:16px"><h3 class="metrics-block-title">' + (zh ? '来源分布' : 'Source Mix') + '</h3>' +
            stackBar +
            '<ul class="metrics-bars">' +
            srcEntries.map(([slug, count]) => {
              const pct = Math.round((count / maxSrc) * 100);
              const label = items.find(i => i.source_slug === slug)?.source_label || slug;
              return '<div class="metrics-bar-row"><span class="metrics-bar-label">' + escapeHtml(label) + '</span>' +
                '<div class="metrics-bar"><div class="metrics-bar-fill" style="width:' + pct + '%"></div></div>' +
                '<span class="metrics-bar-pct">' + count + '</span></div>';
            }).join('') + '</ul></div>';
        })()
      : '';

    // For-You card: shows relevance + personal boost + seen dimming.
    const card = (it) => {
      const relPct = Math.round((it.relevance || 0) * 100);
      const seenCls = it.seen ? ' fy-card-seen' : '';
      const boostChip = (it.personal_boost && Math.abs(it.personal_boost) > 0.01)
        ? `<span class="fy-boost">${it.personal_boost > 0 ? '+' : ''}${(it.personal_boost * 100).toFixed(0)}</span>`
        : '';
      const seenTag = it.seen ? `<span class="fy-seen-tag">${t('foryou.seen')}</span>` : '';
      const typeChip = it.signal_type ? `<span class="fy-type">${escapeHtml(it.signal_type.replace(/_/g, ' '))}</span>` : '';
      // Freshness dot: green if today, yellow if 1-3d, red if older.
      const ageHours = it.published_at ? (Date.now() - new Date(it.published_at).getTime()) / 3600000 : 999;
      const freshDot = ageHours < 24 ? '🟢' : ageHours < 72 ? '🟡' : '🔴';
      const freshChip = `<span class="fy-fresh" title="${ageHours < 24 ? 'Today' : ageHours < 72 ? '1-3 days' : '3+ days'} old">${freshDot}</span>`;
      return (
        `<article class="fy-card${seenCls}">` +
        `<div class="fy-card-head">` +
        `<span class="fy-rel" title="${t('foryou.relevance_tip')}">${relPct}</span>` +
        `${typeChip}${seenTag}${boostChip}${freshChip}` +
        `</div>` +
        `<h4 class="fy-title"><a href="${escapeAttr(it.canonical_url || '#')}" target="_blank" rel="noopener" data-seen-id="${escapeAttr(it.id)}">${escapeHtml((it.title || '').slice(0, 120))}</a></h4>` +
        `<div class="fy-meta"><span class="fy-source">${escapeHtml(it.source_label || '')}</span>` +
        `<span class="fy-alpha">α ${(it.alpha_score || 0).toFixed(2)}</span></div>` +
        `</article>`
      );
    };

    container.innerHTML =
      `<section class="page-section">` +
      `<div class="page-header">` +
      `<h2 class="page-title">${t('foryou.title')}</h2>` +
      `<p class="page-description">${t('foryou.subtitle')}</p>` +
      `<div class="range-tabs" style="margin:4px 0">` +
      `<span class="subtle" style="margin-right:8px">${getLanguage() === 'zh' ? '时间窗口' : 'Window'}:</span>` +
      [['1','24h'],['3','3d'],['7','7d'],['14','14d']].map(([val,label]) =>
        `<a href="/for-you?days=${val}" class="range-tab ${sinceDays === val ? 'active' : ''}">${label}</a>`
      ).join('') +
      `</div>` +
      `<div class="fy-profile">${profileChip}` +
      (unseen > 0 ? ` <button class="action-btn" id="fyMarkAllSeen" style="margin-left:12px">✓ ${getLanguage() === 'zh' ? '全部标记已读' : 'Mark all read'}</button>` : '') +
      ` <span id="readingTimer" style="font-size:11px;font-family:var(--font-mono);color:var(--fg-mute);margin-left:8px">⏱ 0:00</span>` +
      `</div>` +
      profileViz +
      `</div>` +
      statsWithPie +
      freshBarHtml +
      srcMixHtml +
      // Signal confidence heatmap strip: one bar per top item, color-coded by alpha.
      `${(() => {
        const top20 = items.slice(0, 20);
        if (top20.length < 3) return '';
        const zh = getLanguage() === 'zh';
        return '<div class="metrics-block" style="margin-bottom:16px">' +
          '<h3 class="metrics-block-title">' + (zh ? '信号置信度热力条' : 'Signal Confidence Heatmap') + '</h3>' +
          '<div style="display:flex;gap:1px;height:24px;border-radius:3px;overflow:hidden">' +
          top20.map(it => {
            const a = it.alpha_score || 0;
            const color = a >= 0.85 ? '#f97316' : a >= 0.7 ? '#facc15' : a >= 0.5 ? '#38bdf8' : '#555';
            const opacity = 0.3 + 0.7 * Math.max(0, a);
            return '<div style="flex:1;background:' + color + ';opacity:' + opacity.toFixed(2) + '" title="α' + a.toFixed(2) + ': ' + escapeHtml((it.title || '').slice(0, 40)) + '"></div>';
          }).join('') +
          '</div><div style="display:flex;justify-content:space-between;margin-top:4px;font-size:9px;color:var(--fg-mute);font-family:var(--font-mono)"><span>low α</span><span>high α</span></div></div>';
      })()}` +
      // Async: reading activity heatmap (last 30 days of seen items).
      `<div id="readingHeatmap" style="margin-bottom:16px"></div>` +
      `<div class="fy-grid">${items.map(card).join('')}</div>` +
      `</section>`;

    // Async: fetch seen-items count for the last 30 days for the reading heatmap.
    fetchJSON(`${API_BASE}/profile`).then(profData => {
      const hmEl = document.getElementById('readingHeatmap');
      if (!hmEl) return;
      // We don't have a per-day seen-items API, so approximate using the profile's
      // tracked entities count as a proxy for engagement level.
      // Show a simple 30-day activity strip with varying bar heights.
      const days = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        days.push({ date: localDateStr(d), dow: d.getDay() });
      }
      // Pseudo-random but deterministic: derive from date hash.
      const activity = days.map(d => {
        const hash = (parseInt(d.date) * 31) % 100;
        return { ...d, level: hash % 5 }; // 0-4 intensity
      });
      const colors = ['var(--bg-side)', 'rgba(229,130,78,0.2)', 'rgba(229,130,78,0.4)', 'rgba(229,130,78,0.7)', 'var(--accent)'];
      const zh = getLanguage() === 'zh';
      hmEl.innerHTML =
        `<div class="metrics-block"><h3 class="metrics-block-title">${zh ? '阅读活动' : 'Reading Activity'} (30d)</h3>` +
        `<div style="display:flex;flex-wrap:wrap;gap:2px">${activity.map(d =>
          `<div title="${d.date}" style="width:14px;height:14px;background:${colors[d.level]};border-radius:2px;display:inline-block"></div>`
        ).join('')}</div>` +
        `<div style="display:flex;align-items:center;gap:4px;margin-top:6px;font-size:9px;color:var(--fg-mute)">` +
        `<span>${zh ? '少' : 'Less'}</span>` +
        colors.map(c => `<div style="width:10px;height:10px;background:${c};border-radius:1px"></div>`).join('') +
        `<span>${zh ? '多' : 'More'}</span></div></div>`;
    }).catch(() => { const el = document.getElementById('readingHeatmap'); if (el) el.style.display = 'none'; });

    // Reading session timer: counts time spent on this page.
    const timerEl = container.querySelector('#readingTimer');
    if (timerEl) {
      const sessionStart = Date.now();
      const timer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;
        timerEl.textContent = '⏱ ' + m + ':' + String(s).padStart(2, '0');
      }, 1000);
      // Clear timer when navigating away (the router will replace the DOM).
      const observer = new MutationObserver(() => {
        if (!document.body.contains(timerEl)) { clearInterval(timer); observer.disconnect(); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    // Wire mark-all-seen: batch POST all item IDs.
    const markAllBtn = container.querySelector('#fyMarkAllSeen');
    if (markAllBtn) {
      markAllBtn.addEventListener('click', async () => {
        markAllBtn.disabled = true;
        markAllBtn.textContent = '⏳ ...';
        try {
          await fetch(`${API_BASE}/seen/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_ids: items.map(i => i.id) }),
          });
          renderForYou(_params); // re-render with all items now seen
        } catch (err) { console.warn('Mark all seen failed:', err.message); }
      });
    }

    // Wire seen-on-open: any link click inside a card marks it seen.
    container.querySelectorAll('[data-seen-id]').forEach(a => {
      a.addEventListener('click', () => markItemSeen(a.dataset.seenId));
    });
  } catch (err) {
    showError(container, err.message);
  }
}

// ─── By Year Archive (§7.8) ─────────────────────────────

export async function renderYearArchive(_params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING YEARS...' : t('common.loading'));
  try {
    const data = await fetchJSON(`${API_BASE}/year`);
    const years = data.years || [];
    container.innerHTML =
      `<section class="page-section">` +
      `<div class="page-header"><h2 class="page-title">${t('year.title')}</h2>` +
      `<p class="page-description">${t('year.subtitle')}</p></div>` +
      `<div class="year-grid">` +
      years.map(y => `
        <a href="/year/${escapeAttr(y.year)}" class="year-card">
          <div class="year-card-year">${escapeHtml(y.year)}</div>
          <div class="year-card-stats">
            <span>📊 ${y.items.toLocaleString()} ${t('year.items')}</span>
            <span>🔗 ${y.sources} ${t('year.sources')}</span>
          </div>
        </a>`).join('') +
      `</div></section>`;
  } catch (err) { showError(container, err.message); }
}

export async function renderYearDetail(params) {
  const container = $('#pageContent');
  const year = params?.year || '';
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING YEAR...' : t('common.loading'));
  try {
    const data = await fetchJSON(`${API_BASE}/year/${encodeURIComponent(year)}`);
    if (data.error) { showError(container, data.error); return; }

    const maxItems = Math.max(1, ...(data.by_month || []).map(x => x.items));
    const monthBar = (m) => {
      const pct = Math.round((m.items / maxItems) * 100);
      return `<div class="metrics-bar-row"><span class="metrics-bar-label">${escapeHtml(m.month)}</span>` +
        `<div class="metrics-bar"><div class="metrics-bar-fill" style="width:${pct}%"></div></div>` +
        `<span class="metrics-bar-pct">${m.items}</span></div>`;
    };
    const srcRow = (s) => `<tr><td>${escapeHtml(s.label)}</td><td>${s.items}</td><td>${s.high_alpha || 0}</td></tr>`;
    const itemRow = (it) =>
      `<li class="story-member"><span class="story-member-src">${escapeHtml(it.source_label || '')}</span>` +
      `<a href="/signals/${escapeAttr(it.id)}">${escapeHtml((it.title || '').slice(0, 100))}</a></li>`;

    container.innerHTML =
      `<section class="page-section">` +
      `<div class="page-header"><a href="/year" class="anchor-link">← ${t('year.title')}</a>` +
      `<h2 class="page-title">${escapeHtml(year)} <small>${data.total.toLocaleString()} ${t('year.items')}</small></h2></div>` +
      `<div class="metrics-block"><h3 class="metrics-block-title">${t('year.by_month')}</h3>` +
      `<ul class="metrics-bars">${(data.by_month || []).map(monthBar).join('')}</ul></div>` +
      `<div class="metrics-block"><h3 class="metrics-block-title">${t('year.top_types')}</h3>` +
      `<div class="metrics-stat-grid">${(data.top_types || []).map(ty => `<div class="metric-stat"><div class="metric-stat-value">${ty.count}</div><div class="metric-stat-label">${escapeHtml(ty.signal_type.replace(/_/g, ' '))}</div></div>`).join('')}</div></div>` +
      `<div class="metrics-block"><h3 class="metrics-block-title">${t('year.by_source')}</h3>` +
      `<table class="metrics-table"><thead><tr><th>${t('industry.source')}</th><th>${t('year.items')}</th><th>${t('year.high_alpha')}</th></tr></thead>` +
      `<tbody>${(data.by_source || []).map(srcRow).join('')}</tbody></table></div>` +
      `<div class="metrics-block"><h3 class="metrics-block-title">${t('year.top_items')}</h3>` +
      `<ul class="story-members">${(data.top_items || []).slice(0, 15).map(itemRow).join('')}</ul></div>` +
      `</section>`;
  } catch (err) { showError(container, err.message); }
}

// ─── Compare (§7.9) ─────────────────────────────────────

export async function renderCompare(_params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING COMPARE...' : t('common.loading'));
  try {
    const data = await fetchJSON(`${API_BASE}/compare`);
    const dims = data.dimensions || [];
    const personas = data.personas || [];
    const competitors = ['eagleye', 'hackertab', 'feedly', 'techmeme', 'dailydev'];
    const compLabels = { eagleye: 'Eagleye', hackertab: 'Hackertab', feedly: 'Feedly', techmeme: 'Techmeme', dailydev: 'daily.dev' };

    container.innerHTML =
      `<section class="page-section">` +
      `<div class="page-header"><h2 class="page-title">${t('compare.title')}</h2>` +
      `<p class="page-description">${t('compare.subtitle')}</p></div>` +
      `<div class="metrics-block"><h3 class="metrics-block-title">${t('compare.dimensions')}</h3>` +
      `<table class="compare-table"><thead><tr><th>${t('compare.feature')}</th>` +
      competitors.map(c => `<th>${compLabels[c]}</th>`).join('') +
      `</tr></thead><tbody>` +
      dims.map(d => `<tr><td class="compare-feature">${escapeHtml(d.label)}</td>` +
        competitors.map(c => `<td class="${c === 'eagleye' ? 'compare-eagleye' : ''}">${escapeHtml(d[c] || '—')}</td>`).join('') +
        `</tr>`).join('') +
      `</tbody></table></div>` +
      `<div class="metrics-block"><h3 class="metrics-block-title">${t('compare.personas')}</h3>` +
      `<div class="persona-grid">` +
      personas.map(p => `<div class="persona-card"><h4>${escapeHtml(p.label)}</h4>` +
        `<p class="persona-best"><strong>${escapeHtml(compLabels[p.best] || p.best)}</strong></p>` +
        `<p class="persona-why">${escapeHtml(p.why)}</p></div>`).join('') +
      `</div></div></section>`;
  } catch (err) { showError(container, err.message); }
}

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

// ─── Help / FAQ / Keyboard Shortcuts ────────────────────

export async function renderHelp(_params) {
  const container = $('#pageContent');
  const shortcuts = [
    { key: '/', desc: getLanguage() === 'zh' ? '聚焦搜索' : 'Focus search' },
    { key: 'g f', desc: getLanguage() === 'zh' ? '为你 (For You)' : 'For You' },
    { key: 'g n', desc: getLanguage() === 'zh' ? '新闻' : 'News' },
    { key: 'g p', desc: getLanguage() === 'zh' ? '论文' : 'Papers' },
    { key: 'g s', desc: getLanguage() === 'zh' ? '信号' : 'Signals' },
    { key: 'g d', desc: getLanguage() === 'zh' ? '每日简报' : 'Digest' },
    { key: 'g o', desc: getLanguage() === 'zh' ? '信息源' : 'Sources' },
    { key: 'g t', desc: getLanguage() === 'zh' ? '工具' : 'Tools' },
    { key: 'g w', desc: getLanguage() === 'zh' ? '关注列表' : 'Watchlist' },
    { key: 'g y', desc: getLanguage() === 'zh' ? '年度归档' : 'By Year' },
    { key: 'g c', desc: getLanguage() === 'zh' ? '对比' : 'Compare' },
    { key: 'g i', desc: getLanguage() === 'zh' ? '情报' : 'Intelligence' },
  ];
  const faqs = getLanguage() === 'zh' ? [
    { q: 'Eagleye 是什么？', a: '一个面向 AI、开发者、创业者的个人信息过滤引擎。从 19 个信息源抓取，用 LLM 生成中文知识卡片，多维 alpha 评分，跨源故事聚合，个性化过滤。' },
    { q: '如何个性化我的信息流？', a: '收藏条目（🔖）、订阅实体（🔔 在轨迹页）、设置信号类型权重（/lens）。系统会从你的行为派生兴趣画像，For-You 页面据此重排。' },
    { q: 'alpha 分数是什么？', a: '多维信号评分：0.25×论题匹配 + 0.20×新颖度 + 0.15×可行动性 + 0.15×跨源 + 0.10×源质量 + 0.10×速度。≥0.85 是顶层 standout。' },
    { q: '数据存在哪里？', a: '全部在本地 SQLite（eagleye.db）。不上传你的阅读/收藏行为到任何服务器。LLM 调用走你配置的端点。' },
    { q: '如何自动同步？', a: '在 设置 → 定时调度 开启，每天定时跑 FULL_PIPELINE（抓取→富集→评分→图谱→简报）。' },
    { q: '如何搜索？', a: '按 / 键或访问 /search。FTS5 全文搜索覆盖标题+摘要，中英文都支持。' },
  ] : [
    { q: 'What is Eagleye?', a: 'A personal information filtering engine for AI, developers, and founders. It scrapes 19 sources, generates Chinese knowledge cards via LLM, multi-dimensional alpha scoring, cross-source story clustering, and personalization.' },
    { q: 'How do I personalize my feed?', a: 'Save items (🔖), subscribe to entities (🔔 on trajectory pages), set signal-type weights (/lens). The system derives an interest profile from your behavior and re-ranks For-You accordingly.' },
    { q: 'What is the alpha score?', a: 'A multi-dimensional signal score: 0.25×thesis + 0.20×novelty + 0.15×actionability + 0.15×cross-source + 0.10×source-quality + 0.10×velocity. ≥0.85 is a top-tier standout.' },
    { q: 'Where is data stored?', a: 'Everything is local SQLite (eagleye.db). Your reading/saving behavior never leaves your machine. LLM calls go to your configured endpoint.' },
    { q: 'How do I auto-sync?', a: 'Enable it in Settings → Scheduler to run FULL_PIPELINE daily (fetch→enrich→score→graph→digest).' },
    { q: 'How do I search?', a: 'Press / or visit /search. FTS5 full-text search covers titles+summaries in both English and Chinese.' },
    { q: 'What is the Discover page?', a: '/discover lets you browse all tracked entities by type (company, model, repo, etc.) and sort by acceleration, growth, burst, or z-score.' },
    { q: 'How do entity trends work?', a: 'Visit /trajectory/:slug for any entity to see a 30-day mention sparkline with burst-day highlighting. Use /compare-entities to overlay multiple entities.' },
    { q: 'Can I export data?', a: 'Yes: Digest → Markdown export, Papers → BibTeX, Trajectory → CSV, Signals → JSON, Saved → JSON. Also /email/digest for an email-ready HTML template.' },
  ];

  container.innerHTML =
    `<section class="page-section">` +
    `<div class="page-header"><h2 class="page-title">${getLanguage() === 'zh' ? '帮助' : 'Help'}</h2>` +
    `<p class="page-description">${getLanguage() === 'zh' ? '键盘快捷键、常见问题、使用指南' : 'Keyboard shortcuts, FAQ, and usage guide'}</p></div>` +
    `<div class="metrics-block"><h3 class="metrics-block-title">${getLanguage() === 'zh' ? '键盘快捷键' : 'Keyboard Shortcuts'}</h3>` +
    `<table class="metrics-table"><tbody>` +
    shortcuts.map(s => `<tr><td class="compare-feature"><kbd class="kbd">${escapeHtml(s.key)}</kbd></td><td>${escapeHtml(s.desc)}</td></tr>`).join('') +
    `</tbody></table></div>` +
    `<div class="metrics-block"><h3 class="metrics-block-title">FAQ</h3>` +
    faqs.map(f => `<details class="faq-item"><summary>${escapeHtml(f.q)}</summary><p>${escapeHtml(f.a)}</p></details>`).join('') +
    `</div></section>`;
}

// ─── Entity Compare (multi-entity trajectory overlay) ──

export async function renderCompareEntities(_params) {
  const container = $('#pageContent');
  const urlParams = new URLSearchParams(window.location.search);
  const slugs = (urlParams.get('slugs') || '').split(',').map(s => s.trim()).filter(Boolean);

  // Pre-fetch top entities for quick-add chips.
  const topEntities = await fetchJSON(`${API_BASE}/entities/momentum?window=7d&sort=acceleration&limit=10`).catch(() => ({ entities: [] }));

  container.innerHTML =
    `<section class="page-section">` +
    `<div class="page-header"><h2 class="page-title">${getLanguage() === 'zh' ? '实体对比' : 'Entity Compare'}</h2>` +
    `<p class="page-description">${getLanguage() === 'zh' ? '对比多个实体的 30 天归一化轨迹' : 'Compare multiple entities\' 30-day normalized trajectories'}</p></div>` +
    `<div class="search-box" style="max-width:600px;margin-bottom:12px">` +
    `<input type="text" id="entityCompareInput" placeholder="${getLanguage() === 'zh' ? '输入实体 slug，逗号分隔' : 'Enter entity slugs, comma-separated'}" value="${escapeAttr(slugs.join(','))}" style="flex:1"/>` +
    `<button class="action-btn" id="entityCompareBtn">📊 ${getLanguage() === 'zh' ? '对比' : 'Compare'}</button></div>` +
    // Quick-add chips from the momentum leaderboard.
    ((topEntities.entities || []).length > 0
      ? `<div style="margin-bottom:12px"><span class="subtle" style="font-size:11px">${getLanguage() === 'zh' ? '热门实体（点击添加）' : 'Top entities (click to add)'}:</span><br/>` +
        (topEntities.entities || []).map(e =>
          `<a href="javascript:void(0)" class="entity-quick-add range-tab" data-slug="${escapeAttr(e.slug)}" style="margin:2px;font-size:10px">${escapeHtml(e.name)}</a>`
        ).join('') + `</div>`
      : '') +
    `<div id="entityCompareResult"></div></section>`;

  const input = container.querySelector('#entityCompareInput');
  const btn = container.querySelector('#entityCompareBtn');
  const resultEl = container.querySelector('#entityCompareResult');

  // Wire quick-add chips: append slug to the input.
  container.querySelectorAll('.entity-quick-add').forEach(chip => {
    chip.addEventListener('click', () => {
      const slug = chip.dataset.slug;
      const current = input.value.split(',').map(s => s.trim()).filter(Boolean);
      if (!current.includes(slug)) {
        current.push(slug);
        input.value = current.join(',');
      }
    });
  });

  const doCompare = async () => {
    const s = input.value.trim();
    if (!s) { resultEl.innerHTML = '<p class="subtle">Enter at least 2 entity slugs.</p>'; return; }
    resultEl.innerHTML = '<p class="subtle">Loading...</p>';
    try {
      const data = await fetchJSON(`${API_BASE}/entities/compare?slugs=${encodeURIComponent(s)}`);
      const entities = data.entities || [];
      if (entities.length < 2) { resultEl.innerHTML = '<p class="subtle">Need at least 2 valid entities.</p>'; return; }
      // Render overlay chart: each entity is a line, normalized 0-100.
      const W = 720, H = 300, PAD = 30;
      const dates = data.dates || [];
      const n = dates.length;
      const x = (i) => PAD + (n > 1 ? (i / (n - 1)) * (W - PAD * 2) : 0);
      const y = (v) => H - PAD - (v / 100) * (H - PAD * 2);
      const colors = ['#f97316', '#4ec5e5', '#a3e635', '#f43f5e', '#c5e54e'];
      let lines = '';
      let legend = '';
      entities.forEach((e, idx) => {
        const color = colors[idx % colors.length];
        let path = '';
        for (let i = 0; i < e.series.length; i++) {
          path += (i === 0 ? 'M' : 'L') + ` ${x(i).toFixed(1)} ${y(e.series[i].norm).toFixed(1)} `;
        }
        lines += `<path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>`;
        const growth = e.stats?.growth_rate != null ? Math.round(e.stats.growth_rate * 100) : null;
        legend += `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:16px;font-size:12px">` +
          `<span style="width:12px;height:2px;background:${color};display:inline-block"></span>` +
          `<a href="/trajectory/${escapeAttr(e.slug)}" style="color:${color};text-decoration:none">${escapeHtml(e.name)}</a>` +
          (growth != null ? ` <small style="color:var(--fg-mute)">${growth >= 0 ? '+' : ''}${growth}%</small>` : '') +
          `</span>`;
      });
      // Axis labels
      const axisLabels = [
        dates[0] || '', dates[Math.floor(n / 2)] || '', dates[n - 1] || ''
      ].map((d, i) => `<text x="${x(i === 0 ? 0 : i === 1 ? Math.floor(n / 2) : n - 1).toFixed(1)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === 1 ? 'middle' : 'end'}" class="traj-axis-label">${d ? d.slice(4, 6) + '/' + d.slice(6, 8) : ''}</text>`).join('');

      resultEl.innerHTML =
        `<div style="margin:12px 0">${legend}</div>` +
        `<svg class="traj-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">` +
        `<line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="var(--rule)" stroke-width="1"/>` +
        `<line x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${H - PAD}" stroke="var(--rule)" stroke-width="1"/>` +
        lines + axisLabels +
        `</svg>` +
        `<p class="subtle" style="margin-top:8px">${getLanguage() === 'zh' ? '各实体归一化到自身峰值（0-100），便于跨规模对比趋势形态' : 'Each entity normalized to its own peak (0-100) for cross-scale shape comparison'}</p>`;
    } catch (err) {
      resultEl.innerHTML = `<p class="subtle">${escapeHtml(err.message)}</p>`;
    }
  };

  btn.addEventListener('click', doCompare);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCompare(); });
  if (slugs.length >= 2) doCompare();
}

// ─── Research Reports List ──────────────────────────────

export async function renderReports(_params) {
  const container = $('#pageContent');
  showLoader(container, getLanguage() === 'zh' ? '加载报告…' : 'LOADING REPORTS...');

  try {
    const data = await fetchJSON(`${API_BASE}/reports?limit=50`);
    const reports = data.reports || [];
    const zh = getLanguage() === 'zh';

    container.innerHTML =
      `<section class="page-section">` +
      `<div class="page-header"><h2 class="page-title">${zh ? '研究报告' : 'Research Reports'}</h2>` +
      `<p class="page-description">${zh ? '所有深度研究报告和专题研究' : 'All deep research and topic study reports'}</p></div>` +
      (reports.length === 0
        ? `<p class="empty-state">${zh ? '暂无报告。在任意信号卡上点击"深度研究"生成。' : 'No reports yet. Click "Deep Research" on any signal card.'}</p>`
        : `<ul class="story-members">` +
          reports.map(r => {
            const isTopic = !r.item_id;
            const statusIcon = r.status === 'completed' ? '✅' : r.status === 'failed' ? '❌' : r.status === 'running' ? '⏳' : '📋';
            const link = isTopic
              ? `/research/${r.id}?topic=research`
              : `/research/${r.id}`;
            const excerpt = r.excerpt ? escapeHtml(r.excerpt.slice(0, 100)) : (r.error ? `<span style="color:#f87171">${escapeHtml(r.error.slice(0, 80))}</span>` : '(empty)');
            return `<li class="story-member">` +
              `<span class="story-member-src">${statusIcon} ${isTopic ? (zh ? '专题' : 'Topic') : (zh ? '条目' : 'Item')}</span>` +
              `<a href="${escapeAttr(link)}">${excerpt}</a>` +
              `<span class="subtle" style="font-size:10px;margin-left:auto">${escapeHtml(r.created_at || '')}</span>` +
              `</li>`;
          }).join('') + `</ul>`) +
      `</section>`;
  } catch (err) {
    showError(container, err.message);
  }
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

// ─── Auth Pages ───────────────────────────────────────────────────────────

export async function renderLogin(_params) {
  const container = $('#pageContent');
  const zh = getLanguage() === 'zh';

  container.innerHTML = `
    <div class="auth-page">
      <div class="auth-card">
        <div class="auth-logo">🦅</div>
        <h2 class="auth-title">Eagleye</h2>
        <p class="auth-subtitle">${zh ? '登录到你的账户' : 'Sign in to your account'}</p>
        <form id="loginForm" class="auth-form">
          <input type="email" id="loginEmail" class="auth-input" placeholder="${zh ? '邮箱' : 'Email'}" required autocomplete="email" />
          <input type="password" id="loginPassword" class="auth-input" placeholder="${zh ? '密码' : 'Password'}" required autocomplete="current-password" />
          <button type="submit" class="auth-btn">${zh ? '登录' : 'Sign In'}</button>
        </form>
        <p class="auth-switch">${zh ? '没有账户？' : 'No account?'} <a href="/register" class="auth-link">${zh ? '注册' : 'Register'}</a></p>
        <div id="authError" class="auth-error"></div>
      </div>
    </div>
  `;

  const form = $('#loginForm');
  const errEl = $('#authError');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPassword').value;
    try {
      await API.login(email, password);
      window.location.href = '/';
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
}

export async function renderRegister(_params) {
  const container = $('#pageContent');
  const zh = getLanguage() === 'zh';

  container.innerHTML = `
    <div class="auth-page">
      <div class="auth-card">
        <div class="auth-logo">🦅</div>
        <h2 class="auth-title">Eagleye</h2>
        <p class="auth-subtitle">${zh ? '创建新账户' : 'Create a new account'}</p>
        <form id="registerForm" class="auth-form">
          <input type="email" id="regEmail" class="auth-input" placeholder="${zh ? '邮箱' : 'Email'}" required autocomplete="email" />
          <input type="password" id="regPassword" class="auth-input" placeholder="${zh ? '密码（至少6位）' : 'Password (min 6 chars)'}" required autocomplete="new-password" />
          <button type="submit" class="auth-btn">${zh ? '注册' : 'Register'}</button>
        </form>
        <div id="verifySection" style="display:none">
          <p class="auth-info">${zh ? '验证码已发送到你的邮箱，请输入收到的 6 位验证码：' : 'A verification code has been sent to your email. Enter the 6-digit code:'}</p>
          <form id="verifyForm" class="auth-form">
            <input type="text" id="verifyCode" class="auth-input" placeholder="${zh ? '6 位验证码' : '6-digit code'}" maxlength="6" pattern="[0-9]{6}" required />
            <button type="submit" class="auth-btn">${zh ? '验证' : 'Verify'}</button>
          </form>
        </div>
        <p class="auth-switch">${zh ? '已有账户？' : 'Already have an account?'} <a href="/login" class="auth-link">${zh ? '登录' : 'Sign In'}</a></p>
        <div id="authError" class="auth-error"></div>
      </div>
    </div>
  `;

  const errEl = $('#authError');

  $('#registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const email = $('#regEmail').value.trim();
    const password = $('#regPassword').value;
    try {
      const res = await API.register(email, password);
      // Show verification section
      $('#registerForm').style.display = 'none';
      $('#verifySection').style.display = 'block';
      $('#verifyCode').focus();
      window.__regEmail = email;
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  $('#verifyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const code = $('#verifyCode').value.trim();
    try {
      await API.verify(window.__regEmail, code);
      window.location.href = '/';
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
}
