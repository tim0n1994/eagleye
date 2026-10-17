-- Eagleye Schema Migration 037: Source health fields (R0-09)
--
-- Separates "active" (user enablement, sources.is_active) from "healthy"
-- (observed behavior, sources.health_status). Additive only: five new columns,
-- no rewrites, safe to run online via the standard migration runner.
--
-- Backfill is idempotent (COALESCE guards): re-running these UPDATEs on an
-- already-migrated database is a no-op. last_fetched_at is written by
-- connectors/base.js after every completed fetch pass, so it is the best
-- available proxy for both last attempt and last success until the scheduler
-- starts recording attempts/outcomes explicitly (R0 scheduler integration).

ALTER TABLE sources ADD COLUMN last_attempt_at TEXT;
ALTER TABLE sources ADD COLUMN last_success_at TEXT;
ALTER TABLE sources ADD COLUMN last_new_content_at TEXT;
ALTER TABLE sources ADD COLUMN last_error_class TEXT;
ALTER TABLE sources ADD COLUMN health_status TEXT NOT NULL DEFAULT 'unknown';

-- Attempt/success backfill from the existing fetch marker.
UPDATE sources SET
  last_attempt_at = COALESCE(last_attempt_at, last_fetched_at),
  last_success_at = COALESCE(last_success_at, last_fetched_at);

-- Last time this source actually produced content (any ingested item).
UPDATE sources SET
  last_new_content_at = COALESCE(
    last_new_content_at,
    (SELECT MAX(i.fetched_at) FROM information_items i WHERE i.source_id = sources.id)
  );

-- Coarse initial classification mirroring server/services/source-health.js
-- defaults (healthy <= 48h, stale <= 14d, else failing). The JS evaluator
-- (recomputeSourceHealth) is the authority afterwards; this only avoids every
-- row reading 'unknown' immediately after the migration.
UPDATE sources SET
  health_status = CASE
    WHEN COALESCE(last_new_content_at, last_success_at, last_attempt_at) IS NULL THEN 'unknown'
    WHEN COALESCE(last_new_content_at, last_success_at) >= datetime('now', '-2 days') THEN 'healthy'
    WHEN COALESCE(last_new_content_at, last_success_at) >= datetime('now', '-14 days') THEN 'stale'
    ELSE 'failing'
  END;
