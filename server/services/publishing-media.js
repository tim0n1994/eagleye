/** Eagleye publishing draft images: safe store plus bounded public fetch. */
/**
 * Eagleye — Publishing draft image store and bounded public fetch.
 *
 * Every image is decoded with sharp and re-encoded to safe JPEG (flattened on
 * white, auto-rotated, capped at 1920px, metadata stripped) before storage,
 * so exports never trust the original bytes. Remote fetches resolve through
 * public DoH, validate every answer with ipaddr.js, and connect to the pinned
 * IP with the domain kept in SNI/Host. That prevents DNS rebinding and keeps
 * private targets unreachable even when a local transparent-proxy resolver
 * answers with fake IPs in 198.18.0.0/15.
 */

const crypto = require('node:crypto');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const ipaddr = require('ipaddr.js');
const sharp = require('sharp');
const cheerio = require('cheerio');
const { getDB } = require('../db/connection');

const MAX_IMAGES_PER_DRAFT = 12;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ENCODED_BASE64_CHARS = 12 * 1024 * 1024;
const MAX_OUTPUT_DIM = 1920;
const MAX_INPUT_PIXELS = 25000000;
const JPEG_QUALITY = 85;
const MAX_REDIRECTS = 3;
const CANDIDATE_BUDGET_MS = 20000;
const CANDIDATE_SOURCES = 6;
const MAX_CANDIDATES = 12;
const CANDIDATE_PAGE_BYTES = 2 * 1024 * 1024;
const CANDIDATE_PAGE_TIMEOUT_MS = 7000;
const FAKEIP_NETWORK = '198.18.0.0/15';
const REQUEST_USER_AGENT = 'Mozilla/5.0 (compatible; EagleyePublishing/1.0; +https://eagleye.local)';

const DOH_ENDPOINTS = [
  { host: 'dns.google', path: '/resolve' },
  { host: 'cloudflare-dns.com', path: '/dns-query' },
];
const DOH_TIMEOUT_MS = 1800;

const IMAGE_MAGIC = [
  { name: 'JPG', bytes: [0xff, 0xd8, 0xff] },
  { name: 'PNG', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { name: 'WebP', ascii: 'RIFF', offset: 0, extra: { ascii: 'WEBP', offset: 8 } },
  { name: 'GIF', ascii: 'GIF8' },
];

function httpError(status, message, code) {
  return Object.assign(new Error(message), { statusCode: status, code: code || null });
}

function requireUser(userId) {
  if (!userId || typeof userId !== 'string') throw httpError(403, '需要登录后才能管理配图。');
}

function requireDB() {
  const db = getDB();
  if (!db) throw httpError(503, '存储暂不可用，请稍后重试。');
  return db;
}

function nowISO() {
  return new Date().toISOString();
}

// Draft ownership checks go through the DB directly; requiring
// services/publishing from here would be circular because getDraft() reads
// image lists from this module. listImages() intentionally works while a
// draft is still generating, so freshly created drafts return an empty list.
function getDraftRow(userId, draftId) {
  const row = requireDB().prepare(
    'SELECT id, user_id, status, sources_json, updated_at FROM publishing_drafts WHERE user_id = ? AND id = ?'
  ).get(userId, draftId);
  if (!row) throw httpError(404, '草稿不存在，请刷新后重试。');
  return row;
}

function parseStoredJSON(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function draftSources(row) {
  const sources = parseStoredJSON(row.sources_json, []);
  return Array.isArray(sources) ? sources.filter(source => source && typeof source.id === 'string' && source.id) : [];
}

function cleanFilename(value) {
  if (typeof value !== 'string') return '配图.jpg';
  const cleaned = Array.from(value)
    .filter(character => character.codePointAt(0) >= 32 && character.codePointAt(0) !== 127 && character !== '/' && character !== '\\')
    .join('').trim();
  return Array.from(cleaned).slice(0, 200).join('') || '配图.jpg';
}

function imageMetadata(row) {
  return {
    id: row.id,
    filename: row.filename,
    mime_type: row.mime_type,
    width: row.width,
    height: row.height,
    source_id: row.source_id,
    source_url: row.source_url,
    origin: row.origin,
    url: ['/api/publishing/drafts/', row.draft_id, '/images/', row.id].join('')
  };
}

function listImages(userId, draftId) {
  requireUser(userId);
  getDraftRow(userId, draftId);
  const rows = requireDB().prepare(
    'SELECT id, draft_id, filename, mime_type, width, height, source_id, source_url, origin FROM publishing_images WHERE user_id = ? AND draft_id = ? ORDER BY created_at, id'
  ).all(userId, draftId);
  return rows.map(imageMetadata);
}

function getImage(userId, draftId, imageId) {
  requireUser(userId);
  if (typeof imageId !== 'string' || !imageId || imageId.length > 256) throw httpError(404, '配图不存在。');
  const row = requireDB().prepare(
    'SELECT * FROM publishing_images WHERE user_id = ? AND draft_id = ? AND id = ?'
  ).get(userId, draftId, imageId);
  if (!row) throw httpError(404, '配图不存在。');
  const metadata = imageMetadata(row);
  metadata.data = row.data;
  return metadata;
}

function hydrateImages(userId, draftId) {
  requireUser(userId);
  return requireDB().prepare(
    'SELECT id, draft_id, filename, mime_type, width, height, source_id, source_url, origin, data FROM publishing_images WHERE user_id = ? AND draft_id = ? ORDER BY created_at, id'
  ).all(userId, draftId).map(row => {
    const item = imageMetadata(row);
    item.data_uri = ['data:', row.mime_type, ';base64,', Buffer.from(row.data).toString('base64')].join('');
    return item;
  });
}

function countImages(db, userId, draftId) {
  return db.prepare('SELECT COUNT(*) AS count FROM publishing_images WHERE user_id = ? AND draft_id = ?').get(userId, draftId).count;
}

function assertImageQuota(userId, draftId) {
  const db = requireDB();
  getDraftRow(userId, draftId);
  if (countImages(db, userId, draftId) >= MAX_IMAGES_PER_DRAFT) {
    throw httpError(400, '本稿已达到12张配图上限，可继续使用已保存图片。');
  }
}

function decodeBase64Image(value) {
  if (typeof value !== 'string' || !value) throw httpError(400, '缺少图片数据。');
  const compact = value.replace(/[\r\n\t ]/g, '');
  if (compact.length > MAX_ENCODED_BASE64_CHARS) throw httpError(400, '图片数据超过 12MB 编码限制。');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) throw httpError(400, '图片数据不是有效的 base64。');
  const buffer = Buffer.from(compact, 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) throw httpError(400, '图片不能超过 8MB。');
  return buffer;
}

function detectImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  for (const format of IMAGE_MAGIC) {
    if (format.ascii) {
      if (buffer.toString('latin1', format.offset || 0, (format.offset || 0) + format.ascii.length) !== format.ascii) continue;
      if (format.extra && buffer.toString('latin1', format.extra.offset, format.extra.offset + format.extra.ascii.length) !== format.extra.ascii) continue;
      return format.name;
    }
    if (format.bytes.every((byte, index) => buffer[index] === byte)) return format.name;
  }
  return null;
}

async function processImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw httpError(400, '图片数据为空。');
  if (buffer.length > MAX_IMAGE_BYTES) throw httpError(400, '图片不能超过 8MB。');
  if (!detectImageFormat(buffer)) throw httpError(400, '仅支持 JPG、PNG、WebP 或 GIF 图片，其他格式无法识别。');
  try {
    const rendered = await sharp(buffer, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: 'error',
      animated: false, // Animated GIF/WebP contribute their first frame only.
    })
      .rotate() // Bakes EXIF orientation into pixels; metadata is dropped on re-encode.
      .flatten({ background: '#ffffff' })
      .resize({ width: MAX_OUTPUT_DIM, height: MAX_OUTPUT_DIM, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return { data: rendered.data, width: rendered.info.width, height: rendered.info.height };
  } catch (error) {
    if (error && error.statusCode) throw error;
    const message = String((error && error.message) || '');
    if (/pixel|dimension/i.test(message)) {
      throw httpError(400, '图片像素超过 2500 万上限，请缩小后再上传。');
    }
    throw httpError(400, '图片解码失败，请改用完整的 JPG、PNG、WebP 或 GIF 文件。');
  }
}

async function addImage(userId, draftId, input) {
  const request = input && typeof input === 'object' ? input : {};
  requireUser(userId);
  const origin = request.origin;
  if (!['upload', 'source', 'generated'].includes(origin)) throw httpError(400, '配图来源无效。');
  const sourceId = request.source_id || null;
  const sourceUrl = request.source_url || null;
  if (origin === 'source') {
    if (typeof request.source_id !== 'string' || !request.source_id || request.source_id.length > 256) {
      throw httpError(400, '来源标识无效。');
    }
    if (typeof request.source_url !== 'string' || !request.source_url || request.source_url.length > 2048) {
      throw httpError(400, '来源地址无效。');
    }
  } else {
    if (sourceId !== null && (typeof sourceId !== 'string' || sourceId.length > 256)) throw httpError(400, '来源标识无效。');
    if (sourceUrl !== null && (typeof sourceUrl !== 'string' || sourceUrl.length > 2048)) throw httpError(400, '来源地址无效。');
  }
  const db = requireDB();
  getDraftRow(userId, draftId);
  // Fail fast before decoding or upstream fetches; the authoritative check
  // happens again inside the insert transaction.
  if (countImages(db, userId, draftId) >= MAX_IMAGES_PER_DRAFT) {
    throw httpError(400, '本稿已达到12张配图上限，可继续使用已保存图片。');
  }
  const buffer = Buffer.isBuffer(request.buffer) ? request.buffer : Buffer.from(request.buffer || '');
  const processed = await processImage(buffer);
  const id = crypto.randomUUID();
  const filename = cleanFilename(request.filename);
  const createdAt = nowISO();
  db.transaction(() => {
    if (countImages(db, userId, draftId) >= MAX_IMAGES_PER_DRAFT) {
      throw httpError(400, '本稿已达到12张配图上限，可继续使用已保存图片。');
    }
    db.prepare(
      'INSERT INTO publishing_images (id, user_id, draft_id, filename, mime_type, width, height, source_id, source_url, origin, data, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id, userId, draftId, filename,
      'image/jpeg',
      processed.width, processed.height,
      sourceId, sourceUrl, origin, processed.data, createdAt
    );
    db.prepare('UPDATE publishing_drafts SET updated_at = ? WHERE user_id = ? AND id = ?').run(createdAt, userId, draftId);
  })();
  return {
    id,
    filename,
    mime_type: 'image/jpeg',
    width: processed.width,
    height: processed.height,
    source_id: sourceId,
    source_url: sourceUrl,
    origin,
    url: ['/api/publishing/drafts/', draftId, '/images/', id].join(''),
  };
}
function assertPublicAddress(value) {
  let parsed;
  try {
    parsed = ipaddr.parse(value);
  } catch {
    throw httpError(400, '远程地址无效。');
  }
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }
  if (parsed.kind() === 'ipv4' && parsed.match(ipaddr.parseCIDR(FAKEIP_NETWORK))) {
    throw httpError(502, '域名解析返回了透明代理保留地址，已停止下载。');
  }
  if (parsed.range() !== 'unicast') {
    throw httpError(502, '目标地址不是安全的公网地址，已停止下载。');
  }
  return { address: parsed.toString(), family: parsed.kind() === 'ipv4' ? 4 : 6 };
}

function assertPublicHost(host) {
  if (typeof host !== 'string' || !host || host.length > 253) throw httpError(400, '远程地址主机无效。');
  if (!ipaddr.isValid(host)) return null;
  return assertPublicAddress(host);
}

function assertPublicUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw httpError(400, '远程图片地址无效。');
  }
  const isHTTPS = url.protocol === 'https:';
  const isHTTP = url.protocol === 'http:';
  const expectedPort = isHTTPS ? '443' : isHTTP ? '80' : '';
  if ((!isHTTPS && !isHTTP) || (url.port && url.port !== expectedPort)) {
    throw httpError(400, '远程图片仅支持 HTTP 或 HTTPS 标准端口。');
  }
  if (url.username || url.password) throw httpError(400, '远程图片地址不能包含账号信息。');
  assertPublicHost(url.hostname);
  return url;
}

function chooseAddress(addresses) {
  return addresses.find(item => item.family === 4) || addresses[0];
}

async function lookupViaSystem(host) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('DNS timeout')), 1500);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([
      dns.promises.lookup(host, { all: true, verbatim: true }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function dohQuery(endpoint, name, type) {
  const path = endpoint.path + '?name=' + encodeURIComponent(name) + '&type=' + type;
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: endpoint.host,
      path,
      method: 'GET',
      agent: false,
      timeout: DOH_TIMEOUT_MS,
      headers: {
        Accept: 'application/dns-json',
        Connection: 'close',
        'User-Agent': REQUEST_USER_AGENT,
      },
    }, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error('DoH status'));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) {
          request.destroy(new Error('DoH response too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const answer = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!answer || answer.Status !== 0 || !Array.isArray(answer.Answer)) {
            reject(new Error('DoH answer'));
            return;
          }
          resolve(answer.Answer.filter(item => item && (item.type === 1 || item.type === 28) && typeof item.data === 'string'));
        } catch {
          reject(new Error('DoH JSON'));
        }
      });
      response.on('error', () => reject(new Error('DoH connection')));
    });
    request.on('timeout', () => request.destroy(new Error('DoH timeout')));
    request.on('error', () => reject(new Error('DoH connection')));
    request.end();
  });
}

async function lookupViaDoH(host) {
  const attempts = DOH_ENDPOINTS.map(endpoint => (async () => {
    const results = await Promise.allSettled([
      dohQuery(endpoint, host, 'A'),
      dohQuery(endpoint, host, 'AAAA'),
    ]);
    const records = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    if (!records.length) throw new Error('No DoH address records');
    return records.map(record => assertPublicAddress(record.data.trim()));
  })());
  const winner = await Promise.any(attempts);
  if (!winner.length) throw new Error('No usable DoH address');
  return winner;
}

async function resolvePublicHost(host) {
  const pinned = assertPublicHost(host);
  if (pinned) return pinned;
  try {
    const addresses = await lookupViaDoH(host);
    return chooseAddress(addresses);
  } catch {
    // Public DoH is the primary resolver. System DNS is only accepted when
    // every answer is a public unicast address, so TUN fake IPs cannot pass.
  }
  try {
    const systemAddresses = await lookupViaSystem(host);
    if (!Array.isArray(systemAddresses) || !systemAddresses.length) throw new Error('Empty system DNS');
    const addresses = systemAddresses.map(item => assertPublicAddress(item.address));
    return chooseAddress(addresses);
  } catch {
    throw httpError(502, '无法通过公共DNS安全解析该域名，已停止下载。');
  }
}
function downloadOnce(url, pinned, maxBytes, deadline, accept) {
  const transport = url.protocol === 'https:' ? https : http;
  const timeoutError = httpError(504, '远程图片下载超时，请稍后重试。');
  return new Promise((resolve, reject) => {
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining < 250) {
      reject(timeoutError);
      return;
    }
    const clearDeadline = () => {
      clearTimeout(deadlineTimer);
    };
    const request = transport.request({
      host: pinned.address,
      family: pinned.family,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      path: [url.pathname, url.search].join(''),
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      agent: false,
      timeout: remaining,
      headers: {
        Accept: accept,
        Connection: 'close',
        Host: url.host,
        'User-Agent': REQUEST_USER_AGENT,
      },
    }, response => {
      const contentType = response.headers['content-type'];
      const declaredLength = Number(response.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        request.destroy(httpError(413, '远程图片超过大小限制。'));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        if (Date.now() >= deadline) {
          request.destroy(timeoutError);
          return;
        }
        bytes += chunk.length;
        if (bytes > maxBytes) {
          request.destroy(httpError(413, '远程图片超过大小限制。'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        clearDeadline();
        resolve({
          status: response.statusCode || 0,
          location: typeof response.headers.location === 'string' ? response.headers.location : null,
          contentType: typeof contentType === 'string' ? contentType : null,
          buffer: Buffer.concat(chunks),
        });
      });
      response.on('error', () => { clearDeadline(); reject(httpError(502, '远程图片下载失败，请稍后重试。')); });
    });
    const deadlineTimer = setTimeout(() => request.destroy(timeoutError), remaining);
    if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
    request.on('timeout', () => request.destroy(timeoutError));
    request.on('error', error => {
      clearDeadline();
      if (error && error.statusCode) reject(error);
      else reject(httpError(502, '远程图片下载失败，请稍后重试。'));
    });
    request.end();
  });
}

async function fetchPublic(value, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const maxBytes = Number(opts.maxBytes);
  const timeoutMs = Number(opts.timeoutMs);
  const accept = typeof opts.accept === 'string' && opts.accept ? opts.accept : '*/*';
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > 64 * 1024 * 1024) throw httpError(400, '下载大小限制无效。');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw httpError(400, '下载时间限制无效。');
  const deadline = Date.now() + timeoutMs;
  let current = assertPublicUrl(value);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (Date.now() >= deadline) throw httpError(504, '远程图片下载超时，请稍后重试。');
    const pinned = await resolvePublicHost(current.hostname);
    const result = await downloadOnce(current, pinned, maxBytes, deadline, accept);
    if (result.status >= 300 && result.status <= 399 && [301, 302, 303, 307, 308].includes(result.status)) {
      if (!result.location) throw httpError(502, '远程图片返回了无效跳转。');
      if (redirects === MAX_REDIRECTS) throw httpError(502, '远程图片跳转次数过多。');
      current = assertPublicUrl(new URL(result.location, current).toString());
      continue;
    }
    if (result.status < 200 || result.status >= 300) {
      throw httpError(502, '远程图片服务暂时无法访问，请稍后重试。');
    }
    return { buffer: result.buffer, contentType: result.contentType, url: current.toString() };
  }
  throw httpError(502, '远程图片跳转次数过多。');
}
function filenameFromUrl(value) {
  let filename = '配图.jpg';
  try {
    const parsed = new URL(value);
    const raw = parsed.pathname.split('/').pop() || '';
    filename = cleanFilename(decodeURIComponent(raw));
  } catch {
    // The caller supplies a safe fallback.
  }
  return filename;
}

async function importSourceImage(userId, draftId, input) {
  const request = input && typeof input === 'object' ? input : {};
  requireUser(userId);
  if (typeof request.source_id !== 'string' || !request.source_id || request.source_id.length > 256) {
    throw httpError(400, '来源标识无效。');
  }
  const sourceUrl = assertPublicUrl(request.url || '').toString();
  // Refuse upstream work before a network request when the draft is full.
  assertImageQuota(userId, draftId);
  const source = draftSources(getDraftRow(userId, draftId)).find(item => item.id === request.source_id);
  if (!source) throw httpError(400, '来源不属于这篇草稿。');
  const snapshotUrl = typeof source.url === 'string' && source.url ? assertPublicUrl(source.url).toString() : '';
  if (!snapshotUrl) throw httpError(400, '该来源没有可用的原始页面地址。');
  const fetched = await fetchPublic(sourceUrl, {
    maxBytes: MAX_IMAGE_BYTES,
    timeoutMs: 15000,
    accept: 'image/*,image/*;q=0.8,*/*;q=0.5',
  });
  if (fetched.contentType && !fetched.contentType.toLowerCase().startsWith('image/')) {
    throw httpError(415, '远程地址没有返回图片。');
  }
  return addImage(userId, draftId, {
    buffer: fetched.buffer,
    filename: filenameFromUrl(fetched.url),
    source_id: request.source_id,
    source_url: snapshotUrl,
    origin: 'source',
  });
}
function candidateCaption(source, alternative) {
  const value = typeof alternative === 'string' && alternative.trim() ? alternative.trim() : source.title;
  return Array.from(typeof value === 'string' ? value : '').slice(0, 200).join('');
}

function safeCandidateUrl(value, baseUrl) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = new URL(value, baseUrl);
    parsed.hash = '';
    return assertPublicUrl(parsed.toString()).toString();
  } catch {
    return null;
  }
}

function payloadImageCandidates(source, payload, addCandidate) {
  if (!payload || typeof payload !== 'object') return;
  for (const key of ['image', 'thumbnail', 'image_url', 'cover', 'cover_image']) {
    const value = payload[key];
    const url = safeCandidateUrl(value, source.url);
    if (url) addCandidate(url, source, '');
  }
}
async function listImageCandidates(userId, draftId) {
  requireUser(userId);
  const draft = getDraftRow(userId, draftId);
  const sources = draftSources(draft).filter(source => typeof source.url === 'string' && /^https?:\/\//i.test(source.url)).slice(0, CANDIDATE_SOURCES);
  const candidates = [];
  const warnings = [];
  const seen = new Set();
  const deadline = Date.now() + CANDIDATE_BUDGET_MS;
  const addCandidate = (url, source, alternative) => {
    if (candidates.length >= MAX_CANDIDATES || seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, source_id: source.id, source_url: source.url, caption: candidateCaption(source, alternative) });
  };
  const itemIds = Array.from(new Set(sources.map(source => source.id)));
  if (itemIds.length) {
    const rows = requireDB().prepare(
      'SELECT id, source_payload, normalized_payload FROM information_items WHERE id IN (' + itemIds.map(() => '?').join(',') + ')'
    ).all(...itemIds);
    for (const row of rows) {
      const source = sources.find(item => item.id === row.id);
      if (!source) continue;
      payloadImageCandidates(source, parseStoredJSON(row.source_payload, {}), addCandidate);
      payloadImageCandidates(source, parseStoredJSON(row.normalized_payload, {}), addCandidate);
    }
  }
  for (const source of sources) {
    const remaining = deadline - Date.now();
    if (remaining < 1000) {
      warnings.push('读取来源图片时间已到上限。');
      break;
    }
    try {
      const page = await fetchPublic(source.url, {
        maxBytes: CANDIDATE_PAGE_BYTES,
        timeoutMs: Math.min(CANDIDATE_PAGE_TIMEOUT_MS, remaining),
        accept: 'text/html,application/xhtml+xml',
      });
      const document = cheerio.load(page.buffer.toString('utf8'));
      const selectors = [
        "meta[property='og:image']",
        "meta[name='twitter:image']",
        "meta[name='twitter:image:src']",
        "meta[property='twitter:image']",
        'img[src]',
      ].join(',');
      document(selectors).each((index, element) => {
        if (candidates.length >= MAX_CANDIDATES) return;
        const node = document(element);
        const raw = element.tagName === 'img' ? node.attr('src') : node.attr('content');
        const url = safeCandidateUrl(raw, page.url);
        if (url) addCandidate(url, source, element.tagName === 'img' ? node.attr('alt') : '');
      });
    } catch {
      warnings.push('「' + (source.title || '来源') + '」暂时无法读取页面图片。');
    }
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return { candidates, warnings };
}
async function addImageFromBase64(userId, draftId, input) {
  const request = input && typeof input === 'object' ? input : {};
  const buffer = decodeBase64Image(request.data_base64);
  return addImage(userId, draftId, {
    buffer,
    filename: request.filename,
    origin: 'upload',
  });
}

module.exports = {
  listImages,
  getImage,
  addImage,
  hydrateImages,
  fetchPublic,
  importSourceImage,
  listImageCandidates,
  addImageFromBase64,
  prepareImageUpload: value => processImage(decodeBase64Image(value)),
  assertImageQuota,
};
