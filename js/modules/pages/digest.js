/**
 * Eagleye — digest page module
 *
 * Daily digest index and a single day's full AI briefing.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml, localDateStr, normalizeDateStr } from '../utils.js';
import { getLanguage, t } from '../i18n.js';
import { API_BASE, fetchJSON, getSourcesCached, localizedDate, orderedSourceEntries, pickZh, renderItemMiniCard, setSourcesCache, showError, showLoader } from './shared.js';
import { isStaleSource } from './sources.js';

// D4: title attribute shared by the stale (🔴) markers below.
const staleTitle = () => (getLanguage() === 'zh' ? '启用中但超过 48 小时无成功抓取' : 'Enabled but no successful fetch in over 48h');


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
        count: dateCoverage[normalizeDateStr(dateStr)] || 0,
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
    // D4: the sources list (SELECT s.* carries last_fetched_at) drives source
    // ordering and the stale-source badges below. getSourcesCached() caches
    // an empty list for the whole SPA session after one transient
    // /api/sources failure — re-fetch once in that case instead of rendering
    // the day view without health data.
    let sources = await getSourcesCached();
    if (!Array.isArray(sources) || sources.length === 0) {
      try {
        sources = (await fetchJSON(`${API_BASE}/sources`)).sources || [];
        setSourcesCache(sources);
      } catch { /* keep [] and render without health data */ }
    }
    const data = await fetchJSON(`${API_BASE}/digest?date=${date}`);

    // Build prev/next dates
    const d = new Date(normalizeDateStr(date));
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
              const cached = sources.find(s => s.slug === firstItem.source_slug);
              const displayName = cached ? pickZh(cached.label, cached.label_zh) : (firstItem.source_label || source);
              // D4: flag sources whose last successful fetch is >48h old.
              const rowStale = cached ? isStaleSource(cached) : false;
              return '<div class="metrics-bar-row"><span class="metrics-bar-label">' + escapeHtml(displayName) +
                (rowStale ? `<span class="stale-badge" title="${staleTitle()}"> 🔴</span>` : '') + '</span>' +
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
            const cached = sourceObjFromOrder || (slug ? sources.find(s => s.slug === slug) : null);
            const displayName = cached ? pickZh(cached.label, cached.label_zh) : (firstItem.source_label || source);
            // D4: flag sources whose last successful fetch is >48h old.
            const stale = cached ? isStaleSource(cached) : false;
            return `
            <section class="source-section">
              <div class="source-section-header">
                <h3 class="source-section-title${stale ? ' source-stale' : ''}">${escapeHtml(displayName)}${stale ? ` <span class="stale-badge" title="${staleTitle()}">🔴</span>` : ''}</h3>
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
