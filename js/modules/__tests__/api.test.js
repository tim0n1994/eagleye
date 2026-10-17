import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { API } from '../api.js';

describe('API', () => {
  let originalFetch;
  let mockFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetchResponse(data, ok = true) {
    const body = data === undefined || data === null ? '' : JSON.stringify(data);
    return Promise.resolve({
      ok,
      status: ok ? 200 : 500,
      text: () => Promise.resolve(body),
      json: () => Promise.resolve(data),
    });
  }

  it('logout rejects an HTTP failure without treating the session as signed out', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(API.logout()).rejects.toThrow('Sign out failed (HTTP 503)');
    expect(mockFetch).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
  });

  it('logout resolves only after the server accepts the request', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    await expect(API.logout()).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
  });

  // ─── fetchClassifiedItems ────────────────────────────────

  it('fetchClassifiedItems fetches from /api/items with default category', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse({ items: [{ id: 1 }] }));
    const result = await API.fetchClassifiedItems();
    expect(mockFetch).toHaveBeenCalledWith('/api/items?category=All');
    expect(result).toEqual([{ id: 1 }]);
  });

  it('fetchClassifiedItems fetches with specific category', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse({ items: [{ id: 2 }] }));
    const result = await API.fetchClassifiedItems('AI');
    expect(mockFetch).toHaveBeenCalledWith('/api/items?category=AI');
    expect(result).toEqual([{ id: 2 }]);
  });

  it('fetchClassifiedItems encodes category with special characters', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse({ items: [] }));
    await API.fetchClassifiedItems('AI & ML');
    expect(mockFetch).toHaveBeenCalledWith('/api/items?category=AI%20%26%20ML');
  });

  it('fetchClassifiedItems returns empty array when no items', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse({}));
    const result = await API.fetchClassifiedItems();
    expect(result).toEqual([]);
  });

  it('fetchClassifiedItems returns empty array when items is null', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse({ items: null }));
    const result = await API.fetchClassifiedItems();
    expect(result).toEqual([]);
  });

  it('fetchClassifiedItems retries on failure', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(mockFetchResponse({ items: [{ id: 1 }] }));

    const result = await API.fetchClassifiedItems();
    expect(result).toEqual([{ id: 1 }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('fetchClassifiedItems throws after exhausting retries', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    await expect(API.fetchClassifiedItems()).rejects.toThrow('Network error');
    expect(mockFetch).toHaveBeenCalledTimes(3); // original + 2 retries
  });

  // ─── fetchCategories ────────────────────────────────────

  it('fetchCategories fetches from /api/categories', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse({ categories: ['AI', 'ML'] }));
    const result = await API.fetchCategories();
    expect(mockFetch).toHaveBeenCalledWith('/api/categories');
    expect(result).toEqual(['AI', 'ML']);
  });

  it('fetchCategories returns empty array when no categories', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse({}));
    const result = await API.fetchCategories();
    expect(result).toEqual([]);
  });

  // ─── triggerSync ─────────────────────────────────────────

  it('triggerSync fetches /api/sync', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse({ status: 'ok' }));
    const result = await API.triggerSync();
    expect(mockFetch).toHaveBeenCalledWith('/api/sync', { method: 'POST' });
    expect(result).toEqual({ status: 'ok' });
  });

  // ─── syncGet ─────────────────────────────────────────────

  it('syncGet fetches /api/sync/get', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse({ data: 'test' }));
    const result = await API.syncGet();
    expect(mockFetch).toHaveBeenCalledWith('/api/sync/get');
    expect(result).toEqual({ data: 'test' });
  });

  // ─── syncSet ─────────────────────────────────────────────

  it('syncSet POSTs data to /api/sync/set', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
    const data = { key: 'value' };
    const result = await API.syncSet(data);
    expect(mockFetch).toHaveBeenCalledWith('/api/sync/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    // syncSet returns the raw Response, not parsed JSON
    expect(result).toBeInstanceOf(Response);
    expect(result.ok).toBe(true);
  });

  // ─── fetchResearch ───────────────────────────────────────

  it('fetchResearch explicitly posts a generation request', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse({ result: 'research data' }));
    const result = await API.fetchResearch('https://example.com/article');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/research', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/article' }) }
    );
    expect(result).toEqual({ result: 'research data' });
  });

  it('fetchResearch preserves special URL characters in its JSON body', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse({}));
    await API.fetchResearch('https://example.com/path?q=ai&lang=en');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/research', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/path?q=ai&lang=en' }) }
    );
  });

  // ─── fetchGraph ──────────────────────────────────────────

  it('fetchGraph fetches /api/graph', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse({ nodes: [], edges: [] }));
    const result = await API.fetchGraph();
    expect(mockFetch).toHaveBeenCalledWith('/api/graph');
    expect(result).toEqual({ nodes: [], edges: [] });
  });

  // ─── Error handling ──────────────────────────────────────

  it('handles non-ok HTTP responses', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse({ error: 'Server Error' }, false));
    await expect(API.fetchCategories()).rejects.toThrow('HTTP 500');
  });

  it('handles fetch with query parameters correctly', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse({ items: [] }));
    await API.fetchClassifiedItems('Science');
    const url = mockFetch.mock.calls[0][0];
    expect(url).toBe('/api/items?category=Science');
  });
});
