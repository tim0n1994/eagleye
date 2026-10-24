/**
 * Eagleye — Hacker News Connector
 *
 * Round 2 ② — dual backend behind the HN_BACKEND env switch:
 *
 *   HN_BACKEND=algolia   incremental pull: ONE hn.algolia.com
 *                        /api/v1/search_by_date?tags=story request (plus a
 *                        rare extra page when the increment overflows the
 *                        page size) filtered by
 *                        numericFilters=created_at_i>{cursor}, replacing the
 *                        firebase topstories + one-request-per-item N+1
 *                        (1+30 HTTP calls per run). The cursor is the max
 *                        created_at_i already ingested and lives in user_data
 *                        global scope under key `hn_cursor`
 *                        ({ cursor, updated_at } — scheduler_config single-key
 *                        JSON style; server-level keys use user_id '',
 *                        migration 028 convention). A first run without a
 *                        cursor seeds the filter at the D2 fetch-window
 *                        lookback floor so a fresh deployment never walks the
 *                        whole Algolia index. The cursor only advances when
 *                        pagination reached the last page — a truncated walk
 *                        (page cap hit) keeps the previous cursor so the
 *                        un-walked tail is retried next run instead of being
 *                        lost forever.
 *
 *   HN_BACKEND=firebase  the pre-Round-2 path, kept intact as the rollback
 *                        target: topstories ranking + per-item fetches.
 *                        This is also the DEFAULT: unset or unknown values
 *                        land here so an unconfigured deployment behaves
 *                        exactly like production before Round 2. Rollback =
 *                        set HN_BACKEND=firebase (or remove the env line).
 *
 * Score semantics are identical on both paths: HN points -> score and
 * popularity.points, comment counts -> popularity.comments,
 * source_payload.hnId is the algolia objectID or the firebase id, URL-less
 * stories fall back to their news.ycombinator.com item page, and
 * epoch-second timestamps (created_at_i | time) become published_at ISO.
 * The item cap (parseItemLimit ?? 30) is preserved; the declared Round 2
 * behavior change is the selection dimension (topstories rank -> time
 * increment), which still yields at most `limit` items.
 */

const { BaseConnector, parseItemLimit } = require('./base');
const { fetchURL } = require('../services/utils');
const {
  isWithinFetchWindow,
  compactDigestDate,
  todayDigestDate,
  fetchLookbackHours,
} = require('../services/date-contract');

const BACKEND_ALGOLIA = 'algolia';
const BACKEND_FIREBASE = 'firebase';

// user_data server-level key (global scope, user_id '' — migration 028
// convention). Round 2 ②: { cursor: <max created_at_i ingested>, updated_at }.
const HN_CURSOR_KEY = 'hn_cursor';

const ALGOLIA_SEARCH_URL = 'https://hn.algolia.com/api/v1/search_by_date';
// HN averages a few hundred stories/day, so one 100-hit page carries the
// whole daily increment; 4 pages is a runaway guard, not the norm. Cursor
// advancement requires reaching nbPages (see fetchViaAlgolia).
const ALGOLIA_HITS_PER_PAGE = 100;
const ALGOLIA_MAX_PAGES = 4;

function currentBackend() {
  return process.env.HN_BACKEND === BACKEND_ALGOLIA ? BACKEND_ALGOLIA : BACKEND_FIREBASE;
}

// R2 观测性 A: the `since` anchor shared by the dispatch log line below. For
// algolia this is the cursor actually used in the created_at_i filter (or the
// first-run window floor below it); for firebase there is no cursor, so the
// honest anchor is the D2 fetch-window floor that isWithinFetchWindow enforces
// anyway. Pure computation — logging only, no behavior change.
function windowFloorEpoch() {
  return Math.floor(Date.now() / 1000) - Math.round(fetchLookbackHours() * 3600);
}

// R2 观测性 A: one evidence line per successful fetch, on BOTH backend paths.
// Before this, a successful round was completely silent, so ALGOLIA_COUNT=0 in
// the journal could not distinguish "HN_BACKEND=algolia not in effect" from
// "in effect but not logged". items=<n> is the RETURNED item count (after the
// window filter / item cap), not stats.requested, so an empty round logs
// items=0 instead of silence. Never console.error — that channel is reserved
// for per-item failures (see the catch blocks below).
function logBackendDispatch(backend, itemCount, since) {
  console.log(`[hacker-news] backend=${backend} items=${itemCount} since=${since}`);
}

class HNConnector extends BaseConnector {
  constructor() {
    super('hacker-news');
  }

  async fetch(date, opts = {}) {
    const limit = parseItemLimit(opts.limit) ?? 30;
    const stats = opts.stats || { requested: 0, failed: 0, skipped: 0 };
    const digestDate = date || compactDigestDate(todayDigestDate());
    if (currentBackend() === BACKEND_ALGOLIA) {
      return this.fetchViaAlgolia(date, digestDate, limit, stats);
    }
    return this.fetchViaFirebase(date, digestDate, limit, stats);
  }

  /**
   * Round 2 ② opt-in incremental backend. One search_by_date pull (rarely a
   * few pages) instead of topstories + 30 per-item requests.
   */
  async fetchViaAlgolia(date, digestDate, limit, stats) {
    // Required lazily INSIDE the algolia branch: the firebase rollback path
    // (and the unset-switch default) must not touch user_data at all, and
    // older test harnesses that only mock the firebase path do not route
    // this module.
    const { getValue, setValue, GLOBAL_SCOPE } = require('../db/user-data');

    const stored = getValue(HN_CURSOR_KEY);
    const prevCursor = stored && Number.isFinite(stored.cursor)
      ? Math.floor(stored.cursor)
      : null;

    let since;
    if (prevCursor) {
      since = prevCursor;
    } else {
      // First run (no cursor): the backend contract allows an unfiltered
      // pull, but seeding at the D2 fetch-window floor keeps a fresh
      // deployment from walking the whole Algolia index while matching what
      // the isWithinFetchWindow filter below would keep anyway.
      since = windowFloorEpoch();
    }

    const hits = [];
    let walkedFullIncrement = false;
    for (let page = 0; page < ALGOLIA_MAX_PAGES; page += 1) {
      // Hand-rolled query string (encodeURIComponent only): the connector
      // also runs inside minimal test sandboxes without URLSearchParams.
      const query = `tags=${encodeURIComponent('story')}`
        + `&numericFilters=${encodeURIComponent(`created_at_i>${since}`)}`
        + `&hitsPerPage=${ALGOLIA_HITS_PER_PAGE}`
        + `&page=${page}`;
      const body = await fetchURL(`${ALGOLIA_SEARCH_URL}?${query}`);
      const data = JSON.parse(body);
      if (!data || !Array.isArray(data.hits)) throw new Error('Invalid Hacker News Algolia response');
      hits.push(...data.hits);
      const nbPages = Number(data.nbPages) || 1;
      if (data.hits.length === 0 || page + 1 >= nbPages) {
        walkedFullIncrement = true;
        break;
      }
    }

    // Dedup objectIDs — the pagination boundary can repeat a hit.
    const seen = new Set();
    const uniqueHits = [];
    for (const hit of hits) {
      const id = hit && hit.objectID !== undefined && hit.objectID !== null ? String(hit.objectID) : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      uniqueHits.push(hit);
    }
    stats.requested = uniqueHits.length;

    const items = [];
    for (const hit of uniqueHits) {
      try {
        const createdAtI = Number(hit.created_at_i);
        if (!Number.isFinite(createdAtI) || createdAtI <= 0) throw new Error('Missing Hacker News created_at_i');
        // D2 time-window freshness, same contract as the firebase path:
        // keep [now - SOURCE_LOOKBACK_HOURS (default 36h), now + 1h];
        // digest_date always takes the requested digest date.
        if (date && !isWithinFetchWindow(createdAtI * 1000)) { stats.skipped++; continue; }
        if (typeof hit.title !== 'string' || !hit.title.trim()) throw new Error('Missing Hacker News title');

        // Same mapping/shape as the firebase path (points -> score etc.);
        // Ask-HN style hits without a url fall back to their HN item page.
        const hnUrl = `https://news.ycombinator.com/item?id=${hit.objectID}`;
        const url = hit.url || hnUrl;
        const points = hit.points || 0;
        const comments = hit.num_comments || 0;

        items.push({
          ...this.normalize({
            title: hit.title,
            url,
            description: hit.story_text || hit.comment_text || '',
            publishedAt: new Date(createdAtI * 1000).toISOString(),
            author: hit.author || '',
            score: points,
            sourcePayload: {
              hnId: hit.objectID,
              hnUrl,
              points,
              comments,
              domain: hit.url ? new URL(hit.url).hostname.replace(/^www\./, '') : 'news.ycombinator.com',
              by: hit.author || '',
              type: 'story',
            },
            popularity: { points, comments },
          }),
          digest_date: digestDate,
        });
      } catch (err) {
        console.error(`[${this.slug}] item ${hit?.objectID ?? '?'} failed:`, err.message);
        stats.failed++;
      }
    }

    // Advance the cursor only on a complete walk (pagination reached the
    // last page). A truncated walk keeps the previous cursor so the
    // un-walked tail is retried next run — the max created_at_i is the
    // newest hit seen, so advancing after a truncation would silently skip
    // everything below the page cap. `Math.max(prevCursor, …)` also keeps
    // the write monotonic across runs even when this round saw nothing new.
    if (walkedFullIncrement) {
      const maxSeen = uniqueHits.reduce((max, hit) => {
        const t = Number(hit.created_at_i);
        return Number.isFinite(t) && t > max ? t : max;
      }, 0);
      const nextCursor = Math.max(maxSeen, prevCursor || 0);
      if (nextCursor > 0) {
        setValue(HN_CURSOR_KEY, { cursor: nextCursor, updated_at: new Date().toISOString() }, GLOBAL_SCOPE);
      }
    }

    // Item cap preserved (same parseItemLimit ?? 30 as the firebase path);
    // search_by_date returns newest-first, so this keeps the newest
    // `limit` in-window stories — the declared selection-dimension change.
    const result = items.slice(0, limit);
    logBackendDispatch(BACKEND_ALGOLIA, result.length, since);
    return result;
  }

  /**
   * Pre-Round-2 backend (default + rollback target): topstories ranking
   * followed by one item request per id.
   */
  async fetchViaFirebase(date, digestDate, limit, stats) {
    const idsBody = await fetchURL('https://hacker-news.firebaseio.com/v0/topstories.json');
    const topIds = JSON.parse(idsBody);
    if (!Array.isArray(topIds)) throw new Error('Invalid Hacker News topstories response');
    const ids = [...new Set(topIds)].slice(0, limit);
    stats.requested = ids.length;
    const items = [];

    const results = await Promise.allSettled(ids.map(async (id) => {
      if (!Number.isInteger(id) || id < 1) throw new Error('Invalid Hacker News story ID');
      const body = await fetchURL(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      return JSON.parse(body);
    }));

    for (const r of results) {
      if (r.status !== 'fulfilled') { stats.failed++; continue; }
      const raw = r.value;
      if (!raw) { stats.failed++; continue; }
      if (raw.deleted || raw.dead) { stats.skipped++; continue; }

      try {
        // D2 time-window freshness: keep items published within
        // [now - SOURCE_LOOKBACK_HOURS (default 36h), now + 1h]. The old
        // digest-day == item-UTC-day equality check killed every cross-UTC-day
        // story during the 01:00 Asia/Shanghai run (UTC is still on the
        // previous day). digest_date always takes the requested digest date.
        if (date && !isWithinFetchWindow(raw.time * 1000)) { stats.skipped++; continue; }
        if (typeof raw.title !== 'string' || !raw.title.trim()) throw new Error('Missing Hacker News title');

        items.push({
          ...this.normalize({
            title: raw.title,
            url: raw.url || `https://news.ycombinator.com/item?id=${raw.id}`,
            description: raw.text || '',
            publishedAt: new Date(raw.time * 1000).toISOString(),
            author: raw.by || '',
            score: raw.score || 0,
            sourcePayload: {
              hnId: raw.id,
              hnUrl: `https://news.ycombinator.com/item?id=${raw.id}`,
              points: raw.score || 0,
              comments: raw.descendants || 0,
              domain: raw.url ? new URL(raw.url).hostname.replace(/^www\./, '') : 'news.ycombinator.com',
              by: raw.by || '',
              type: raw.type || 'story',
            },
            popularity: { points: raw.score || 0, comments: raw.descendants || 0 },
          }),
          digest_date: digestDate,
        });
      } catch (err) {
        console.error(`[${this.slug}] item ${raw?.id ?? '?'} failed:`, err.message);
        stats.failed++;
      }
    }

    logBackendDispatch(BACKEND_FIREBASE, items.length, windowFloorEpoch());
    return items;
  }
}

module.exports = { HNConnector };
