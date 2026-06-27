import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UI } from '../ui.js';

describe('UI', () => {
  beforeEach(() => {
    // Set up DOM structure needed by UI methods
    document.body.innerHTML = `
      <div id="itemsGrid"></div>
      <div id="categoryList"></div>
      <div id="lastUpdated"></div>
      <div id="searchInput"></div>
      <div id="researchModal" style="display:none;"></div>
      <div id="researchTitle"></div>
      <div id="researchBody"></div>
      <div id="graphOverlay"></div>
      <div id="graphCanvas"></div>
      <button id="showGraph"></button>
      <button id="closeGraph"></button>
      <button id="syncNow"></button>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  // ─── cacheDom ────────────────────────────────────────────

  it('cacheDom caches all DOM elements', () => {
    UI.cacheDom();

    expect(UI.dom.itemsGrid).toBeTruthy();
    expect(UI.dom.categoryList).toBeTruthy();
    expect(UI.dom.lastUpdated).toBeTruthy();
    expect(UI.dom.syncBtn).toBeTruthy();
    expect(UI.dom.searchInput).toBeTruthy();
    expect(UI.dom.researchModal).toBeTruthy();
    expect(UI.dom.researchTitle).toBeTruthy();
    expect(UI.dom.researchBody).toBeTruthy();
    expect(UI.dom.graphOverlay).toBeTruthy();
    expect(UI.dom.showGraph).toBeTruthy();
    expect(UI.dom.closeGraph).toBeTruthy();
    expect(UI.dom.graphCanvas).toBeTruthy();
  });

  it('cacheDom sets correct element IDs', () => {
    UI.cacheDom();
    expect(UI.dom.itemsGrid.id).toBe('itemsGrid');
    expect(UI.dom.categoryList.id).toBe('categoryList');
    expect(UI.dom.researchModal.id).toBe('researchModal');
    expect(UI.dom.graphCanvas.id).toBe('graphCanvas');
  });

  it('cacheDom handles missing elements gracefully', () => {
    document.body.innerHTML = '';
    UI.cacheDom();
    expect(UI.dom.itemsGrid).toBeNull();
    expect(UI.dom.categoryList).toBeNull();
  });

  // ─── highlightText ───────────────────────────────────────

  it('highlightText returns escaped text when no query', () => {
    UI.cacheDom();
    const result = UI.highlightText('Hello <world>', '');
    expect(result).toBe('Hello &lt;world&gt;');
  });

  it('highlightText highlights matching query terms', () => {
    UI.cacheDom();
    const result = UI.highlightText('Hello World', 'World');
    expect(result).toContain('<mark');
    expect(result).toContain('Hello');
    expect(result).toContain('World');
    expect(result).toContain('</mark>');
  });

  it('highlightText is case-insensitive', () => {
    UI.cacheDom();
    const result = UI.highlightText('Hello World', 'world');
    expect(result).toContain('<mark');
    expect(result).toContain('World');
  });

  it('highlightText handles HTML special characters in query', () => {
    UI.cacheDom();
    const result = UI.highlightText('foo (bar) [baz]', '(bar)');
    expect(result).toContain('<mark');
    expect(result).toContain('(bar)');
  });

  it('highlightText escapes HTML in text then highlights', () => {
    UI.cacheDom();
    const result = UI.highlightText('<test> value', 'value');
    expect(result).toContain('&lt;test&gt;');
    expect(result).toContain('<mark');
    expect(result).toContain('value');
  });

  it('highlightText returns empty string for empty text', () => {
    UI.cacheDom();
    const result = UI.highlightText('', 'query');
    expect(result).toBe('');
  });

  it('highlightText returns escaped text for no match', () => {
    UI.cacheDom();
    const result = UI.highlightText('Hello World', 'Nomatch');
    expect(result).toBe('Hello World');
  });

  // ─── renderCategories ────────────────────────────────────

  it('renderCategories renders category list with All and sorted categories', () => {
    UI.cacheDom();
    const categories = [
      { category: 'GitHub', count: 10 },
      { category: 'AI', count: 5 },
      { category: 'Blockchain', count: 3 },
    ];

    UI.renderCategories(categories);

    const html = UI.dom.categoryList.innerHTML;
    expect(html).toContain('全部');
    expect(html).toContain('LIVE');
    expect(html).toContain('GitHub');
    expect(html).toContain('10');
    expect(html).toContain('AI');
    expect(html).toContain('5');
  });

  it('renderCategories sorts categories alphabetically', () => {
    UI.cacheDom();
    const categories = [
      { category: 'Zebra', count: 1 },
      { category: 'Apple', count: 2 },
      { category: 'Banana', count: 3 },
    ];

    UI.renderCategories(categories);

    const html = UI.dom.categoryList.innerHTML;
    const appleIdx = html.indexOf('Apple');
    const bananaIdx = html.indexOf('Banana');
    const zebraIdx = html.indexOf('Zebra');
    expect(appleIdx).toBeLessThan(bananaIdx);
    expect(bananaIdx).toBeLessThan(zebraIdx);
  });

  it('renderCategories escapes HTML in category names', () => {
    UI.cacheDom();
    const categories = [{ category: '<b>test</b>', count: 1 }];

    UI.renderCategories(categories);

    // Check via DOM — text content should contain the raw HTML string
    const items = UI.dom.categoryList.querySelectorAll('.category-item');
    expect(items.length).toBe(2); // 'All' link + the category link
    expect(items[1].textContent).toContain('<b>test</b>');
    // There should be no actual <b> element rendered
    expect(UI.dom.categoryList.querySelectorAll('b').length).toBe(0);
  });

  it('renderCategories handles empty categories (shows All link only)', () => {
    UI.cacheDom();
    UI.renderCategories([]);
    const html = UI.dom.categoryList.innerHTML;
    expect(html).toContain('全部');
    // The "All" link has class "category-item"
    expect(html).toContain('category-item');
    // No additional category items beyond the "All" link
    const items = UI.dom.categoryList.querySelectorAll('.category-item');
    expect(items.length).toBe(1);
  });

  it('renderCategories does nothing when categoryList is missing', () => {
    UI.dom.categoryList = null;
    expect(() => UI.renderCategories([{ category: 'Test', count: 1 }])).not.toThrow();
  });

  // ─── renderModules ───────────────────────────────────────

  it('renderModules shows empty state for no items', () => {
    UI.cacheDom();
    UI.renderModules([]);
    const html = UI.dom.itemsGrid.innerHTML;
    expect(html).toContain('SIGNAL LOST');
    expect(html).toContain('NO ITEMS FOUND');
  });

  it('renderModules filters items by search query', () => {
    UI.cacheDom();
    const items = [
      { title: 'AI News', summary: 'About AI', source: 'HN', url: '#', importance: 1, created_at: new Date().toISOString(), tags: [] },
      { title: 'ML Update', summary: 'About ML', source: 'GH', url: '#', importance: 2, created_at: new Date().toISOString(), tags: [] },
    ];

    UI.renderModules(items, 'ML');
    const html = UI.dom.itemsGrid.innerHTML;
    expect(html).toContain('ML Update');
    expect(html).not.toContain('AI News');
  });

  it('renderModules shows all items when no search query', () => {
    UI.cacheDom();
    const items = [
      { title: 'Item One', summary: 'First', source: 'Src1', url: '#', importance: 1, created_at: new Date().toISOString(), tags: [] },
      { title: 'Item Two', summary: 'Second', source: 'Src2', url: '#', importance: 2, created_at: new Date().toISOString(), tags: [] },
    ];

    UI.renderModules(items);
    const html = UI.dom.itemsGrid.innerHTML;
    expect(html).toContain('Item One');
    expect(html).toContain('Item Two');
  });

  // ─── createItemRow ──────────────────────────────────────

  it('createItemRow creates a row with correct structure', () => {
    UI.cacheDom();
    const item = {
      title: 'Test Item',
      summary: 'A summary of the item',
      source: 'GitHub',
      url: 'https://github.com/test',
      importance: 3,
      tags: ['javascript', 'open-source'],
      created_at: new Date().toISOString(),
    };

    const row = UI.createItemRow(item, '');
    expect(row.className).toContain('item-row');
    expect(row.querySelector('.item-source-tag').textContent).toBe('GitHub');
    expect(row.querySelector('.item-title').textContent).toContain('Test Item');
    expect(row.querySelector('.item-summary').textContent).toContain('A summary of the item');
    expect(row.querySelectorAll('.tag').length).toBe(2);
  });

  it('createItemRow handles items without tags', () => {
    UI.cacheDom();
    const row = UI.createItemRow({ title: 'No Tags', summary: '', source: 'Src', url: '#', created_at: new Date().toISOString(), tags: null }, '');
    expect(row.querySelectorAll('.tag').length).toBe(0);
  });

  it('createItemRow handles undefined tags', () => {
    UI.cacheDom();
    const row = UI.createItemRow({ title: 'Undefined Tags', summary: '', source: 'Src', url: '#', created_at: new Date().toISOString() }, '');
    expect(row.querySelectorAll('.tag').length).toBe(0);
  });

  it('createItemRow highlights title when search query exists', () => {
    UI.cacheDom();
    const row = UI.createItemRow({ title: 'Searchable Title', summary: '', source: 'Src', url: '#', created_at: new Date().toISOString(), tags: [] }, 'Searchable');
    expect(row.innerHTML).toContain('<mark');
  });

  it('createItemRow includes research button', () => {
    UI.cacheDom();
    const row = UI.createItemRow({ title: 'Test', summary: '', source: 'Src', url: 'https://example.com', created_at: new Date().toISOString(), tags: [] }, '');
    expect(row.querySelector('.research-btn')).toBeTruthy();
  });

  it('createItemRow sets data attributes on research button', () => {
    UI.cacheDom();
    const row = UI.createItemRow({ title: 'Test Title', summary: '', source: 'Src', url: 'https://example.com/article', created_at: new Date().toISOString(), tags: [] }, '');
    const btn = /** @type {HTMLElement} */ (row.querySelector('.research-btn'));
    expect(btn.dataset.url).toBe('https://example.com/article');
    expect(btn.dataset.title).toBe('Test Title');
  });

  // ─── showResearch ───────────────────────────────────────

  it('showResearch displays the modal with title and content', () => {
    UI.cacheDom();
    UI.showResearch('Test Title', 'Research content here');

    expect(UI.dom.researchTitle.textContent).toBe('Test Title');
    expect(UI.dom.researchBody.innerHTML).toContain('Research content here');
    expect(UI.dom.researchModal.style.display).toBe('block');
  });

  it('showResearch formats markdown-style content', () => {
    UI.cacheDom();
    UI.showResearch('Title', '# Heading\n\n**bold**\n\n> quote');

    const html = UI.dom.researchBody.innerHTML;
    expect(html).toContain('<h1>');
    expect(html).toContain('Heading');
    expect(html).toContain('<strong>');
    expect(html).toContain('bold');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('quote');
  });

  it('showResearch handles empty content', () => {
    UI.cacheDom();
    UI.showResearch('Empty', '');
    expect(UI.dom.researchBody.innerHTML).toBe('');
    expect(UI.dom.researchModal.style.display).toBe('block');
  });
});
