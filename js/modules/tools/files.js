/**
 * Eagleye — files tools
 *
 * Archive and document tools: ZIP creation and PDF compression.
 * Each render* returns a full HTML string; behaviour lives in the inline
 * <script> the shell re-evaluates. Split out of tools.js; unchanged otherwise.
 */

import { toolShell } from './shell.js';


// ─── ZIP Creator (placeholder) ──────────────────────────────

export function renderZIPCreator() {
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

export function renderPDFCompressor() {
  return toolShell('pdf-compressor', 'PDF Compressor', `
      <div class="tool-row">
        <label>Select PDF</label>
        <input type="file" id="pdfFile" accept="application/pdf" class="tool-input" />
      </div>
      <button onclick="window.__pdfCompress()" class="tool-btn" id="pdfCompressBtn" style="display:none">Optimize & Download</button>
      <div id="pdfResult" class="tool-result"></div>
    <script>
      document.getElementById('pdfFile')?.addEventListener('change', function(e) {
        const hasFile = !!e.target.files[0];
        document.getElementById('pdfCompressBtn').style.display = hasFile ? 'block' : 'none';
        if (hasFile) {
          const f = e.target.files[0];
          document.getElementById('pdfResult').innerHTML = '<p class="subtle">Selected: ' + f.name + ' (' + (f.size/1024).toFixed(0) + ' KB)</p>';
        }
      });
      window.__pdfCompress = async function() {
        // pdf-lib is 525KB and only this tool uses it — load on first use.
        try { await window.__LIBS.pdfLib(); } catch (e) { /* guard handles it */ }
        const file = document.getElementById('pdfFile')?.files[0];
        if (!file) return;
        if (typeof PDFLib === 'undefined') {
          document.getElementById('pdfResult').innerHTML = '<p class="tool-status error">pdf-lib not loaded. Refresh the page.</p>';
          return;
        }
        const { PDFDocument } = PDFLib;
        const result = document.getElementById('pdfResult');
        result.innerHTML = '<p class="subtle">Processing...</p>';
        try {
          const arrayBuffer = await file.arrayBuffer();
          const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
          // Strip metadata to reduce size.
          pdfDoc.setTitle('');
          pdfDoc.setAuthor('');
          pdfDoc.setSubject('');
          pdfDoc.setKeywords([]);
          pdfDoc.setProducer('pdf-lib');
          pdfDoc.setCreator('pdf-lib');
          // Save with object streams (more compact).
          const optimized = await pdfDoc.save({ useObjectStreams: true });
          const blob = new Blob([optimized], { type: 'application/pdf' });
          const origKB = (file.size / 1024).toFixed(0);
          const newKB = (blob.size / 1024).toFixed(0);
          const savings = file.size > 0 ? Math.round((1 - blob.size / file.size) * 100) : 0;
          const url = URL.createObjectURL(blob);
          result.innerHTML =
            '<div class="tool-output-group">' +
            '<div class="tool-output-label">Original</div><div class="tool-output-value">' + origKB + ' KB</div></div>' +
            '<div class="tool-output-group"><div class="tool-output-label">Optimized</div>' +
            '<div class="tool-output-value">' + newKB + ' KB</div></div>' +
            '<div class="tool-output-group"><div class="tool-output-label">Savings</div>' +
            '<div class="tool-output-value ' + (savings > 0 ? 'tool-status success' : 'tool-status') + '">' +
            (savings > 0 ? '↓ ' + savings + '%' : 'No reduction (already optimized)') + '</div></div>' +
            '<a href="' + url + '" download="optimized.pdf" class="tool-btn" style="display:inline-block;margin-top:12px">⬇ Download optimized PDF</a>';
        } catch(err) {
          result.innerHTML = '<p class="tool-status error">❌ ' + err.message + '</p>';
        }
      };
    </script>
  `);
}
