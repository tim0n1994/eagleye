/**
 * Eagleye — Interactive Knowledge Graph Visualization
 *
 * D3.js force-directed graph for the /topics page.
 * Renders topics, entities, items, and tags as an interactive network.
 *
 * Features:
 * - Force-directed layout with physics simulation
 * - Draggable nodes
 * - Hover highlights with neighbor dimming
 * - Click to load topic details
 * - Zoom and pan
 * - Color-coded by node type
 * - Size-coded by importance (growth_score, edge count)
 */

export class KnowledgeGraph {
  /** @returns {any} */
  static get _d3() { return /** @type {any} */ (window).d3; }
  constructor(containerId) {
    this.containerId = containerId;
    this.svg = null;
    this.simulation = null;
    this.nodes = [];
    this.edges = [];
    this.selectedNode = null;
    this.width = 800;
    this.height = 500;
    this.onNodeClick = null;
  }

  /**
   * Initialize the graph with data from the API.
   * @param {Object} data - { nodes: [...], edges: [...] }
   */
  init(data) {
    const container = document.getElementById(this.containerId);
    if (!container) return;

    // Clear previous content
    container.innerHTML = '';

    // Get container dimensions
    const rect = container.getBoundingClientRect();
    this.width = rect.width || 800;
    this.height = rect.height || 500;

    // Process nodes - deduplicate by id
    const nodeMap = new Map();
    for (const node of (data.nodes || [])) {
      nodeMap.set(node.id || node.label, {
        ...node,
        // Ensure consistent fields
        id: node.id || node.label,
        label: node.label || node.name || node.id || '',
        type: node.type || 'unknown',
        weight: node.weight || node.growth_score || node.item_count || 1,
        radius: this._nodeRadius(node),
        color: this._nodeColor(node),
      });
    }
    this.nodes = Array.from(nodeMap.values());

    // Process edges - filter to only include edges between existing nodes
    const nodeIds = new Set(this.nodes.map(n => n.id));
    this.edges = (data.edges || []).filter(e => {
      const fromId = e.from_id || e.source;
      const toId = e.to_id || e.target;
      return nodeIds.has(fromId) && nodeIds.has(toId);
    }).map(e => ({
      ...e,
      source: e.from_id || e.source,
      target: e.to_id || e.target,
      weight: e.weight || 1,
      type: e.edge_type || 'connected',
    }));

    // Create SVG
    const d3 = KnowledgeGraph._d3;
    this.svg = d3.select(container)
      .append('svg')
      .attr('width', this.width)
      .attr('height', this.height)
      .attr('viewBox', [0, 0, this.width, this.height])
      .style('cursor', 'grab');

    // Zoom behavior
    const g = this.svg.append('g');
    const d3zoom = KnowledgeGraph._d3;
    const zoom = d3zoom.zoom()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });
    this.svg.call(zoom);

    // Create simulation
    const d3sim = KnowledgeGraph._d3;
    this.simulation = d3sim.forceSimulation(this.nodes)
      .force('link', d3sim.forceLink(this.edges)
        .id(d => d.id)
        .distance(d => 100 - (d.weight || 1) * 30)
        .strength(d => (d.weight || 1) * 0.3))
      .force('charge', d3sim.forceManyBody()
        .strength(d => -150 - (d.radius || 5) * 20))
      .force('center', d3sim.forceCenter(this.width / 2, this.height / 2))
      .force('collision', d3sim.forceCollide().radius(d => (d.radius || 5) + 5));

    // Draw links
    const link = g.append('g')
      .selectAll('line')
      .data(this.edges)
      .join('line')
      .attr('stroke', d => this._edgeColor(d))
      .attr('stroke-width', d => Math.max(0.5, (d.weight || 0.5) * 2))
      .attr('stroke-opacity', 0.3)
      .attr('stroke-dasharray', d => d.type === 'entity_related_entity' ? '3,3' : 'none');

    // Draw node groups
    const node = g.append('g')
      .selectAll('g')
      .data(this.nodes)
      .join('g')
      .attr('cursor', 'pointer')
      .call(this._drag(this.simulation));

    // Node circles
    node.append('circle')
      .attr('r', d => d.radius)
      .attr('fill', d => d.color)
      .attr('stroke', d => KnowledgeGraph._d3.color(d.color).darker(0.5))
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.85);

    // Node labels (show for larger/important nodes)
    node.append('text')
      .text(d => d.label.length > 20 ? d.label.slice(0, 18) + '…' : d.label)
      .attr('x', 0)
      .attr('y', d => d.radius + 12)
      .attr('text-anchor', 'middle')
      .attr('fill', 'var(--fg-dim)')
      .attr('font-size', d => d.type === 'topic' ? '11px' : '9px')
      .attr('font-family', 'var(--font-mono)')
      .attr('font-weight', d => d.type === 'topic' ? '700' : '400')
      .attr('opacity', d => d.type === 'topic' ? 0.9 : 0.6)
      .style('pointer-events', 'none');

    // Small type badges for non-topic nodes
    node.filter(d => d.type !== 'topic')
      .append('text')
      .text(d => d.type === 'entity' ? 'ENT' : d.type === 'tag' ? 'TAG' : 'ITM')
      .attr('x', 0)
      .attr('y', 2)
      .attr('text-anchor', 'middle')
      .attr('fill', '#fff')
      .attr('font-size', '6px')
      .attr('font-family', 'var(--font-mono)')
      .attr('font-weight', '700')
      .style('pointer-events', 'none');

    // Hover interaction
    node.on('mouseenter', (event, d) => {
      // Dim non-connected nodes
      const connectedIds = new Set([d.id]);
      this.edges.forEach(e => {
        const srcId = typeof e.source === 'object' ? e.source.id : e.source;
        const tgtId = typeof e.target === 'object' ? e.target.id : e.target;
        if (srcId === d.id) connectedIds.add(tgtId);
        if (tgtId === d.id) connectedIds.add(srcId);
      });

      node.attr('opacity', n => connectedIds.has(n.id) ? 1 : 0.2);
      link.attr('stroke-opacity', e => {
        const srcId = typeof e.source === 'object' ? e.source.id : e.source;
        const tgtId = typeof e.target === 'object' ? e.target.id : e.target;
        return (srcId === d.id || tgtId === d.id) ? 0.8 : 0.1;
      });
    });

    node.on('mouseleave', () => {
      node.attr('opacity', 1);
      link.attr('stroke-opacity', 0.3);
    });

    // Click interaction
    node.on('click', (event, d) => {
      event.stopPropagation();
      this.selectedNode = d;

      // Highlight selected
      node.selectAll('circle')
        .attr('stroke', n => n.id === d.id ? 'var(--accent)' : KnowledgeGraph._d3.color(n.color).darker(0.5))
        .attr('stroke-width', n => n.id === d.id ? 3 : 1.5);

      if (this.onNodeClick) {
        this.onNodeClick(d);
      }
    });

    // Click background to deselect
    this.svg.on('click', () => {
      this.selectedNode = null;
      node.selectAll('circle')
        .attr('stroke', n => KnowledgeGraph._d3.color(n.color).darker(0.5))
        .attr('stroke-width', 1.5);
    });

    // Simulation tick
    this.simulation.on('tick', () => {
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);

      node.attr('transform', d => `translate(${d.x},${d.y})`);
    });

    // Legend
    this._addLegend(g);
  }

  /**
   * Update the graph with new data.
   */
  update(data) {
    if (this.simulation) {
      this.simulation.stop();
    }
    this.init(data);
  }

  /**
   * Resize the graph to fit its container.
   */
  resize() {
    const container = document.getElementById(this.containerId);
    if (!container || !this.svg) return;
    const rect = container.getBoundingClientRect();
    this.width = rect.width || 800;
    this.height = rect.height || 500;
    this.svg.attr('width', this.width).attr('height', this.height);
    this.svg.attr('viewBox', [0, 0, this.width, this.height]);
    if (this.simulation) {
      this.simulation.force('center', KnowledgeGraph._d3.forceCenter(this.width / 2, this.height / 2));
      this.simulation.alpha(0.3).restart();
    }
  }

  /**
   * Set a callback for node click events.
   */
  setOnNodeClick(callback) {
    this.onNodeClick = callback;
  }

  // ─── Private helpers ──────────────────────────────────

  _nodeRadius(node) {
    if (node.type === 'topic') return Math.max(15, Math.min(40, 10 + (node.growth_score || node.weight || 1) * 15));
    if (node.type === 'entity') return Math.max(8, Math.min(20, 5 + (node.weight || 1) * 3));
    if (node.type === 'tag') return 6;
    return Math.max(5, Math.min(12, 3 + (node.weight || 1) * 2));
  }

  _nodeColor(node) {
    switch (node.type) {
      case 'topic': return '#ff6600';
      case 'entity': return '#4fc3f7';
      case 'tag': return '#81c784';
      case 'item': return '#ba68c8';
      default: return '#999999';
    }
  }

  _edgeColor(edge) {
    switch (edge.type || edge.edge_type) {
      case 'item_mentions_entity': return '#4fc3f7';
      case 'item_belongs_topic': return '#ff6600';
      case 'entity_related_entity': return '#81c784';
      case 'topic_related_topic': return '#ffa726';
      default: return '#555555';
    }
  }

  _addLegend(g) {
    const legend = g.append('g')
      .attr('transform', `translate(${this.width - 130}, 20)`)
      .attr('font-family', 'var(--font-mono)')
      .attr('font-size', '9px');

    const items = [
      { label: 'Topics', color: '#ff6600' },
      { label: 'Entities', color: '#4fc3f7' },
      { label: 'Tags', color: '#81c784' },
      { label: 'Items', color: '#ba68c8' },
    ];

    items.forEach((item, i) => {
      const y = i * 18;
      legend.append('circle')
        .attr('cx', 6)
        .attr('cy', y + 4)
        .attr('r', 5)
        .attr('fill', item.color)
        .attr('opacity', 0.8);
      legend.append('text')
        .attr('x', 16)
        .attr('y', y + 8)
        .attr('fill', 'var(--fg-dim)')
        .text(item.label);
    });
  }

  _drag(simulation) {
    function dragstarted(event) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      event.subject.fx = event.subject.x;
      event.subject.fy = event.subject.y;
    }

    function dragged(event) {
      event.subject.fx = event.x;
      event.subject.fy = event.y;
    }

    function dragended(event) {
      if (!event.active) simulation.alphaTarget(0);
      event.subject.fx = null;
      event.subject.fy = null;
    }

    return KnowledgeGraph._d3.drag()
      .on('start', dragstarted)
      .on('drag', dragged)
      .on('end', dragended);
  }
}
