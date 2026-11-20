/** XiaoHongShu collector: REST when configured, otherwise OpenCLI. */

const { BaseConnector } = require('./base');
const reach = require('../services/agent-reach');
const collectors = require('../services/server-collectors');
const { setTimeout: sleep } = require('node:timers/promises');
const { readXiaohongshuConfig } = require('../services/xiaohongshu-config');

const NOTE_PATHS = ['explore', 'search_result', 'discovery/item'];
const noteIdFromUrl = url => String(url || '').match(
  /^https?:\/\/(?:www\.)?xiaohongshu\.com\/(?:explore|search_result|discovery\/item)\/([a-f0-9]{24})(?:[/?#]|$)/i
)?.[1]?.toLowerCase();

class XiaoHongShuConnector extends BaseConnector {
  constructor() {
    super('xiaohongshu');
  }

  /** Map an opencli xiaohongshu search record to a normalized raw item. */
  _noteToItem(note) {
    const url = note.url || '';
    const likes = Number(String(note.likes).replace(/[^\d.]/g, '')) || 0;
    const id = noteIdFromUrl(url);
    const title = (note.title || '').trim() || '[无标题]';
    const author = note.author || '';

    return this.normalize({
      id,
      title,
      url,
      description: title,
      content: title,
      author,
      publishedAt: note.published_at || null,
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

  // Links carry rotating access parameters. Match by note ID across both
  // current and historical URL forms while preserving the original link.
  prepareProviderIdentityLookup(db) {
    const byNoteUrl = db.prepare(`
      SELECT 1 FROM information_items
      WHERE source_id = ? AND canonical_url >= ? AND canonical_url < ?
      AND (canonical_url = ? OR substr(canonical_url, ?, 1) = '?')
      LIMIT 1
    `);
    return ({ source_id, external_id }) => {
      if (!external_id) return false;
      return NOTE_PATHS.some(path => {
        const url = `https://www.xiaohongshu.com/${path}/${external_id}`;
        return byNoteUrl.get(source_id, url, url + '@', url, url.length + 1);
      });
    };
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
    const seen = new Set();
    for (let i = 0; i < keywords.length; i++) {
      const kw = keywords[i];
      signal?.throwIfAborted();
      const result = await (serverBackend ? collectors : reach).xiaohongshuSearch(kw, { limit, signal });
      if (!result.ok) {
        throw new Error(`xiaohongshu: ${result.code || 'COLLECTION_FAILED'}`);
      } else {
        if (!Array.isArray(result.data)) throw new Error('SCHEMA_ERROR');
        const items = result.data
          .filter(Boolean)
          .map(n => this._noteToItem(n))
          .filter(it => {
            const key = it.external_id || it.canonical_url;
            if (!it.canonical_url || seen.has(key)) return false;
            seen.add(key);
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
