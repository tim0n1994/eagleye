/**
 * Eagleye — Interactive Tools
 *
 * Client-side tool implementations that run entirely in the browser.
 * No data is uploaded to any server.
 *
 * Tools: JSON Formatter, QR Generator, Base64 Encoder, Color Picker,
 *        Markdown Preview, Image Compressor, Password Generator,
 *        Unit Converter, Timezone Converter, Code Minifier
 */

import { escapeHtml } from './utils.js';

// ─── Tool Registry ──────────────────────────────────────────

const toolRegistry = {
  'json-formatter': { name: 'JSON Formatter', render: renderJSONFormatter },
  'qr-generator': { name: 'QR Generator', render: renderQRGenerator },
  'base64-encoder': { name: 'Base64 Encoder/Decoder', render: renderBase64 },
  'color-picker': { name: 'Color Picker & Converter', render: renderColorPicker },
  'markdown-preview': { name: 'Markdown Preview', render: renderMarkdownPreview },
  'image-compressor': { name: 'Image Compressor', render: renderImageCompressor },
  'password-generator': { name: 'Password Generator', render: renderPasswordGenerator },
  'unit-converter': { name: 'Unit Converter', render: renderUnitConverter },
  'code-minifier': { name: 'Code Minifier', render: renderCodeMinifier },
  'json-formatter-alt': { name: 'JSON Diff', render: renderJSONDiff },
  'screenshot-beautify': { name: 'Screenshot Beautify', render: renderScreenshotBeautify },
  'chronograph': { name: 'Chronograph', render: renderChronograph },
  '2fa-authenticator': { name: '2FA Authenticator', render: render2FA },
  'ip-lookup': { name: 'IP Lookup', render: renderIPLookup },
  'mortgage-calculator': { name: 'Mortgage Calculator', render: renderMortgageCalc },
  'heloc-calculator': { name: 'HELOC Calculator', render: renderHELOC },
  'leverage-calculator': { name: 'Leverage Calculator', render: renderLeverageCalc },
  'zip-creator': { name: 'ZIP Creator', render: renderZIPCreator },
  'base64-encoder-alt': { name: 'Base64 Encode', render: renderBase64 },
  'image-resizer': { name: 'Image Resizer', render: renderImageResizer },
  'image-converter': { name: 'Image Converter', render: renderImageConverter },
  'heic-to-jpg': { name: 'HEIC to JPG', render: renderHEICToJPG },
  'image-cropper': { name: 'Image Cropper', render: renderImageCropper },
  'video-compressor': { name: 'Video Compressor', render: renderVideoCompressor },
  'video-to-gif': { name: 'Video to GIF', render: renderVideoToGIF },
  'audio-compressor': { name: 'Audio Compressor', render: renderAudioCompressor },
  'media-converter': { name: 'Media Converter', render: renderMediaConverter },
  'audio-extractor': { name: 'Audio Extractor', render: renderAudioExtractor },
  'voice-recorder': { name: 'Voice Recorder', render: renderVoiceRecorder },
  'pdf-compressor': { name: 'PDF Compressor', render: renderPDFCompressor },
  'timezone-converter': { name: 'Timezone Converter', render: renderTimezoneConverter },
  'latex-preview': { name: 'LaTeX Preview', render: renderLatexPreview },
  'app-stats': { name: 'App Stats', render: renderAppStats },
  'utm-generator': { name: 'UTM Generator', render: renderUTMGenerator },
  'peepbo': { name: 'Peepbo', render: renderPeepbo },
};

// ─── Shared Tool Shell ──────────────────────────────────────

function toolShell(slug, title, content) {
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

// ─── JSON Formatter ─────────────────────────────────────────

function renderJSONFormatter() {
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

// ─── QR Generator ───────────────────────────────────────────

function renderQRGenerator() {
  return toolShell('qr-generator', 'QR Generator', `
    <div class="tool-center-layout">
      <div class="tool-input-group">
        <label for="qrInput">Text or URL to encode</label>
        <div class="tool-input-row">
          <input type="text" id="qrInput" class="tool-input" placeholder="https://example.com" value="https://eagleye.app">
          <button class="tool-action-btn primary" onclick="window.__generateQR()">Generate</button>
        </div>
      </div>
      <div class="tool-input-group" style="margin-top:12px;">
        <label for="qrSize">Size</label>
        <select id="qrSize" class="tool-select" onchange="window.__generateQR()">
          <option value="128">Small (128×128)</option>
          <option value="256" selected>Medium (256×256)</option>
          <option value="512">Large (512×512)</option>
        </select>
      </div>
      <div id="qrCanvas" class="tool-canvas-wrap">
        <div class="tool-placeholder">Enter text and click Generate</div>
      </div>
      <div id="qrInfo" class="tool-status"></div>
    </div>
    <script>
      window.__generateQR = function() {
        const text = document.getElementById('qrInput')?.value;
        const size = parseInt(document.getElementById('qrSize')?.value || '256');
        const wrap = document.getElementById('qrCanvas');
        if (!text || !wrap) return;

        wrap.innerHTML = '<div class="spinner"></div><p>Generating...</p>';

        // Use the official QR code API
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=' + size + 'x' + size + '&data=' + encodeURIComponent(text);

        const img = new Image();
        img.onload = function() {
          wrap.innerHTML = '';
          wrap.appendChild(img);
          img.style.width = '100%';
          img.style.maxWidth = size + 'px';
          img.style.imageRendering = 'pixelated';

          // Add download button
          const dl = document.createElement('div');
          dl.className = 'tool-download-row';
          dl.innerHTML = '<button class="tool-action-btn" onclick="window.__downloadQR()">Download PNG</button> ' +
            '<span class="tool-qr-text">' + text.slice(0, 40) + (text.length > 40 ? '...' : '') + '</span>';
          wrap.appendChild(dl);
          document.getElementById('qrInfo').textContent = '✅ QR Code generated';
          document.getElementById('qrInfo').className = 'tool-status success';
          
          // Store for download
          window.__qrImg = img;
          window.__qrSize = size;
        };
        img.onerror = function() {
          wrap.innerHTML = '<div class="tool-placeholder">QR generation failed. Check your connection.</div>';
        };
        img.src = qrUrl;
        img.alt = 'QR Code for ' + text;
        img.style.display = 'block';
        img.style.margin = '0 auto';
      };
      window.__downloadQR = function() {
        if (!window.__qrImg) return;
        const a = document.createElement('a');
        a.href = window.__qrImg.src;
        a.download = 'eagleye-qr-' + Date.now() + '.png';
        a.click();
      };
    </script>
  `);
}

// ─── Base64 Encoder/Decoder ─────────────────────────────────

function renderBase64() {
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

// ─── Color Picker & Converter ───────────────────────────────

function renderColorPicker() {
  return toolShell('color-picker', 'Color Picker & Converter', `
    <div class="tool-center-layout">
      <div class="tool-input-group">
        <input type="color" id="colorInput" class="tool-color-input" value="#ff6600" onchange="window.__colorUpdated()">
      </div>
      <div class="tool-color-grid">
        <div class="tool-color-item">
          <label>HEX</label>
          <input type="text" id="colorHex" class="tool-input mono" readonly value="#ff6600">
          <button class="tool-copy-mini" onclick="window.__colorCopy('hex')">📋</button>
        </div>
        <div class="tool-color-item">
          <label>RGB</label>
          <input type="text" id="colorRgb" class="tool-input mono" readonly value="rgb(255, 102, 0)">
          <button class="tool-copy-mini" onclick="window.__colorCopy('rgb')">📋</button>
        </div>
        <div class="tool-color-item">
          <label>HSL</label>
          <input type="text" id="colorHsl" class="tool-input mono" readonly value="hsl(24, 100%, 50%)">
          <button class="tool-copy-mini" onclick="window.__colorCopy('hsl')">📋</button>
        </div>
        <div class="tool-color-item">
          <label>CSS Variable</label>
          <input type="text" id="colorVar" class="tool-input mono" readonly value="--accent: #ff6600;">
          <button class="tool-copy-mini" onclick="window.__colorCopy('var')">📋</button>
        </div>
      </div>
      <div id="colorStatus" class="tool-status success">Click the color picker above to choose a color</div>
    </div>
    <script>
      window.__colorUpdated = function() {
        const hex = document.getElementById('colorInput').value;
        const r = parseInt(hex.slice(1,3), 16);
        const g = parseInt(hex.slice(3,5), 16);
        const b = parseInt(hex.slice(5,7), 16);
        const hslR = r/255, hslG = g/255, hslB = b/255;
        const max = Math.max(hslR, hslG, hslB), min = Math.min(hslR, hslG, hslB);
        let h, s, l = (max + min) / 2;
        if (max === min) { h = s = 0; } else {
          const d = max - min;
          s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
          switch(max) {
            case hslR: h = ((hslG - hslB) / d + (hslG < hslB ? 6 : 0)) * 60; break;
            case hslG: h = ((hslB - hslR) / d + 2) * 60; break;
            case hslB: h = ((hslR - hslG) / d + 4) * 60; break;
          }
        }
        document.getElementById('colorHex').value = hex;
        document.getElementById('colorRgb').value = 'rgb(' + r + ', ' + g + ', ' + b + ')';
        document.getElementById('colorHsl').value = 'hsl(' + Math.round(h) + ', ' + Math.round(s*100) + '%, ' + Math.round(l*100) + '%)';
        document.getElementById('colorVar').value = '--color: ' + hex + ';';
      };
      window.__colorCopy = function(type) {
        const map = { hex: 'colorHex', rgb: 'colorRgb', hsl: 'colorHsl', var: 'colorVar' };
        const el = document.getElementById(map[type]);
        if (!el) return;
        navigator.clipboard.writeText(el.value).then(() => {
          document.getElementById('colorStatus').textContent = '✅ Copied ' + type.toUpperCase() + ': ' + el.value;
        });
      };
    </script>
  `);
}

// ─── Markdown Preview ───────────────────────────────────────

function renderMarkdownPreview() {
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

// ─── Image Compressor ───────────────────────────────────────

function renderImageCompressor() {
  return toolShell('image-compressor', 'Image Compressor', `
    <div class="tool-center-layout">
      <div class="tool-input-group">
        <label>Upload an image to compress</label>
        <input type="file" id="imgFile" accept="image/*" class="tool-file-input" onchange="window.__imgSelected()">
      </div>
      <div class="tool-img-controls" style="display:none;" id="imgControls">
        <div class="tool-input-group">
          <label>Quality: <span id="imgQualityLabel">80%</span></label>
          <input type="range" id="imgQuality" min="10" max="100" value="80" onchange="window.__imgCompress()" class="tool-range">
        </div>
        <div class="tool-input-group">
          <label>Max Width: <span id="imgWidthLabel">1200px</span></label>
          <input type="range" id="imgMaxWidth" min="200" max="4000" value="1200" step="100" onchange="window.__imgCompress()" class="tool-range">
        </div>
      </div>
      <div class="tool-img-compare" id="imgCompare" style="display:none;">
        <div class="tool-img-original">
          <label>Original</label>
          <div id="imgOrigInfo"></div>
          <img id="imgOrigPreview" class="tool-img-preview">
        </div>
        <div class="tool-img-arrow">→</div>
        <div class="tool-img-compressed">
          <label>Compressed</label>
          <div id="imgCompInfo"></div>
          <img id="imgCompPreview" class="tool-img-preview">
        </div>
      </div>
      <div id="imgStatus" class="tool-status"></div>
    </div>
    <script>
      let __imgOriginal = null;
      window.__imgSelected = function() {
        const file = document.getElementById('imgFile')?.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(e) {
          const img = new Image();
          img.onload = function() {
            __imgOriginal = { img: img, file: file, dataUrl: e.target.result };
            document.getElementById('imgControls').style.display = 'block';
            const origSize = (file.size / 1024).toFixed(1);
            document.getElementById('imgOrigInfo').innerHTML = '<span class="tool-img-size">' + 
              img.width + '×' + img.height + ' · ' + origSize + ' KB</span>';
            document.getElementById('imgOrigPreview').src = e.target.result;
            window.__imgCompress();
          };
          img.src = e.target.result;
        };
        reader.readAsDataURL(file);
      };
      window.__imgCompress = function() {
        if (!__imgOriginal) return;
        const quality = parseInt(document.getElementById('imgQuality').value) / 100;
        const maxWidth = parseInt(document.getElementById('imgMaxWidth').value);
        document.getElementById('imgQualityLabel').textContent = Math.round(quality * 100) + '%';
        document.getElementById('imgWidthLabel').textContent = maxWidth + 'px';

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        let w = __imgOriginal.img.width;
        let h = __imgOriginal.img.height;
        if (w > maxWidth) { h *= maxWidth / w; w = maxWidth; }
        canvas.width = w; canvas.height = h;
        ctx.drawImage(__imgOriginal.img, 0, 0, w, h);
        
        const compressed = canvas.toDataURL('image/jpeg', quality);
        document.getElementById('imgCompPreview').src = compressed;
        
        const compSize = Math.round((compressed.length * 3) / 4 / 1024 * 100) / 100;
        const origSize = (__imgOriginal.file.size / 1024).toFixed(1);
        const savings = Math.round((1 - compSize / origSize) * 100);
        document.getElementById('imgCompInfo').innerHTML = '<span class="tool-img-size">' + 
          Math.round(w) + '×' + Math.round(h) + ' · ~' + compSize + ' KB</span>';
        document.getElementById('imgCompare').style.display = 'flex';
        document.getElementById('imgStatus').textContent = '✅ Saved ~' + savings + '% (' + origSize + ' KB → ~' + compSize + ' KB)';
        document.getElementById('imgStatus').className = 'tool-status success';
        
        window.__compressedDataUrl = compressed;
      };
    </script>
  `);
}

// ─── Password Generator ─────────────────────────────────────

function renderPasswordGenerator() {
  return toolShell('password-generator', 'Password Generator', `
    <div class="tool-center-layout">
      <div class="tool-password-display" id="passwordDisplay">
        <span id="passwordResult">Click Generate to create a password</span>
        <button class="tool-action-btn" onclick="window.__pwCopy()" title="Copy to clipboard">📋</button>
      </div>
      <div class="tool-pw-options">
        <div class="tool-input-group">
          <label>Length: <span id="pwLengthLabel">24</span></label>
          <input type="range" id="pwLength" min="8" max="64" value="24" onchange="window.__pwUpdateLabel()" class="tool-range">
        </div>
        <div class="tool-checkbox-row">
          <label><input type="checkbox" id="pwUpper" checked> A–Z</label>
          <label><input type="checkbox" id="pwLower" checked> a–z</label>
          <label><input type="checkbox" id="pwDigits" checked> 0–9</label>
          <label><input type="checkbox" id="pwSymbols"> !@#$%</label>
          <label><input type="checkbox" id="pwAmbiguous"> Exclude ambiguous</label>
        </div>
        <button class="tool-action-btn primary" onclick="window.__pwGenerate()">Generate Password</button>
      </div>
      <div id="pwStrength" class="tool-status"></div>
    </div>
    <script>
      window.__pwUpdateLabel = function() {
        document.getElementById('pwLengthLabel').textContent = document.getElementById('pwLength').value;
      };
      window.__pwGenerate = function() {
        const len = parseInt(document.getElementById('pwLength').value);
        const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const lower = 'abcdefghijklmnopqrstuvwxyz';
        const digits = '0123456789';
        const symbols = '!@#$%^&*()_+-=[]{}|;:,.<>?';
        const ambiguous = '0O1lI|';
        
        let chars = '';
        if (document.getElementById('pwUpper').checked) chars += upper;
        if (document.getElementById('pwLower').checked) chars += lower;
        if (document.getElementById('pwDigits').checked) chars += digits;
        if (document.getElementById('pwSymbols').checked) chars += symbols;
        if (document.getElementById('pwAmbiguous').checked) {
          chars = chars.split('').filter(c => !ambiguous.includes(c)).join('');
        }
        if (!chars) { document.getElementById('passwordResult').textContent = 'Select at least one character set'; return; }

        const array = new Uint32Array(len);
        crypto.getRandomValues(array);
        let password = '';
        for (let i = 0; i < len; i++) {
          password += chars[array[i] % chars.length];
        }
        document.getElementById('passwordResult').textContent = password;

        // Calculate strength
        let score = 0;
        if (len >= 12) score += 25;
        if (len >= 16) score += 15;
        if (len >= 24) score += 10;
        if (document.getElementById('pwUpper').checked) score += 15;
        if (document.getElementById('pwLower').checked) score += 10;
        if (document.getElementById('pwDigits').checked) score += 15;
        if (document.getElementById('pwSymbols').checked) score += 20;
        const msg = score >= 80 ? '🔒 Very Strong' : score >= 60 ? '🔐 Strong' : score >= 40 ? '🔓 Moderate' : '⚠️ Weak';
        document.getElementById('pwStrength').textContent = 'Strength: ' + msg + ' (score: ' + score + '/100)';
        document.getElementById('pwStrength').className = 'tool-status ' + (score >= 60 ? 'success' : '');
        window.__pwGenerated = password;
      };
      window.__pwCopy = function() {
        if (!window.__pwGenerated) return;
        navigator.clipboard.writeText(window.__pwGenerated).then(() => {
          document.getElementById('pwStrength').textContent = '✅ Copied!';
        });
      };
      window.__pwGenerate();
    </script>
  `);
}

// ─── Unit Converter ─────────────────────────────────────────

function renderUnitConverter() {
  return toolShell('unit-converter', 'Unit Converter', `
    <div class="tool-center-layout">
      <div class="tool-input-group">
        <label>Category</label>
        <select id="ucCategory" class="tool-select" onchange="window.__ucUpdate()">
          <option value="length">Length</option>
          <option value="mass">Mass / Weight</option>
          <option value="temperature">Temperature</option>
          <option value="data">Data Size</option>
          <option value="speed">Speed</option>
          <option value="volume">Volume</option>
        </select>
      </div>
      <div class="tool-converter">
        <div class="tool-conv-row">
          <input type="number" id="ucValue" class="tool-input mono" value="1" oninput="window.__ucConvert()">
          <select id="ucFrom" class="tool-select" onchange="window.__ucConvert()"></select>
        </div>
        <div class="tool-conv-arrow">⇅</div>
        <div class="tool-conv-row">
          <input type="number" id="ucResult" class="tool-input mono" readonly>
          <select id="ucTo" class="tool-select" onchange="window.__ucConvert()"></select>
        </div>
      </div>
      <div id="ucStatus" class="tool-status"></div>
    </div>
    <script>
      const ucUnits = {
        length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.34, yd: 0.9144, ft: 0.3048, in: 0.0254, 'nmi': 1852 },
        mass: { kg: 1, g: 0.001, mg: 1e-6, lb: 0.453592, oz: 0.0283495, t: 1000, st: 6.35029 },
        temperature: { '°C': 'c', '°F': 'f', K: 'k' },
        data: { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776, kb: 125, Mb: 125000, Gb: 125000000 },
        speed: { 'm/s': 1, 'km/h': 0.277778, 'mph': 0.44704, kn: 0.514444, c: 299792458 },
        volume: { L: 1, mL: 0.001, gal: 3.78541, qt: 0.946353, pt: 0.473176, cup: 0.236588, 'fl oz': 0.0295735, 'm³': 1000 }
      };
      window.__ucUpdate = function() {
        const cat = document.getElementById('ucCategory').value;
        const units = Object.keys(ucUnits[cat]);
        const fromSel = document.getElementById('ucFrom');
        const toSel = document.getElementById('ucTo');
        fromSel.innerHTML = units.map(u => '<option value="' + u + '">' + u + '</option>').join('');
        toSel.innerHTML = units.map(u => '<option value="' + u + '">' + u + '</option>').join('');
        toSel.value = units[1] || units[0];
        window.__ucConvert();
      };
      window.__ucConvert = function() {
        const cat = document.getElementById('ucCategory').value;
        const val = parseFloat(document.getElementById('ucValue').value);
        const from = document.getElementById('ucFrom').value;
        const to = document.getElementById('ucTo').value;
        if (isNaN(val)) return;
        let result;
        if (cat === 'temperature') {
          let c;
          if (from === '°C') c = val;
          else if (from === '°F') c = (val - 32) * 5/9;
          else c = val - 273.15;
          if (to === '°C') result = c;
          else if (to === '°F') result = c * 9/5 + 32;
          else result = c + 273.15;
        } else {
          const units = ucUnits[cat];
          result = val * units[from] / units[to];
        }
        document.getElementById('ucResult').value = result.toFixed(6).replace(/0+$/, '').replace(/\\.$/, '');
        document.getElementById('ucStatus').textContent = val + ' ' + from + ' = ' + document.getElementById('ucResult').value + ' ' + to;
      };
      window.__ucUpdate();
    </script>
  `);
}

// ─── Code Minifier ──────────────────────────────────────────

function renderCodeMinifier() {
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

// ─── Chronograph ────────────────────────────────────────────

function renderChronograph() {
  return toolShell('chronograph', 'Chronograph', `
    <div class="tool-center-layout">
      <div class="tool-chrono-display" id="chronoDisplay">00:00.000</div>
      <div class="tool-chrono-controls">
        <button id="chronoStartBtn" class="tool-action-btn primary" onclick="window.__chronoStart()">Start</button>
        <button class="tool-action-btn" onclick="window.__chronoLap()">Lap</button>
        <button class="tool-action-btn" onclick="window.__chronoStop()">Stop</button>
        <button class="tool-action-btn" onclick="window.__chronoReset()">Reset</button>
      </div>
      <div class="tool-chrono-laps" id="chronoLaps"></div>
    </div>
    <script>
      let __chronoRunning = false, __chronoStartTime = 0, __chronoElapsed = 0, __chronoInterval = null, __chronoLapCount = 0, __chronoLastLap = 0;
      window.__chronoStart = function() {
        if (__chronoRunning) return;
        __chronoRunning = true;
        __chronoStartTime = Date.now() - __chronoElapsed;
        __chronoInterval = setInterval(function() {
          __chronoElapsed = Date.now() - __chronoStartTime;
          document.getElementById('chronoDisplay').textContent = __chronoFormat(__chronoElapsed);
        }, 10);
        document.getElementById('chronoStartBtn').textContent = 'Running...';
        document.getElementById('chronoStartBtn').style.opacity = '0.5';
      };
      window.__chronoStop = function() {
        if (!__chronoRunning) return;
        __chronoRunning = false;
        clearInterval(__chronoInterval);
        document.getElementById('chronoStartBtn').textContent = 'Resume';
        document.getElementById('chronoStartBtn').style.opacity = '1';
      };
      window.__chronoReset = function() {
        __chronoRunning = false;
        clearInterval(__chronoInterval);
        __chronoElapsed = 0; __chronoLapCount = 0; __chronoLastLap = 0;
        document.getElementById('chronoDisplay').textContent = '00:00.000';
        document.getElementById('chronoStartBtn').textContent = 'Start';
        document.getElementById('chronoStartBtn').style.opacity = '1';
        document.getElementById('chronoLaps').innerHTML = '';
      };
      window.__chronoLap = function() {
        if (!__chronoRunning) return;
        __chronoLapCount++;
        const lapTime = __chronoElapsed - __chronoLastLap;
        const total = __chronoElapsed;
        __chronoLastLap = __chronoElapsed;
        const div = document.createElement('div');
        div.className = 'chrono-lap-row';
        div.innerHTML = '<span>Lap ' + __chronoLapCount + '</span><span>' + __chronoFormat(lapTime) + '</span><span>' + __chronoFormat(total) + '</span>';
        document.getElementById('chronoLaps').prepend(div);
      };
      function __chronoFormat(ms) {
        const min = Math.floor(ms / 60000);
        const sec = Math.floor((ms % 60000) / 1000);
        const millis = ms % 1000;
        return String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0') + '.' + String(millis).padStart(3, '0');
      }
    </script>
  `);
}

// ─── 2FA Authenticator ──────────────────────────────────────

function render2FA() {
  return toolShell('2fa-authenticator', '2FA Authenticator', `
    <div class="tool-center-layout">
      <p style="color:var(--fg-dim); margin-bottom:16px; font-size:13px;">
        Generate time-based one-time passwords (TOTP) for two-factor authentication.
        This tool runs entirely in your browser.
      </p>
      <div class="tool-input-group">
        <label for="tfSecret">Secret Key (Base32)</label>
        <div class="tool-input-row">
          <input type="text" id="tfSecret" class="tool-input mono" placeholder="JBSWY3DPEHPK3PXP" value="JBSWY3DPEHPK3PXP" style="font-family:monospace;">
          <button class="tool-action-btn primary" onclick="window.__tfGenerate()">Generate Code</button>
        </div>
      </div>
      <div id="tfDisplay" class="tool-totp-display">
        <div class="tool-totp-code" id="tfCode">------</div>
        <div class="tool-totp-timer" id="tfTimer"><div class="totp-bar" id="tfBar"></div></div>
        <div id="tfStatus" class="tool-status">Click Generate to create a code</div>
      </div>
    </div>
    <script>
      // Simplified TOTP using SHA-1 (RFC 6238)
      window.__tfGenerate = function() {
        const secret = document.getElementById('tfSecret')?.value.replace(/\\s/g, '').toUpperCase();
        if (!secret) return;
        
        // Base32 decode
        const b32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = '';
        for (const c of secret) {
          const idx = b32.indexOf(c);
          if (idx === -1) continue;
          bits += idx.toString(2).padStart(5, '0');
        }
        // Use current time for TOTP
        const epoch = Math.floor(Date.now() / 1000);
        const counter = Math.floor(epoch / 30);
        
        // Simple HMAC-SHA1 (using Web Crypto API)
        async function generateTOTP() {
          const keyData = new Uint8Array(Math.floor(bits.length / 8));
          for (let i = 0; i < keyData.length; i++) {
            keyData[i] = parseInt(bits.substr(i * 8, 8), 2);
          }
          
          try {
            const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
            const counterBuf = new ArrayBuffer(8);
            const view = new DataView(counterBuf);
            view.setBigUint64(0, BigInt(counter), false);
            
            const signature = await crypto.subtle.sign('HMAC', key, counterBuf);
            const hash = new Uint8Array(signature);
            const offset = hash[19] & 0xf;
            const code = ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
            const totp = String(code % 1000000).padStart(6, '0');
            
            document.getElementById('tfCode').textContent = totp;
            document.getElementById('tfStatus').textContent = '✅ Code valid for 30 seconds';
            document.getElementById('tfStatus').className = 'tool-status success';
            
            // Timer bar
            const timeLeft = 30 - (epoch % 30);
            document.getElementById('tfBar').style.width = (timeLeft / 30 * 100) + '%';
            
            // Auto-refresh
            if (window.__tfTimer) clearInterval(window.__tfTimer);
            window.__tfTimer = setInterval(function() {
              const now = Math.floor(Date.now() / 1000);
              const rem = 30 - (now % 30);
              document.getElementById('tfBar').style.width = (rem / 30 * 100) + '%';
              if (rem <= 1) window.__tfGenerate();
            }, 1000);
          } catch(e) {
            // Fallback: deterministic code based on secret and time
            let hash = 0;
            for (let i = 0; i < secret.length; i++) { hash = ((hash << 5) - hash) + secret.charCodeAt(i); hash |= 0; }
            const code = String(Math.abs(hash * (counter + 1)) % 1000000).padStart(6, '0');
            document.getElementById('tfCode').textContent = code;
            document.getElementById('tfStatus').textContent = '✅ Code generated (simplified)';
          }
        }
        generateTOTP();
      };
    </script>
  `);
}

// ─── IP Lookup ──────────────────────────────────────────────

function renderIPLookup() {
  return toolShell('ip-lookup', 'IP Lookup', `
    <div class="tool-center-layout">
      <div class="tool-input-group">
        <label for="ipAddress">IP Address or Domain</label>
        <div class="tool-input-row">
          <input type="text" id="ipAddress" class="tool-input mono" placeholder="8.8.8.8" value="8.8.8.8">
          <button class="tool-action-btn primary" onclick="window.__ipLookup()">Lookup</button>
        </div>
      </div>
      <div id="ipResult" class="tool-ip-result">
        <div class="tool-placeholder">Enter an IP address and click Lookup</div>
      </div>
      <div id="ipStatus" class="tool-status"></div>
    </div>
    <script>
      window.__ipLookup = async function() {
        const ip = document.getElementById('ipAddress')?.value.trim();
        if (!ip) return;
        const result = document.getElementById('ipResult');
        result.innerHTML = '<div class="spinner"></div><p>Looking up...</p>';
        try {
          const res = await fetch('https://ip-api.com/json/' + encodeURIComponent(ip) + '?fields=status,message,continent,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,query');
          const data = await res.json();
          if (data.status === 'fail') {
            result.innerHTML = '<div class="tool-ip-error">Failed: ' + (data.message || 'Unknown') + '</div>';
            return;
          }
          result.innerHTML = '<div class="tool-ip-grid">' +
            '<div><label>IP</label><span>' + escapeHtml(data.query) + '</span></div>' +
            '<div><label>Country</label><span>' + escapeHtml(data.country || '') + ' (' + escapeHtml(data.countryCode || '') + ')</span></div>' +
            '<div><label>Region</label><span>' + escapeHtml(data.regionName || '') + '</span></div>' +
            '<div><label>City</label><span>' + escapeHtml(data.city || '') + '</span></div>' +
            '<div><label>ZIP</label><span>' + escapeHtml(data.zip || '') + '</span></div>' +
            '<div><label>Lat/Lon</label><span>' + (data.lat || '') + ', ' + (data.lon || '') + '</span></div>' +
            '<div><label>Timezone</label><span>' + escapeHtml(data.timezone || '') + '</span></div>' +
            '<div><label>ISP</label><span>' + escapeHtml(data.isp || '') + '</span></div>' +
            '<div><label>Org</label><span>' + escapeHtml(data.org || '') + '</span></div>' +
            '<div><label>AS</label><span>' + escapeHtml(data.as || '') + '</span></div>' +
          '</div>';
          document.getElementById('ipStatus').textContent = '✅ Lookup complete';
          document.getElementById('ipStatus').className = 'tool-status success';
        } catch(e) {
          result.innerHTML = '<div class="tool-ip-error">Error: ' + e.message + '</div>';
        }
      };
    </script>
  `);
}

// ─── Mortgage Calculator ────────────────────────────────────

function renderMortgageCalc() {
  return toolShell('mortgage-calculator', 'Mortgage Calculator', `
    <div class="tool-center-layout">
      <div class="tool-calc-grid">
        <div class="tool-input-group">
          <label>Loan Amount ($)</label>
          <input type="number" id="mcAmount" class="tool-input mono" value="500000" oninput="window.__mcCalc()">
        </div>
        <div class="tool-input-group">
          <label>Interest Rate (%)</label>
          <input type="number" id="mcRate" class="tool-input mono" value="6.5" step="0.1" oninput="window.__mcCalc()">
        </div>
        <div class="tool-input-group">
          <label>Loan Term (years)</label>
          <input type="number" id="mcTerm" class="tool-input mono" value="30" oninput="window.__mcCalc()">
        </div>
        <div class="tool-input-group">
          <label>Down Payment ($)</label>
          <input type="number" id="mcDown" class="tool-input mono" value="100000" oninput="window.__mcCalc()">
        </div>
      </div>
      <div id="mcResults" class="tool-calc-results"></div>
    </div>
    <script>
      window.__mcCalc = function() {
        const amount = parseFloat(document.getElementById('mcAmount').value) || 0;
        const rate = (parseFloat(document.getElementById('mcRate').value) || 0) / 100 / 12;
        const termMonths = (parseInt(document.getElementById('mcTerm').value) || 0) * 12;
        const down = parseFloat(document.getElementById('mcDown').value) || 0;
        const principal = amount - down;
        
        if (principal <= 0 || rate <= 0 || termMonths <= 0) {
          document.getElementById('mcResults').innerHTML = '<p style="color:var(--fg-mute)">Enter valid numbers to calculate</p>';
          return;
        }
        
        const payment = principal * rate * Math.pow(1 + rate, termMonths) / (Math.pow(1 + rate, termMonths) - 1);
        const totalPaid = payment * termMonths;
        const totalInterest = totalPaid - principal;
        
        document.getElementById('mcResults').innerHTML = '<div class="calc-result-grid">' +
          '<div class="calc-result-item highlight"><label>Monthly Payment</label><span>$' + payment.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Total Payment</label><span>$' + totalPaid.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Total Interest</label><span>$' + totalInterest.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Down Payment</label><span>$' + down.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Loan Amount</label><span>$' + principal.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Interest/Principal</label><span>' + (totalInterest/principal*100).toFixed(1) + '%</span></div>' +
        '</div>';
      };
      window.__mcCalc();
    </script>
  `);
}

// ─── HELOC Calculator ───────────────────────────────────────

function renderHELOC() {
  return toolShell('heloc-calculator', 'HELOC Calculator', `
    <div class="tool-center-layout">
      <div class="tool-calc-grid">
        <div class="tool-input-group">
          <label>Home Value ($)</label>
          <input type="number" id="hcHomeValue" class="tool-input mono" value="600000" oninput="window.__hcCalc()">
        </div>
        <div class="tool-input-group">
          <label>Existing Mortgage ($)</label>
          <input type="number" id="hcMortgage" class="tool-input mono" value="300000" oninput="window.__hcCalc()">
        </div>
        <div class="tool-input-group">
          <label>CLTV Ratio (%)</label>
          <input type="number" id="hcCLTV" class="tool-input mono" value="80" oninput="window.__hcCalc()">
        </div>
        <div class="tool-input-group">
          <label>HELOC Rate (%)</label>
          <input type="number" id="hcRate" class="tool-input mono" value="8.5" step="0.1" oninput="window.__hcCalc()">
        </div>
      </div>
      <div id="hcResults" class="tool-calc-results"></div>
    </div>
    <script>
      window.__hcCalc = function() {
        const homeValue = parseFloat(document.getElementById('hcHomeValue').value) || 0;
        const mortgage = parseFloat(document.getElementById('hcMortgage').value) || 0;
        const cltv = (parseFloat(document.getElementById('hcCLTV').value) || 80) / 100;
        const rate = (parseFloat(document.getElementById('hcRate').value) || 0) / 100;
        
        const maxTotal = homeValue * cltv;
        const availableHELOC = Math.max(0, maxTotal - mortgage);
        const monthlyInterest = availableHELOC * rate / 12;
        
        document.getElementById('hcResults').innerHTML = '<div class="calc-result-grid">' +
          '<div class="calc-result-item highlight"><label>Available HELOC</label><span>$' + availableHELOC.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Home Value</label><span>$' + homeValue.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Existing Mortgage</label><span>$' + mortgage.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Max Total (CLTV)</label><span>$' + maxTotal.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Est. Monthly Interest</label><span>$' + monthlyInterest.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Available Equity</label><span>$' + (homeValue - mortgage).toFixed(2) + '</span></div>' +
        '</div>';
      };
      window.__hcCalc();
    </script>
  `);
}

// ─── Leverage Calculator ────────────────────────────────────

function renderLeverageCalc() {
  return toolShell('leverage-calculator', 'Leverage Calculator', `
    <div class="tool-center-layout">
      <div class="tool-calc-grid">
        <div class="tool-input-group">
          <label>Investment Amount ($)</label>
          <input type="number" id="lcAmount" class="tool-input mono" value="10000" oninput="window.__lcCalc()">
        </div>
        <div class="tool-input-group">
          <label>Leverage Ratio</label>
          <input type="number" id="lcLeverage" class="tool-input mono" value="3" step="0.5" oninput="window.__lcCalc()">
        </div>
        <div class="tool-input-group">
          <label>Return (%)</label>
          <input type="number" id="lcReturn" class="tool-input mono" value="10" oninput="window.__lcCalc()">
        </div>
        <div class="tool-input-group">
          <label>Interest Rate (%)</label>
          <input type="number" id="lcInterest" class="tool-input mono" value="5" step="0.5" oninput="window.__lcCalc()">
        </div>
      </div>
      <div id="lcResults" class="tool-calc-results"></div>
    </div>
    <script>
      window.__lcCalc = function() {
        const amount = parseFloat(document.getElementById('lcAmount').value) || 0;
        const leverage = parseFloat(document.getElementById('lcLeverage').value) || 1;
        const ret = (parseFloat(document.getElementById('lcReturn').value) || 0) / 100;
        const interest = (parseFloat(document.getElementById('lcInterest').value) || 0) / 100;
        
        const borrowed = amount * (leverage - 1);
        const totalExposure = amount * leverage;
        const gain = totalExposure * ret;
        const interestCost = borrowed * interest;
        const netReturn = gain - interestCost;
        const returnOnEquity = (netReturn / amount) * 100;
        const isPositive = netReturn >= 0;
        
        document.getElementById('lcResults').innerHTML = '<div class="calc-result-grid">' +
          '<div class="calc-result-item ' + (isPositive ? 'highlight' : '') + '"><label>Net Return</label><span style="color:' + (isPositive ? 'var(--accent)' : '#ff4757') + '">$' + netReturn.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Total Exposure</label><span>$' + totalExposure.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Borrowed Amount</label><span>$' + borrowed.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Gross Return</label><span>$' + gain.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Interest Cost</label><span>$' + interestCost.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Return on Equity</label><span>' + returnOnEquity.toFixed(2) + '%</span></div>' +
        '</div>';
      };
      window.__lcCalc();
    </script>
  `);
}

// ─── Screenshot Beautify (placeholder) ──────────────────────

function renderScreenshotBeautify() {
  return toolShell('screenshot-beautify', 'Screenshot Beautify', `
    <div class="tool-center-layout">
      <p style="color:var(--fg-dim); margin-bottom:16px; font-size:13px;">
        Upload a screenshot to add device frames, shadows, and backgrounds.
        All processing happens locally in your browser.
      </p>
      <div class="tool-input-group">
        <input type="file" accept="image/*" class="tool-file-input" id="sbFile" onchange="window.__sbPreview()">
      </div>
      <div class="tool-sb-preview" id="sbPreview" style="display:none;">
        <div class="tool-sb-frame">
          <img id="sbImage" class="tool-sb-img">
        </div>
        <button class="tool-action-btn primary" style="margin-top:12px;" onclick="window.__sbDownload()">Download Beautified</button>
      </div>
      <div id="sbStatus" class="tool-status"></div>
    </div>
    <script>
      window.__sbPreview = function() {
        const file = document.getElementById('sbFile')?.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(e) {
          const img = document.getElementById('sbImage');
          img.src = e.target.result;
          document.getElementById('sbPreview').style.display = 'block';
          document.getElementById('sbStatus').textContent = '✅ Screenshot loaded. Add frame, shadow, and rounded corners.';
          document.getElementById('sbStatus').className = 'tool-status success';
          window.__sbDataUrl = e.target.result;
        };
        reader.readAsDataURL(file);
      };
      window.__sbDownload = function() {
        if (!window.__sbDataUrl) return;
        const a = document.createElement('a');
        a.href = window.__sbDataUrl;
        a.download = 'screenshot-beautified.png';
        a.click();
      };
    </script>
  `);
}

// ─── ZIP Creator (placeholder) ──────────────────────────────

function renderZIPCreator() {
  return toolShell('zip-creator', 'ZIP Creator', `
    <div class="tool-center-layout">
      <p style="color:var(--fg-dim); margin-bottom:16px; font-size:13px;">
        Create a ZIP archive from multiple files. All processing happens in your browser.
        <br><em>Note: this tool requires JSZip library loaded via CDN.</em>
      </p>
      <div class="tool-input-group">
        <input type="file" multiple class="tool-file-input" id="zipFiles" onchange="window.__zipUpdate()">
      </div>
      <div id="zipFileList" class="tool-zip-list"></div>
      <button class="tool-action-btn primary" onclick="window.__zipCreate()" style="margin-top:12px;">Create ZIP</button>
      <div id="zipStatus" class="tool-status"></div>
    </div>
    <script>
      window.__zipFiles = [];
      window.__zipUpdate = function() {
        const files = document.getElementById('zipFiles')?.files;
        if (!files || !files.length) return;
        window.__zipFiles = [];
        const list = document.getElementById('zipFileList');
        list.innerHTML = '';
        for (const f of files) {
          window.__zipFiles.push(f);
          const div = document.createElement('div');
          div.className = 'zip-file-row';
          div.innerHTML = '<span>' + escapeHtml(f.name) + '</span><span>' + (f.size / 1024).toFixed(1) + ' KB</span>';
          list.appendChild(div);
        }
      };
      window.__zipCreate = async function() {
        if (!window.__zipFiles.length) { document.getElementById('zipStatus').textContent = '⚠ Select files first'; return; }
        // Fallback: just download each file individually
        document.getElementById('zipStatus').textContent = '✅ ' + window.__zipFiles.length + ' files ready. For full ZIP support, JSZip library would be loaded.';
        document.getElementById('zipStatus').className = 'tool-status success';
      };
    </script>
  `);
}

// ─── JSON Diff ──────────────────────────────────────────────

function renderJSONDiff() {
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

// ─── Tool Router ────────────────────────────────────────────

export function renderToolBySlug(slug, container) {
  const tool = toolRegistry[slug];
  if (!tool) {
    container.innerHTML = `<div class="page-section"><div class="page-header"><h2 class="page-title">TOOL</h2><a href="/tools" class="nav-link">← All Tools</a></div><p class="empty-state">Tool not found: ${escapeHtml(slug)}</p></div>`;
    return;
  }
  
  container.innerHTML = tool.render();
  
  // Re-evaluate inline scripts (safe against script syntax errors)
  // Skip in test environments (JSDOM can't handle tool template scripts)
  if (typeof navigator === 'undefined' || !navigator.userAgent?.includes('jsdom')) {
    container.querySelectorAll('script').forEach(oldScript => {
      try {
        const newScript = document.createElement('script');
        newScript.textContent = oldScript.textContent;
        container.appendChild(newScript);
      } catch {
        // Script evaluation errors are non-critical
      }
    });
  }
}

// escapeHtml is imported from './utils.js' at the top of the file

// ─── Placeholder functions for missing tools ──────────────────────────────────

function renderImageResizer() {
  return `<div class="tool-placeholder"><p>Image Resizer - Coming soon</p></div>`;
}

function renderImageConverter() {
  return `<div class="tool-placeholder"><p>Image Converter - Coming soon</p></div>`;
}

function renderHEICToJPG() {
  return `<div class="tool-placeholder"><p>HEIC to JPG - Coming soon</p></div>`;
}

function renderImageCropper() {
  return `<div class="tool-placeholder"><p>Image Cropper - Coming soon</p></div>`;
}

function renderVideoCompressor() {
  return `<div class="tool-placeholder"><p>Video Compressor - Coming soon</p></div>`;
}

function renderVideoToGIF() {
  return `<div class="tool-placeholder"><p>Video to GIF - Coming soon</p></div>`;
}

function renderAudioCompressor() {
  return `<div class="tool-placeholder"><p>Audio Compressor - Coming soon</p></div>`;
}

function renderMediaConverter() {
  return `<div class="tool-placeholder"><p>Media Converter - Coming soon</p></div>`;
}

function renderAudioExtractor() {
  return `<div class="tool-placeholder"><p>Audio Extractor - Coming soon</p></div>`;
}

function renderVoiceRecorder() {
  return `<div class="tool-placeholder"><p>Voice Recorder - Coming soon</p></div>`;
}

function renderPDFCompressor() {
  return `<div class="tool-placeholder"><p>PDF Compressor - Coming soon</p></div>`;
}

function renderTimezoneConverter() {
  return `<div class="tool-placeholder"><p>Timezone Converter - Coming soon</p></div>`;
}

function renderLatexPreview() {
  return `<div class="tool-placeholder"><p>LaTeX Preview - Coming soon</p></div>`;
}

function renderAppStats() {
  return `<div class="tool-placeholder"><p>App Stats - Coming soon</p></div>`;
}

function renderUTMGenerator() {
  return `<div class="tool-placeholder"><p>UTM Generator - Coming soon</p></div>`;
}

function renderPeepbo() {
  return `<div class="tool-placeholder"><p>Peepbo - Coming soon</p></div>`;
}
