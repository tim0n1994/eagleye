/** XiaoHongShu collector: REST when configured, otherwise OpenCLI. */

const { BaseConnector } = require('./base');
const reach = require('../services/agent-reach');
const collectors = require('../services/server-collectors');
const { setTimeout: sleep } = require('node:timers/promises');
const { readXiaohongshuConfig } = require('../services/xiaohongshu-config');

/** Parse a "YYYY-MM-DD" (or partial) string into an ISO timestamp. */
function parseXhsDate(value) {
  const s = String(value || '').trim();
  if (!s) return new Date().toISOString();
  // YYYY-MM-DD  →  YYYY-MM-DDT00:00:00Z
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  const parsed = Date.parse(s);
  return isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

class XiaoHongShuConnector extends BaseConnector {
  constructor() {
    super('xiaohongshu');
  }

  /** Map an opencli xiaohongshu search record to a normalized raw item. */
  _noteToItem(note) {
    const url = note.url || '';
    const likes = Number(String(note.likes).replace(/[^\d.]/g, '')) || 0;
    const publishedAt = parseXhsDate(note.published_at);
    const title = (note.title || '').trim() || '[无标题]';
    const author = note.author || '';

    return this.normalize({
      title,
      url,
      description: title,
      content: title,
      author,
      publishedAt,
      language: 'zh',
      score: Math.log2(1 + likes),
      sourcePayload: {
        noteUrl: url,
        authorUrl: note.author_url || '',
        likes,
        rank: note.rank || null,
      },
      popularity: { likes },
    });
  }

  async fetch(_date, { signal } = {}) {
    signal?.throwIfAborted();
    const serverBackend = Boolean(process.env.EAGLEYE_XHS_MCP_URL);
    const { keywords } = readXiaohongshuConfig();
    if (keywords.length === 0) {
      console.log('  ⚠ XiaoHongShu: no keywords configured (set XIAOHONGSHU_KEYWORDS env or config/xiaohongshu-keywords.txt)');
      return [];
    }

    if (!serverBackend && !await reach.isReachReady('xiaohongshu', { signal })) {
      throw new Error('xiaohongshu: BACKEND_NOT_READY');
    }

    const limit = parseInt(process.env.XHS_NOTES_PER_KEYWORD || '20', 10) || 20;
    const delayMs = parseInt(process.env.XHS_POLITENESS_MS || '3000', 10) || 0; // 3s per agent-reach guidance
    console.log(`  📕 XiaoHongShu: searching ${keywords.length} keywords via ${serverBackend ? 'server' : 'opencli'}...`);

    const allItems = [];
    for (let i = 0; i < keywords.length; i++) {
      const kw = keywords[i];
      signal?.throwIfAborted();
      const result = await (serverBackend ? collectors : reach).xiaohongshuSearch(kw, { limit, signal });
      if (!result.ok) {
        throw new Error(`xiaohongshu: ${result.code || 'COLLECTION_FAILED'}`);
      } else {
        const seen = new Set();
        if (!Array.isArray(result.data)) throw new Error('SCHEMA_ERROR');
        const items = result.data
          .filter(Boolean)
          .map(n => this._noteToItem(n))
          .filter(it => {
            if (!it.canonical_url || seen.has(it.canonical_url)) return false;
            seen.add(it.canonical_url);
            return true;
          });
        allItems.push(...items);
        console.log(`  📕 XiaoHongShu "${kw}": ${items.length} notes`);
      }
      if (delayMs > 0 && i < keywords.length - 1) await sleep(delayMs, undefined, { signal });
    }

    console.log(`  📕 XiaoHongShu: ${allItems.length} notes from ${keywords.length} keywords`);
    return allItems;
  }
}

module.exports = { XiaoHongShuConnector };
