/**
 * Eagleye — sources page module
 *
 * Source index and per-source detail.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml } from '../utils.js';
import { getLanguage, t } from '../i18n.js';
import { progressiveSourceFeed } from '../progressive.js';
import { API_BASE, fetchJSON, hydrateSourceNavPills, pickZh, renderItemMiniCard, renderSourceNav, showError, showLoader, sourceIcon, trustBadge , setSourcesCache } from './shared.js';


// ─── Sources ──────────────────────────────────────────────

export async function renderSources(_params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING SOURCES...' : t('common.loading'));

  try {
    const data = await fetchJSON(`${API_BASE}/sources`);
    setSourcesCache(data.sources || []);

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
