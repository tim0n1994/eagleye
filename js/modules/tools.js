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
// Publishes window.__LIBS, which the tools' inline <script> strings call to
// pull katex / pdf-lib on first use.
import './lazy-lib.js';

// ─── Tool Registry ──────────────────────────────────────────

import { renderBase64, renderCodeMinifier, renderJSONDiff, renderJSONFormatter, renderLatexPreview, renderMarkdownPreview } from './tools/text.js';
import { renderColorPicker, renderHEICToJPG, renderImageCompressor, renderImageConverter, renderImageCropper, renderImageResizer, renderQRGenerator, renderScreenshotBeautify } from './tools/image.js';
import { renderAudioCompressor, renderAudioExtractor, renderMediaConverter, renderVideoCompressor, renderVideoToGIF, renderVoiceRecorder } from './tools/media.js';
import { renderPDFCompressor, renderZIPCreator } from './tools/files.js';
import { renderChronograph, renderHELOC, renderLeverageCalc, renderMortgageCalc, renderTimezoneConverter, renderUnitConverter } from './tools/calc.js';
import { render2FA, renderAppStats, renderIPLookup, renderPasswordGenerator, renderPeepbo, renderUTMGenerator } from './tools/devnet.js';

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
