/**
 * Eagleye — RSS Connector
 *
 * Generic connector for any RSS/Atom feed source.
 * Looks up the feed URL from the sources table.
 *
 * Round 2 changes (independent toggles, see round2 plan ③④):
 *   ③ Conditional requests (RSS_CONDITIONAL, default ON): ETag/Last-Modified
 *      validators are persisted in user_data (global scope, single JSON key
 *      `rss_conditional_state`, same convention as scheduler_config) and
 *      replayed as If-None-Match / If-Modified-Since. A 304 short-circuits to
 *      an empty item list without parsing. Per-feed isolation is by feed URL.
 *      Requires the native fetch() transport (response headers are needed);
 *      when fetch() is unavailable the connector falls back to utils.fetchURL
 *      with the exact legacy behavior.
 *   ④ Parsing switched to fast-xml-parser: entity decoding in text nodes,
 *      <item> opening-tag attributes (rdf:about), <content:encoded> bodies,
 *      atom:-prefixed Atom feeds and mixed-format channels are all handled.
 *      The dependency is loaded lazily; if it is missing the old regex parser
 *      is kept as a degradation path so environments without node_modules
 *      never lose RSS ingestion.
 */

const { BaseConnector } = require('./base');
const sharedUtils = require('../services/utils');
const { fetchURL } = sharedUtils;
// CTO 03:40 network-retry: on the production runtime (node v24, global fetch)
// the native transport below is the LIVE path and utils.fetchURL is only the
// no-fetch fallback, so the native path must carry the same shared retry
// policy (30s → 120s, max 2, same classifier, injectable sleep, stats
// counter). Tolerate utils stubs that only provide fetchURL (test harnesses).
const withFetchRetry = typeof sharedUtils.withFetchRetry === 'function'
  ? sharedUtils.withFetchRetry
  : (attempt, opts = {}) => attempt({ signal: opts.signal });
const { getDB } = require('../db/connection');
const { isWithinFetchWindow, compactDigestDate, todayDigestDate } = require('../services/date-contract');
// 案2 fix-morning-1022: this connector writes user_data directly (not via
// db/user-data.js setValue), so it shares the same write-time secret redaction.
const { redactForStorage } = require('../services/secret-redaction');

/* ---------- ③ conditional-request state (user_data, global scope) ---------- */

const COND_STATE_KEY = 'rss_conditional_state';

// Default ON; only an explicit off value disables it ('0' | 'false' | 'off').
function conditionalEnabled() {
  const flag = String(process.env.RSS_CONDITIONAL ?? '').trim().toLowerCase();
  return !['0', 'false', 'off'].includes(flag);
}

// Read { feeds: { [url]: { etag, lastModified, updatedAt } } } best-effort:
// no DB / missing table / corrupt JSON all degrade to {} (conditional fetch
// must never break ingestion).
function readCondState(db) {
  if (!db) return {};
  try {
    const row = db.prepare('SELECT value FROM user_data WHERE key = ? AND user_id = ?')
      .get(COND_STATE_KEY, '');
    if (!row) return {};
    const parsed = JSON.parse(row.value);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

// INSERT OR REPLACE whole-row overwrite, mirroring server/db/user-data.js
// setValue semantics for the global scope (user_id ''). 案2: same write-time
// redaction contract — no credential-named field may land in plaintext.
function writeCondState(db, state) {
  try {
    const { value: safeState } = redactForStorage(state);
    db.prepare('INSERT OR REPLACE INTO user_data (key, user_id, value) VALUES (?, ?, ?)')
      .run(COND_STATE_KEY, '', JSON.stringify(safeState));
  } catch {
    /* best-effort */
  }
}

function saveValidators(db, state, feedUrl, etag, lastModified) {
  const next = {
    ...state,
    feeds: {
      ...(state.feeds || {}),
      [feedUrl]: {
        etag: etag || null,
        lastModified: lastModified || null,
        updatedAt: new Date().toISOString(),
      },
    },
  };
  writeCondState(db, next);
}

/* ---------- ③ native-fetch transport (headers/status visible) ---------- */

// vm/plain-context safe signal linker: no AbortSignal global is assumed, only
// the AbortController + setTimeout/clearTimeout pair that every supported
// runtime (and every test harness) provides.
function linkSignals(signal, timeoutMs) {
  const ctrl = new AbortController();
  let timer = null;
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      // Tagged ETIMEDOUT so the shared retry classifier treats our own idle
      // timeout like any other network-class failure (parity with fetchURL).
      const err = new Error('Request timeout');
      err.code = 'ETIMEDOUT';
      ctrl.abort(err);
    }, timeoutMs);
  }
  return {
    signal: ctrl.signal,
    dispose() {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

function fetchTimeoutMs() {
  const raw = parseInt(process.env.FETCH_TIMEOUT_MS || '15000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 15000;
}

/** One native-fetch request (no retry) — rejects with the historical shapes. */
async function fetchFeedOnce(url, { signal, headers }) {
  const linked = linkSignals(signal, fetchTimeoutMs());
  try {
    const res = await fetch(url, { headers, signal: linked.signal, redirect: 'follow' });
    if (res.status === 304) {
      return { notModified: true, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
    }
    const body = await res.text();
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`Upstream ${res.status}: ${body.slice(0, 200)}`);
      err.upstreamStatus = res.status; // lets the shared classifier see 5xx without re-parsing
      throw err;
    }
    return { body, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
  } finally {
    linked.dispose();
  }
}

/**
 * Native transport under the shared network-retry policy (CTO 03:40). Each
 * attempt gets its own linked timeout; 304 resolves (never retried), 4xx
 * throws non-retryable, 5xx / undici transport failures (TypeError 'fetch
 * failed' with .cause) retry 30s → 120s. sleep/stats come from the caller
 * (fetchSource's opts via connector.fetch) or the ambient fetch context.
 */
function fetchFeedNative(url, { signal, headers, sleep, stats }) {
  return withFetchRetry(
    ({ signal: attemptSignal }) => fetchFeedOnce(url, { signal: attemptSignal, headers }),
    { signal, sleep, stats, label: url },
  );
}

/* ---------- ④ fast-xml-parser (lazy) + legacy regex fallback ---------- */

let feedParser; // undefined = not tried, false = dependency unavailable
function getFeedParser() {
  if (feedParser !== undefined) return feedParser;
  try {
    const { XMLParser } = require('fast-xml-parser');
    feedParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseTagValue: false,
      parseAttributeValue: true,
      trimValues: false,
      cdataPropName: '#cdata',
      processEntities: true,
    });
  } catch {
    feedParser = false; // degrade to the legacy regex parser below
  }
  return feedParser;
}

// fast-xml-parser decodes the five predefined entities but leaves numeric
// character references (&#39; / &#x27;) as-is (verified against v5.11.2), so
// text nodes get a completion pass. CDATA content is NEVER passed through
// here — it is literal character data by contract.
const NUMERIC_ENTITY = /&#(x[0-9a-fA-F]+|\d+);/g;
function decodeNumericEntities(text) {
  if (!text || text.indexOf('&#') === -1) return text;
  return text.replace(NUMERIC_ENTITY, (whole, body) => {
    const code = body[0] === 'x' || body[0] === 'X' ? parseInt(body.slice(1), 16) : parseInt(body, 10);
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) return whole;
    try {
      return String.fromCodePoint(code);
    } catch {
      return whole;
    }
  });
}

// Extract the text of a tag value across every fast-xml-parser output shape:
// plain string, { '@_attr': …, '#text': … }, { '#cdata': … } or an array of
// those. Plain text is entity-decoded and trimmed; CDATA is joined verbatim.
function textOf(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return decodeNumericEntities(node).trim();
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') {
    const cdata = node['#cdata'];
    const cdataText = Array.isArray(cdata) ? cdata.join('') : (typeof cdata === 'string' ? cdata : '');
    return textOf(node['#text']) + cdataText;
  }
  return '';
}

function pick(item, names) {
  for (const name of names) {
    const value = item[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

// RSS <link>text</link> and Atom <link rel="…" href="…"/> (possibly repeated),
// prefixed or not: prefer rel="alternate", else the first href present.
function linkOf(item) {
  const raw = item.link !== undefined ? item.link : item['atom:link'];
  if (raw === undefined || raw === null) return '';
  const candidates = Array.isArray(raw) ? raw : [raw];
  let firstHref = '';
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (candidate && typeof candidate === 'object') {
      // P0 follow-up（2026-10-23）：RSS 形状的 <link><![CDATA[url]]></link> 在本文件
      // cdataPropName:'#cdata' 解析器下成 { '#cdata': url }（实测
      // feeds.feedburner.com/solidot fallback feed）。元素文本（#cdata/#text）就是
      // RSS link 本体；不取出来 → canonical_url 空 → base.saveItems 整批 skip。
      const elemText = typeof candidate['#cdata'] === 'string' ? candidate['#cdata']
        : typeof candidate['#text'] === 'string' ? candidate['#text'] : '';
      const trimmedText = elemText.trim();
      if (trimmedText) return trimmedText;
      const href = typeof candidate['@_href'] === 'string' ? candidate['@_href'] : '';
      if (!href) continue;
      if (!firstHref) firstHref = href;
      const rel = typeof candidate['@_rel'] === 'string' ? candidate['@_rel'] : 'alternate';
      if (rel === 'alternate') return href;
    }
  }
  return firstHref;
}

const ROOT_KEY_RE = /^(rss|feed|atom:feed|rdf:RDF)$/i;

// Locate the entry array for RSS 2.0 (rss>channel>item), RSS 1.0/RDF
// (rdf:RDF>item) and Atom (feed>entry / atom:feed>atom:entry). Returns null
// for documents that are not a recognizable feed (the "Invalid RSS" gate).
function extractEntries(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  let rootKey = null;
  for (const key of Object.keys(doc)) {
    if (ROOT_KEY_RE.test(key)) {
      rootKey = key;
      break;
    }
  }
  if (!rootKey) return null;
  const root = doc[rootKey];
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  const container = /rss/i.test(rootKey) ? (root.channel ?? {}) : root;
  const raw = container.item ?? container.entry ?? container['atom:entry']
    ?? container['atom:item'] ?? container['rdf:item'];
  if (raw === undefined || raw === null) return [];
  return Array.isArray(raw) ? raw : [raw];
}

class RSSConnector extends BaseConnector {
  constructor(slug) {
    super(slug);
  }

  getFeedUrl() {
    const db = getDB();
    if (!db) return null;
    const row = db.prepare('SELECT feed_url FROM sources WHERE slug = ?').get(this.slug);
    return row?.feed_url || null;
  }

  async fetch(date, { signal, sleep, stats } = {}) {
    signal?.throwIfAborted();
    const feedUrl = this.getFeedUrl();
    if (!feedUrl) {
      throw new Error(`No feed URL for source: ${this.slug}`);
    }

    try {
      return await this.fetchFeedAndParse(feedUrl, date, { signal, sleep, stats });
    } catch (err) {
      signal?.throwIfAborted();
      // Legacy transport tolerance: utils.fetchURL rejects non-2xx, so a 304
      // arrives as "Upstream 304: …". Treat it as "no new content", exactly
      // like the native path, instead of failing the source.
      if (/^Upstream 304\b/.test(String(err?.message))) return [];
      const fallback = this.slug === 'solidot' && process.env.SOLIDOT_RSS_FALLBACK_URL;
      if (!fallback) throw err;
      console.warn(`RSS primary failed for ${this.slug}; using configured fallback: ${err.message}`);
      return this.fetchFeedAndParse(fallback, date, { signal, sleep, stats });
    }
  }

  async fetchFeedAndParse(feedUrl, date, { signal, sleep, stats }) {
    const conditional = conditionalEnabled();
    const db = getDB();
    const state = conditional ? readCondState(db) : {};
    const validators = (state && state.feeds && state.feeds[feedUrl]) || {};
    const useNative = typeof fetch === 'function';

    const headers = {
      'User-Agent': 'EagleyeBot/1.0',
      'Accept': 'application/json, application/xml, text/xml, */*',
    };
    if (conditional) {
      // If-None-Match takes precedence per RFC 9110; If-Modified-Since is only
      // replayed for feeds that did not hand us an ETag.
      if (validators.etag) headers['If-None-Match'] = validators.etag;
      else if (validators.lastModified) headers['If-Modified-Since'] = validators.lastModified;
    }

    let res;
    if (useNative) {
      res = await fetchFeedNative(feedUrl, { signal, headers, sleep, stats });
    } else {
      res = { body: await fetchURL(feedUrl, { signal, headers, sleep, stats }) };
    }

    if (res.notModified) {
      // ③ C2: 304 = "no new content" → resolve to zero items, no parsing.
      // R2 观测性 B: the short-circuit used to be fully silent — an all-zero
      // round (inserted=0/dup=0/skipped=0) could not prove the feed actually
      // answered 304. One explicit evidence line (↻ prefix per the utils.js
      // fetch-retry convention, non-error level) plus a stats counter that
      // fetchSource surfaces as envelope.notModified. Zero behavior change:
      // same zero items, same validators replay, no retry/window semantics
      // touched.
      if (stats) stats.notModified = (Number(stats.notModified) || 0) + 1;
      console.log(`  ↻ 304 ${feedUrl}`);
      if (conditional && db && (res.etag || res.lastModified)) {
        saveValidators(db, state, feedUrl, res.etag, res.lastModified);
      }
      return [];
    }

    // Validators are only observable on the native transport.
    if (conditional && db && useNative) {
      saveValidators(db, state, feedUrl, res.etag, res.lastModified);
    }

    return this.parseRSS(res.body, date, feedUrl);
  }

  parseRSS(xml, date, feedUrl = this.getFeedUrl()) {
    const parser = getFeedParser();
    if (parser) {
      let entries = null;
      try {
        entries = extractEntries(parser.parse(xml));
      } catch {
        /* keep entries null → rejected below as an invalid feed */
      }
      if (entries === null) throw new Error(`Invalid RSS/Atom response for ${this.slug}`);
      return this.buildItems(entries, date, feedUrl);
    }
    return this.parseRSSLegacy(xml, date, feedUrl);
  }

  buildItems(entries, date, feedUrl) {
    const items = [];
    // D2: digest_date always takes the requested digest date (local calendar
    // basis), never the item's own UTC day.
    const digestDate = date || compactDigestDate(todayDigestDate());
    const extractImage = (html) => {
      if (!html) return '';
      const m = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
      return m ? m[1] : '';
    };

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;

      const title = textOf(pick(entry, ['title', 'atom:title'])) || '[No Title]';
      const link = linkOf(entry);
      const guidRaw = textOf(pick(entry, ['guid', 'id', 'atom:id']));
      const pubDate = textOf(pick(entry, ['pubDate', 'published', 'updated', 'atom:published', 'atom:updated']));
      const description = textOf(pick(entry, ['description', 'content:encoded', 'content', 'summary', 'atom:summary', 'atom:content']));

      // D2 time-window freshness: keep items published within
      // [now - SOURCE_LOOKBACK_HOURS (default 36h), now + 1h]. The old
      // digest-day == item-UTC-day equality check killed cross-UTC-day items
      // during the 01:00 Asia/Shanghai run. Items without a parseable pubDate
      // keep the legacy keep-behavior (judged against fetch time).
      const pubTs = Date.parse(pubDate);
      const effectiveTs = Number.isFinite(pubTs) ? pubTs : Date.now();
      if (date && !isWithinFetchWindow(effectiveTs)) continue;

      items.push({
        ...this.normalize({
          title,
          url: link || guidRaw || '',
          description: description.replace(/<[^>]*>/g, '').slice(0, 2000),
          publishedAt: pubDate || new Date().toISOString(),
          sourcePayload: {
            guid: guidRaw || '',
            feedUrl,
            image: extractImage(description),
          },
        }),
        digest_date: digestDate,
      });
    }

    return items;
  }

  // Legacy regex parser — degradation path when fast-xml-parser is not
  // loadable. Behavior is byte-for-byte the pre-Round-2 implementation.
  parseRSSLegacy(xml, date, feedUrl = this.getFeedUrl()) {
    if (!/<(?:rss|feed)\b/i.test(xml)) throw new Error(`Invalid RSS/Atom response for ${this.slug}`);
    const items = [];
    const digestDate = date || compactDigestDate(todayDigestDate());
    const itemRegex = /<(item|entry)>([\s\S]*?)<\/\1>/gi;
    let itemMatch;

    while ((itemMatch = itemRegex.exec(xml)) !== null) {
      const block = itemMatch[2];

      const getField = (tag) => {
        // Try CDATA first
        const cdataMatch = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i'));
        if (cdataMatch) return cdataMatch[1];
        // Fallback: capture between tags
        const m2 = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return m2 ? m2[1].trim() : '';
      };

      let link = getField('link');
      if (!link) {
        const linkHrefMatch = block.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
        link = linkHrefMatch ? linkHrefMatch[1] : '';
      }

      const guidRaw = getField('guid') || getField('id');
      const pubDate = getField('pubDate') || getField('published') || getField('updated');
      const description = getField('description') || getField('content') || getField('summary') || '';
      const title = getField('title') || '[No Title]';

      const pubTs = Date.parse(pubDate);
      const effectiveTs = Number.isFinite(pubTs) ? pubTs : Date.now();
      if (date && !isWithinFetchWindow(effectiveTs)) continue;

      const extractImage = (html) => {
        if (!html) return '';
        const m = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
        return m ? m[1] : '';
      };

      items.push({
        ...this.normalize({
          title,
          url: link || guidRaw || '',
          description: description.replace(/<[^>]*>/g, '').slice(0, 2000),
          publishedAt: pubDate || new Date().toISOString(),
          sourcePayload: {
            guid: guidRaw || '',
            feedUrl,
            image: extractImage(description),
          },
        }),
        digest_date: digestDate,
      });
    }

    return items;
  }
}

module.exports = { RSSConnector };
