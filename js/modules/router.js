/**
 * Eagleye — Page Router
 *
 * Handles SPA-style client-side routing for all OrangeBot pages.
 * Parses window.location.pathname and renders the appropriate page.
 */

class PageRouter {
  constructor() {
    this._stringRoutes = {};
    this._regexRoutes = [];
    this.currentRoute = null;
    this.beforeRouteCallbacks = [];
    this.afterRouteCallbacks = [];
  }

  /**
   * Register a route pattern with a render function.
   * Pattern can be a string (exact match) or a regex.
   */
  register(pattern, renderFn) {
    if (pattern instanceof RegExp) {
      this._regexRoutes.push({ pattern, renderFn });
    } else {
      this._stringRoutes[pattern] = renderFn;
    }
  }

  /**
   * Add a callback that runs before every route change.
   */
  beforeEach(callback) {
    this.beforeRouteCallbacks.push(callback);
  }

  /**
   * Add a callback that runs after every route change.
   */
  afterEach(callback) {
    this.afterRouteCallbacks.push(callback);
  }

  /**
   * Navigate to a new path.
   */
  navigate(path) {
    if (this.currentRoute === path) return;
    window.history.pushState(null, '', path);
    this._handleRoute();
  }

  /**
   * Handle the current route (called on load and popstate).
   */
  _handleRoute() {
    const path = window.location.pathname;
    const searchParams = new URLSearchParams(window.location.search);
    let params = {};
    // Merge all query params into params object
    for (const [key, value] of searchParams) {
      params[key] = decodeURIComponent(value);
    }

    if (this._stringRoutes[path]) {
      this._executeRoute(path, this._stringRoutes[path], params);
      return;
    }

    for (const { pattern, renderFn } of this._regexRoutes) {
      const match = path.match(pattern);
      if (match) {
        params = { ...params, slug: match[1], id: match[1], year: match[1], date: match[1] };
        this._executeRoute(path, renderFn, params);
        return;
      }
    }

    if (this._stringRoutes['/404']) {
      this._executeRoute('/404', this._stringRoutes['/404'], params);
    }
  }

  async _executeRoute(path, renderFn, params) {
    this.currentRoute = path;
    this._currentParams = params;
    // A guard returning false cancels navigation. This used to be a forEach,
    // which discarded the return value (and never awaited the async auth
    // guard), so a signed-out visitor rendered the protected page and fired its
    // data requests before the redirect to /login took effect.
    for (const cb of this.beforeRouteCallbacks) {
      if (await cb(path, params) === false) return;
    }
    renderFn(params);
    this.afterRouteCallbacks.forEach(cb => cb(path, params));
  }
  _findCurrentRenderFn() {
    const path = this.currentRoute || window.location.pathname;
    if (this._stringRoutes[path]) {
      return { renderFn: this._stringRoutes[path], path, params: this._currentParams || {} };
    }
    for (const { pattern, renderFn } of this._regexRoutes) {
      const match = path.match(pattern);
      if (match) {
        return {
          renderFn,
          path,
          params: { slug: match[1], id: match[1], year: match[1], date: match[1] },
        };
      }
    }
    if (this._stringRoutes['/404']) {
      return { renderFn: this._stringRoutes['/404'], path: '/404', params: {} };
    }
    return null;
  }

  /**
   * Re-render the current route without changing history.
   * Used for language changes and other in-place refreshes.
   */
  async rerenderCurrentRoute() {
    const found = this._findCurrentRenderFn();
    if (!found) return;
    this._currentParams = found.params;
    for (const cb of this.beforeRouteCallbacks) {
      if (await cb(found.path, found.params) === false) return;
    }
    found.renderFn(found.params);
    this.afterRouteCallbacks.forEach(cb => cb(found.path, found.params));
  }

  /**
   * Initialize the router.
   */
  init() {
    this._handleRoute();
    window.addEventListener('popstate', () => this._handleRoute());

    document.addEventListener('click', (e) => {
      const link = (/** @type {Element} */ (e.target)).closest('a[href]');
      if (!link) return;

      const href = link.getAttribute('href');
      if (!href || href.startsWith('http') || href.startsWith('//') || href.startsWith('#')) return;

      e.preventDefault();
      this.navigate(href);
    });
  }
}

export const router = new PageRouter();
