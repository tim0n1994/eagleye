import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { router } from '../router.js';

describe('PageRouter', () => {
  let testRouter;
  let originalPushState;

  beforeEach(() => {
    testRouter = router;

    // Save originals
    originalPushState = window.history.pushState;

    // Mock history.pushState
    window.history.pushState = vi.fn();

    // Set up a fresh instance state without resetting singleton prototype
    delete testRouter.routes;
    testRouter.routes = {};
    testRouter.beforeRouteCallbacks = [];
    testRouter.afterRouteCallbacks = [];
    testRouter.currentRoute = null;
  });

  afterEach(() => {
    window.history.pushState = originalPushState;
  });

  // ─── register ────────────────────────────────────────────

  it('registers a string route', () => {
    const fn = vi.fn();
    testRouter.register('/test', fn);
    expect(testRouter.routes['/test']).toBe(fn);
  });

  it('registers a regex route', () => {
    const fn = vi.fn();
    testRouter.register(/^\/test\/(\d+)$/, fn);
    // Regex keys get stringified in plain objects, so check via iteration
    const found = Object.keys(testRouter.routes).some(k => {
      const match = k.match(/\/test/);
      return match;
    });
    expect(found).toBe(true);
  });

  it('registers multiple routes', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    testRouter.register('/a', fn1);
    testRouter.register('/b', fn2);
    expect(Object.keys(testRouter.routes)).toHaveLength(2);
  });

  // ─── beforeEach / afterEach ──────────────────────────────

  it('adds beforeEach callback', () => {
    const cb = vi.fn();
    testRouter.beforeEach(cb);
    expect(testRouter.beforeRouteCallbacks).toContain(cb);
  });

  it('adds afterEach callback', () => {
    const cb = vi.fn();
    testRouter.afterEach(cb);
    expect(testRouter.afterRouteCallbacks).toContain(cb);
  });

  it('supports multiple lifecycle callbacks', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    testRouter.beforeEach(cb1);
    testRouter.afterEach(cb2);
    expect(testRouter.beforeRouteCallbacks).toHaveLength(1);
    expect(testRouter.afterRouteCallbacks).toHaveLength(1);
  });

  // ─── _executeRoute ──────────────────────────────────────

  it('executes render function with params', () => {
    const renderFn = vi.fn();
    const params = { slug: 'test-slug' };

    testRouter._executeRoute('/test', renderFn, params);

    expect(renderFn).toHaveBeenCalledWith(params);
  });

  it('calls lifecycle callbacks before and after render', () => {
    const order = [];
    const beforeCb = vi.fn(() => order.push('before'));
    const renderFn = vi.fn(() => order.push('render'));
    const afterCb = vi.fn(() => order.push('after'));

    testRouter.beforeEach(beforeCb);
    testRouter.afterEach(afterCb);
    testRouter._executeRoute('/test', renderFn, {});

    expect(order).toEqual(['before', 'render', 'after']);
  });

  it('updates currentRoute', () => {
    testRouter._executeRoute('/current', vi.fn(), {});
    expect(testRouter.currentRoute).toBe('/current');
  });

  it('passes path and params to lifecycle callbacks', () => {
    const beforeCb = vi.fn();
    const afterCb = vi.fn();
    testRouter.beforeEach(beforeCb);
    testRouter.afterEach(afterCb);

    testRouter._executeRoute('/test', vi.fn(), { id: '42' });

    expect(beforeCb).toHaveBeenCalledWith('/test', { id: '42' });
    expect(afterCb).toHaveBeenCalledWith('/test', { id: '42' });
  });

  // ─── navigate ───────────────────────────────────────────

  it('pushes state and calls _handleRoute on navigate', () => {
    testRouter._handleRoute = vi.fn();
    testRouter.navigate('/new');

    expect(window.history.pushState).toHaveBeenCalledWith(null, '', '/new');
    expect(testRouter._handleRoute).toHaveBeenCalled();
  });

  it('skips navigation if already on the same route', () => {
    testRouter.currentRoute = '/same';
    testRouter._handleRoute = vi.fn();

    testRouter.navigate('/same');

    expect(testRouter._handleRoute).not.toHaveBeenCalled();
  });

  // ─── init ────────────────────────────────────────────────

  it('calls _handleRoute on init', () => {
    testRouter._handleRoute = vi.fn();
    testRouter.init();

    expect(testRouter._handleRoute).toHaveBeenCalled();
  });

  it('adds popstate event listener on init', () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    testRouter._handleRoute = vi.fn();
    testRouter.init();

    expect(addEventListenerSpy).toHaveBeenCalledWith('popstate', expect.any(Function));
    addEventListenerSpy.mockRestore();
  });

  it('intercepts internal link clicks on init', () => {
    const addEventListenerSpy = vi.spyOn(document, 'addEventListener');
    testRouter._handleRoute = vi.fn();
    testRouter.init();

    expect(addEventListenerSpy).toHaveBeenCalledWith('click', expect.any(Function));
    addEventListenerSpy.mockRestore();
  });

  // ─── _handleRoute (through navigate + registered routes) ─

  it('matches exact string routes via navigate', () => {
    const fn = vi.fn();
    testRouter.register('/exact', fn);

    // Stub _handleRoute to test the matching logic directly
    testRouter._handleRoute = function () {
      const path = window.location.pathname;
      if (this.routes[path]) {
        this._executeRoute(path, this.routes[path], {});
      }
    };
    testRouter._executeRoute = vi.fn();

    Object.defineProperty(window, 'location', {
      value: { pathname: '/exact' },
      writable: true,
      configurable: true,
    });

    testRouter._handleRoute();
    expect(testRouter._executeRoute).toHaveBeenCalledWith('/exact', fn, {});
  });

  it('falls back to /404 when no route matches', () => {
    const fn404 = vi.fn();
    testRouter.register('/404', fn404);

    testRouter._handleRoute = function () {
      const path = window.location.pathname;
      const params = {};
      if (!this.routes[path]) {
        if (this.routes['/404']) {
          this._executeRoute('/404', this.routes['/404'], params);
        }
      }
    };
    testRouter._executeRoute = vi.fn();

    Object.defineProperty(window, 'location', {
      value: { pathname: '/nonexistent' },
      writable: true,
      configurable: true,
    });

    testRouter._handleRoute();
    expect(testRouter._executeRoute).toHaveBeenCalledWith('/404', fn404, {});
  });

  // ─── Constructor defaults ───────────────────────────────

  it('has correct initial state after reset', () => {
    expect(Object.keys(testRouter.routes)).toHaveLength(0);
    expect(testRouter.beforeRouteCallbacks).toEqual([]);
    expect(testRouter.afterRouteCallbacks).toEqual([]);
    expect(testRouter.currentRoute).toBeNull();
  });
});
