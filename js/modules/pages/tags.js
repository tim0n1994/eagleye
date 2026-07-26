/**
 * Eagleye — tags page module
 *
 * Tag index and tag detail.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml } from '../utils.js';
import { KnowledgeGraph } from '../graph-viz.js';
import { getLanguage, t } from '../i18n.js';
import { API_BASE, fetchJSON, renderItemMiniCard, showError, showLoader, tagHref } from './shared.js';


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
