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

// Images reach this module only through the trusted, hydrated draft.images
// snapshot (data URIs prepared by the media layer). Nothing is fetched here.
const IMAGE_MIME_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const IMAGE_ORIGINS = new Set(['upload', 'source', 'generated']);
const DATA_URI_PATTERN = /^data:image\/(?:jpe?g|png|webp|gif);base64,[A-Za-z0-9+/=]+$/i;
const PLACEMENT_RANGE = { min: 0, max: 1000 };
// Image-card picture frame: 896px wide, 340-720px tall between title and body.
const CARD_FRAME = { width: 896, minHeight: 340, maxHeight: 720, bottomLimit: 1252, footerGap: 44 };

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

function urlHost(value) {
  try {
    return new URL(value).hostname;
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

const BODY_SANITIZE = {
  allowedTags: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'strong', 'em', 's', 'blockquote', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  allowedAttributes: { a: ['href', 'title'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'] },
  allowedSchemes: ['http', 'https'], allowProtocolRelative: false,
  transformTags: { a: (_tag, attrs) => ({ tagName: 'a', attribs: { ...(publicUrl(attrs.href) ? { href: publicUrl(attrs.href) } : {}), ...(attrs.title ? { title: attrs.title } : {}) } }) },
};
const IMAGE_BODY_SANITIZE = {
  ...BODY_SANITIZE,
  allowedTags: [...BODY_SANITIZE.allowedTags, 'figure', 'figcaption', 'img'],
  allowedAttributes: {
    ...BODY_SANITIZE.allowedAttributes,
    img: ['src', 'alt', 'style'], figure: ['style'], figcaption: ['style'],
  },
  allowedSchemesByTag: { img: ['data'] },
};

function safeBody(value) {
  return sanitizeHtml(markdown.render(String(value || '')), BODY_SANITIZE);
}

function trustedImages(draft) {
  const map = new Map();
  const images = Array.isArray(draft?.images) ? draft.images : [];
  for (const image of images) {
    if (!image || typeof image !== 'object' || typeof image.id !== 'string' || !image.id || map.has(image.id)) continue;
    const mime = String(image.mime_type || '').toLowerCase();
    if (!IMAGE_MIME_EXTENSIONS[mime] || !IMAGE_ORIGINS.has(image.origin)) continue;
    const dataUri = normalizeDataUri(image.data_uri, mime);
    if (!dataUri) continue;
    map.set(image.id, {
      id: image.id,
      filename: typeof image.filename === 'string' ? image.filename : '',
      mime_type: mime,
      source_id: typeof image.source_id === 'string' ? image.source_id : '',
      source_url: publicUrl(image.source_url),
      origin: image.origin,
      data_uri: dataUri,
    });
  }
  return map;
}

function normalizeDataUri(value, mime) {
  if (typeof value !== 'string') return '';
  const compact = value.replace(/\s+/g, '');
  if (!compact.toLowerCase().startsWith(`data:${mime};base64,`)) return '';
  return DATA_URI_PATTERN.test(compact) ? compact : '';
}

function requireImage(trusted, imageId, label) {
  const image = trusted.get(String(imageId || ''));
  if (!image) fail(`${label}引用的图片不存在或不可用，请重新选择。`);
  return image;
}

function imageAlt(image) {
  return String(image.filename || '').trim() || '配图';
}

function imageCredit(image, sources) {
  if (image.origin === 'generated') return { text: 'AI 生成图', html: 'AI 生成图', md: 'AI 生成图' };
  if (image.origin === 'upload') return { text: '作者配图', html: '作者配图', md: '作者配图' };
  const source = sources.find(item => item.id === image.source_id && item.url);
  if (source) {
    const label = source.title || urlHost(source.url) || source.url;
    return {
      text: `图源：${label}（${source.url}）`,
      html: `图源 <a href="${escape(source.url)}">${escape(label)}</a>`,
      md: `图源：[${label.replace(/[[\]]/g, '')}](${source.url})`,
    };
  }
  return { text: '图源：来源素材', html: '图源：来源素材', md: '图源：来源素材' };
}

// All pictures use the draft's explicit image placements. Raw Markdown image
// URLs cannot bypass ownership, image decoding or source-credit handling.
markdown.renderer.rules.image = () => '';

function plannedWechatFigures(draft, trusted) {
  const placements = draft.wechat?.images;
  if (!Array.isArray(placements) || !placements.length) return [];
  const sources = publicSources(draft);
  return placements.map((placement, index) => {
    if (!placement || typeof placement !== 'object') fail(`配图设置 ${index + 1} 无效，请重新保存配图。`);
    const image = requireImage(trusted, placement.image_id, `配图 ${index + 1}`);
    const after = Number(placement.after_paragraph);
    if (!Number.isInteger(after) || after < PLACEMENT_RANGE.min || after > PLACEMENT_RANGE.max) {
      fail(`配图 ${index + 1} 的插入位置 after_paragraph 必须是 0 到 1000 的整数。`);
    }
    return {
      image,
      caption: String(placement.caption || ''),
      after,
      credit: imageCredit(image, sources),
    };
  });
}

function figureHtml(figure, src) {
  const caption = figure.caption.trim();
  const parts = [];
  if (caption) parts.push(escape(caption));
  if (figure.credit.html) parts.push(figure.credit.html);
  const captionHtml = parts.length
    ? `<figcaption style="font-size:13px;color:#70695e;margin-top:8px;line-height:1.6;">${parts.join(' · ')}</figcaption>`
    : '';
  return `<figure style="margin:26px 0;text-align:center;"><img src="${src}" alt="${escape(caption || imageAlt(figure.image))}" style="max-width:100%;width:100%;height:auto;border-radius:6px;">${captionHtml}</figure>`;
}

function figureToken(html) {
  return { type: 'html_block', tag: '', nesting: 0, level: 0, content: html, markup: '', info: '', meta: null, map: null, block: true, hidden: false, children: null, attrs: null };
}

function spliceGrouped(target, entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const list = grouped.get(entry.at) || [];
    const value = entry.token ?? entry.content;
    if (Array.isArray(value)) list.push(...value);
    else list.push(value);
    grouped.set(entry.at, list);
  }
  for (const at of Array.from(grouped.keys()).sort((a, b) => b - a)) {
    target.splice(at, 0, ...grouped.get(at));
  }
}

// Placement anchors come from MarkdownIt tokens (top-level paragraph_open at
// level 0), so figure positions match the UI's paragraph count exactly.
function wechatBodyTokens(markdownText, figures, resolveSrc) {
  const tokens = markdown.parse(String(markdownText || ''), {});
  const paragraphOpens = [];
  tokens.forEach((token, index) => {
    if (token.type === 'paragraph_open' && token.level === 0) paragraphOpens.push(index);
  });
  const entries = figures.map((figure) => {
    let at;
    if (figure.after === 0) {
      at = paragraphOpens.length ? paragraphOpens[0] : tokens.length;
    } else if (figure.after <= paragraphOpens.length) {
      const openIndex = paragraphOpens[figure.after - 1];
      let closeIndex = openIndex + 1;
      while (closeIndex < tokens.length && tokens[closeIndex].type !== 'paragraph_close') closeIndex += 1;
      at = closeIndex + 1;
    } else {
      at = tokens.length;
    }
    return { at, token: figureToken(figureHtml(figure, resolveSrc(figure.image))) };
  });
  spliceGrouped(tokens, entries);
  return tokens;
}

function figureMarkdown(figure, src) {
  const caption = figure.caption.trim() || imageAlt(figure.image);
  const alt = caption.replace(/[[\]]/g, ' ');
  const lines = [`![${alt}](${src})`];
  if (figure.credit.text) lines.push('', `*${figure.credit.md}*`);
  return lines;
}

function wechatMarkdownBody(markdownText, figures, resolveSrc) {
  const source = String(markdownText || '');
  const tokens = markdown.parse(source, {});
  const paragraphOpens = tokens.filter(token => token.type === 'paragraph_open' && token.level === 0 && Array.isArray(token.map));
  const lines = source.split('\n');
  const entries = figures.map((figure) => {
    let line;
    if (figure.after === 0) {
      line = paragraphOpens.length ? paragraphOpens[0].map[0] : lines.length;
    } else if (figure.after <= paragraphOpens.length) {
      line = paragraphOpens[figure.after - 1].map[1];
    } else {
      line = lines.length;
    }
    return { at: line, content: ['', ...figureMarkdown(figure, resolveSrc(figure.image)), ''] };
  });
  spliceGrouped(lines, entries);
  return lines.join('\n');
}

function imageFileBase(value) {
  return path.basename(String(value || '')).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]+/g, '').replace(/^[.-]+/, '').slice(0, 60);
}

function linkedImagePaths(usedImages) {
  const map = new Map();
  const names = new Set();
  usedImages.forEach((image, index) => {
    const base = imageFileBase(image.filename) || `image-${index + 1}`;
    const extension = IMAGE_MIME_EXTENSIONS[image.mime_type];
    let name = `${base}${extension}`;
    let counter = 1;
    while (names.has(name)) {
      counter += 1;
      name = `${base}-${counter}${extension}`;
    }
    names.add(name);
    map.set(image.id, `images/${name}`);
  });
  return map;
}

async function renderWechat(draft, linkedImages) {
  if (!draft.wechat?.markdown?.trim()) fail('公众号正文为空，请先编辑并保存。', 400);
  const trusted = trustedImages(draft);
  const figures = plannedWechatFigures(draft, trusted);
  const resolveSrc = image => (linkedImages && linkedImages.get(image.id)) || image.data_uri;
  const body = figures.length
    ? sanitizeHtml(
      markdown.renderer.render(wechatBodyTokens(draft.wechat.markdown, figures, resolveSrc), markdown.options, { images: trusted, resolveSrc }),
      IMAGE_BODY_SANITIZE,
    )
    : safeBody(draft.wechat.markdown);
  const figureNote = figures.some(figure => figure.image.origin === 'generated')
    ? '<p class="figure-note" style="font-size:12px;color:#70695e;margin:30px 0 0;">本文部分配图为 AI 生成图片。</p>'
    : '';
  const css = `
    .article{max-width:680px;margin:0 auto;padding:28px 22px;background:#fff;color:#29251f;font-family:-apple-system,BlinkMacSystemFont,"Noto Sans CJK SC","Microsoft YaHei",sans-serif;font-size:16px;line-height:1.9;word-break:break-word;}
    h1{font-size:26px;line-height:1.45;margin:0 0 22px;font-weight:700;}h2{font-size:21px;margin:30px 0 14px;}h3,h4{font-size:18px;margin:24px 0 12px;}
    p{margin:0 0 18px;}strong{font-weight:700;}a{color:#a74930;text-decoration:underline;}blockquote{border-left:3px solid #a74930;margin:22px 0;padding:8px 18px;color:#655e54;background:#f7f4ef;}
    ul,ol{padding-left:24px;margin:12px 0 20px;}li{margin:8px 0;}pre{padding:14px;background:#f3f2ef;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;}code{font-family:monospace;}
    table{width:100%;border-collapse:collapse;font-size:14px;}th,td{border:1px solid #d8d3cb;padding:8px;text-align:left;}hr{border:0;border-top:1px solid #d8d3cb;margin:28px 0;}
    .sources{border-top:1px solid #d8d3cb;margin-top:34px;padding-top:10px;font-size:12px;color:#70695e;}.sources h2{font-size:15px;}.sources li{margin:8px 0;}`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(draft.wechat.title)}</title><style>${css}</style></head><body><section class="article"><h1>${escape(draft.wechat.title)}</h1>${body}${figureNote}${sourceList(draft)}</section></body></html>`;
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
      if (used + advance > width && line) {
        const previous = Array.from(line);
        let carry = '';
        // Keep closing punctuation with its preceding character and opening
        // punctuation with the text that follows it.
        if (/^[，。！？、；：）》】」』”’…,.!?;:)]$/u.test(character) && previous.length > 1) carry = previous.pop();
        while (previous.length > 1 && /^[（《【「『“‘(]$/u.test(previous[previous.length - 1])) carry = previous.pop() + carry;
        lines.push(previous.join(''));
        line = carry;
        used = Array.from(carry).reduce((total, item) => total + characterWidth(item, size), 0);
      }
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

// Image cards keep a fixed picture frame between heading and body. The frame
// adapts (340-720px) while body text stays readable (>=30px); when the
// 200-char body cannot fit with the image, the card fails loudly instead of
// clipping or silently truncating text.
function layoutImageCard(card) {
  const title = String(card.title || '').trim();
  const body = String(card.body || '').trim();
  if (!title || !body) fail('每张图卡都需要标题和正文，请补充后保存。', 400);
  if (Array.from(title).length > 40 || Array.from(body).length > 200) fail('图卡标题最多40字、正文最多200字，请拆分或缩短后保存。');
  for (let size = 48; size >= 30; size -= 2) {
    const titleSize = Math.round(size * 1.42);
    const titles = wrap(title, titleSize, 880);
    const lines = wrap(body, size, 880);
    const titleHeight = titles.length * titleSize * 1.38;
    const bodyHeight = lines.length * size * 1.65;
    const frameTop = Math.round(230 + titleHeight + 26);
    const frameHeight = Math.min(Math.round(CARD_FRAME.bottomLimit - bodyHeight - CARD_FRAME.footerGap - size - frameTop), CARD_FRAME.maxHeight);
    if (frameHeight < CARD_FRAME.minHeight) continue;
    const frameBottom = frameTop + frameHeight;
    const bodyStart = frameBottom + CARD_FRAME.footerGap + size;
    const bodyBottom = bodyStart + bodyHeight - Math.round(size * 0.65);
    if (bodyBottom > CARD_FRAME.bottomLimit + 4) continue;
    return { size, titleSize, titles, lines, titleHeight, frameTop, frameHeight, bodyStart };
  }
  fail('这张图卡的图片和正文放不下：请缩短正文、减少空行或拆分图卡后保存。');
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
  const media = cardImage(draft, card, trustedImages(draft), index + 1);
  const layout = media ? layoutImageCard(card) : layoutCard(card);
  const sources = publicSources(draft);
  const references = (card.source_ids || []).map(id => sources.findIndex(source => source.id === id) + 1).filter(n => n > 0);
  let footer = references.length ? `来源 ${references.map(n => `[${n}]`).join(' ')} · 完整出处见配套文案` : '个人观察';
  if (media) footer += ` · ${imageFooterMark(media.image)}`;
  if (!media) {
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
  const preserve = media.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet';
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1080" height="1440" viewBox="0 0 1080 1440">
    <rect width="1080" height="1440" fill="${theme.background}"/>
    <g font-family="${escape(font.family)}">
      <rect x="88" y="84" width="44" height="6" rx="3" fill="${theme.accent}"/>
      <text x="150" y="96" fill="${theme.muted}" font-size="24" letter-spacing="3">发现与想法</text>
      <text x="990" y="96" text-anchor="end" fill="${theme.muted}" font-size="24">${String(index + 1).padStart(2, '0')} / ${String(cards.length).padStart(2, '0')}</text>
      ${svgLines(layout.titles, 92, 208, layout.titleSize, layout.titleSize * 1.38, theme.foreground, 700)}
      <rect x="92" y="${230 + layout.titleHeight}" width="64" height="5" fill="${theme.accent}"/>
      <rect x="90" y="${layout.frameTop - 2}" width="900" height="${layout.frameHeight + 4}" rx="10" fill="none" stroke="${theme.rule}" stroke-width="2"/>
      <image x="92" y="${layout.frameTop}" width="${CARD_FRAME.width}" height="${layout.frameHeight}" preserveAspectRatio="${preserve}" href="${media.image.data_uri}" xlink:href="${media.image.data_uri}"/>
      ${svgLines(layout.lines, 92, layout.bodyStart, layout.size, layout.size * 1.65, theme.foreground)}
      <path d="M92 1290H988" stroke="${theme.rule}" stroke-width="2"/>
      ${svgLines(wrap(footer, 22, 880), 92, 1331, 22, 30, theme.muted)}
    </g>
  </svg>`;
}

function cardImage(draft, card, trusted, cardNumber) {
  const imageId = String(card?.image_id || '');
  if (!imageId) return null;
  const image = requireImage(trusted, imageId, `卡片 ${cardNumber}`);
  const fit = card.image_fit === undefined || card.image_fit === null || card.image_fit === '' ? 'contain' : String(card.image_fit);
  if (fit !== 'contain' && fit !== 'cover') fail('图卡图片适配方式只支持 contain 或 cover。');
  return { image, fit };
}

function imageFooterMark(image) {
  if (image.origin === 'generated') return 'AI 生成配图';
  if (image.origin === 'upload') return '作者配图';
  return '配图来自来源';
}

async function renderCard(draft, index) {
  const font = fontConfiguration();
  const svg = cardSvg(draft, index, font);
  try {
    const rendered = await renderAsync(svg, { font: font.options, languages: ['zh-CN', 'en'], fitTo: { mode: 'original' }, textRendering: 2 });
    return rendered.asPng();
  } catch (error) {
    fail(`图卡渲染失败：${error?.message || '未知错误'}。如果图卡包含图片，请更换或压缩图片后重试。`);
  }
}

function filename(draft) {
  const value = String(draft.wechat?.title || draft.title || 'Eagleye').replace(/[<>:"/\\|?*]/g, '').replace(/^\.+|[.\s]+$/g, '');
  return Array.from(value).filter(c => c.codePointAt(0) >= 32 && c.codePointAt(0) !== 127).slice(0, 64).join('') || 'Eagleye';
}

function sourceText(draft) {
  return publicSources(draft).map((source, index) => `[${index + 1}] ${source.title}${source.source_label ? ` · ${source.source_label}` : ''}\n${source.url}`).join('\n\n');
}

function exportMarkdown(draft, base) {
  const trusted = trustedImages(draft);
  const figures = plannedWechatFigures(draft, trusted);
  const body = figures.length
    ? wechatMarkdownBody(draft.wechat.markdown, figures, image => image.data_uri)
    : draft.wechat.markdown;
  return { body: `# ${draft.wechat.title}\n\n${body}\n\n---\n\n来源与延伸阅读\n\n${sourceText(draft)}\n`, contentType: 'text/markdown; charset=utf-8', filename: `${base}.md` };
}

// wechat-zip keeps one HTML + one Markdown copy of the article plus only the
// placed images. Private notes/excerpts never enter this bundle; image
// sources ride through publicUrl sanitation via imageCredit().
async function exportWechatZip(draft, base) {
  const trusted = trustedImages(draft);
  const figures = plannedWechatFigures(draft, trusted);
  const usedImages = [];
  const seen = new Set();
  for (const figure of figures) {
    if (!seen.has(figure.image.id)) {
      seen.add(figure.image.id);
      usedImages.push(figure.image);
    }
  }
  const linkedImages = linkedImagePaths(usedImages);
  const resolveSrc = image => linkedImages.get(image.id) || image.data_uri;
  const html = await renderWechat(draft, linkedImages);
  const markdownBody = wechatMarkdownBody(draft.wechat.markdown, figures, resolveSrc);
  const zip = new JSZip();
  zip.file('article.html', html);
  zip.file('article.md', `# ${draft.wechat.title}\n\n${markdownBody}\n\n---\n\n来源与延伸阅读\n\n${sourceText(draft)}\n`);
  for (const image of usedImages) {
    const base64 = image.data_uri.slice(image.data_uri.indexOf(',') + 1);
    zip.file(linkedImages.get(image.id), Buffer.from(base64, 'base64'));
  }
  return { body: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }), contentType: 'application/zip', filename: `${base}-公众号.zip` };
}

function cardImageCredits(draft) {
  const cards = draft.xiaohongshu?.cards;
  if (!Array.isArray(cards)) return [];
  const trusted = trustedImages(draft);
  const sources = publicSources(draft);
  const lines = [];
  cards.forEach((card, index) => {
    const imageId = String(card?.image_id || '');
    if (!imageId) return;
    const image = trusted.get(imageId);
    if (!image) return;
    lines.push(`卡片${String(index + 1).padStart(2, '0')}（${String(card.title || '').trim()}）：${imageCredit(image, sources).text}`);
  });
  return lines;
}

async function exportDraft(draft, format) {
  const base = filename(draft);
  if (format === 'wechat-html') return { body: await renderWechat(draft), contentType: 'text/html; charset=utf-8', filename: `${base}.html` };
  if (format === 'wechat-zip') return exportWechatZip(draft, base);
  if (format === 'markdown') return exportMarkdown(draft, base);
  if (format === 'xiaohongshu-zip') {
    const cards = draft.xiaohongshu?.cards || [];
    if (!cards.length || cards.length > 6) fail('小红书图文需要1至6张图卡。', 400);
    const zip = new JSZip();
    // Sequential rendering bounds native memory; renderAsync keeps the API free.
    for (let index = 0; index < cards.length; index++) zip.file(`${String(index + 1).padStart(2, '0')}.png`, await renderCard(draft, index));
    const tags = (draft.xiaohongshu.tags || []).map(tag => `#${String(tag).replace(/^#+/, '')}`).join(' ');
    let captionContent = `${draft.xiaohongshu.title}\n\n${draft.xiaohongshu.caption}\n\n${tags}\n\n来源与延伸阅读\n\n${sourceText(draft)}\n`;
    const imageCredits = cardImageCredits(draft);
    if (imageCredits.length) captionContent += `\n图片说明\n\n${imageCredits.join('\n')}\n`;
    zip.file('caption.txt', captionContent);
    zip.file('sources.json', JSON.stringify(publicSources(draft), null, 2));
    return { body: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }), contentType: 'application/zip', filename: `${base}-小红书.zip` };
  }
  fail('不支持的导出格式。', 400);
}

module.exports = { renderWechat, renderCard, exportDraft };
