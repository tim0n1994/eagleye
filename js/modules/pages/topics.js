/**
 * Eagleye — topics page module
 *
 * Topic index, topic detail and the standalone topic page.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml } from '../utils.js';
import { KnowledgeGraph } from '../graph-viz.js';
import { router } from '../router.js';
import { getLanguage, t } from '../i18n.js';
import { API_BASE, fetchJSON, getItemDisplayTitle, pickZh, renderItemCard, showError, showLoader } from './shared.js';


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
    router.onCleanup(() => window.removeEventListener('resize', resizeHandler));

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
