# ROADMAP — Eagleye P0 热修线（eagleye-p0-wt，自 main ec93cec）

> 本文件是 P0 热修 worktree 的本地 ROADMAP（2026-10-23 采集断流事故）。
> 只记录本线的降级/残留风险与后续动作，不合并回 CTO 共享版。

## 2026-10-23 P0 采集断流（CTO 02:10 巡检：10 有数据 / 4 空 / 3 ERRORED，门槛 16/0）

### reddit — DEGRADED（需 JC 人工动作，本轮不可自动修）
- 根因：rdt credential.json（cookies+modhash，source=browser:subprocess）
  saved_at=10-16，reddit cookie 过期（与 alt X 同批时间窗口的会话清扫）；
  connector 走 server 后端（AGENT_REACH_RDT_BIN=rdt → rdt-cli python）
  → AUTH_REQUIRED。
- opencli 回退路径核查结论（本轮已核查，不切）：opencli 不读 cookie 文件
  （驱动真实 Chrome 活会话），但本机为无头生产机：无 chrome 进程、
  19825/9222 无监听 → 必 BRIDGE_DOWN；且 agent-reach doctor reddit
  status=warn / active_backend=null → gate isReachReady 直接 false
  （server/services/agent-reach.js:216-227，server/connectors/reddit.js:62-63）。
  无 Chrome 的机器上 opencli 不可行，不做代码切换。
- 恢复动作：JC 在浏览器重新登录 reddit 并导出 cookie（rdt credential.json），
  rdt 路径自动恢复。另注意 reddit 连接器全有全无：4 个 sub 任一失败整源 throw
  （server/connectors/reddit.js:74-76，config/reddit-subreddits.txt）。

### solidot — 追加修复（2026-10-23 03:5x，部署验证轮 RED→GREEN）

- 真实抓取验证（fetch-source job 1f17f4d4）暴露二阶问题：fallback feed 可达、
  8 条窗内条目解析成功，但 canonical_url 全空 → base.saveItems 整批 skip
  （skipped:8 / inserted:0）。
- 根因：feedburner 的 <link> 是 CDATA 包裹，本文件 cdataPropName:'#cdata'
  解析器下成 { '#cdata': url }；rss.js linkOf 只认纯字符串与 @_href（Atom），
  不认元素文本形状 → url 空。
- 修复（P0 线内最小改动）：linkOf 对象分支先取 #cdata/#text 元素文本
  （RSS link 本体），无文本再走 @_href（Atom 不受影响）。
  回归测试：rss-parser-formats.test.js 新增 P1 用例（RED→GREEN，9/9）。

### solidot — 已换 fallback（feedburner），origin 宕机残留风险
- origin www.solidot.org / solidot.org 443/80 全拒（上游故障或 IP 段拒连，
  非我方问题）；官方无可用备用 RSS；8 个 RSSHub 公共实例全 503/超时/封锁
  （/solidot 路由自身依赖已死的 origin）。
- 修复（本轮）：systemd drop-in 20-pipeline.conf 的
  SOLIDOT_RSS_FALLBACK_URL → https://feeds.feedburner.com/solidot
  （rss.js:304-307 现成 fallback 钩子，零代码改动；随下次服务重启生效）。
- 残留风险：feedburner 是 origin 的缓存镜像。若 origin 持续不恢复，
  36h 新鲜窗口滑过（约 2026-10-23 13:10 起）该源将变为健康但空轮，
  直到 origin 恢复才有新内容。观察项：若连续多轮空轮，再评估 deactivate
  或另寻镜像。

### physical-ai-cn-photonics — feed 层上游全灭（占位兜底，待寻替代源）
- 原 8 个 CN_FEEDS 双路由探活 8/8 死（2026-10-23 02:33，明细见
  server/connectors/cn-photonics.js CN_FEEDS 注释）；RSS 层上游全灭，
  直连同样死，非代理问题。
- 本轮已做：config 级移除全部 8 个死 feed（清空后走 CN_COMPANIES 占位
  10 条/轮）+ per-feed 预算保护（B①：单 feed 总成本上限
  min(30s, 源级剩余预算/2)，防单个挂死/拒连 feed 吃穿 180s 源预算）。
- 残留：占位条目非真实新闻。真实中文光子/半导体 RSS 替代源需另寻
  （OFweek 系 RSS 已整体下线，C114/eeworld/laoyaoba/gelonghui 均停），
  寻源不在本轮最小改动内。

### startup-archive — 上游真实枯竭（观察，无需修）
- startuparchive.org 最新条目 2026-03-31，站点与解析正常，连续 6 轮真空
  属真实枯竭。无我方修法；保留低耗（9s/轮）等上游恢复，或后续 deactivate。

## 附：本轮 4 空源答案（非故障）
- solidot（10-22 轮）：feed 可达但 36h 窗口内 0 条（origin 停更）。
- product-hunt / app-store-rank：全量跨日重复，良性去重；10-23 轮已自愈
  （12 条 / 1 条）。
- github-trending digest 计 0 行是条目按仓库活跃日写 digest_date 的口径
  假象，非断流。
