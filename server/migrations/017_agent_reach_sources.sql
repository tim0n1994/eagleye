-- Eagleye Schema Migration 017: agent-reach sources (Reddit + XiaoHongShu)
--
-- Adds two new information sources backed by the agent-reach opencli bridge.
-- The X (Twitter) Following source (s016) is reused as-is; its connector was
-- rewritten to prefer agent-reach twitter-cli with a Jina Reader fallback, so
-- no row change is needed there.
--
-- Note: migration FILE numbers and source ID numbers are independent sequences.
-- Source IDs s018/s019 here; the file is named 017 (next free migration slot).
-- Uses INSERT OR IGNORE so re-runs are idempotent (slug is UNIQUE).

INSERT OR IGNORE INTO sources
  (id, slug, label, description, homepage_url, feed_url, connector_type,
   is_active, label_zh, description_zh, translation_status)
VALUES
  ('s018', 'reddit', 'Reddit',
   'Hot posts from curated subreddits via agent-reach (opencli)',
   'https://reddit.com', NULL, 'reddit', 1,
   'Reddit', '精选 subreddit 热门帖子（agent-reach opencli 后端）', 'translated'),
  ('s019', 'xiaohongshu', 'XiaoHongShu',
   'Chinese AI notes from XiaoHongShu via agent-reach (opencli)',
   'https://xiaohongshu.com', NULL, 'xiaohongshu', 1,
   '小红书', '小红书 AI 落地场景笔记（agent-reach opencli 后端）', 'translated');
