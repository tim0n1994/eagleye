import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../markdown.js';

// These cases are the actual payloads that survived `marked.parse()` before the
// sanitizing renderers were added. Everything rendered through renderMarkdown is
// LLM output derived from scraped pages, and it lands in innerHTML, so each of
// these must come back inert.
describe('renderMarkdown — untrusted input is neutralized', () => {
  it('renders raw HTML tags as visible text, not markup', () => {
    const html = renderMarkdown('# Title\n\n<img src=x onerror=alert(1)>');
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('&lt;img');
  });

  it('does not emit a script element', () => {
    const html = renderMarkdown('text <script>alert(1)</script> more');
    expect(html).not.toMatch(/<script/i);
  });

  it('does not emit an iframe element', () => {
    const html = renderMarkdown('<iframe src=//evil.tld></iframe>');
    expect(html).not.toMatch(/<iframe/i);
  });

  it('strips javascript: hrefs while keeping the link text', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))');
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toContain('click me');
  });

  it('strips data: URIs on images', () => {
    const html = renderMarkdown('![x](data:text/html;base64,PHN2Zz4=)');
    expect(html).not.toMatch(/src="data:/i);
  });

  it('marks external links noopener so they cannot reach window.opener', () => {
    const html = renderMarkdown('[docs](https://example.com/a)');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe('renderMarkdown — legitimate markdown still renders', () => {
  it('renders headings', () => {
    expect(renderMarkdown('# Hello')).toMatch(/<h1[^>]*>Hello<\/h1>/);
  });

  it('renders bold and lists', () => {
    const html = renderMarkdown('**bold**\n\n- one\n- two');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<li>one</li>');
  });

  it('renders blockquotes', () => {
    expect(renderMarkdown('> quoted')).toContain('<blockquote>');
  });

  it('renders GFM tables', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  it('renders fenced code blocks', () => {
    const html = renderMarkdown('```js\nconst x = 1;\n```');
    expect(html).toContain('<code');
    expect(html).toContain('const x = 1;');
  });

  it('keeps safe http links clickable', () => {
    expect(renderMarkdown('[docs](https://example.com)')).toContain('href="https://example.com"');
  });

  it('shows the supplied placeholder when the input is empty', () => {
    expect(renderMarkdown('', 'nothing here')).toContain('nothing here');
  });
});
