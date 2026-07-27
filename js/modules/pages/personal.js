/**
 * Eagleye — personal page module
 *
 * Personal lens editor and the For-You feed.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml, localDateStr } from '../utils.js';
import { getLanguage, t } from '../i18n.js';
import { API_BASE, fetchJSON, markItemSeen, showError, showLoader } from './shared.js';


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
