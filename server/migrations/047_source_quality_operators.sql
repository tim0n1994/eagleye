-- Align source health and fetching with the deployed ThinkPad lanes.

-- The 2-hour X Following timer is the actual owner of this source. Explicit
-- cadence keeps health evaluation from judging it against the generic daily
-- pipeline and marking a healthy incremental lane as stale.
UPDATE sources
   SET expected_interval_hours = 2
 WHERE slug = 'x-following';

-- Startup Archive returned genuine empty rounds for 15 consecutive scheduled
-- fetches, with the newest item predating 2026-10-19. Soft-disable the source
-- until its upstream publishes again; retain the connector and history.
UPDATE sources
   SET is_active = 0
 WHERE slug = 'startup-archive'
   AND is_active <> 0;
