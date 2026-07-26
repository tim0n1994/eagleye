/**
 * Eagleye — image tools
 *
 * Image tools: QR, colour picker, compress/resize/convert/crop, screenshot framing.
 * Each render* returns a full HTML string; behaviour lives in the inline
 * <script> the shell re-evaluates. Split out of tools.js; unchanged otherwise.
 */

import { toolShell } from './shell.js';


// ─── QR Generator ───────────────────────────────────────────

export function renderQRGenerator() {
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

// ─── Color Picker & Converter ───────────────────────────────

export function renderColorPicker() {
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

// ─── Image Compressor ───────────────────────────────────────

export function renderImageCompressor() {
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

// ─── Screenshot Beautify (placeholder) ──────────────────────

export function renderScreenshotBeautify() {
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

// escapeHtml is imported from './utils.js' at the top of the file

// ─── Placeholder functions for missing tools ──────────────────────────────────

export function renderImageResizer() {
  return `
    <div class="tool-container">
      <div class="tool-header">
        <h2>📐 Image Resizer</h2>
        <p class="tool-desc">Resize images in your browser. No upload — uses Canvas API. Supports PNG/JPEG/WebP.</p>
      </div>
      <div class="tool-row">
        <label>Select Image</label>
        <input type="file" id="resizeFile" accept="image/*" class="tool-input" />
      </div>
      <div class="tool-grid-2" id="resizeControls" style="display:none">
        <div class="tool-row">
          <label>Width (px)</label>
          <input type="number" id="resizeWidth" class="tool-input" />
        </div>
        <div class="tool-row">
          <label>Height (px)</label>
          <input type="number" id="resizeHeight" class="tool-input" />
        </div>
      </div>
      <div class="tool-row" id="resizeFormatRow" style="display:none">
        <label>Output Format</label>
        <select id="resizeFormat" class="tool-input" style="width:auto">
          <option value="image/png">PNG</option>
          <option value="image/jpeg">JPEG</option>
          <option value="image/webp">WebP</option>
        </select>
        <label>Quality (JPEG/WebP): <input type="range" id="resizeQuality" min="0.1" max="1" step="0.1" value="0.9" style="width:100px"/></label>
      </div>
      <button onclick="window.__resizeImage()" class="tool-btn" id="resizeBtn" style="display:none">Resize & Download</button>
      <div id="resizePreview" class="resize-preview"></div>
    </div>
    <script>
      window.__resizeOrig = null;
      document.getElementById('resizeFile')?.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(ev) {
          const img = new Image();
          img.onload = function() {
            window.__resizeOrig = img;
            document.getElementById('resizeWidth').value = img.width;
            document.getElementById('resizeHeight').value = img.height;
            document.getElementById('resizeControls').style.display = 'grid';
            document.getElementById('resizeFormatRow').style.display = 'flex';
            document.getElementById('resizeBtn').style.display = 'block';
            document.getElementById('resizePreview').innerHTML = '<p class="subtle">Original: ' + img.width + '×' + img.height + '</p>';
          };
          img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
      });
      window.__resizeImage = function() {
        const img = window.__resizeOrig;
        if (!img) return;
        const w = parseInt(document.getElementById('resizeWidth').value) || img.width;
        const h = parseInt(document.getElementById('resizeHeight').value) || img.height;
        const fmt = document.getElementById('resizeFormat').value;
        const q = parseFloat(document.getElementById('resizeQuality').value) || 0.9;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(function(blob) {
          const url = URL.createObjectURL(blob);
          const sizeKB = (blob.size / 1024).toFixed(0);
          document.getElementById('resizePreview').innerHTML =
            '<p class="subtle">Resized: ' + w + '×' + h + ' (' + sizeKB + ' KB)</p>' +
            '<img src="' + url + '" style="max-width:100%;max-height:300px;border:1px solid var(--rule);border-radius:var(--radius)"/>' +
            '<br/><a href="' + url + '" download="resized-image.' + fmt.split('/')[1] + '" class="tool-btn" style="display:inline-block;margin-top:8px">⬇ Download</a>';
        }, fmt, q);
      };
    </script>
  `;
}

export function renderImageConverter() {
  return `
    <div class="tool-container">
      <div class="tool-header">
        <h2>🔄 Image Converter</h2>
        <p class="tool-desc">Convert images between PNG, JPEG, and WebP. No upload — uses Canvas API.</p>
      </div>
      <div class="tool-row">
        <label>Select Image</label>
        <input type="file" id="convFile" accept="image/*" class="tool-input" />
      </div>
      <div class="tool-row" id="convFormatRow" style="display:none">
        <label>Convert to</label>
        <select id="convFormat" class="tool-input" style="width:auto">
          <option value="image/png">PNG</option>
          <option value="image/jpeg">JPEG</option>
          <option value="image/webp">WebP</option>
        </select>
        <label>Quality: <input type="range" id="convQuality" min="0.1" max="1" step="0.1" value="0.9" style="width:100px"/></label>
      </div>
      <button onclick="window.__convImage()" class="tool-btn" id="convBtn" style="display:none">Convert & Download</button>
      <div id="convResult" class="tool-result"></div>
    </div>
    <script>
      window.__convOrig = null;
      window.__convName = '';
      document.getElementById('convFile')?.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        window.__convName = file.name.replace(/[.][^.]+$/, '');
        const reader = new FileReader();
        reader.onload = function(ev) {
          const img = new Image();
          img.onload = function() {
            window.__convOrig = img;
            document.getElementById('convFormatRow').style.display = 'flex';
            document.getElementById('convBtn').style.display = 'block';
            document.getElementById('convResult').innerHTML = '<p class="subtle">Original: ' + img.width + '×' + img.height + ' (' + (file.size/1024).toFixed(0) + ' KB)</p>';
          };
          img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
      });
      window.__convImage = function() {
        const img = window.__convOrig;
        if (!img) return;
        const fmt = document.getElementById('convFormat').value;
        const q = parseFloat(document.getElementById('convQuality').value) || 0.9;
        const canvas = document.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        // For JPEG, fill white background (JPEG doesn't support transparency).
        if (fmt === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(function(blob) {
          const url = URL.createObjectURL(blob);
          const ext = fmt.split('/')[1];
          const sizeKB = (blob.size / 1024).toFixed(0);
          document.getElementById('convResult').innerHTML =
            '<p class="subtle">Converted: ' + ext.toUpperCase() + ' (' + sizeKB + ' KB)</p>' +
            '<img src="' + url + '" style="max-width:100%;max-height:300px;border:1px solid var(--rule);border-radius:var(--radius)"/>' +
            '<br/><a href="' + url + '" download="' + window.__convName + '-converted.' + ext + '" class="tool-btn" style="display:inline-block;margin-top:8px">⬇ Download</a>';
        }, fmt, q);
      };
    </script>
  `;
}

export function renderHEICToJPG() {
  return `
    <div class="tool-container">
      <div class="tool-header">
        <h2>📱 HEIC to JPG</h2>
        <p class="tool-desc">Convert HEIC/HEIF images (from iPhones) to JPG. No upload — uses the browser's native image decoder. Note: HEIC support depends on your browser/OS (Safari on macOS works best).</p>
      </div>
      <div class="tool-row">
        <label>Select HEIC Image</label>
        <input type="file" id="heicFile" accept=".heic,.heif,image/heic,image/heif,image/*" class="tool-input" />
      </div>
      <div class="tool-row" id="heicQualityRow" style="display:none">
        <label>JPEG Quality: <input type="range" id="heicQuality" min="0.1" max="1" step="0.1" value="0.9" style="width:100px"/></label>
      </div>
      <button onclick="window.__heicConvert()" class="tool-btn" id="heicBtn" style="display:none">Convert to JPG</button>
      <div id="heicResult" class="tool-result"></div>
    </div>
    <script>
      document.getElementById('heicFile')?.addEventListener('change', function(e) {
        const hasFile = !!e.target.files[0];
        document.getElementById('heicQualityRow').style.display = hasFile ? 'flex' : 'none';
        document.getElementById('heicBtn').style.display = hasFile ? 'block' : 'none';
        if (hasFile) document.getElementById('heicResult').innerHTML = '<p class="subtle">Ready to convert ' + e.target.files[0].name + '</p>';
      });
      window.__heicConvert = function() {
        const file = document.getElementById('heicFile')?.files[0];
        if (!file) return;
        const result = document.getElementById('heicResult');
        result.innerHTML = '<p class="subtle">Converting...</p>';
        const reader = new FileReader();
        reader.onload = function(ev) {
          const img = new Image();
          img.onload = function() {
            const q = parseFloat(document.getElementById('heicQuality').value) || 0.9;
            const canvas = document.createElement('canvas');
            canvas.width = img.width; canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff'; // JPEG doesn't support transparency
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
            canvas.toBlob(function(blob) {
              if (!blob) { result.innerHTML = '<p class="tool-status error">Conversion failed. Your browser may not support HEIC decoding. Try Safari on macOS.</p>'; return; }
              const url = URL.createObjectURL(blob);
              const baseName = file.name.replace(/\\.[^.]+$/, '');
              const sizeKB = (blob.size / 1024).toFixed(0);
              result.innerHTML =
                '<p class="subtle">Converted: ' + img.width + '×' + img.height + ' (' + sizeKB + ' KB JPG)</p>' +
                '<img src="' + url + '" style="max-width:100%;max-height:300px;border:1px solid var(--rule);border-radius:var(--radius)"/>' +
                '<br/><a href="' + url + '" download="' + baseName + '.jpg" class="tool-btn" style="display:inline-block;margin-top:8px">⬇ Download JPG</a>';
            }, 'image/jpeg', q);
          };
          img.onerror = function() {
            result.innerHTML = '<p class="tool-status error">Cannot decode HEIC. Your browser does not support HEIC images natively. Use Safari on macOS/iOS, or install a HEIC codec.</p>';
          };
          img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
      };
    </script>
  `;
}

export function renderImageCropper() {
  return `
    <div class="tool-container">
      <div class="tool-header">
        <h2>✂️ Image Cropper</h2>
        <p class="tool-desc">Crop images by specifying the region. Enter top-left X/Y and width/height. No upload — uses Canvas API.</p>
      </div>
      <div class="tool-row">
        <label>Select Image</label>
        <input type="file" id="cropFile" accept="image/*" class="tool-input" />
      </div>
      <div class="tool-grid-2" id="cropControls" style="display:none">
        <div class="tool-row"><label>X (left)</label><input type="number" id="cropX" class="tool-input" value="0" /></div>
        <div class="tool-row"><label>Y (top)</label><input type="number" id="cropY" class="tool-input" value="0" /></div>
        <div class="tool-row"><label>Width</label><input type="number" id="cropW" class="tool-input" /></div>
        <div class="tool-row"><label>Height</label><input type="number" id="cropH" class="tool-input" /></div>
      </div>
      <button onclick="window.__cropImage()" class="tool-btn" id="cropBtn" style="display:none">Crop & Download</button>
      <div id="cropResult" class="tool-result"></div>
    </div>
    <script>
      window.__cropOrig = null;
      window.__cropName = '';
      document.getElementById('cropFile')?.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        window.__cropName = file.name.replace(/\\.[^.]+$/, '');
        const reader = new FileReader();
        reader.onload = function(ev) {
          const img = new Image();
          img.onload = function() {
            window.__cropOrig = img;
            document.getElementById('cropX').value = 0;
            document.getElementById('cropY').value = 0;
            document.getElementById('cropW').value = img.width;
            document.getElementById('cropH').value = img.height;
            document.getElementById('cropControls').style.display = 'grid';
            document.getElementById('cropBtn').style.display = 'block';
            document.getElementById('cropResult').innerHTML = '<p class="subtle">Original: ' + img.width + '×' + img.height + '</p>';
          };
          img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
      });
      window.__cropImage = function() {
        const img = window.__cropOrig;
        if (!img) return;
        const x = Math.max(0, parseInt(document.getElementById('cropX').value) || 0);
        const y = Math.max(0, parseInt(document.getElementById('cropY').value) || 0);
        const w = Math.min(parseInt(document.getElementById('cropW').value) || 0, img.width - x);
        const h = Math.min(parseInt(document.getElementById('cropH').value) || 0, img.height - y);
        if (w <= 0 || h <= 0) { document.getElementById('cropResult').innerHTML = '<p class="tool-status error">Invalid crop region</p>'; return; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
        canvas.toBlob(function(blob) {
          const url = URL.createObjectURL(blob);
          const sizeKB = (blob.size / 1024).toFixed(0);
          document.getElementById('cropResult').innerHTML =
            '<p class="subtle">Cropped: ' + w + '×' + h + ' (' + sizeKB + ' KB)</p>' +
            '<img src="' + url + '" style="max-width:100%;max-height:300px;border:1px solid var(--rule);border-radius:var(--radius)"/>' +
            '<br/><a href="' + url + '" download="' + window.__cropName + '-cropped.png" class="tool-btn" style="display:inline-block;margin-top:8px">⬇ Download</a>';
        }, 'image/png');
      };
    </script>
  `;
}
