/**
 * Eagleye — tool page shell
 *
 * Common chrome every tool renders into. Its own module so the tool group files
 * and the tools.js dispatcher do not form an import cycle.
 */

import { escapeHtml } from '../utils.js';

export function toolShell(slug, title, content) {
  return `
    <section class="page-section">
      <div class="page-header">
        <h2 class="page-title">TOOL / ${escapeHtml(title)}</h2>
        <a href="/tools" class="nav-link">← All Tools</a>
      </div>
      <div class="tool-interactive" id="tool-${slug}">
        <div class="tool-interactive-header">
          <div class="tool-interactive-meta">
            <span class="tool-badge">LOCAL</span>
            <span class="tool-badge">NO UPLOAD</span>
            <span class="tool-badge">NO LOGIN</span>
          </div>
        </div>
        <div class="tool-body">${content}</div>
      </div>
    </section>
  `;
}
