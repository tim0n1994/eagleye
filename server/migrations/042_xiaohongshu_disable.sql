-- Round 1 · D5: disable the xiaohongshu source.
-- Reason: the collection backend login state expired (argus-eagleye-xhs on
-- 127.0.0.1:18060 no longer authenticated), so every scheduled crawl fails.
-- The connector code stays registered (manual fetch is still possible);
-- fetchAllSources and /api/sources both filter is_active = 1. Soft-disable
-- double-insurance: config/xiaohongshu-keywords.txt keywords are commented
-- out with a disable note. Idempotent: re-running changes nothing once 0.
UPDATE sources SET is_active = 0 WHERE slug = 'xiaohongshu' AND is_active <> 0;
