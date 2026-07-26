-- 019_seen_items.sql — Personal filtering foundation: read/seen state tracking
--
-- A personal information filter must know what the user has already consumed,
-- otherwise the feed keeps resurfacing the same items. This table records the
-- "seen" (opened/viewed) state per item so the For-You feed can surface
-- unseen-first and damp already-read items.
--
-- Single-user system (user_id='anonymous'), but the column is kept for forward
-- compatibility. Composite PK gives natural dedup (an item is either seen or
-- not — re-marking is a no-op via INSERT OR IGNORE).

CREATE TABLE IF NOT EXISTS seen_items (
  user_id    TEXT NOT NULL DEFAULT 'anonymous',
  item_id    TEXT NOT NULL,
  seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, item_id)
);

-- Look up "has this item been seen" and "unseen count for a window" fast.
CREATE INDEX IF NOT EXISTS idx_seen_items_user_seen_at ON seen_items (user_id, seen_at);
