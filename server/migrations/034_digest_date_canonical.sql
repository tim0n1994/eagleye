-- Eagleye Schema Migration 034: Canonical digest dates (R0-02, OBS-02)
--
-- Rewrites legacy compact digest_date values (YYYYMMDD, e.g. 20260801) to the
-- canonical YYYY-MM-DD form so canonical date lookups, lexicographic range
-- queries and substr-based year/month slicing all agree. API boundaries keep
-- accepting the compact form via server/services/date-contract.js
-- (normalizeDigestDate) — that is the explicit compatibility mapping; storage
-- and query paths are unified here.
--
-- Rows whose (source_id, canonical_url, canonical date) would collide with an
-- existing canonical row are dropped first so the rewrite cannot violate
-- UNIQUE(source_id, canonical_url, digest_date); the canonical row wins.
-- Idempotent: the GLOB guard matches only 8-digit compact values.

DELETE FROM information_items
WHERE digest_date GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
  AND EXISTS (
    SELECT 1 FROM information_items canonical
    WHERE canonical.source_id = information_items.source_id
      AND canonical.canonical_url = information_items.canonical_url
      AND canonical.digest_date =
        substr(information_items.digest_date, 1, 4) || '-' ||
        substr(information_items.digest_date, 5, 2) || '-' ||
        substr(information_items.digest_date, 7, 2)
  );

UPDATE information_items
SET digest_date = substr(digest_date, 1, 4) || '-' || substr(digest_date, 5, 2) || '-' || substr(digest_date, 7, 2)
WHERE digest_date GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]';

DELETE FROM daily_digests
WHERE digest_date GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
  AND EXISTS (
    SELECT 1 FROM daily_digests canonical
    WHERE canonical.digest_date =
      substr(daily_digests.digest_date, 1, 4) || '-' ||
      substr(daily_digests.digest_date, 5, 2) || '-' ||
      substr(daily_digests.digest_date, 7, 2)
  );

UPDATE daily_digests
SET digest_date = substr(digest_date, 1, 4) || '-' || substr(digest_date, 5, 2) || '-' || substr(digest_date, 7, 2)
WHERE digest_date GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]';
