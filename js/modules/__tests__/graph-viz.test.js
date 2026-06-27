import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// KnowledgeGraph uses window.d3 which requires complex mocking for rendering.
// We test the pure helper methods (nodeRadius, nodeColor, edgeColor) and
// constructor/setter behavior directly. The D3 rendering (init, update, resize)
// is tested by creating the graph instance and verifying it doesn't throw.

import { KnowledgeGraph } from '../graph-viz.js';

describe('KnowledgeGraph', () => {
  let container;
  let graph;

  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'test-graph';
    container.style.width = '800px';
    container.style.height = '500px';
    document.body.appendChild(container);

    // Minimal d3 mock — just enough to prevent runtime errors from init/update/resize
    // The mock creates a chained API that mirrors d3's method chain without actual rendering
    function createChain() {
      const chain = () => createChain();
      Object.assign(chain, {
        append: vi.fn(() => createChain()),
        attr: vi.fn(() => createChain()),
        style: vi.fn(() => createChain()),
        call: vi.fn(() => createChain()),
        text: vi.fn(() => createChain()),
        on: vi.fn(() => createChain()),
        selectAll: vi.fn(() => createChain()),
        data: vi.fn(() => createChain()),
        join: vi.fn(() => createChain()),
        enter: vi.fn(() => createChain()),
        filter: vi.fn(() => createChain()),
        node: vi.fn(() => document.createElementNS('http://www.w3.org/2000/svg', 'g')),
        remove: vi.fn(),
        stop: vi.fn(),
        restart: vi.fn(),
        nodes: vi.fn(() => []),
      });
      return chain;
    }

    // @ts-expect-error — mock d3 object for testing
    window.d3 = {
      select: vi.fn(() => {
        const chain = createChain();
        // @ts-expect-error — chain is a callable with mock properties
        chain.append = vi.fn((tag) => {
          if (tag === 'svg' || tag === 'g') {
            return Object.assign(createChain(), {
              selectAll: vi.fn(() => createChain()),
              append: vi.fn(() => createChain()),
              call: vi.fn(() => createChain()),
            });
          }
          return createChain();
        });
        return chain;
      }),
      zoom: vi.fn(() => ({
        scaleExtent: vi.fn().mockReturnThis(),
        on: vi.fn().mockReturnThis(),
      })),
      forceSimulation: vi.fn(() => ({
        force: vi.fn().mockReturnThis(),
        on: vi.fn((event, cb) => {
          if (event === 'tick' && cb) cb();
          return createChain();
        }),
        stop: vi.fn(),
        alphaTarget: vi.fn().mockReturnThis(),
        restart: vi.fn(),
        alpha: vi.fn().mockReturnThis(),
        nodes: vi.fn().mockReturnThis(),
      })),
      forceLink: vi.fn(() => ({
        id: vi.fn().mockReturnThis(),
        distance: vi.fn().mockReturnThis(),
        strength: vi.fn().mockReturnThis(),
      })),
      forceManyBody: vi.fn(() => ({
        strength: vi.fn().mockReturnThis(),
      })),
      forceCenter: vi.fn(),
      forceCollide: vi.fn(() => ({
        radius: vi.fn().mockReturnThis(),
      })),
      drag: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
      })),
      color: vi.fn((c) => ({
        darker: vi.fn(() => c),
      })),
    };

    graph = new KnowledgeGraph('test-graph');
  });

  afterEach(() => {
    container.remove();
    // @ts-expect-error — cleanup mock
    delete window.d3;
  });

  // ─── Constructor ─────────────────────────────────────────

  it('sets container ID from constructor', () => {
    const g = new KnowledgeGraph('my-container');
    expect(g.containerId).toBe('my-container');
  });

  it('initializes with default values', () => {
    expect(graph.svg).toBeNull();
    expect(graph.simulation).toBeNull();
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.selectedNode).toBeNull();
    expect(graph.width).toBe(800);
    expect(graph.height).toBe(500);
    expect(graph.onNodeClick).toBeNull();
  });

  // ─── _nodeRadius ─────────────────────────────────────────

  it('returns large radius for topic nodes', () => {
    const node = { type: 'topic', growth_score: 2 };
    const radius = graph._nodeRadius(node);
    expect(radius).toBeGreaterThanOrEqual(15);
    expect(radius).toBeLessThanOrEqual(40);
  });

  it('returns larger radius for high-weight topics', () => {
    const small = graph._nodeRadius({ type: 'topic', weight: 1 });
    const large = graph._nodeRadius({ type: 'topic', weight: 3 });
    expect(large).toBeGreaterThan(small);
  });

  it('returns medium radius for entity nodes', () => {
    const node = { type: 'entity', weight: 1 };
    const radius = graph._nodeRadius(node);
    expect(radius).toBeGreaterThanOrEqual(8);
    expect(radius).toBeLessThanOrEqual(20);
  });

  it('returns radius 6 for tag nodes', () => {
    expect(graph._nodeRadius({ type: 'tag' })).toBe(6);
  });

  it('returns small radius for item nodes', () => {
    const radius = graph._nodeRadius({ type: 'item', weight: 1 });
    expect(radius).toBeGreaterThanOrEqual(5);
    expect(radius).toBeLessThanOrEqual(12);
  });

  it('returns default radius for unknown types', () => {
    const radius = graph._nodeRadius({ type: 'unknown', weight: 1 });
    expect(radius).toBeGreaterThanOrEqual(5);
    expect(radius).toBeLessThanOrEqual(12);
  });

  it('uses weight fallback when growth_score is missing', () => {
    const radius = graph._nodeRadius({ type: 'topic', weight: 2 });
    expect(radius).toBeGreaterThanOrEqual(15);
  });

  // ─── _nodeColor ──────────────────────────────────────────

  it('returns orange for topic nodes', () => {
    expect(graph._nodeColor({ type: 'topic' })).toBe('#ff6600');
  });

  it('returns blue for entity nodes', () => {
    expect(graph._nodeColor({ type: 'entity' })).toBe('#4fc3f7');
  });

  it('returns green for tag nodes', () => {
    expect(graph._nodeColor({ type: 'tag' })).toBe('#81c784');
  });

  it('returns purple for item nodes', () => {
    expect(graph._nodeColor({ type: 'item' })).toBe('#ba68c8');
  });

  it('returns gray for unknown node types', () => {
    expect(graph._nodeColor({ type: 'unknown' })).toBe('#999999');
  });

  it('returns gray for missing type', () => {
    expect(graph._nodeColor({})).toBe('#999999');
  });

  // ─── _edgeColor ──────────────────────────────────────────

  it('returns blue for item_mentions_entity edges', () => {
    expect(graph._edgeColor({ type: 'item_mentions_entity' })).toBe('#4fc3f7');
  });

  it('returns orange for item_belongs_topic edges', () => {
    expect(graph._edgeColor({ type: 'item_belongs_topic' })).toBe('#ff6600');
  });

  it('returns green for entity_related_entity edges', () => {
    expect(graph._edgeColor({ type: 'entity_related_entity' })).toBe('#81c784');
  });

  it('returns amber for topic_related_topic edges', () => {
    expect(graph._edgeColor({ type: 'topic_related_topic' })).toBe('#ffa726');
  });

  it('returns fallback for unknown edge types', () => {
    expect(graph._edgeColor({ type: 'unknown' })).toBe('#555555');
  });

  it('uses edge_type property when type is missing', () => {
    expect(graph._edgeColor({ edge_type: 'item_mentions_entity' })).toBe('#4fc3f7');
  });

  it('returns fallback for missing type', () => {
    expect(graph._edgeColor({})).toBe('#555555');
  });

  // ─── setOnNodeClick ──────────────────────────────────────

  it('sets onNodeClick callback', () => {
    const cb = vi.fn();
    graph.setOnNodeClick(cb);
    expect(graph.onNodeClick).toBe(cb);
  });

  // ─── init (basic behavior) ──────────────────────────────

  it('init aborts if container is missing', () => {
    graph.containerId = 'nonexistent';
    expect(() => graph.init({ nodes: [], edges: [] })).not.toThrow();
    expect(graph.svg).toBeNull();
  });

  it('init clears previous content', () => {
    container.innerHTML = '<div>Previous content</div>';
    graph.init({ nodes: [], edges: [] });
    expect(container.innerHTML).not.toContain('Previous content');
  });

  it('init processes nodes with deduplication by id', () => {
    const data = {
      nodes: [
        { id: 'a', label: 'Alpha', type: 'topic', weight: 1 },
        { id: 'a', label: 'Alpha Duplicate', type: 'topic', weight: 2 },
        { id: 'b', label: 'Beta', type: 'entity', weight: 1 },
      ],
      edges: [],
    };

    graph.init(data);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.find(n => n.id === 'a').label).toBe('Alpha Duplicate');
  });

  it('init handles empty data', () => {
    graph.init({});
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it('init handles null nodes', () => {
    graph.init({ nodes: null, edges: [] });
    expect(graph.nodes).toEqual([]);
  });

  // ─── update ─────────────────────────────────────────────

  it('update stops simulation and calls init', () => {
    const initSpy = vi.spyOn(graph, 'init');
    const mockSim = { stop: vi.fn() };
    graph.simulation = mockSim;

    graph.update({ nodes: [], edges: [] });

    expect(mockSim.stop).toHaveBeenCalled();
    expect(initSpy).toHaveBeenCalledWith({ nodes: [], edges: [] });
  });

  it('update handles null simulation gracefully', () => {
    const initSpy = vi.spyOn(graph, 'init');

    graph.update({ nodes: [], edges: [] });

    expect(initSpy).toHaveBeenCalledWith({ nodes: [], edges: [] });
  });

  // ─── resize ──────────────────────────────────────────────

  it('resize updates svg dimensions', () => {
    const svgMock = { attr: vi.fn().mockReturnThis() };
    graph.svg = svgMock;
    graph.simulation = {
      force: vi.fn().mockReturnThis(),
      alpha: vi.fn().mockReturnThis(),
      restart: vi.fn(),
    };

    graph.resize();

    expect(svgMock.attr).toHaveBeenCalledWith('width', expect.any(Number));
    expect(svgMock.attr).toHaveBeenCalledWith('height', expect.any(Number));
    expect(graph.simulation.alpha).toHaveBeenCalledWith(0.3);
    expect(graph.simulation.restart).toHaveBeenCalled();
  });

  it('resize does nothing if container is missing', () => {
    graph.containerId = 'nonexistent-container';
    graph.svg = { attr: vi.fn() };
    expect(() => graph.resize()).not.toThrow();
  });

  it('resize does nothing if svg is null', () => {
    graph.svg = null;
    expect(() => graph.resize()).not.toThrow();
  });
});
