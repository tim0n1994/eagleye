/**
 * Eagleye — intelligence page module
 *
 * Entity momentum, trending topics and the industry metrics dashboard.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml } from '../utils.js';
import { KnowledgeGraph } from '../graph-viz.js';
import { getLanguage, t } from '../i18n.js';
import { API_BASE, fetchJSON, pickZh, showError, showLoader } from './shared.js';


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
              // /api/topics answers { status, topics: [...] }, not a bare array —
              // line ~121 below already unwraps it. Treating the envelope as an
              // array made .reduce throw and blanked the whole page.
              const topicsData = topicsResp?.topics || [];
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
