import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderSearch } from '../pages/search.js';
import { setLanguage } from '../i18n.js';
beforeEach(() => { setLanguage('en'); document.body.innerHTML = '<main id="pageContent"></main>'; });
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });
it('renders an unmatched HTML search query as text rather than executable markup', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({items: [], topics: [], entities: []}) })));
  const q = '<img src=x onerror="window.__qaInjected=1">';
  await renderSearch({q});
  await vi.waitFor(() => expect(document.querySelector('#searchResults').textContent).toContain('No results'));
  expect(document.querySelector('#searchResults img')).toBeNull();
  expect(document.querySelector('#searchResults').textContent).toContain(q);
});
