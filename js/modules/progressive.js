/**
 * Progressive Load — Virtual scroll / pagination helper for feed pages.
 *
 * Usage:
 *   progressiveLoad({ container: '#feedList', fetchMore, batchSize: 50, renderItem });
 */

const API_BASE = '/api';

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function progressiveLoad({ container, fetchMore, batchSize = 30, renderItem }) {
  let offset = batchSize;
  let hasMore = true;
  let loading = false;

  const sentinel = document.createElement('div');
  sentinel.className = 'load-sentinel';
  sentinel.innerHTML = '<div class="loader-dots"><span></span><span></span><span></span></div>';
  container.appendChild(sentinel);

  const observer = new IntersectionObserver(async ([entry]) => {
    if (!entry.isIntersecting || !hasMore || loading) return;
    loading = true;
    sentinel.classList.add('loading');

    try {
      const result = await fetchMore(offset, batchSize);
      const items = result.items || result;
      if (!items || items.length === 0) {
        hasMore = false;
        sentinel.innerHTML = '';
        observer.disconnect();
        return;
      }

      const frag = document.createDocumentFragment();
      for (const item of items) {
        const div = document.createElement('div');
        div.innerHTML = renderItem(item);
        frag.appendChild(div.firstElementChild);
      }

      // Insert before sentinel
      container.insertBefore(frag, sentinel);
      offset += items.length;

      if (items.length < batchSize) {
        hasMore = false;
        sentinel.innerHTML = '';
        observer.disconnect();
      }
    } catch (err) {
      console.warn('Progressive load failed:', err.message);
      hasMore = false;
      sentinel.innerHTML = '';
      observer.disconnect();
    } finally {
      loading = false;
      sentinel.classList.remove('loading');
    }
  }, { rootMargin: '400px' });

  observer.observe(sentinel);

  return {
    stop: () => observer.disconnect(),
    getOffset: () => offset,
  };
}

/**
 * Progressive feed for source-specific pages.
 * Fetches from /api/items?source=X&offset=N&limit=M
 */
export function progressiveSourceFeed({ container, sourceSlug, batchSize = 30, renderItem }) {
  return progressiveLoad({
    container,
    batchSize,
    renderItem,
    fetchMore: async (offset, limit) => {
      const data = await fetchJSON(`${API_BASE}/items?source=${encodeURIComponent(sourceSlug)}&offset=${offset}&limit=${limit}`);
      return data.items || [];
    },
  });
}

/**
 * Progressive feed for date-based news feed.
 */
export function progressiveDateFeed({ container, date, batchSize = 30, renderItem }) {
  return progressiveLoad({
    container,
    batchSize,
    renderItem,
    fetchMore: async (offset, limit) => {
      const data = await fetchJSON(`${API_BASE}/items?date=${encodeURIComponent(date)}&offset=${offset}&limit=${limit}`);
      return data.items || [];
    },
  });
}
