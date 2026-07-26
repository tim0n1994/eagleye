/**
 * Eagleye — text tools
 *
 * Text and markup tools: JSON, Base64, Markdown, minifier, diff, LaTeX.
 * Each render* returns a full HTML string; behaviour lives in the inline
 * <script> the shell re-evaluates. Split out of tools.js; unchanged otherwise.
 */

import { escapeHtml } from '../utils.js';
import { toolShell } from './shell.js';


// ─── JSON Formatter ─────────────────────────────────────────

export function renderJSONFormatter() {
  return toolShell('json-formatter', 'JSON Formatter', `
    <div class="tool-two-col">
      <div class="tool-panel">
        <div class="tool-panel-header">
          <label>Input JSON</label>
          <div class="tool-actions">
            <button class="tool-action-btn" onclick="window.__toolSample()">Load Sample</button>
            <button class="tool-action-btn" onclick="window.__toolClear()">Clear</button>
          </div>
        </div>
        <textarea id="jsonInput" class="tool-textarea" placeholder="Paste JSON here..." spellcheck="false"></textarea>
      </div>
      <div class="tool-panel">
        <div class="tool-panel-header">
          <label>Output</label>
          <div class="tool-actions">
            <button class="tool-action-btn primary" onclick="window.__toolFormat()">Format</button>
            <button class="tool-action-btn" onclick="window.__toolMinify()">Minify</button>
            <button class="tool-action-btn" onclick="window.__toolCopy()">Copy</button>
            <button class="tool-action-btn" onclick="window.__toolValidate()">Validate</button>
          </div>
        </div>
        <textarea id="jsonOutput" class="tool-textarea" readonly placeholder="Formatted JSON will appear here..." spellcheck="false"></textarea>
        <div id="jsonStatus" class="tool-status"></div>
      </div>
    </div>
    <script>
      window.__toolFormat = function() {
        const input = document.getElementById('jsonInput')?.value;
        if (!input) { document.getElementById('jsonStatus').textContent = '⚠ No input'; return; }
        try {
          const parsed = JSON.parse(input);
          document.getElementById('jsonOutput').value = JSON.stringify(parsed, null, 2);
          document.getElementById('jsonStatus').textContent = '✅ Valid JSON — formatted with 2-space indent';
          document.getElementById('jsonStatus').className = 'tool-status success';
        } catch(err) {
          document.getElementById('jsonStatus').textContent = '❌ ' + err.message;
          document.getElementById('jsonStatus').className = 'tool-status error';
        }
      };
      window.__toolMinify = function() {
        const input = document.getElementById('jsonInput')?.value;
        if (!input) return;
        try {
          const parsed = JSON.parse(input);
          document.getElementById('jsonOutput').value = JSON.stringify(parsed);
          document.getElementById('jsonStatus').textContent = '✅ Minified';
          document.getElementById('jsonStatus').className = 'tool-status success';
        } catch(err) {
          document.getElementById('jsonStatus').textContent = '❌ ' + err.message;
          document.getElementById('jsonStatus').className = 'tool-status error';
        }
      };
      window.__toolCopy = function() {
        const val = document.getElementById('jsonOutput')?.value;
        if (!val) return;
        navigator.clipboard.writeText(val).then(() => {
          document.getElementById('jsonStatus').textContent = '✅ Copied!';
        });
      };
      window.__toolValidate = function() {
        const input = document.getElementById('jsonInput')?.value;
        if (!input) { document.getElementById('jsonStatus').textContent = '⚠ No input to validate'; return; }
        try {
          JSON.parse(input);
          document.getElementById('jsonStatus').textContent = '✅ Valid JSON';
          document.getElementById('jsonStatus').className = 'tool-status success';
        } catch(err) {
          document.getElementById('jsonStatus').textContent = '❌ ' + err.message;
          document.getElementById('jsonStatus').className = 'tool-status error';
        }
      };
      window.__toolSample = function() {
        document.getElementById('jsonInput').value = JSON.stringify({
          "name": "Eagleye",
          "version": "1.0.0",
          "features": ["AI Summaries", "Knowledge Graph", "Deep Research"],
          "config": { "theme": "dark", "sources": 15, "enabled": true },
          "metrics": { "items": 71, "topics": 10, "skills": 40 }
        }, null, 2);
      };
      window.__toolClear = function() {
        document.getElementById('jsonInput').value = '';
        document.getElementById('jsonOutput').value = '';
        document.getElementById('jsonStatus').textContent = '';
      };
    </script>
  `);
}

// ─── Base64 Encoder/Decoder ─────────────────────────────────

export function renderBase64() {
  return toolShell('base64-encoder', 'Base64 Encoder/Decoder', `
    <div class="tool-two-col">
      <div class="tool-panel">
        <div class="tool-panel-header">
          <label>Input</label>
          <div class="tool-actions">
            <button class="tool-action-btn" onclick="window.__b64Mode('encode')">Encode →</button>
            <button class="tool-action-btn" onclick="window.__b64Mode('decode')">Decode →</button>
          </div>
        </div>
        <textarea id="b64Input" class="tool-textarea" placeholder="Enter text or Base64 string..." spellcheck="false"></textarea>
        <div class="tool-radio-row">
          <label><input type="radio" name="b64mode" value="encode" checked onchange="window.__b64Toggle()"> Text → Base64</label>
          <label><input type="radio" name="b64mode" value="decode" onchange="window.__b64Toggle()"> Base64 → Text</label>
        </div>
      </div>
      <div class="tool-panel">
        <div class="tool-panel-header">
          <label>Output</label>
          <button class="tool-action-btn" onclick="window.__b64Copy()">Copy</button>
        </div>
        <textarea id="b64Output" class="tool-textarea" readonly placeholder="Result will appear here..." spellcheck="false"></textarea>
        <div id="b64Status" class="tool-status"></div>
      </div>
    </div>
    <script>
      window.__b64Toggle = function() {
        const mode = document.querySelector('input[name="b64mode"]:checked')?.value;
        if (mode === 'encode') {
          document.getElementById('b64Input').placeholder = 'Enter text to encode...';
        } else {
          document.getElementById('b64Input').placeholder = 'Enter Base64 to decode...';
        }
      };
      window.__b64Mode = function(mode) {
        const input = document.getElementById('b64Input')?.value;
        if (!input) { document.getElementById('b64Status').textContent = '⚠ No input'; return; }
        try {
          if (mode === 'encode') {
            document.getElementById('b64Output').value = btoa(unescape(encodeURIComponent(input)));
            document.getElementById('b64Status').textContent = '✅ Encoded (' + document.getElementById('b64Output').value.length + ' chars)';
          } else {
            document.getElementById('b64Output').value = decodeURIComponent(escape(atob(input.trim())));
            document.getElementById('b64Status').textContent = '✅ Decoded';
          }
          document.getElementById('b64Status').className = 'tool-status success';
        } catch(e) {
          document.getElementById('b64Status').textContent = '❌ ' + e.message;
          document.getElementById('b64Status').className = 'tool-status error';
        }
      };
      window.__b64Copy = function() {
        const val = document.getElementById('b64Output')?.value;
        if (!val) return;
        navigator.clipboard.writeText(val).then(() => {
          document.getElementById('b64Status').textContent = '✅ Copied!';
        });
      };
    </script>
  `);
}

// ─── Markdown Preview ───────────────────────────────────────

export function renderMarkdownPreview() {
  return toolShell('markdown-preview', 'Markdown Preview', `
    <div class="tool-two-col">
      <div class="tool-panel">
        <div class="tool-panel-header">
          <label>Markdown</label>
          <div class="tool-actions">
            <button class="tool-action-btn" onclick="window.__mdSample()">Sample</button>
            <button class="tool-action-btn" onclick="window.__mdClear()">Clear</button>
          </div>
        </div>
        <textarea id="mdInput" class="tool-textarea" placeholder="Write or paste Markdown here..." spellcheck="false"># Hello Eagleye

Type **Markdown** here to see the preview.

- Lists work
- **Bold** and *italic*
- \`Code blocks\`

> Blockquotes too

## Links
[Eagleye](/)</textarea>
      </div>
      <div class="tool-panel">
        <div class="tool-panel-header">
          <label>Preview</label>
          <button class="tool-action-btn" onclick="window.__mdCopyHTML()">Copy HTML</button>
        </div>
        <div id="mdPreview" class="tool-markdown-preview"></div>
      </div>
    </div>
    <script>
      function __mdRender() {
        const input = document.getElementById('mdInput')?.value || '';
        const preview = document.getElementById('mdPreview');
        if (!preview) return;
        
        let html = input
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/^### (.+)$/gm, '<h3>$1</h3>')
          .replace(/^## (.+)$/gm, '<h2>$1</h2>')
          .replace(/^# (.+)$/gm, '<h1>$1</h1>')
          .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
          .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
          .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
          .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
          .replace(/^\\d+\\. (.+)$/gm, '<li>$1</li>')
          .replace(/^- (.+)$/gm, '<li>$1</li>')
          .replace(/\\[(.+?)\\]\\((.+?)\\)/g, '<a href="$2" target="_blank">$1</a>')
          .replace(/\\n{2,}/g, '</p><p>')
          .replace(/\\n/g, '<br>')
          .replace(/<li>([\\s\\S]*?)<br><br>/g, '<li>$1</p><p>')
          .replace(/<li>([^<]*)<\\/p>/g, '<li>$1');
        
        preview.innerHTML = '<p>' + html + '</p>';
        window.__mdHTML = preview.innerHTML;
      }

      document.addEventListener('input', function(e) {
        if (e.target.id === 'mdInput') __mdRender();
      });

      window.__mdSample = function() {
        document.getElementById('mdInput').value = '# Sample\n\n## Features\n- **Live** preview\n- *Simple* formatting\n- \\\`inline code\\\`\n\n> This is a blockquote\n\n[Link to Eagleye](/)';
        __mdRender();
      };
      window.__mdClear = function() {
        document.getElementById('mdInput').value = '';
        __mdRender();
      };
      window.__mdCopyHTML = function() {
        if (!window.__mdHTML) return;
        navigator.clipboard.writeText(window.__mdHTML).then(() => {
          const status = document.createElement('div');
          status.className = 'tool-status success';
          status.textContent = '✅ HTML copied!';
          document.getElementById('mdPreview').appendChild(status);
        });
      };
      setTimeout(__mdRender, 100);
    </script>
  `);
}

// ─── Code Minifier ──────────────────────────────────────────

export function renderCodeMinifier() {
  return toolShell('code-minifier', 'Code Minifier', `
    <div class="tool-two-col">
      <div class="tool-panel">
        <div class="tool-panel-header">
          <label>Input Code</label>
          <div class="tool-actions">
            <select id="cmLang" class="tool-select" style="font-size:11px; padding:4px 8px;">
              <option value="js">JavaScript</option>
              <option value="css">CSS</option>
              <option value="html">HTML</option>
            </select>
            <button class="tool-action-btn primary" onclick="window.__cmMinify()">Minify</button>
            <button class="tool-action-btn" onclick="window.__cmClear()">Clear</button>
          </div>
        </div>
        <textarea id="cmInput" class="tool-textarea" placeholder="Paste code here..." spellcheck="false">function hello(name) {
  // This is a comment
  const greeting = "Hello, " + name;
  console.log(greeting);
  return greeting;
}</textarea>
      </div>
      <div class="tool-panel">
        <div class="tool-panel-header">
          <label>Minified Output</label>
          <button class="tool-action-btn" onclick="window.__cmCopy()">Copy</button>
        </div>
        <textarea id="cmOutput" class="tool-textarea" readonly placeholder="Minified code..." spellcheck="false"></textarea>
        <div id="cmStatus" class="tool-status"></div>
      </div>
    </div>
    <script>
      window.__cmMinify = function() {
        const input = document.getElementById('cmInput')?.value || '';
        const lang = document.getElementById('cmLang')?.value || 'js';
        if (!input.trim()) return;
        let minified = input;
        if (lang === 'js') {
          minified = input
            .replace(/\\/\\/[^\\n]*/g, '')
            .replace(/\\/\\*[\\s\\S]*?\\*\\//g, '')
            .replace(/\\s+/g, ' ')
            .replace(/\\s*({|}|\\(|\\)|;|,|:|\\.)\\s*/g, '$1')
            .replace(/\\s*([+\\-*/%]?=)\\s*/g, '$1')
            .replace(/;\\}/g, '}')
            .trim();
        } else if (lang === 'css') {
          minified = input
            .replace(/\\/\\*[\\s\\S]*?\\*\\//g, '')
            .replace(/\\s+/g, ' ')
            .replace(/\\s*({|}|;|:|,)\\s*/g, '$1')
            .trim();
        } else if (lang === 'html') {
          minified = input
            .replace(/<!--[\\s\\S]*?-->/g, '')
            .replace(/>\\s+</g, '><')
            .replace(/\\s{2,}/g, ' ')
            .split('\\n').map(l => l.trim()).join('')
            .trim();
        }
        document.getElementById('cmOutput').value = minified;
        const saved = ((input.length - minified.length) / input.length * 100).toFixed(1);
        document.getElementById('cmStatus').textContent = '✅ ' + input.length + ' → ' + minified.length + ' chars (saved ' + saved + '%)';
        document.getElementById('cmStatus').className = 'tool-status success';
        window.__cmMinified = minified;
      };
      window.__cmCopy = function() {
        if (!window.__cmMinified) return;
        navigator.clipboard.writeText(window.__cmMinified).then(() => {
          document.getElementById('cmStatus').textContent = '✅ Copied!';
        });
      };
      window.__cmClear = function() {
        document.getElementById('cmInput').value = '';
        document.getElementById('cmOutput').value = '';
        document.getElementById('cmStatus').textContent = '';
      };
    </script>
  `);
}

// ─── JSON Diff ──────────────────────────────────────────────

export function renderJSONDiff() {
  return toolShell('json-formatter-alt', 'JSON Diff', `
    <div class="tool-two-col">
      <div class="tool-panel">
        <div class="tool-panel-header">
          <label>Left (Original)</label>
        </div>
        <textarea id="jdLeft" class="tool-textarea" placeholder='{"version": 1, "name": "Old"}' spellcheck="false"></textarea>
      </div>
      <div class="tool-panel">
        <div class="tool-panel-header">
          <label>Right (New)</label>
          <button class="tool-action-btn primary" onclick="window.__jdDiff()">Diff</button>
        </div>
        <textarea id="jdRight" class="tool-textarea" placeholder='{"version": 2, "name": "New"}' spellcheck="false"></textarea>
      </div>
    </div>
    <div id="jdResult" class="tool-diff-result"></div>
    <script>
      window.__jdDiff = function() {
        const left = document.getElementById('jdLeft')?.value;
        const right = document.getElementById('jdRight')?.value;
        const result = document.getElementById('jdResult');
        if (!left && !right) { result.innerHTML = '<p style="color:var(--fg-mute); padding:16px;">Enter JSON on both sides</p>'; return; }
        try {
          const l = left ? JSON.parse(left) : {};
          const r = right ? JSON.parse(right) : {};
          const diff = [];
          const allKeys = [...new Set([...Object.keys(l), ...Object.keys(r)])];
          for (const k of allKeys) {
            const lv = JSON.stringify(l[k]);
            const rv = JSON.stringify(r[k]);
            if (lv === rv && k in l && k in r) continue;
            const status = !(k in l) ? 'added' : (!(k in r) ? 'removed' : 'changed');
            diff.push('<div class="diff-row diff-' + status + '"><span class="diff-key">' + escapeHtml(k) + '</span><span class="diff-old">' + escapeHtml(lv || 'undefined') + '</span><span class="diff-arrow">→</span><span class="diff-new">' + escapeHtml(rv || 'undefined') + '</span></div>');
          }
          result.innerHTML = diff.length ? diff.join('') : '<div class="diff-row diff-same">No differences</div>';
        } catch(e) {
          result.innerHTML = '<div class="diff-row diff-error">Error: ' + escapeHtml(e.message) + '</div>';
        }
      };
    </script>
  `);
}

export function renderLatexPreview() {
  return `
    <div class="tool-container">
      <div class="tool-header">
        <h2>📐 LaTeX Preview</h2>
        <p class="tool-desc">Render LaTeX math equations live. Type LaTeX, see the rendered output. Uses KaTeX (fast, no server).</p>
      </div>
      <div class="tool-row">
        <label>LaTeX Input</label>
        <textarea id="latexInput" class="tool-textarea" rows="4" placeholder="\\frac{1}{1+e^{-x}} = \\sigma(x)" spellcheck="false">\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}</textarea>
      </div>
      <div class="tool-btn-group">
        <button onclick="window.__latexRender()" class="tool-btn">Render</button>
        <button onclick="window.__latexClear()" class="tool-btn tool-btn-secondary">Clear</button>
      </div>
      <div class="tool-row">
        <label>Rendered Output</label>
        <div id="latexOutput" class="latex-output"></div>
      </div>
      <div id="latexStatus" class="tool-status"></div>
      <details class="tool-help">
        <summary>Quick reference</summary>
        <div class="latex-ref">
          <code>\\frac{a}{b}</code> — fraction ·
          <code>\\sqrt{x}</code> — square root ·
          <code>\\sum</code> · <code>\\int</code> · <code>\\lim</code> ·
          <code>\\alpha \\beta \\gamma</code> — Greek ·
          <code>x^{2}</code> · <code>x_{i}</code> — super/subscript ·
          <code>\\begin{matrix}a&b\\\\c&d\\end{matrix}</code> — matrix
        </div>
      </details>
    </div>
    <script>
      window.__latexRender = function() {
        const input = document.getElementById('latexInput')?.value || '';
        const output = document.getElementById('latexOutput');
        const status = document.getElementById('latexStatus');
        if (!input.trim()) { output.innerHTML = ''; status.textContent = '⚠ Enter LaTeX'; return; }
        if (typeof katex === 'undefined') {
          output.innerHTML = '<p class="tool-status error">KaTeX library not loaded. Refresh the page.</p>';
          return;
        }
        try {
          katex.render(input, output, { throwOnError: false, displayMode: true });
          status.textContent = '✅ Rendered';
          status.className = 'tool-status success';
        } catch(err) {
          output.innerHTML = '';
          status.textContent = '❌ ' + err.message;
          status.className = 'tool-status error';
        }
      };
      window.__latexClear = function() {
        document.getElementById('latexInput').value = '';
        document.getElementById('latexOutput').innerHTML = '';
        document.getElementById('latexStatus').textContent = '';
      };
      // Auto-render on load
      setTimeout(window.__latexRender, 100);
    </script>
  `;
}
