/**
 * Eagleye — Base Source Connector Interface
 *
 * All connectors must implement fetch(date) and optionally normalize(raw).
 */

const { getDB } = require('../db/connection');
const { generateId, contentHash } = require('../services/utils');
const { parsePublishedDate, normalizeDigestDate, todayDigestDate } = require('../services/date-contract');

function parseItemLimit(value) {
  if (value === undefined) return undefined;
  const limit = typeof value === 'number' ? value
    : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('limit must be an integer from 1 to 100');
  }
  return limit;
}

// Round 1.1 定案4 — bucket a round failure into a stable token for
// sources.last_error_class (037 column; deliberately NO new migration —
// re-ALTERing a 037-applied database would abort startup with "duplicate
// column name"). Coarse by design: the class feeds health grading
// (services/source-health.js evaluateHealth) and dashboards, not debugging —
// err.message stays in the job/pipeline logs.
function classifyFetchError(err) {
  if (!err) return 'unknown';
  const name = String(err.name || '');
  const code = String(err.code || '');
  // Cancellation is a caller decision, not a source timeout. fetchSource marks
  // the rejected error before bookkeeping when the parent signal is aborted.
  if (name === 'CancelledError') return 'cancelled';
  // Business rejections are actionable separately from protocol/network
  // failures: AUTH_REQUIRED is the connector convention, while 401/403 covers
  // HTTP-shaped and upstreamStatus-shaped errors.
  const status = Number(err.status ?? err.statusCode ?? err.upstreamStatus ?? NaN);
  if (code === 'AUTH_REQUIRED' || /\bAUTH\b|AUTH_REQUIRED|UNAUTHORIZED|FORBIDDEN/i.test(String(err.message || '')) ||
      (Number.isInteger(status) && (status === 401 || status === 403))) return 'auth';
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT' || code === 'ABORT_ERR') return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  // Node system errors (ECONNRESET / ECONNREFUSED / EHOSTUNREACH / …);
  // undici fetch() network failures surface as TypeError.
  if (/^E[A-Z0-9_]+$/.test(code) || name === 'TypeError') return 'network';
  if (Number.isInteger(status) && status >= 400 && status < 600) return `http_${status}`;
  if (name === 'SyntaxError') return 'parse';
  return name && name !== 'Error' ? name : 'unknown';
}

class BaseConnector {
  constructor(slug) {
    this.slug = slug;
  }

  /**
   * Fetch raw items for a given date (yyyymmdd).
   * Must be overridden by subclasses.
   * @param {string} [_date] - Date in yyyymmdd format
   * @returns {Promise<Object[]>}
   */
  async fetch(_date) {
    throw new Error('fetch() must be implemented by subclass');
  }

  /**
   * Normalize a raw item into the information_items format.
   * Override if needed.
   */
  normalize(raw) {
    const publishedCandidate = raw.publishedAt || raw.date || raw.pubDate || '';
    const published = parsePublishedDate(publishedCandidate);
    return {
      id: generateId(),
      source_id: this.getSourceId(),
      canonical_url: raw.url || '',
      external_id: raw.id || raw.externalId || '',
      title: raw.title || '[No Title]',
      original_summary: raw.description || raw.summary || '',
      content_text: raw.content || raw.text || '',
      language: raw.language || 'en',
      author: raw.author || '',
      published_at: published.iso,
      published_raw: published.status === 'missing' ? null : String(publishedCandidate),
      published_precision: published.precision,
      published_parse_status: published.status,
      digest_date: normalizeDigestDate(raw.digestDate) || todayDigestDate(),
      source_payload: JSON.stringify(raw.sourcePayload || raw.metadata || {}),
      normalized_payload: JSON.stringify({}),
      score: raw.score || 0,
      popularity: JSON.stringify(raw.popularity || {}),
      content_hash: contentHash(raw.title + (raw.url || '')),
      paper_metadata: raw.paperMetadata || null,
    };
  }

  getSourceId() {
    const db = getDB();
    if (!db) return '';
    const row = db.prepare('SELECT id FROM sources WHERE slug = ?').get(this.slug);
    return row ? row.id : '';
  }

  /**
   * Save normalized items to the database.
   */
  saveItems(items, opts = {}) {
    const db = getDB();
    const saved = [];
    // `duplicates` (Round 1 D3): items skipped because the same
    // (source_id, canonical_url) already exists under a DIFFERENT digest_date.
    const details = { items: saved, inserted: 0, existing: 0, duplicates: 0, skipped: 0, failed: 0 };
    const result = () => opts.returnDetails ? details : saved;
    if (!db) {
      details.failed = items.length;
      details.error = 'Database not available';
      return result();
    }

    // Round 1.1 — source round bookkeeping, per the four-case semantic
    // ruling (语义定案; contract: base-saveitems-round1-1-bookkeeping.test.js):
    //   1) success with new items/output → consecutive_empty reset to 0,
    //      last_success_at refreshed, last_new_content_at stamped (§7 Q1
    //      裁决 A), health_status='healthy' and last_error_class cleared
    //      (§7 Q2 裁决 A);
    //   2) success with every item cross-day deduped (dup-only) → NOT an
    //      empty round: the source is alive, so last_success_at is still
    //      refreshed and consecutive_empty is left unchanged;
    //   3) success with zero items (not even duplicates) → the only real
    //      empty round: consecutive_empty +1, no last_success_at refresh;
    //   4) fetch/transaction error → last_error_class recorded (037 column)
    //      and health_status='failing'; an error round is not case 3, so the
    //      streak is left untouched.
    // Every completed round still stamps sources.last_attempt_at (037
    // column; previously nothing wrote it at runtime). Columns are probed
    // because partial-schema databases (001-only fixtures) legitimately lack
    // them; bookkeeping is best-effort and must never break ingestion.
    // last_fetched_at keeps its existing semantics below (refreshed only
    // when the round has output — ruling-2 sources stay non-red through
    // last_success_at, which Round 1.1 switches the /sources staleness
    // badge to read).
    const sourceColumns = new Set((() => {
      try { return db.pragma('table_info(sources)'); } catch { return []; }
    })().map(c => c.name));
    const stampLastAttempt = sourceColumns.has('last_attempt_at')
      ? db.prepare("UPDATE sources SET last_attempt_at = datetime('now') WHERE id = ?")
      : null;
    // 定案1/2 共用：抓取成功的轮次（无论是否落了新行）都证明源是活的 →
    // 刷 last_success_at。此前该列运行时零写入（037 一次性回填后即冻结，
    // 生产实测全部停在 07-25/08-01/09-17）。
    const stampSuccess = sourceColumns.has('last_success_at')
      ? db.prepare("UPDATE sources SET last_success_at = datetime('now') WHERE id = ?")
      : null;
    // §7 Q1 裁决 A（2026-10-20）：情形1（saved>0 或 existing>0）的轮次单独
    // 戳记「最近一次真正产出新内容」。037 已有该列，此前运行时零写入者
    //（一次性回填后冻结），而 Round 1.1 起 dup-only 轮也刷 last_success_at，
    // latestOf(last_success_at, last_new_content_at)（source-health.js:82）的
    // 信息量只能靠本列单独表达 —— dup-only/empty/error 轮一律不写。
    const stampNewContent = sourceColumns.has('last_new_content_at')
      ? db.prepare("UPDATE sources SET last_new_content_at = datetime('now') WHERE id = ?")
      : null;
    // §7 Q2 裁决 A（2026-10-20）：成功轮清空 last_error_class ——「当前最后
    // 一个错误」与「健康」互斥，否则 evaluateHealth（source-health.js:101-103）
    // 的 lastErrorClass 分支会用一次历史故障永远压制早已康复的源。
    // 门控不变：仍探测 health_status（037 同批加列，缺列库照常静默跳过）。
    const markHealthy = sourceColumns.has('health_status')
      ? db.prepare("UPDATE sources SET health_status = 'healthy', last_error_class = NULL WHERE id = ?")
      : null;
    // Dup-only is also a clean, successful round: it proves the source is
    // alive, but unlike new-content it intentionally leaves health_status to
    // the health recompute path (a retained error must still surface there).
    const clearErrorClass = sourceColumns.has('last_error_class')
      ? db.prepare('UPDATE sources SET last_error_class = NULL WHERE id = ?')
      : null;
    const stampErrorClass = sourceColumns.has('last_error_class')
      ? db.prepare('UPDATE sources SET last_error_class = ? WHERE id = ?')
      : null;
    const markFailing = sourceColumns.has('health_status')
      ? db.prepare("UPDATE sources SET health_status = 'failing' WHERE id = ?")
      : null;
    const maintainEmptyStreak = sourceColumns.has('consecutive_empty')
      ? db.prepare('UPDATE sources SET consecutive_empty = CASE WHEN ? > 0 THEN 0 ELSE consecutive_empty + 1 END WHERE id = ?')
      : null;
    const resolveSourceId = (fallbackId) => fallbackId || this.getSourceId();
    // 定案 1/2/3 的落账出口；roundKind ∈ 'new-content' | 'dup-only' | 'empty'。
    const writeRoundBookkeeping = (roundKind, sourceId) => {
      if (!sourceId) return;
      try {
        if (stampLastAttempt) stampLastAttempt.run(sourceId);
        if ((roundKind === 'new-content' || roundKind === 'dup-only') && stampSuccess) {
          stampSuccess.run(sourceId);
        }
        if (roundKind === 'new-content') {
          // 定案1 + §7 Q1 裁决 A：有产出（新插入或同日 existing）→ 清零 +
          // healthy + 戳 last_new_content_at（recomputeSourceHealth 的输入
          // latestOf(last_success_at, last_new_content_at) 从此保持新鲜）。
          if (maintainEmptyStreak) maintainEmptyStreak.run(1, sourceId);
          if (stampNewContent) stampNewContent.run(sourceId);
          if (markHealthy) markHealthy.run(sourceId);
        } else if (roundKind === 'dup-only') {
          if (clearErrorClass) clearErrorClass.run(sourceId);
        } else if (roundKind === 'empty') {
          // 定案3：0 个条目（连重复都没有）→ 唯一真正的空轮，+1。
          if (maintainEmptyStreak) maintainEmptyStreak.run(0, sourceId);
        }
        // 定案2（修订）：dup-only 刷 last_success_at 并清当前错误；streak
        // 不动、health 交给 recomputeSourceHealth 统一评估。
      } catch { /* best-effort bookkeeping */ }
    };
    // 定案4：异常轮（saveItems 事务失败）—— 记 last_error_class + 置
    // health_status='failing'；streak 不动（异常轮不得混入定案3的空轮计数）。
    const recordFailedRound = (sourceId, err) => {
      if (!sourceId) return;
      try {
        if (stampLastAttempt) stampLastAttempt.run(sourceId);
        if (stampErrorClass) stampErrorClass.run(classifyFetchError(err), sourceId);
        if (markFailing) markFailing.run(sourceId);
      } catch { /* best-effort bookkeeping */ }
    };

    if (items.length === 0) {
      // 定案3：抓取成功但 0 个条目 —— 真正的空轮。
      writeRoundBookkeeping('empty', resolveSourceId());
      return result();
    }

    // Filter out blocked authors (e.g. noisy X accounts that post off-topic
    // social/political content). The blocklist check is a no-op for sources
    // whose items have no `author` field.
    const { readBlocklist, isBlocked } = require('../services/x-following-config');
    const blocklist = readBlocklist();
    // R0-07 transactional outbox: pending side-effect events (e.g. search
    // indexing) commit in the SAME transaction as the item rows they
    // describe. An item only counts as "persisted, pending delivery" when
    // BOTH the information_items row and its outbox row land in this
    // transaction; drainOutbox() delivers at-least-once later and consumers
    // dedup redelivery by unique_key (plan §7.4 checkpoint semantics).
    const { registerEvent } = require('../services/outbox');
    let filtered = items;
    if (blocklist.size > 0) {
      filtered = items.filter(it => !isBlocked(it.author, blocklist));
      details.skipped = items.length - filtered.length;
      if (filtered.length < items.length) {
        console.log(`  🚫 Filtered ${items.length - filtered.length} blocked-author item(s)`);
      }
      if (filtered.length === 0) {
        // 全部条目被 blocklist 滤掉：无任何产出/重复证据，按定案3空轮处理
        //（与 d4a8e9b 行为一致：+1）。
        writeRoundBookkeeping('empty', resolveSourceId());
        return result();
      }
    }

    for (const item of filtered) {
      if (item.published_parse_status === undefined) {
        const original = item.published_at;
        const parsed = parsePublishedDate(original);
        item.published_at = parsed.iso;
        item.published_raw = parsed.status === 'missing' ? null : String(original ?? '');
        item.published_precision = parsed.precision;
        item.published_parse_status = parsed.status;
      }
      item.digest_date = normalizeDigestDate(item.digest_date) || todayDigestDate();
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO information_items 
        (id, source_id, canonical_url, external_id, title, original_summary, content_text, 
         language, author, published_at, published_raw, published_precision, published_parse_status,
         digest_date, source_payload, normalized_payload,
         score, popularity, content_hash)
      VALUES 
        (@id, @source_id, @canonical_url, @external_id, @title, @original_summary, @content_text,
         @language, @author, @published_at, @published_raw, @published_precision, @published_parse_status,
         @digest_date, @source_payload, @normalized_payload,
         @score, @popularity, @content_hash)
    `);

    const updateSourceCount = db.prepare(
      'UPDATE sources SET item_count = (SELECT COUNT(*) FROM information_items WHERE source_id = ?), last_fetched_at = datetime(\'now\') WHERE id = ?'
    );
    const findItemByUniqueKey = db.prepare(`
      SELECT id FROM information_items
      WHERE source_id = ? AND canonical_url = ? AND digest_date = ?
      LIMIT 1
    `);
    // Round 1 D3 — forward cross-day dedup backstop: a URL already ingested
    // under a different digest_date is skipped (counted in details.duplicates)
    // instead of re-inserted, which was the source of the ~49.9% cross-day
    // duplicate rows. Same-day hits keep the legacy INSERT OR IGNORE →
    // `existing` semantics; UNIQUE(source_id, canonical_url, digest_date) is
    // unchanged and its autoindex prefix serves this lookup, so no extra
    // index is needed (EXPLAIN QUERY PLAN: SEARCH ... USING INDEX
    // sqlite_autoindex_information_items_2).
    const findAnyDayByUrl = db.prepare(`
      SELECT id, digest_date FROM information_items
      WHERE source_id = ? AND canonical_url = ?
      LIMIT 1
    `);
    const hasPaperMetadata = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'paper_metadata'").get();
    const upsertPaperMetadata = hasPaperMetadata ? db.prepare(`
      INSERT INTO paper_metadata (
        item_id, paper_id, source_slug, provider, arxiv_id, doi, title, abstract,
        authors_json, categories_json, published_at, updated_at, pdf_url, landing_url,
        code_url, datasets_json, tasks_json, venue, dedupe_key, metadata_json,
        updated_at_row
      )
      VALUES (
        @item_id, @paper_id, @source_slug, @provider, @arxiv_id, @doi, @title, @abstract,
        @authors_json, @categories_json, @published_at, @updated_at, @pdf_url, @landing_url,
        @code_url, @datasets_json, @tasks_json, @venue, @dedupe_key, @metadata_json,
        datetime('now')
      )
      ON CONFLICT(item_id) DO UPDATE SET
        paper_id = excluded.paper_id,
        source_slug = excluded.source_slug,
        provider = excluded.provider,
        arxiv_id = excluded.arxiv_id,
        doi = excluded.doi,
        title = excluded.title,
        abstract = excluded.abstract,
        authors_json = excluded.authors_json,
        categories_json = excluded.categories_json,
        published_at = excluded.published_at,
        updated_at = excluded.updated_at,
        pdf_url = excluded.pdf_url,
        landing_url = excluded.landing_url,
        code_url = excluded.code_url,
        datasets_json = excluded.datasets_json,
        tasks_json = excluded.tasks_json,
        venue = excluded.venue,
        dedupe_key = excluded.dedupe_key,
        metadata_json = excluded.metadata_json,
        updated_at_row = datetime('now')
    `) : null;

    const normalizePaperMetadata = (item) => {
      if (!item.paper_metadata || !upsertPaperMetadata) return null;
      const meta = item.paper_metadata;
      const json = (value) => JSON.stringify(Array.isArray(value) ? value : []);
      const title = String(meta.title || item.title || '').trim();
      if (!title) return null;
      return {
        item_id: item.id,
        paper_id: meta.paper_id || meta.paperId || meta.arxiv_id || item.external_id || '',
        source_slug: this.slug,
        provider: meta.provider || this.slug,
        arxiv_id: meta.arxiv_id || meta.arxivId || '',
        doi: meta.doi || '',
        title,
        abstract: meta.abstract || item.original_summary || '',
        authors_json: json(meta.authors),
        categories_json: json(meta.categories),
        published_at: meta.published_at || item.published_at || '',
        updated_at: meta.updated_at || '',
        pdf_url: meta.pdf_url || meta.pdfUrl || '',
        landing_url: meta.landing_url || meta.landingUrl || item.canonical_url || '',
        code_url: meta.code_url || meta.codeUrl || '',
        datasets_json: json(meta.datasets),
        tasks_json: json(meta.tasks),
        venue: meta.venue || '',
        dedupe_key: meta.dedupe_key || meta.dedupeKey || meta.doi || meta.arxiv_id || contentHash(title.toLowerCase().replace(/\s+/g, ' ')),
        metadata_json: JSON.stringify(meta.metadata || {}),
      };
    };

    // Cross-day dedup: when a newly-inserted item has a content_hash that
    // already exists from a DIFFERENT digest_date, assign both the same
    // duplicate_group_id (§16). This surfaces "you've seen this before" without
    // deleting the item (the digest-date model needs each day's row).
    const findDupByHash = db.prepare(`
      SELECT id, duplicate_group_id FROM information_items
      WHERE content_hash = ? AND content_hash != '' AND id != ? AND digest_date != ?
      LIMIT 1
    `);
    const setDupGroup = db.prepare(`UPDATE information_items SET duplicate_group_id = ? WHERE id = ?`);

    const tx = db.transaction(() => {
      for (const item of filtered) {
        if (!item.canonical_url) { details.skipped++; continue; }
        const priorRow = findAnyDayByUrl.get(item.source_id, item.canonical_url);
        if (priorRow && priorRow.digest_date !== item.digest_date
          && !findItemByUniqueKey.get(item.source_id, item.canonical_url, item.digest_date)) {
          // Seen before on another day (and not also today): skip the insert,
          // count it as a duplicate, but still refresh paper metadata on the
          // surviving row (arXiv-style sources upsert enrichment by item_id).
          details.duplicates++;
          const priorPaperMeta = normalizePaperMetadata({ ...item, id: priorRow.id });
          if (priorPaperMeta) upsertPaperMetadata.run(priorPaperMeta);
          continue;
        }
        const result = insert.run(item);
        const rowId = result.changes > 0
          ? item.id
          : findItemByUniqueKey.get(item.source_id, item.canonical_url, item.digest_date)?.id;
        if (result.changes === 0) {
          if (rowId) details.existing++;
          else details.failed++;
        }
        const paperMeta = rowId ? normalizePaperMetadata({ ...item, id: rowId }) : null;
        if (paperMeta) upsertPaperMetadata.run(paperMeta);
        if (result.changes > 0) {
          // Atomic pending-event registration: if this INSERT fails, the
          // whole transaction (item row included) rolls back, so a committed
          // item always carries its 'item_index_pending' outbox row.
          registerEvent(db, {
            type: 'item_index_pending',
            payload: { item_id: item.id, source_id: item.source_id, digest_date: item.digest_date },
            uniqueKey: `index_item:${item.id}`,
          });
          // Cross-day dedup check: link to an existing group if this content
          // was seen on a prior day (e.g. a trending repo that persists).
          if (item.content_hash) {
            const dup = findDupByHash.get(item.content_hash, item.id, item.digest_date);
            if (dup) {
              const groupId = dup.duplicate_group_id || dup.id;
              setDupGroup.run(groupId, item.id);
              if (!dup.duplicate_group_id) setDupGroup.run(groupId, dup.id);
            }
          }
          saved.push(item);
        }
      }
      // last_fetched_at / item_count keep their pre-D4 gate (rounds with
      // output only); the attempt ledger and streak update run on every
      // completed round regardless.
      const roundSourceId = resolveSourceId(filtered[0]?.source_id);
      const hasOutput = saved.length > 0 || details.existing > 0;
      if (hasOutput && roundSourceId) {
        updateSourceCount.run(roundSourceId, roundSourceId);
      }
      // Round 1.1 定案分派：有产出（新插入或同日 existing）→ 情形1；
      // 无产出但整批被跨天去重拦下（details.duplicates>0）→ 情形2
      // dup-only（不算空轮）；两者皆无 → 情形3 空轮。
      writeRoundBookkeeping(
        hasOutput ? 'new-content' : (details.duplicates > 0 ? 'dup-only' : 'empty'),
        roundSourceId,
      );
    });

    try {
      tx();
    } catch (err) {
      console.error(`Error saving items for ${this.slug}:`, err.message);
      saved.length = 0;
      details.existing = 0;
      details.duplicates = 0;
      details.failed = items.length - details.skipped;
      details.error = err.message;
      // Round 1.1 定案4：事务失败 = 异常轮 —— 记 last_error_class（归桶）并置
      // health_status='failing'；streak 不动（保留 d4a8e9b 的意图：未干净完成
      // 的轮次不能归类为产出，也不能混入定案3的空轮计数）。
      recordFailedRound(resolveSourceId(filtered[0]?.source_id), err);
    }

    details.inserted = saved.length;
    return result();
  }
}

module.exports = { BaseConnector, parseItemLimit, classifyFetchError };
