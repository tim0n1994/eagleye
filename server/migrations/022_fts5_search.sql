-- 022_fts5_search.sql — FTS5 full-text search index for information_items
--
-- Replaces the 8-pattern LIKE search in /api/search with an O(log n) FTS5
-- index. Uses the trigram tokenizer (built into SQLite ≥ 3.34, bundled with
-- better-sqlite3) which gives substring matching that works for BOTH English
-- and Chinese without a dictionary — critical because the corpus is bilingual
-- (English titles + Chinese title_zh/summary_zh). The default unicode61
-- tokenizer treats runs of CJK as single tokens, making Chinese search useless.
--
-- External-content table: FTS mirrors information_items without duplicating
-- data. Triggers keep the index in sync on insert/delete/update.
-- Note: ai_summaries changes don't auto-sync (separate table) — the index
-- covers title/title_zh/original_summary which is the bulk of search value;
-- summary text is backfilled once here and refreshed on periodic rebuild.

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, title_zh, summary,
  tokenize='trigram'
);

-- Backfill from existing data (title + title_zh + AI summary text).
INSERT INTO items_fts(rowid, title, title_zh, summary)
  SELECT i.rowid, i.title, COALESCE(i.title_zh, ''),
         COALESCE(a.one_liner_zh,'') || ' ' || COALESCE(a.short_summary_zh,'')
  FROM information_items i
  LEFT JOIN ai_summaries a ON a.item_id = i.id;

-- Sync triggers on information_items.
CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON information_items BEGIN
  INSERT INTO items_fts(rowid, title, title_zh, summary)
    VALUES (new.rowid, new.title, COALESCE(new.title_zh,''), COALESCE(new.original_summary,''));
END;
CREATE TRIGGER IF NOT EXISTS items_fts_ad AFTER DELETE ON information_items BEGIN
  INSERT INTO items_fts(items_fts, rowid) VALUES('delete', old.rowid);
END;
CREATE TRIGGER IF NOT EXISTS items_fts_au AFTER UPDATE ON information_items BEGIN
  INSERT INTO items_fts(items_fts, rowid) VALUES('delete', old.rowid);
  INSERT INTO items_fts(rowid, title, title_zh, summary)
    VALUES (new.rowid, new.title, COALESCE(new.title_zh,''), COALESCE(new.original_summary,''));
END;
