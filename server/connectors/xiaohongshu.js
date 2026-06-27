/**
 * Eagleye — XiaoHongShu Connector (via agent-reach opencli)
 *
 * Searches XiaoHongShu (小红书) for curated keywords using the agent-reach
 * opencli backend (browser bridge — requires Chrome logged into xiaohongshu.com).
 *
 * Backend notes (verified against live opencli output):
 *  - The search result's `url` contains the xsec_token required to read the
 *    full note later. We store that full URL as canonical_url — never a bare
 *    note_id, which cannot be re-read.
 *  - `likes` and `published_at` are emitted as STRINGS (e.g. "3574",
 *    "2026-06-20"). We coerce both here.
 *  - We do NOT fetch each note's full body (a second opencli call per note)
 *    because deep paging triggers captcha. The search result's title is enough
 *    for the LLM enrichment stage to expand on.
 *  - Rate-limit safety: 2-3s between search calls (per agent-reach guidance).
 */

const { BaseConnector } = require('./base');
const reach = require('../services/agent-reach');
const { readXiaohongshuConfig } = require('../services/xiaohongshu-config');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

  async fetch(_date) {
    const { keywords } = readXiaohongshuConfig();
    if (keywords.length === 0) {
      console.log('  ⚠ XiaoHongShu: no keywords configured (set XIAOHONGSHU_KEYWORDS env or config/xiaohongshu-keywords.txt)');
      return [];
    }

    const ready = await reach.isReachReady('xiaohongshu').catch(() => true);
    if (!ready) {
      console.warn('  ⚠ XiaoHongShu: opencli backend not ready — skipping (open Chrome and log into xiaohongshu.com)');
      return [];
    }

    const limit = parseInt(process.env.XHS_NOTES_PER_KEYWORD || '20', 10) || 20;
    const delayMs = parseInt(process.env.XHS_POLITENESS_MS || '3000', 10) || 0; // 3s per agent-reach guidance
    console.log(`  📕 XiaoHongShu: searching ${keywords.length} keywords via opencli...`);

    const allItems = [];
    for (let i = 0; i < keywords.length; i++) {
      const kw = keywords[i];
      const result = await reach.xiaohongshuSearch(kw, { limit });
      if (!result.ok) {
        if (result.code === 'BRIDGE_DOWN' || result.code === 'AUTH_REQUIRED') {
          console.warn(`  ⚠ XiaoHongShu: opencli ${result.code} — aborting remaining keywords (${result.message})`);
          break;
        }
        console.warn(`  ⚠ XiaoHongShu "${kw}": ${result.code} — ${result.message}`);
      } else {
        const seen = new Set();
        const items = (result.data || [])
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
      if (delayMs > 0 && i < keywords.length - 1) await sleep(delayMs);
    }

    console.log(`  📕 XiaoHongShu: ${allItems.length} notes from ${keywords.length} keywords`);
    return allItems;
  }
}

module.exports = { XiaoHongShuConnector };
