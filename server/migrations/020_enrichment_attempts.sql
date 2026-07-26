-- 020_enrichment_attempts.sql — Track enrichment attempts to break the failure loop
--
-- Problem: items that fail LLM enrichment (empty/unparseable response) never get
-- an ai_summaries row, so `WHERE id NOT IN (SELECT item_id FROM ai_summaries)`
-- re-selects them on EVERY run. 881 items were failing silently per pipeline run
-- and retrying forever, burning LLM budget without progress.
--
-- Fix: track attempts on information_items. Items that fail MAX_ENRICH_ATTEMPTS
-- times are skipped by the selection query. A forced re-enrich (--force or
-- clearing the counter) is still possible for prompt/model upgrades.

ALTER TABLE information_items ADD COLUMN enrichment_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE information_items ADD COLUMN last_enrich_attempt TEXT;

-- Covering index for the enrichment selection query:
-- WHERE enrichment_attempts < N AND id NOT IN (...) ORDER BY priority, score
CREATE INDEX IF NOT EXISTS idx_items_enrich_attempts ON information_items (enrichment_attempts);
