/**
 * Eagleye — signals page module
 *
 * The alpha radar: signal list, type filters, audience tabs and the detail pane.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml, localDateStr, normalizeDateStr } from '../utils.js';
import { getLanguage, t } from '../i18n.js';
import { router } from '../router.js';
import { API_BASE, fetchJSON, pickZh, showError, showLoader, trustBadge } from './shared.js';

const SIGNAL_LIMIT = 2000;
const scoreValue = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const scorePercent = value => scoreValue(value) === null ? '—' : (value * 100).toFixed(0);
const scoreWidth = value => scoreValue(value) === null ? 0 : Math.max(0, Math.min(100, value * 100));
let pageVersion = 0;

function beginSignalPage() {
  const version = ++pageVersion;
  let active = true;
  router.onCleanup(() => { active = false; });
  return () => active && pageVersion === version;
}

function signalHref({ type = 'all', audience = '', range = '7' }) {
  const query = new URLSearchParams();
  if (type !== 'all') query.set('type', type);
  if (audience) query.set('audience', audience);
  if (range !== '7') query.set('range', range);
  return `/signals${query.size ? '?' + query.toString() : ''}`;
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
  const isCurrent = beginSignalPage();
  showLoader(container, 'LOADING SIGNALS...');

  try {
    const typesData = await loadSignalTypes();
    const selectedType = _params?.type || 'all';
    const selectedAudience = _params?.audience || '';
    const urlSearch = new URLSearchParams(window.location.search);
    const requestedRange = _params?.range || urlSearch.get('range') || '7';
    const selectedRange = ['1', '7', '30', '9999'].includes(requestedRange) ? requestedRange : '7';
    const filterHref = changes => signalHref({ type: selectedType, audience: selectedAudience, range: selectedRange, ...changes });

    // Audience lens (Phase 2): fetch the weight definitions for the tab bar.
    const audiences = await loadRadarAudiences();

    const params = new URLSearchParams({ sinceDays: selectedRange, limit: String(SIGNAL_LIMIT) });
    if (selectedType !== 'all') params.set('type', selectedType);
    if (selectedAudience) params.set('audience', selectedAudience);
    const signalData = await fetchJSON(`${API_BASE}/signals?${params.toString()}`);

    const signals = signalData.signals || [];
    const filteredSignals = signals;
    const cardScore = s => scoreValue(selectedAudience ? s.alpha_score_audience : s.alpha_score);
    const scores = signals.map(cardScore).filter(value => value !== null);

    const avgAlpha = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;
    const topAlpha = scores.length ? Math.max(...scores) : null;
    const typeCounts = {};
    for (const s of signals) { if (s.signal_type) typeCounts[s.signal_type] = (typeCounts[s.signal_type] || 0) + 1; }
    const topTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const zh = getLanguage() === 'zh';
    // Velocity trend sparkline: avg velocity per day over the loaded window.
    const dayMap = {};
    for (const s of signals) {
      if (!s.digest_date || scoreValue(s.velocity_score) === null) continue;
      const dayKey = normalizeDateStr(s.digest_date);
      if (!dayMap[dayKey]) dayMap[dayKey] = { count: 0, velSum: 0 };
      dayMap[dayKey].count++;
      dayMap[dayKey].velSum += s.velocity_score;
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
    const todayKey = normalizeDateStr(localDateStr());
    const todayScores = signals.filter(s => normalizeDateStr(s.digest_date) === todayKey).map(cardScore).filter(value => value !== null);
    const todayAvgAlpha = todayScores.length ? todayScores.reduce((sum, value) => sum + value, 0) / todayScores.length : null;
    const trendArrow = todayAvgAlpha === null ? '—' : todayAvgAlpha > avgAlpha + 0.02 ? '▲▲' : todayAvgAlpha >= avgAlpha - 0.02 ? '●' : '▼';
    const trendColor = trendArrow === '▲▲' ? '#34d399' : trendArrow === '▼' ? '#f87171' : 'var(--fg-mute)';
    const trendText = todayAvgAlpha === null ? (zh ? '今日暂无可评分样本' : 'No scored sample today') : trendArrow === '▲▲' ? (zh ? '今日上升' : 'Rising today') : trendArrow === '●' ? (zh ? '平稳' : 'Stable') : (zh ? '今日下降' : 'Declining today');

    // Rising entities (Phase 2): the entity currently accelerating fastest.
    // Ranked by acceleration on the 7d window; falls back to zscore.
    const risingData = await fetchJSON(`${API_BASE}/entities/momentum?window=7d&sort=acceleration&limit=8`).catch(() => ({ entities: [] }));
    const rising = risingData.entities || [];

    // Audience tab bar — switches the reweight lens for the whole page.
    const rangeTabs = `
      <div class="range-tabs">
        ${[['1', '24h'], ['7', '7d'], ['30', '30d'], ['9999', 'All']].map(([val, label]) => {
          const active = selectedRange === val;
          return `<a href="${escapeAttr(filterHref({ range: val }))}" class="range-tab ${active ? 'active' : ''}">${label}</a>`;
        }).join('')}
      </div>`;
    const audienceTabs = `
      <div class="audience-tabs">
        <a href="${escapeAttr(filterHref({ audience: '' }))}" class="audience-tab ${selectedAudience === '' ? 'active' : ''}">All</a>
        ${audiences.map(a => `
          <a href="${escapeAttr(filterHref({ audience: a.key }))}"
             class="audience-tab ${selectedAudience === a.key ? 'active' : ''}"
             title="${escapeAttr(pickZh(a.description, a.description_zh))}">
            ${escapeHtml(pickZh(a.label, a.label_zh))}
          </a>
        `).join('')}
      </div>
      ${rangeTabs}`;

    const exportParams = params;

    // Alpha distribution mini-histogram: computed before the template to avoid nesting.
    const alphaBuckets = [0, 0, 0, 0];
    for (const s of filteredSignals) {
      const a = cardScore(s);
      if (a === null) continue;
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
        <a href="${API_BASE}/signals?${escapeAttr(exportParams.toString())}" download="signals.json" class="action-link" style="font-size:11px;margin:4px 0;display:inline-block">⬇ Export JSON</a>
        <p class="subtle signal-sample-note">${zh ? `已加载 ${signals.length} 条（最多 ${SIGNAL_LIMIT} 条）；统计及导出基于当前筛选样本。` : `Loaded ${signals.length} signals (limit ${SIGNAL_LIMIT}); statistics and export use the current filtered sample.`}${signals.length >= SIGNAL_LIMIT ? (zh ? ' 已达到上限，可能还有更多结果。' : ' Limit reached; more results may exist.') : ''} ${zh ? `可评分 ${scores.length} 条，缺分 ${signals.length - scores.length} 条。` : `${scores.length} scored, ${signals.length - scores.length} missing scores.`}</p>
        ${alphaHistHtml}
        ${signals.length > 0 ? `<div style="display:flex;gap:16px;flex-wrap:wrap;margin:4px 0 12px;font-size:11px;font-family:var(--font-mono);color:var(--fg-mute)">
          <span>${zh ? '已加载' : 'Loaded'}: <strong style="color:var(--fg)">${signals.length}</strong></span>
          <span>${zh ? '平均 α' : 'Avg α'}: <strong class="signal-avg-alpha" style="color:var(--accent)">${avgAlpha === null ? '—' : avgAlpha.toFixed(2)}</strong></span>
          <span>${zh ? '最高 α' : 'Top α'}: <strong class="signal-top-alpha" style="color:var(--accent)">${topAlpha === null ? '—' : topAlpha.toFixed(2)}</strong></span>
          <span class="signal-quality-trend" title="${zh ? '今日样本均分与当前加载窗口均分比较' : 'Today’s sample mean compared with the loaded window mean'}">${zh ? '样本质量趋势' : 'Sample quality trend'}: <strong style="color:${trendColor}">${trendArrow}</strong> <small style="color:var(--fg-mute)">${trendText}</small>${velSparkHtml}</span>
          ${topTypes.length > 0 ? `<span>${zh ? '热门类型' : 'Top types'}: ${topTypes.map(([t, c]) => escapeHtml(t.replace(/_/g, ' ')) + '(' + c + ')').join(', ')}</span>` : ''}
        </div>` : ''}
        ${typeDonutHtml}
        <div class="signals-left">
          <div class="signals-type-filter">
            <h3 class="signals-filter-title">SIGNAL TYPES</h3>
            <p class="subtle">${zh ? '计数：当前加载样本' : 'Counts: current loaded sample'}</p>
            <a href="${escapeAttr(filterHref({ type: 'all' }))}" class="signal-type-item ${selectedType === 'all' ? 'active' : ''}">
              <span class="st-icon">🔄</span>
              <span class="st-name">All Signals</span>
              <span class="st-count">${signals.length}</span>
            </a>
            ${typesData.map(t => `
              <a href="${escapeAttr(filterHref({ type: t.slug }))}" class="signal-type-item ${selectedType === t.slug ? 'active' : ''}">
                <span class="st-icon">${escapeHtml(t.icon || '📡')}</span>
                <span class="st-name">${escapeHtml(pickZh(t.name, t.name_zh))}</span>
                <span class="st-count">${selectedType !== 'all' && selectedType !== t.slug ? '—' : typeCounts[t.slug] || 0}</span>
              </a>
            `).join('')}
          </div>
          <div class="signals-rising">
            <h3 class="signals-filter-title">${zh ? '已保存实体动量' : 'Stored entity momentum'}</h3>
            <p class="subtle">${zh ? '已保存的 7 日窗口指标；更新时间未知。' : 'Saved 7-day window metrics; update time unavailable.'}</p>
            ${rising.length === 0 ? `<p class="empty-state-sm">${zh ? '暂无已保存的动量数据。' : 'No stored momentum data available.'}</p>` : ''}
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
          ${filteredSignals.length === 0 ? `<div class="empty-state signal-empty-state"><p>${zh ? '当前筛选条件下没有信号。' : 'No signals match the current filters.'}</p><a class="action-link" href="${escapeAttr(filterHref({ range: '9999' }))}">${zh ? '查看全部时间' : 'View all time'}</a> · <a class="action-link" href="/settings">${zh ? '查看设置' : 'Open settings'}</a></div>` : ''}
          ${filteredSignals.map(s => {
            const st = typesData.find(t => t.slug === s.signal_type) || {};
            const score = cardScore(s);
            return `
              <article class="signal-card" data-signal-id="${escapeAttr(s.item_id)}">
                <div class="signal-card-top">
                  <span class="signal-type-badge" data-type="${escapeAttr(s.signal_type)}">${escapeHtml(st.icon || '📡')} ${escapeHtml(pickZh(st.name, st.name_zh) || s.signal_type)}</span>
                  <span class="signal-alpha" title="${selectedAudience ? `Audience score (base ${scorePercent(s.alpha_score)})` : 'Alpha Score'}">${scorePercent(score)}</span>
                </div>
                <h4 class="signal-card-title">
                  <a href="${escapeAttr(s.canonical_url || '#')}" target="_blank" rel="noopener">${escapeHtml(s.ai_title || s.title || '')}</a>
                </h4>
                ${s.one_liner || s.short_summary ? `<p class="signal-card-oneliner">${escapeHtml(s.one_liner || s.short_summary || '')}</p>` : ''}
                <div class="signal-card-meta">
                  <span class="signal-source">${escapeHtml(s.source_label || '')}${trustBadge(s.source_type, s.noise_rate)}</span>
                  <span class="signal-scores">
                    N:${scorePercent(s.novelty_score)} V:${scorePercent(s.velocity_score)} CS:${scorePercent(s.cross_source_score)} SQ:${scorePercent(s.source_quality_score)}
                  </span>
                </div>
                <div class="signal-alpha-bar" title="Alpha score ${scorePercent(score)}">
                  <div class="signal-alpha-fill" style="width:${scoreWidth(score)}%;background:${score >= 0.85 ? 'var(--accent)' : score >= 0.7 ? '#facc15' : 'var(--fg-mute)'}"></div>
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

    if (!isCurrent()) return;
    container.innerHTML = html;
    let detailRequest = 0;

    // Click handler for signal cards
    container.querySelectorAll('.signal-card').forEach(card => {
      card.addEventListener('click', async (e) => {
        if (e.target.closest('a, button') || !isCurrent()) return;
        const itemId = card.dataset.signalId;
        const detail = $('#signalsDetail');
        if (!detail || !itemId) return;
        const request = ++detailRequest;

        detail.innerHTML = '<div class="spinner"></div>';
        container.querySelectorAll('.signal-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');

        try {
          const data = await fetchJSON(`${API_BASE}/signals/${encodeURIComponent(itemId)}`);
          if (!isCurrent() || request !== detailRequest || !detail.isConnected) return;
          renderSignalDetailPane(detail, data.signal || data, typesData);
        } catch (err) {
          if (isCurrent() && request === detailRequest && detail.isConnected) detail.innerHTML = `<p class="error">Error: ${escapeHtml(err.message)}</p>`;
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
    if (isCurrent()) showError(container, err.message);
  }
}

async function loadRadarAudiences() {
  try {
    const data = await fetchJSON(`${API_BASE}/radar/audiences`);
    return data.audiences || [];
  } catch { return []; }
}

function renderSignalDetailPane(container, signal, typesData) {
  const st = typesData?.find(t => t.slug === signal.signal_type) || {};
  const entities = signal.entities || [];
  const topics = signal.topics || [];

  container.innerHTML = `
    <div class="signal-detail-inner">
      <div class="signal-detail-header">
        <span class="signal-type-badge large" data-type="${escapeAttr(signal.signal_type)}">${escapeHtml(st.icon || '📡')} ${escapeHtml(pickZh(st.name, st.name_zh) || signal.signal_type)}</span>
        <span class="signal-alpha large">Base Alpha: ${scorePercent(signal.alpha_score)}</span>
      </div>
      <h3 class="signal-detail-title">
        <a href="${escapeAttr(signal.canonical_url || '#')}" target="_blank" rel="noopener">${escapeHtml(signal.ai_title || signal.title || '')}</a>
      </h3>
      ${signal.short_summary || signal.one_liner ? `<p class="signal-detail-summary">${escapeHtml(signal.short_summary || signal.one_liner)}</p>` : ''}

      <div class="signal-score-breakdown">
        <h4>Score Breakdown</h4>
        <div class="score-bars">
          ${[['Novelty', 'novelty_score'], ['Velocity', 'velocity_score'], ['Cross-Source', 'cross_source_score'], ['Source Quality', 'source_quality_score'], ['Thesis Match', 'thesis_match_score'], ['Consensus Penalty', 'consensus_penalty']].map(([label, key]) => {
            const penalty = key === 'consensus_penalty';
            return `<div class="score-row ${penalty ? 'penalty' : ''}"><span>${label}</span><span class="score-bar-wrap"><span class="score-bar ${penalty ? 'penalty' : key === 'thesis_match_score' ? 'thesis' : ''}" style="width:${scoreWidth(signal[key])}%"></span></span><span>${penalty && scoreValue(signal[key]) !== null ? '-' : ''}${scorePercent(signal[key])}</span></div>`;
          }).join('')}
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

      ${(() => {
        // SVG radar chart for the 6 score dimensions.
        const dims = [
          { label: 'Novelty', val: scoreValue(signal.novelty_score) },
          { label: 'Velocity', val: scoreValue(signal.velocity_score) },
          { label: 'Cross-Src', val: scoreValue(signal.cross_source_score) },
          { label: 'Source-Q', val: scoreValue(signal.source_quality_score) },
          { label: 'Thesis', val: scoreValue(signal.thesis_match_score) },
          { label: 'Action', val: scoreValue(signal.actionability_score) },
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
          (dims.every(d => d.val !== null) ? `<polygon points="${dataPts}" fill="var(--accent)" fill-opacity="0.2" stroke="var(--accent)" stroke-width="1.5"/>` : '') +
          labels +
          `</svg>` +
          `<div style="font-size:11px;font-family:var(--font-mono);color:var(--fg-mute);line-height:1.8">` +
          dims.map(d => `${d.label}: <strong style="color:var(--fg)">${scorePercent(d.val)}</strong>`).join('<br/>') +
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
  const isCurrent = beginSignalPage();
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

    if (!isCurrent()) return;
    container.innerHTML = html;

    const detailEl = container.querySelector('#signalDetailFull');
    if (detailEl) renderSignalDetailPane(detailEl, signal, typesData);

    // Async: load related signals (same signal_type, high alpha, different item).
    if (signal.signal_type && signal.signal_type !== 'uncategorized') {
      fetchJSON(`${API_BASE}/signals?type=${encodeURIComponent(signal.signal_type)}&sinceDays=7&limit=10`).then(relData => {
        if (!isCurrent()) return;
        const related = (relData.signals || []).filter(s => s.item_id !== signal.item_id).slice(0, 5);
        if (related.length === 0) return;
        const relDiv = document.createElement('div');
        relDiv.className = 'metrics-block';
        relDiv.style.marginTop = '20px';
        relDiv.innerHTML =
          `<h3 class="metrics-block-title">${getLanguage() === 'zh' ? '相关信号' : 'Related Signals'}</h3>` +
          `<ul class="story-members">` +
          related.map(r => `<li class="story-member">` +
            `<span class="story-member-src">α${scoreValue(r.alpha_score) === null ? '—' : r.alpha_score.toFixed(2)}</span>` +
            `<a href="/signals/${escapeAttr(r.item_id)}">${escapeHtml((r.ai_title || r.title || '').slice(0, 80))}</a>` +
            `</li>`).join('') +
          `</ul>`;
        detailEl?.appendChild(relDiv);
      }).catch(() => {});
    }

  } catch (err) {
    if (isCurrent()) showError(container, err.message);
  }
}
