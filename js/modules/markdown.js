/**
 * Eagleye — Sanitized Markdown rendering
 *
 * Every markdown string rendered in this app is LLM output derived from scraped
 * pages (GitHub READMEs, HN/Reddit posts, arXiv abstracts), so it is untrusted.
 * marked passes raw HTML and `javascript:` URLs straight through by default —
 * `<script>`, `<img onerror>` and `<iframe>` all survive `marked.parse()` — and
 * the results go into innerHTML, so both are neutralized here.
 *
 * marked is a singleton, so configuring it once covers every parse call in the
 * app. Route all markdown through renderMarkdown() rather than calling
 * marked.parse() directly, or the sanitizing renderers get bypassed.
 */

import { marked } from '../lib/marked.esm.js';
import { escapeHtml } from './utils.js';

// Protocols allowed in links. Anything else (javascript:, data:, vbscript:)
// collapses to '#' rather than being dropped, so the link text stays visible.
const SAFE_HREF = /^(https?:|mailto:|#|\/)/i;

marked.setOptions({ gfm: true, breaks: true });

marked.use({
  renderer: {
    // Raw HTML blocks and inline HTML: render as visible text, never as markup.
    html(token) {
      return escapeHtml(token?.raw ?? token?.text ?? token);
    },
    link(token) {
      const href = String(token?.href ?? '');
      const safe = SAFE_HREF.test(href) ? href : '#';
      // parseInline keeps nested formatting (bold/code inside a link label)
      // while still running it through the sanitizing renderers.
      const label = token?.tokens
        ? this.parser.parseInline(token.tokens)
        : escapeHtml(token?.text ?? '');
      return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
    image(token) {
      const href = String(token?.href ?? '');
      if (!SAFE_HREF.test(href)) return escapeHtml(token?.raw ?? '');
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(token?.text ?? '')}">`;
    },
  },
});

/**
 * Render untrusted markdown to sanitized HTML.
 * @param {string} md         markdown source
 * @param {string} emptyText  shown when md is blank
 * @returns {string} HTML safe to assign to innerHTML
 */
export function renderMarkdown(md, emptyText = '') {
  const text = String(md || '').trim();
  if (!text) return `<p>${escapeHtml(emptyText)}</p>`;
  try {
    return `<div class="research-markdown">${marked.parse(text)}</div>`;
  } catch {
    // If marked throws, fall back to plain escaped text — never to raw HTML.
    return `<div class="research-markdown"><p>${escapeHtml(text).replace(/\n/g, '<br>')}</p></div>`;
  }
}
