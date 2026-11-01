-- Disable physical-ai-cn-photonics source.
-- Reason: all 8 original RSS feeds confirmed dead (CTO 2026-10-23 02:33
-- dual-route probe, 8/8 dead), CN_FEEDS was emptied to [], and the connector
-- generated 10 fake placeholder company items every round. Soft-disable via
-- is_active = 0 so fetchAllSources skips it; connector code remains for
-- manual re-enable when viable replacement feeds are found. Idempotent:
-- re-running changes nothing once 0.
UPDATE sources SET is_active = 0 WHERE slug = 'physical-ai-cn-photonics' AND is_active <> 0;
