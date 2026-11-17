/** Personal publishing exports: Markdown → safe HTML; SVG → real PNG cards. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const MarkdownIt = require('markdown-it');
const sanitizeHtml = require('sanitize-html');
const juiceModule = require('juice');
const juice = juiceModule.default || juiceModule;
const { renderAsync } = require('@resvg/resvg-js');
const JSZip = require('jszip');

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
const THEMES = {
  paper: { background: '#f5f0e7', foreground: '#29251f', muted: '#70695e', accent: '#a74930', rule: '#d2c8b9' },
  ink: { background: '#1c2429', foreground: '#f2eee4', muted: '#b5bdba', accent: '#e7b77c', rule: '#45514f' },
  mint: { background: '#e9f2ed', foreground: '#203a32', muted: '#586f66', accent: '#226b51', rule: '#b9cdc1' },
};
let cachedFont;

function fail(message, statusCode = 422) {
  throw Object.assign(new Error(message), { statusCode });
}

function escape(value) {
  return Array.from(String(value ?? '')).filter(c => c.codePointAt(0) >= 32 || '\n\r\t'.includes(c)).join('')
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function publicUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function publicSources(draft) {
  return (draft.sources || []).map(source => ({
    id: String(source.id || ''), title: String(source.title || ''),
    url: publicUrl(source.url), source_label: String(source.source_label || ''),
    evidence_level: String(source.evidence_level || ''),
  }));
}

function sourceList(draft) {
  const sources = publicSources(draft);
  if (!sources.length) return '';
  return `<section class="sources"><h2>来源与延伸阅读</h2><ol>${sources.map(source => `<li>${source.url ? `<a href="${escape(source.url)}">${escape(source.title)}</a>` : escape(source.title)}${source.source_label ? ` · ${escape(source.source_label)}` : ''}</li>`).join('')}</ol></section>`;
}

function safeBody(value) {
  return sanitizeHtml(markdown.render(String(value || '')), {
    allowedTags: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'strong', 'em', 's', 'blockquote', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    allowedAttributes: { a: ['href', 'title'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'] },
    allowedSchemes: ['http', 'https'], allowProtocolRelative: false,
    transformTags: { a: (_tag, attrs) => ({ tagName: 'a', attribs: { ...(publicUrl(attrs.href) ? { href: publicUrl(attrs.href) } : {}), ...(attrs.title ? { title: attrs.title } : {}) } }) },
  });
}

async function renderWechat(draft) {
  if (!draft.wechat?.markdown?.trim()) fail('公众号正文为空，请先编辑并保存。', 400);
  const css = `
    .article{max-width:680px;margin:0 auto;padding:28px 22px;background:#fff;color:#29251f;font-family:-apple-system,BlinkMacSystemFont,"Noto Sans CJK SC","Microsoft YaHei",sans-serif;font-size:16px;line-height:1.9;word-break:break-word;}
    h1{font-size:26px;line-height:1.45;margin:0 0 22px;font-weight:700;}h2{font-size:21px;margin:30px 0 14px;}h3,h4{font-size:18px;margin:24px 0 12px;}
    p{margin:0 0 18px;}strong{font-weight:700;}a{color:#a74930;text-decoration:underline;}blockquote{border-left:3px solid #a74930;margin:22px 0;padding:8px 18px;color:#655e54;background:#f7f4ef;}
    ul,ol{padding-left:24px;margin:12px 0 20px;}li{margin:8px 0;}pre{padding:14px;background:#f3f2ef;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;}code{font-family:monospace;}
    table{width:100%;border-collapse:collapse;font-size:14px;}th,td{border:1px solid #d8d3cb;padding:8px;text-align:left;}hr{border:0;border-top:1px solid #d8d3cb;margin:28px 0;}
    .sources{border-top:1px solid #d8d3cb;margin-top:34px;padding-top:10px;font-size:12px;color:#70695e;}.sources h2{font-size:15px;}.sources li{margin:8px 0;}`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(draft.wechat.title)}</title><style>${css}</style></head><body><section class="article"><h1>${escape(draft.wechat.title)}</h1>${safeBody(draft.wechat.markdown)}${sourceList(draft)}</section></body></html>`;
  // juice() only inlines the supplied CSS; juiceResources() would fetch URLs.
  return juice(html, { removeStyleTags: true, preserveMediaQueries: false, preserveFontFaces: false, applyWidthAttributes: false, applyHeightAttributes: false });
}

function fontConfiguration() {
  const configured = process.env.EAGLEYE_PUBLISHING_FONT?.trim() || '';
  if (cachedFont?.key === configured) return cachedFont;
  try {
    const format = '%{family[0]}\n%{file}\n%{lang}\n';
    let output;
    if (configured) {
      const filename = path.resolve(configured);
      if (!fs.statSync(filename).isFile()) throw new Error('Not a font file');
      output = execFileSync('fc-scan', ['--format', format, filename], { encoding: 'utf8', timeout: 3000, maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } else {
      output = execFileSync('fc-match', ['--format', format, 'sans-serif:lang=zh-cn'], { encoding: 'utf8', timeout: 3000, maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    }
    const [family, filename, languages] = output.split('\n');
    if (!family || !filename || !fs.existsSync(filename) || !/(?:^|\|)zh(?:-|\||$)/.test(languages || '')) throw new Error('CJK font unavailable');
    cachedFont = { key: configured, family, options: { loadSystemFonts: true, fontFiles: [filename], defaultFontFamily: family, sansSerifFamily: family } };
    return cachedFont;
  } catch {
    fail('图卡需要中文字体：请安装 fontconfig 与 fonts-noto-cjk，或将 EAGLEYE_PUBLISHING_FONT 指向可读的中文字体文件。', 503);
  }
}

// Conservative width estimates keep mixed Chinese/Latin text inside the card.
function characterWidth(character, size) {
  if (/\s/u.test(character)) return size * 0.34;
  if (/[ilI.,'`:;!|]/u.test(character)) return size * 0.34;
  if (/[MW@%&#]/u.test(character)) return size * 0.95;
  return /[\u0020-\u007e]/u.test(character) ? size * 0.64 : size * 1.03;
}

function wrap(value, size, width) {
  const lines = [];
  for (const paragraph of String(value || '').replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    let used = 0;
    for (const character of Array.from(paragraph)) {
      const advance = characterWidth(character, size);
      if (used + advance > width && line) { lines.push(line); line = ''; used = 0; }
      line += character;
      used += advance;
    }
    lines.push(line);
  }
  return lines;
}

function layoutCard(card) {
  const title = String(card.title || '').trim();
  const body = String(card.body || '').trim();
  if (!title || !body) fail('每张图卡都需要标题和正文，请补充后保存。', 400);
  if (Array.from(title).length > 40 || Array.from(body).length > 200) fail('图卡标题最多40字、正文最多200字，请拆分或缩短后保存。');
  for (let size = 48; size >= 34; size -= 2) {
    const titleSize = Math.round(size * 1.42);
    const titles = wrap(title, titleSize, 880);
    const lines = wrap(body, size, 880);
    const titleHeight = titles.length * titleSize * 1.38;
    const bodyHeight = lines.length * size * 1.65;
    if (titleHeight + bodyHeight + 72 <= 1000) return { size, titleSize, titles, lines, titleHeight };
  }
  fail('这张图卡的换行过多，无法保持可读字号。请减少空行或拆分内容后保存。');
}

function svgLines(lines, x, y, size, leading, color, weight = 400) {
  return `<text fill="${color}" font-size="${size}" font-weight="${weight}">${lines.map((line, index) => `<tspan x="${x}" y="${y + index * leading}">${escape(line)}</tspan>`).join('')}</text>`;
}

function cardSvg(draft, index, font) {
  const cards = draft.xiaohongshu?.cards;
  if (!Array.isArray(cards) || !cards.length || cards.length > 6) fail('小红书图文需要1至6张图卡。', 400);
  if (!Number.isInteger(index) || index < 0 || index >= cards.length) fail('图卡不存在。', 404);
  const theme = THEMES[draft.theme] || THEMES.paper;
  const card = cards[index];
  const layout = layoutCard(card);
  const sources = publicSources(draft);
  const references = (card.source_ids || []).map(id => sources.findIndex(source => source.id === id) + 1).filter(n => n > 0);
  const footer = references.length ? `来源 ${references.map(n => `[${n}]`).join(' ')} · 完整出处见配套文案` : '个人观察';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440">
    <rect width="1080" height="1440" fill="${theme.background}"/>
    <g font-family="${escape(font.family)}">
      <rect x="88" y="84" width="44" height="6" rx="3" fill="${theme.accent}"/>
      <text x="150" y="96" fill="${theme.muted}" font-size="24" letter-spacing="3">发现与想法</text>
      <text x="990" y="96" text-anchor="end" fill="${theme.muted}" font-size="24">${String(index + 1).padStart(2, '0')} / ${String(cards.length).padStart(2, '0')}</text>
      ${svgLines(layout.titles, 92, 208, layout.titleSize, layout.titleSize * 1.38, theme.foreground, 700)}
      <rect x="92" y="${230 + layout.titleHeight}" width="64" height="5" fill="${theme.accent}"/>
      ${svgLines(layout.lines, 92, 298 + layout.titleHeight, layout.size, layout.size * 1.65, theme.foreground)}
      <path d="M92 1290H988" stroke="${theme.rule}" stroke-width="2"/>
      ${svgLines(wrap(footer, 22, 880), 92, 1331, 22, 30, theme.muted)}
    </g>
  </svg>`;
}

async function renderCard(draft, index) {
  const font = fontConfiguration();
  const svg = cardSvg(draft, index, font);
  const rendered = await renderAsync(svg, { font: font.options, languages: ['zh-CN', 'en'], fitTo: { mode: 'original' }, textRendering: 2 });
  return rendered.asPng();
}

function filename(draft) {
  const value = String(draft.wechat?.title || draft.title || 'Eagleye').replace(/[<>:"/\\|?*]/g, '').replace(/^\.+|[.\s]+$/g, '');
  return Array.from(value).filter(c => c.codePointAt(0) >= 32 && c.codePointAt(0) !== 127).slice(0, 64).join('') || 'Eagleye';
}

function sourceText(draft) {
  return publicSources(draft).map((source, index) => `[${index + 1}] ${source.title}${source.source_label ? ` · ${source.source_label}` : ''}\n${source.url}`).join('\n\n');
}

async function exportDraft(draft, format) {
  const base = filename(draft);
  if (format === 'wechat-html') return { body: await renderWechat(draft), contentType: 'text/html; charset=utf-8', filename: `${base}.html` };
  if (format === 'markdown') return { body: `# ${draft.wechat.title}\n\n${draft.wechat.markdown}\n\n---\n\n来源与延伸阅读\n\n${sourceText(draft)}\n`, contentType: 'text/markdown; charset=utf-8', filename: `${base}.md` };
  if (format === 'xiaohongshu-zip') {
    const cards = draft.xiaohongshu?.cards || [];
    if (!cards.length || cards.length > 6) fail('小红书图文需要1至6张图卡。', 400);
    const zip = new JSZip();
    // Sequential rendering bounds native memory; renderAsync keeps the API free.
    for (let index = 0; index < cards.length; index++) zip.file(`${String(index + 1).padStart(2, '0')}.png`, await renderCard(draft, index));
    const tags = (draft.xiaohongshu.tags || []).map(tag => `#${String(tag).replace(/^#+/, '')}`).join(' ');
    zip.file('caption.txt', `${draft.xiaohongshu.title}\n\n${draft.xiaohongshu.caption}\n\n${tags}\n\n来源与延伸阅读\n\n${sourceText(draft)}\n`);
    zip.file('sources.json', JSON.stringify(publicSources(draft), null, 2));
    return { body: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }), contentType: 'application/zip', filename: `${base}-小红书.zip` };
  }
  fail('不支持的导出格式。', 400);
}

module.exports = { renderWechat, renderCard, exportDraft };
