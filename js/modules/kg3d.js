/**
 * Eagleye — 4-Level Hierarchical 3D Knowledge Graph
 * 
 * Dual-panel layout: left searchable tree + right 3D force graph.
 * Tree nodes click → camera flies to node in 3D view.
 * 3D node click → popover shows detail.
 */

import { $, escapeHtml, escapeAttr } from './utils.js';
import { API } from './api.js';
import { showLoader, showError } from './pages.js';
import { t } from './i18n.js';

const COLORS = {
  domain:   0xe65100,
  topic:    0xff9800,
  subtopic: 0x66bb6a,
  tag:      0x42a5f5,
};

const RADIUS = { domain: 30, topic: 20, subtopic: 11, tag: 6 };
const LEVEL_CLASS = { domain: 'l1', topic: 'l2', subtopic: 'l3', tag: 'l4' };

let _graph = null;
let _data = null;
const _childrenMap = {};
const _nodeById = {};

export async function renderKG3D(_params) {
  const container = $('#pageContent');
  if (!container) return;

  if (typeof window.ForceGraph3D !== 'function') {
    container.innerHTML = '<section class="page-section"><p class="error">3D graph library failed to load. Check network.</p></section>';
    return;
  }

  showLoader(container, t('common.loading'));

  try {
    _data = await API.fetchGraph3D();
    _data.nodes = _data.nodes || [];
    _data.edges = _data.edges || [];
    _data.tagItems = _data.tagItems || {};

    const html = `
      <section class="page-section kg3d-layout" id="kg3dLayout">
        <div class="kg3d-header">
          <h2>🧠 ${t('kg3d.title')}</h2>
          <button class="action-btn" id="kg3dFullscreen" style="margin-left:auto">⛶ Fullscreen</button>
        </div>
        <div class="kg3d-tree-panel">
          <div class="kg3d-tree-search">
            <input type="text" id="kg3dTreeSearch" placeholder="${t('kg3d.search_ph')}" autocomplete="off">
          </div>
          <div class="kg3d-tree-body" id="kg3dTreeBody"></div>
        </div>
        <div class="kg3d-canvas" id="kg3dContainer">
          <div class="kg3d-canvas-popover" id="kg3dPopover"></div>
        </div>
      </section>
    `;
    container.innerHTML = html;

    // Wire fullscreen toggle: uses the Fullscreen API on the layout section.
    const fsBtn = document.getElementById('kg3dFullscreen');
    if (fsBtn) {
      fsBtn.addEventListener('click', () => {
        const layout = document.getElementById('kg3dLayout');
        if (!layout) return;
        if (!document.fullscreenElement) {
          layout.requestFullscreen?.().then(() => {
            fsBtn.textContent = '⛶ Exit';
            layout.classList.add('kg3d-fullscreen-active');
          }).catch(() => {});
        } else {
          document.exitFullscreen?.().then(() => {
            fsBtn.textContent = '⛶ Fullscreen';
            layout.classList.remove('kg3d-fullscreen-active');
          }).catch(() => {});
        }
      });
      document.addEventListener('fullscreenchange', () => {
        const layout = document.getElementById('kg3dLayout');
        if (!document.fullscreenElement && layout) {
          fsBtn.textContent = '⛶ Fullscreen';
          layout.classList.remove('kg3d-fullscreen-active');
        }
      });
    }

    if (!_data.nodes.length) {
      $('#kg3dContainer').innerHTML = '<p class="graph-placeholder">' + t('kg3d.empty') + '</p>';
      return;
    }

    init3DGraph();
    buildTree();
    wireSearch();
  } catch (err) {
    showError(container, err.message);
  }
}

// ── 3D Graph ─────────────────────────────────────────

function init3DGraph() {
  const graphEl = $('#kg3dContainer');
  if (!graphEl) return;

  const nodes = _data.nodes;
  const links = _data.edges;
  const tagItems = _data.tagItems;

  // Index nodes by id
  nodes.forEach(n => _nodeById[n.id] = n);

  // Build children map from edges
  links.forEach(l => {
    const src = typeof l.source === 'object' ? l.source.id : l.source;
    const tgt = typeof l.target === 'object' ? l.target.id : l.target;
    const srcNode = _nodeById[src];
    const tgtNode = _nodeById[tgt];
    if (!srcNode || !tgtNode) return;
    // Hierarchy: child → parent
    if (l.type === 'tag_belongs_subtopic' || l.type === 'tag_weak_signal_subtopic') { addChild(tgtNode, srcNode); }
    else if (l.type === 'subtopic_belongs_topic') { addChild(tgtNode, srcNode); }
    else if (l.type === 'topic_belongs_domain') { addChild(tgtNode, srcNode); }
  });

  const graph = window.ForceGraph3D()(graphEl)
    .graphData({ nodes, links })
    .nodeColor(n => COLORS[n.type] || 0x999999)
    .nodeLabel(n => {
      if (n.type === 'tag') return `🏷️ ${n.labelZh} (${n.itemCount || 0})`;
      if (n.type === 'domain') return `🌐 ${n.labelZh}`;
      if (n.type === 'topic') return `📂 ${n.labelZh}`;
      return `◆ ${n.labelZh}`;
    })
    .nodeVal(n => RADIUS[n.type] || 5)
    .linkWidth(l => {
      if (l.type === 'topic_belongs_domain') return 2.5;
      if (l.type === 'subtopic_belongs_topic') return 1.5;
      if (l.type === 'tag_belongs_subtopic') return 0.7;
      if (l.type === 'tag_weak_signal_subtopic') return 0.25;
      if (l.type === 'tag_cooccur') return Math.max(0.3, (l.weight || 1) * 0.3);
      return 0.6;
    })
    .linkColor(l => {
      if (l.type === 'topic_belongs_domain') return 0xe65100;
      if (l.type === 'subtopic_belongs_topic') return 0xff9800;
      if (l.type === 'tag_belongs_subtopic') return 0x66bb6a;
      if (l.type === 'tag_weak_signal_subtopic') return 0x777777;
      if (l.type === 'tag_cooccur') return 0x444444;
      return 0x333333;
    })
    .linkOpacity(0.13)
    .linkDirectionalParticles(l => l.type === 'tag_cooccur' ? 2 : 0)
    .linkDirectionalParticleWidth(0.7)
    .linkDirectionalParticleSpeed(0.004)
    .linkCurvature(l => l.type === 'tag_cooccur' ? 0.25 : 0)
    .onNodeClick(node => showPopover(node, tagItems))
    .onNodeHover(node => { graphEl.style.cursor = node ? 'pointer' : 'default'; })
    .width(graphEl.clientWidth || 800)
    .height(graphEl.clientHeight || 600);

  graph.cameraPosition({ x: 350, y: 280, z: 400 });
  graph.controls().enableDamping = true;
  graph.controls().dampingFactor = 0.08;

  _graph = graph;

  window.addEventListener('resize', () => {
    if (graphEl && graphEl.clientWidth > 0) {
      graph.width(graphEl.clientWidth);
      graph.height(graphEl.clientHeight);
    }
  });
}

function addChild(parent, child) {
  if (!_childrenMap[parent.id]) _childrenMap[parent.id] = [];
  if (!_childrenMap[parent.id].includes(child)) _childrenMap[parent.id].push(child);
}

// ── Tree Panel ──────────────────────────────────────

function buildTree() {
  const treeBody = $('#kg3dTreeBody');
  if (!treeBody) return;

  const domains = _data.nodes.filter(n => n.type === 'domain');
  let html = '';
  for (const d of domains) {
    html += renderTreeNode(d, 0);
  }
  treeBody.innerHTML = html || '<p class="graph-placeholder" style="padding:12px">No hierarchy data</p>';

  // Click handlers
  treeBody.querySelectorAll('.kg3d-tree-row').forEach(row => {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      const nodeId = row.dataset.nodeId;
      const node = _nodeById[nodeId];
      if (!node) return;

      // Toggle expand if has children
      const childrenEl = row.parentElement.querySelector('.kg3d-tree-children');
      if (childrenEl && node.type !== 'tag') {
        childrenEl.classList.toggle('hidden');
        const toggle = row.querySelector('.kg3d-tree-toggle');
        if (toggle) toggle.textContent = childrenEl.classList.contains('hidden') ? '▸' : '▾';
      }

      // Highlight in tree
      treeBody.querySelectorAll('.kg3d-tree-row.selected').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');

      // Focus in 3D graph
      if (_graph && _data.nodes.find(n => n.id === nodeId)) {
        flyToNode(node);
      }

      // Popover for tags
      if (node.type === 'tag') {
        showPopover(node, _data.tagItems);
      }
    });
  });
}

function renderTreeNode(node, depth) {
  const hasChildren = !!_childrenMap[node.id]?.length;
  const children = _childrenMap[node.id] || [];
  const levelClass = LEVEL_CLASS[node.type] || '';

  const icon = node.type === 'domain'
    ? '<span class="kg3d-node-dot domain"></span>'
    : node.type === 'topic'
      ? '<span class="kg3d-node-dot topic"></span>'
      : node.type === 'subtopic'
        ? '<span class="kg3d-node-dot subtopic"></span>'
        : '<span class="kg3d-node-dot tag"></span>';

  const toggle = hasChildren ? '<span class="kg3d-tree-toggle">▾</span>' : '<span class="kg3d-tree-toggle kg3d-tree-leaf"></span>';

  let countStr = '';
  if (node.type === 'tag' && node.itemCount) countStr = `<span class="kg3d-node-count">${node.itemCount}</span>`;

  let html = `<div class="kg3d-tree-node">
    <div class="kg3d-tree-row ${levelClass}" data-node-id="${escapeAttr(node.id)}" data-type="${node.type}">
      ${toggle}${icon}<span class="kg3d-node-label">${escapeHtml(node.labelZh)}</span>${countStr}
    </div>`;

  if (hasChildren) {
    html += '<div class="kg3d-tree-children">';
    children.sort((a, b) => (b.itemCount || 0) - (a.itemCount || 0));
    for (const child of children) {
      html += renderTreeNode(child, depth + 1);
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function wireSearch() {
  const searchInput = $('#kg3dTreeSearch');
  if (!searchInput) return;
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    const matchedIds = new Set();
    const rows = document.querySelectorAll('.kg3d-tree-row');
    rows.forEach(row => {
      const label = (row.querySelector('.kg3d-node-label')?.textContent || '').toLowerCase();
      const node = row.closest('.kg3d-tree-node');
      if (!node) return;
      if (!q || label.includes(q)) {
        node.style.display = '';
        if (q && label.includes(q)) {
          row.style.background = 'var(--accent-dim, rgba(229,130,78,0.2))';
          row.style.borderLeft = '2px solid var(--accent)';
          // Collect node IDs for 3D highlight.
          const id = node.dataset.nodeId;
          if (id) matchedIds.add(id);
        } else {
          row.style.background = '';
          row.style.borderLeft = '';
        }
        // Expand parents
        let p = node.parentElement;
        while (p) {
          if (p.classList.contains('kg3d-tree-children')) p.classList.remove('hidden');
          p = p.parentElement;
        }
      } else {
        node.style.display = 'none';
        row.style.background = '';
        row.style.borderLeft = '';
      }
    });
    // Highlight matched nodes in the 3D graph by enlarging them.
    if (_graph && typeof _graph.nodeColor === 'function') {
      try {
        const origNodes = _graph.graphData()?.nodes || [];
        if (q && matchedIds.size > 0) {
          origNodes.forEach(n => {
            n.__origSize = n.__origSize || n.val || 1;
            n.val = matchedIds.has(n.id) ? (n.__origSize * 2.5) : n.__origSize;
          });
        } else {
          origNodes.forEach(n => { if (n.__origSize) n.val = n.__origSize; });
        }
        _graph.graphData({ nodes: origNodes });
      } catch { /* graph API may differ */ }
    }
    // Update toggles
    document.querySelectorAll('.kg3d-tree-toggle').forEach(t => {
      const children = t.closest('.kg3d-tree-node')?.querySelector('.kg3d-tree-children');
      if (children) t.textContent = children.classList.contains('hidden') ? '▸' : '▾';
    });
  });
}

// ── 3D Interaction ─────────────────────────────────

function flyToNode(node) {
  if (!_graph || !node) return;
  // The node is already in the 3D graph data. To focus: set a small distance.
  // 3d-force-graph auto-updates positions; we can use the existing node coordinates.
  // Simple highlight: set link/nodes opacities.
  const highlightLinks = [];
  const highlightNodes = new Set([node.id]);
  _data.edges.forEach(l => {
    const src = typeof l.source === 'object' ? l.source.id : l.source;
    const tgt = typeof l.target === 'object' ? l.target.id : l.target;
    if (src === node.id || tgt === node.id) {
      highlightLinks.push(l);
      highlightNodes.add(src);
      highlightNodes.add(tgt);
    }
  });

  // Camera distance based on node type
  const distances = { domain: 500, topic: 300, subtopic: 150, tag: 80 };
  const dist = distances[node.type] || 200;
  _graph.cameraPosition({ x: node.x || 200, y: (node.y || 200) + dist * 0.5, z: (node.z || 0) + dist },
    node, 1000);
}

function showPopover(node, tagItems) {
  const popover = $('#kg3dPopover');
  if (!popover) return;
  popover.classList.add('visible');

  if (node.type === 'tag') {
    const items = tagItems[node.id] || [];
    const parentCount = Array.isArray(node.parentIds) ? node.parentIds.length : 1;
    popover.innerHTML = `
      <h3>🏷️ #${escapeHtml(node.labelZh)}</h3>
      <p class="kg3d-popover-count">${t('kg3d.items_count', { n: node.itemCount || items.length })} · ${t('kg3d.parents_count', { n: parentCount })}</p>
      ${node.multiParent ? '<div class="kg3d-node-state">多父概念：该 tag 同时属于多个 topic/subtopic</div>' : ''}
      <h4>${t('kg3d.item_list')}</h4>
      <div class="kg3d-popover-items">
        ${items.slice(0, 20).map(item => `
          <a href="${escapeAttr(item.url || '#')}" target="_blank" class="kg3d-popover-item" rel="noopener">
            ${escapeHtml(item.title)}<small>${escapeHtml(item.sourceLabel || '')}</small>
          </a>
        `).join('')}
      </div>
    `;
  } else {
    const children = (_childrenMap[node.id] || []).slice(0, 20);
    const typeLabel = { domain: t('kg3d.domain'), topic: t('kg3d.topic'), subtopic: t('kg3d.subtopic') };
    popover.innerHTML = `
      <h3>${node.type === 'domain' ? '🌐' : node.type === 'topic' ? '📂' : '◆'} ${escapeHtml(node.labelZh)}</h3>
      <p class="kg3d-popover-count">${typeLabel[node.type] || node.type} · ${t('kg3d.children_count', { n: children.length })}</p>
      ${children.length ? `
        <h4>${t('kg3d.children')}</h4>
        <div class="kg3d-popover-tags">
          ${children.map(c => `<span class="kg3d-popover-tag">${c.type==='tag'?'#':''}${escapeHtml(c.labelZh)} ${c.itemCount ? '<small>('+c.itemCount+')</small>' : ''}</span>`).join('')}
        </div>
      ` : ''}
    `;
  }

  // Auto-hide after 15s
  clearTimeout(popover._timeout);
  popover._timeout = setTimeout(() => popover.classList.remove('visible'), 15000);
}
