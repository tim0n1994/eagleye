/**
 * Eagleye — archive page module
 *
 * By-year archive and competitor comparison.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml, normalizeDateStr } from '../utils.js';
import { formatNumber, t } from '../i18n.js';
import { API_BASE, fetchJSON, getItemDisplayTitle, localizedDate, showError, showLoader } from './shared.js';
import { monthLabel, readerError, rt, signalLabel, xt } from '../i18n/reader-extra.js';


// ─── By Year Archive (§7.8) ─────────────────────────────

export async function renderYearArchive(_params) {
  const container = $('#pageContent');
  showLoader(container, xt('reader.loading_years'));
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
            <span>${formatNumber(y.items)} ${t('year.items')}</span>
            <span>${formatNumber(y.sources)} ${t('year.sources')}</span>
          </div>
        </a>`).join('') +
      `</div></section>`;
  } catch (err) { showError(container, readerError(err.message)); }
}

export async function renderYearDetail(params) {
  const container = $('#pageContent');
  const year = params?.year || '';
  showLoader(container, xt('reader.loading_year'));
  try {
    const data = await fetchJSON(`${API_BASE}/year/${encodeURIComponent(year)}`);
    if (data.error) { showError(container, readerError(data.error)); return; }

    const maxItems = Math.max(1, ...(data.by_month || []).map(x => x.items));
    const monthBar = (m) => {
      const pct = Math.round((m.items / maxItems) * 100);
      return `<div class="metrics-bar-row"><span class="metrics-bar-label">${escapeHtml(monthLabel(m.month))}</span>` +
        `<div class="metrics-bar"><div class="metrics-bar-fill" style="width:${pct}%"></div></div>` +
        `<span class="metrics-bar-pct">${formatNumber(m.items)}</span></div>`;
    };
    const srcRow = (s) => `<tr><td>${escapeHtml(String(s.label || ''))}</td><td>${formatNumber(s.items)}</td><td>${formatNumber(s.high_alpha || 0)}</td></tr>`;
    const itemRow = (it) =>
      `<li class="story-member"><span class="story-member-src">${escapeHtml(it.source_label || '')}</span>` +
      `<a href="/signals/${escapeAttr(it.id)}">${escapeHtml(getItemDisplayTitle(it).slice(0, 100))}</a></li>`;

    container.innerHTML =
      `<section class="page-section">` +
      `<div class="page-header"><a href="/year" class="anchor-link">← ${t('year.title')}</a>` +
      `<h2 class="page-title">${escapeHtml(year)} <small>${formatNumber(data.total)} ${t('year.items')}</small></h2></div>` +
      `<div class="metrics-block"><h3 class="metrics-block-title">${t('year.by_month')}</h3>` +
      `<ul class="metrics-bars">${(data.by_month || []).map(monthBar).join('')}</ul></div>` +
      `<div class="metrics-block"><h3 class="metrics-block-title">${t('year.top_types')}</h3>` +
      `<div class="metrics-stat-grid">${(data.top_types || []).map(ty => `<div class="metric-stat"><div class="metric-stat-value">${formatNumber(ty.count)}</div><div class="metric-stat-label">${escapeHtml(signalLabel(ty.signal_type))}</div></div>`).join('')}</div></div>` +
      `<div class="metrics-block"><h3 class="metrics-block-title">${t('year.by_source')}</h3>` +
      `<table class="metrics-table"><thead><tr><th>${t('industry.source')}</th><th>${t('year.items')}</th><th>${t('year.high_alpha')}</th></tr></thead>` +
      `<tbody>${(data.by_source || []).map(srcRow).join('')}</tbody></table></div>` +
      `<div class="metrics-block"><h3 class="metrics-block-title">${t('year.top_items')}</h3>` +
      `<ul class="story-members">${(data.top_items || []).slice(0, 15).map(itemRow).join('')}</ul></div>` +
      `</section>`;
  } catch (err) { showError(container, readerError(err.message)); }
}

// ─── Compare (§7.9) ─────────────────────────────────────

export async function renderCompare(_params) {
  const container = $('#pageContent');
  showLoader(container, xt('reader.loading_compare'));
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
      dims.map(d => `<tr><td class="compare-feature">${escapeHtml(rt(d.label))}</td>` +
        competitors.map(c => `<td class="${c === 'eagleye' ? 'compare-eagleye' : ''}">${escapeHtml(rt(d[c] || '—'))}</td>`).join('') +
        `</tr>`).join('') +
      `</tbody></table></div>` +
      `<div class="metrics-block"><h3 class="metrics-block-title">${t('compare.personas')}</h3>` +
      `<div class="persona-grid">` +
      personas.map(p => `<div class="persona-card"><h4>${escapeHtml(rt(p.label))}</h4>` +
        `<p class="persona-best"><strong>${escapeHtml(compLabels[p.best] || p.best)}</strong></p>` +
        `<p class="persona-why">${escapeHtml(rt(p.why))}</p></div>`).join('') +
      `</div></div></section>`;
  } catch (err) { showError(container, readerError(err.message)); }
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
    `<div class="page-header"><h2 class="page-title">${xt('reader.entity_compare_title')}</h2>` +
    `<p class="page-description">${xt('reader.entity_compare_subtitle')}</p></div>` +
    `<div class="search-box" style="max-width:600px;margin-bottom:12px">` +
    `<input type="text" id="entityCompareInput" placeholder="${escapeAttr(xt('reader.entity_compare_placeholder'))}" value="${escapeAttr(slugs.join(','))}" style="flex:1"/>` +
    `<button class="action-btn" id="entityCompareBtn">${xt('reader.compare')}</button></div>` +
    // Quick-add chips from the momentum leaderboard.
    ((topEntities.entities || []).length > 0
      ? `<div style="margin-bottom:12px"><span class="subtle" style="font-size:11px">${xt('reader.top_entities')}</span><br/>` +
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
    if (!s) { resultEl.innerHTML = `<p class="subtle">${xt('reader.enter_entity_slugs')}</p>`; return; }
    resultEl.innerHTML = `<p class="subtle">${xt('reader.loading_entities')}</p>`;
    try {
      const data = await fetchJSON(`${API_BASE}/entities/compare?slugs=${encodeURIComponent(s)}`);
      const entities = data.entities || [];
      if (entities.length < 2) { resultEl.innerHTML = `<p class="subtle">${xt('reader.need_valid_entities')}</p>`; return; }
      // Render overlay chart: each entity is a line, normalized 0-100.
      const W = 720, H = 300, PAD = 30;
      const dates = data.dates || [];
      const n = dates.length;
      const x = (i) => PAD + (n > 1 ? (i / (n - 1)) * (W - PAD * 2) : 0);
      const y = (v) => H - PAD - (v / 100) * (H - PAD * 2);
      const colors = ['var(--accent)', 'var(--sea)', 'var(--olive)', 'var(--color-error)', 'var(--olive)'];
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
          (growth != null ? ` <small style="color:var(--fg-mute)">${growth >= 0 ? '+' : ''}${formatNumber(growth)}%</small>` : '') +
          `</span>`;
      });
      // Axis labels
      const axisLabels = [
        dates[0] || '', dates[Math.floor(n / 2)] || '', dates[n - 1] || ''
      ].map((d, i) => {
        const iso = normalizeDateStr(d);
        return `<text x="${x(i === 0 ? 0 : i === 1 ? Math.floor(n / 2) : n - 1).toFixed(1)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === 1 ? 'middle' : 'end'}" class="traj-axis-label">${iso ? localizedDate(iso, { month: 'short', day: 'numeric' }) : ''}</text>`;
      }).join('');

      resultEl.innerHTML =
        `<div style="margin:12px 0">${legend}</div>` +
        `<svg class="traj-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">` +
        `<line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="var(--rule)" stroke-width="1"/>` +
        `<line x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${H - PAD}" stroke="var(--rule)" stroke-width="1"/>` +
        lines + axisLabels +
        `</svg>` +
        `<p class="subtle" style="margin-top:8px">${xt('reader.entities_normalized')}</p>`;
    } catch (err) {
      resultEl.innerHTML = `<p class="subtle">${escapeHtml(readerError(err.message))}</p>`;
    }
  };

  btn.addEventListener('click', doCompare);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCompare(); });
  if (slugs.length >= 2) doCompare();
}
