-- User-requested restoration via the publisher's public RSS, not HTML scraping.
UPDATE sources SET feed_url='https://rss.beehiiv.com/feeds/67Ef5Nsjmw.xml',
  label='Startup Archive', label_zh='Startup Archive · 创始人经验',
  description='Publisher RSS of evergreen founder insights; preserves original publication dates, not a breaking-news feed',
  description_zh='官方 RSS 的创始人经验档案；保留真实发布日期，不作为当天新闻',
  connector_type='rss', is_active=1, updated_at=datetime('now')
WHERE slug='startup-archive';

-- Prepare foreign-issuer current reports without enabling an unconfigured collector.
UPDATE sources SET label='SEC · Company current reports', label_zh='SEC · 公司重大事项公告',
 description='Official SEC 8-K, 6-K and amended current reports; requires an identified User-Agent',
 description_zh='SEC 官方 8-K、6-K 及修订公告；需要应用名称与联系邮箱', updated_at=datetime('now')
WHERE slug='physical-ai-sec-8k';
