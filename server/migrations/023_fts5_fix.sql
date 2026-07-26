-- 023_fts5_fix.sql — Rebuild FTS5 as a contentless table to fix the UPDATE breakage
--
-- Bug: migration 022 created a standalone FTS5 table (no content= option) but
-- attached AFTER UPDATE/DELETE triggers that use the external-content 'delete'
-- command syntax. On a standalone FTS5 table, the 'delete' command requires the
-- full original row content (not just rowid), so every UPDATE on information_items
-- raised "SQL logic error" — blocking ALL enrichment, scoring, and writes.
--
-- Fix: drop the broken triggers + table, rebuild as a CONTENTLESS FTS5 table
-- (content='') which supports rowid-only delete. Contentless FTS can't return
-- column text (only MATCH + rank), but /api/search joins back to information_items
-- for the display columns, so contentless is exactly right here — smaller index,
-- no parent-table breakage.

DROP TRIGGER IF EXISTS items_fts_ai;
DROP TRIGGER IF EXISTS items_fts_ad;
DROP TRIGGER IF EXISTS items_fts_au;
DROP TABLE IF EXISTS items_fts;

-- Contentless FTS5: stores only the index, not the source text. Matches and
-- ranking work; column values are retrieved by joining rowid → information_items.
CREATE VIRTUAL TABLE items_fts USING fts5(
  title, title_zh, summary,
  content='',
  tokenize='trigram'
);

-- Backfill from existing data.
INSERT INTO items_fts(rowid, title, title_zh, summary)
  SELECT i.rowid, i.title, COALESCE(i.title_zh, ''),
         COALESCE(a.one_liner_zh,'') || ' ' || COALESCE(a.short_summary_zh,'')
  FROM information_items i
  LEFT JOIN ai_summaries a ON a.item_id = i.id;

-- Contentless triggers: rowid-only delete is valid on contentless tables.
CREATE TRIGGER items_fts_ai AFTER INSERT ON information_items BEGIN
  INSERT INTO items_fts(rowid, title, title_zh, summary)
    VALUES (new.rowid, new.title, COALESCE(new.title_zh,''), COALESCE(new.original_summary,''));
END;
CREATE TRIGGER items_fts_ad AFTER DELETE ON information_items BEGIN
  INSERT INTO items_fts(items_fts, rowid) VALUES('delete', old.rowid);
END;
CREATE TRIGGER items_fts_au AFTER UPDATE ON information_items BEGIN
  INSERT INTO items_fts(items_fts, rowid) VALUES('delete', old.rowid);
  INSERT INTO items_fts(rowid, title, title_zh, summary)
    VALUES (new.rowid, new.title, COALESCE(new.title_zh,''), COALESCE(new.original_summary,''));
END;
