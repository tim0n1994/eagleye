-- ============================================================
-- Migration 005: Add X (Twitter) Following source
-- ============================================================
-- The X Following source aggregates latest tweets from a curated
-- list of accounts (configured via X_FOLLOWING_USERS env or
-- ~/.eagleye/x-following.txt). Uses Jina Reader (r.jina.ai) to
-- convert public profile timelines to clean Markdown.
-- ============================================================

INSERT OR IGNORE INTO sources
  (id, slug, label, description, homepage_url, feed_url, connector_type, is_active, label_zh, description_zh, translation_status)
VALUES
  ('s016', 'x-following', 'X Following',
   'Latest tweets from a curated list of X accounts (configured in settings)',
   'https://x.com', NULL, 'x-following', 1,
   'X 关注动态',
   '从你配置的 X 关注账号列表聚合最新推文（在设置中配置）',
   'translated'
);
