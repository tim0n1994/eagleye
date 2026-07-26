import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { renderItemCard, showLoader, showError } from '../pages.js';

describe('renderItemCard', () => {
  const sampleItem = {
    id: 'test-1',
    title: 'Test Item',
    canonical_url: 'https://example.com',
    description: 'A test item description',
    topics: [{ slug: 'test', name: 'Test' }, { slug: 'example', name: 'Example' }],
    source_label: 'github',
    popularity: { stars: 42 },
    published_at: '2026-01-15T00:00:00Z',
  };

  it('returns an HTML string', () => {
    const html = renderItemCard(sampleItem);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });

  it('includes the item title (escaped)', () => {
    const html = renderItemCard(sampleItem);
    expect(html).toContain('Test Item');
  });

  it('includes the item url as an href', () => {
    const html = renderItemCard(sampleItem);
    expect(html).toContain('href="https://example.com"');
  });

  it('renders topic links for each topic', () => {
    const html = renderItemCard(sampleItem);
    expect(html).toContain('/topics/test');
  });

  it('escapes HTML in the title', () => {
    const item = { ...sampleItem, title: '<script>alert("xss")</script>' };
    const html = renderItemCard(item);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('handles items with missing optional fields', () => {
    const minimalItem = {
      id: 'min-1',
      title: 'Minimal',
      canonical_url: 'https://min.com',
      source_label: 'web'
    };
    const html = renderItemCard(minimalItem);
    expect(typeof html).toBe('string');
    expect(html).toContain('Minimal');
  });
});

describe('showLoader / showError', () => {
  let container;

  beforeAll(() => {
    container = document.createElement('div');
    container.id = 'content';
    document.body.appendChild(container);
  });

  afterAll(() => {
    container.remove();
  });

  it('showLoader sets innerHTML to a loading state indicator', () => {
    showLoader(container, 'LOADING...');
    expect(container.innerHTML).toContain('LOADING');
    expect(container.querySelector('.page-loading')).toBeTruthy();
    expect(container.querySelector('.spinner')).toBeTruthy();
  });

  it('showError sets innerHTML to an error state message', () => {
    showError(container, 'Something broke');
    expect(container.innerHTML).toContain('Something broke');
  });
});
