# Startup Archive、小红书和 SEC 接入调查

2026-11-09。复用现有来源 Connector；不增加通用浏览器轮询或模型调用。

## Startup Archive

官方首页公开的 RSS 为 https://rss.beehiiv.com/feeds/67Ef5Nsjmw.xml 。用 agent-browser 打开首页并确认 RSS 链接，订阅实际返回 20 个独立文章 URL。调查时最新文章发布日期为 2026-03-31，因此作为创始人经验档案，不称为实时创业新闻。

旧实现依赖首页正则、同步 curl，且所有条目使用相同首页 URL，会被 URL 去重合并。现在复用 RSSConnector 的条件请求、超时、取消与去重，单轮最多 20 条，保留原文日期；对这一历史档案不使用 36 小时新闻过滤。迁移 054 恢复启用并更新 feed_url。

## 小红书

推荐优先复用 https://github.com/xpzouying/xiaohongshu-mcp 的登录状态、搜索和详情读取能力。Eagleye 已有 REST adapter：先检查 login/status，再调用 feeds/search。MediaCrawler（https://github.com/NanmiCoder/MediaCrawler）适合更重的多平台采集，本次不额外部署。

TP 上专用服务已运行，但登录检查为 false，二维码接口两次超时。独立浏览器访问 xiaohongshu.com/explore 会重定向到 rednote.com；这是当前出口实际观察到的页面形态，不能假设旧的小红书登录选择器仍适用。必须先完成账号登录与一次真实搜索，才能恢复定时启用。此次不更改账号关注、不发布、评论或点赞。

## SEC

优先官方 https://data.sec.gov/submissions/CIK{cik}.json；保留现有轻量 Node 接口，不为下载 JSON 增加 Python 常驻服务。开源参考：https://github.com/dgunning/edgartools 适合未来解析财报/公告正文，https://github.com/jadchaar/sec-edgar-downloader 适合批量归档。

原连接器已验证 User-Agent 必填；线上未配置 SEC_USER_AGENT，需用户提供真实联系邮箱后在私有环境文件设置应用名称与邮箱，再验证接口可达性。未带识别身份的探测返回 HTTP 403，不能据此断言配置邮箱一定能解决出口限制。不得把缺配置状态伪装成采集成功。

连接器补充 6-K 和修订表单，避免漏掉外国发行人；时间窗使用 7 天重叠覆盖周末，使用实际申报文档 URL 去重。来源仍保持原来的停用状态，等待配置并验证成功后启用。

## agent-browser

TP 已有官方 agent-browser 0.41.2、Playwright 与 Chrome for Testing。本次补齐 $HOME/.local/bin/agent-browser 命令，复用 tp-browser 的固定版本与五分钟空闲清理，没有再装第二套浏览器。

使用独立会话检查页面。此 TP 的 Chrome 在默认 sandbox 启动时报 No usable sandbox；本次仅对检查会话显式使用 --args --no-sandbox，未修改系统 sandbox 设置或全局浏览器参数。

适合：检查 JavaScript 页面、定位公开 RSS/API、核对登录失效和页面变化。稳定 API/RSS 仍直接采集，避免每次定时任务启动浏览器。不会自动解决登录、验证码或站点访问限制。
