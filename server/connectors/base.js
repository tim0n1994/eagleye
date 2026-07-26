/**
 * Eagleye — Base Source Connector Interface
 *
 * All connectors must implement fetch(date) and optionally normalize(raw).
 */

const { getDB } = require('../db/connection');
const { generateId, contentHash } = require('../services/utils');

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
      published_at: raw.publishedAt || raw.date || raw.pubDate || new Date().toISOString(),
      digest_date: raw.digestDate || new Date().toISOString().slice(0, 10).replace(/-/g, ''),
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
  saveItems(items) {
    const db = getDB();
    if (!db || items.length === 0) return [];

    // Filter out blocked authors (e.g. noisy X accounts that post off-topic
    // social/political content). The blocklist check is a no-op for sources
    // whose items have no `author` field.
    const { readBlocklist, isBlocked } = require('../services/x-following-config');
    const blocklist = readBlocklist();
    let filtered = items;
    if (blocklist.size > 0) {
      filtered = items.filter(it => !isBlocked(it.author, blocklist));
      if (filtered.length < items.length) {
        console.log(`  🚫 Filtered ${items.length - filtered.length} blocked-author item(s)`);
      }
      if (filtered.length === 0) return [];
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO information_items 
        (id, source_id, canonical_url, external_id, title, original_summary, content_text, 
         language, author, published_at, digest_date, source_payload, normalized_payload, 
         score, popularity, content_hash)
      VALUES 
        (@id, @source_id, @canonical_url, @external_id, @title, @original_summary, @content_text,
         @language, @author, @published_at, @digest_date, @source_payload, @normalized_payload,
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

    const saved = [];
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
        if (!item.canonical_url) continue;
        const result = insert.run(item);
        const rowId = result.changes > 0
          ? item.id
          : findItemByUniqueKey.get(item.source_id, item.canonical_url, item.digest_date)?.id;
        const paperMeta = rowId ? normalizePaperMetadata({ ...item, id: rowId }) : null;
        if (paperMeta) upsertPaperMetadata.run(paperMeta);
        if (result.changes > 0) {
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
      if (saved.length > 0 && filtered[0]?.source_id) {
        updateSourceCount.run(filtered[0].source_id, filtered[0].source_id);
      }
    });

    try {
      tx();
    } catch (err) {
      console.error(`Error saving items for ${this.slug}:`, err.message);
    }

    return saved;
  }
}

module.exports = { BaseConnector };
