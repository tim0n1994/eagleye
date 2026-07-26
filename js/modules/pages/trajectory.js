/**
 * Eagleye — trajectory page module
 *
 * Entity trend trajectory with sparkline and burst highlighting.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml } from '../utils.js';
import { getLanguage, t } from '../i18n.js';
import { API_BASE, fetchJSON, showError, showLoader } from './shared.js';


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
