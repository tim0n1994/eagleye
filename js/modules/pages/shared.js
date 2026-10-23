/**
 * Eagleye — shared page module
 *
 * Helpers and card renderers used across every page: fetch wrapper, title selection, source ordering, loaders and the three item card shapes.
 * Split out of pages.js; render functions are unchanged.
 */

import { escapeAttr, escapeHtml, timeAgo } from '../utils.js';
import { getLanguage, t } from '../i18n.js';
import { renderMarkdown } from '../markdown.js';


// ─── Utility ────────────────────────────────────────────

export function showLoader(container, msg = 'LOADING...') {
  container.innerHTML = `<div class="page-loading"><div class="spinner"></div><span>${msg}</span></div>`;
}

export function showError(container, msg) {
  container.innerHTML = `<div class="page-error">⚠ ${escapeHtml(msg)}</div>`;
}

export const API_BASE = '/api';

export async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function renderMarkdownLite(md) {
  return renderMarkdown(md, t('common.empty'));
}

export function localizedDate(d, opts) {
  try {
    return d.toLocaleDateString(getLanguage() === 'zh' ? 'zh-CN' : 'en-US', opts);
  } catch {
    return d.toLocaleDateString('en-US', opts);
  }
}

export function tagHref(tag) {
  return `/tags/${encodeURIComponent(tag?.slug || tag?.name || '')}`;
}

/**
 * Cache of sources (slug, label, icon, total, today) for the source tab nav.
 * Refreshed on first use; invalidated when language changes (UI re-renders anyway).
 */
// Exported as a live binding so other page modules can read it. Assignment
// through an import binding is illegal in ES modules, so writers call
// setSourcesCache() instead of assigning.
export let _sourcesCache = null;

export function setSourcesCache(list) {
  _sourcesCache = list;
}
export async function getSourcesCached() {
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
export function pickZh(enVal, zhVal) {
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

export function getItemDisplayTitle(item) {
  const summary = item?.ai_summary || {};
  const zhTitle = firstText(summary.ai_title_zh, item?.title_zh, summary.title_zh);
  const enTitle = firstText(summary.ai_title, item?.title);
  const localized = firstText(pickZh(enTitle, zhTitle), zhTitle, enTitle);
  if (!isLowSignalTitle(localized)) return localized;
  return buildFallbackTitle(item);
}

export function orderedSourceEntries(bySourceMap, sources) {
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

export function sourceIcon(slug, fallback) {
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
        <a class="mini-action mini-action-link" href="${escapeAttr(item.canonical_url || '#')}" target="_blank" rel="noopener">${escapeHtml(originalLabel)} ↗</a>
      </div>
    </article>
  `;
}

// Trust badge for source quality (Phase 3.A): surfaces source_profiles.source_type
// so readers can weigh "is this hype?" against the source's noise profile.
// early_signal/originator → green; noisy → red (down-weighted); amplifier → muted.
export function trustBadge(sourceType, noiseRate) {
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
