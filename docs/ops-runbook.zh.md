# Eagleye 运维手册与排错经验

更新日期：2026-07-02

本文档汇总了 Eagleye 在真实运行中遇到的问题、根因分析与修复方案，供后续排错参考。每条都来自实际 incident，附验证过的修复手段。

> **一句话总结**：流水线里所有 LLM 失败，根因几乎都是「**并发太高打爆智谱限流**」。解法是双模型分离 + 限流退避。2026-07-02 实测：6 路并发 glm-4.5-air，全流水线 96 条 enrich failed=1、200 条 translate failed=2，基本零失败。

---

## 0. 排错决策树（先看这个）

流水线某步骤 failed 时，按此顺序快速定位：

```
1. 看错误码
   ├─ "LLM returned empty response"  → 老笼统错误，看 server.log 里真实 HTTP 码
   ├─ HTTP 404                       → base_url 缺 /v1，或端点路径错（见 §2.1）
   ├─ HTTP 429 / code 1302           → 账户级限流（请求太频繁）→ 降并发（见 §2.2/§2.3）
   ├─ HTTP 529 / code 1305           → 模型过载 → 换 glm-4.5-air 或长退避重试
   └─ HTTP 400                       → 请求格式问题（如思考参数注入到不支持的模型）

2. 看是哪个步骤
   ├─ enrich/translate failed        → 应走 glm-4.5-air，检查 ENRICH_LLM_MODEL + 并发
   ├─ 概念图谱/简报 failed           → 走 glm-5.2，可能过载，检查退避重试次数
   └─ ITEM RESEARCH 批量 429         → signals.js 的 autoResearch 限流（见 §2.3）

3. 快速验证
   ├─ curl http://127.0.0.1:3019/api/settings/llm/test     # 主模型 (glm-5.2) 连通性
   ├─ grep ENRICH_LLM_MODEL .env                           # enrich 模型配置
   └─ tail server.log | grep -aE "429|529|404|empty"       # 真实错误码
```

---

## 1. LLM 调用链路

### 1.1 架构：双模型分离

```
eagleye app
├── enrich（摘要/标签/实体）+ translate（中文卡片回填）  ← 大批量任务
│   └── getEnrichProvider() → glm-4.5-air（轻量、稳定、不过载）
├── 概念图谱 / 每日简报 / 深度研究                         ← 低频高价值任务
│   └── getProvider() → glm-5.2（更强，但间歇性过载）
└── 两者共享同一端点 + key，仅 model 字段不同
    └── 经 ccr-dev (127.0.0.1:3458) Anthropic 代理 → 智谱 open.bigmodel.cn
```

**配置位置**：
- 主模型：runtime config（DB `user_data.llm_config`）→ `glm-5.2`
- Enrich 模型：`.env` 的 `ENRICH_LLM_MODEL=glm-4.5-air`
- 端点：runtime config 的 `base_url` 必须含 `/v1`（如 `http://127.0.0.1:3458/v1`）

**为什么分离**：enrich 每次跑 1600+ 条，glm-5.2 大批量调用会触发模型过载（529）。分到 glm-4.5-air 后，glm-5.2 只处理低频高价值任务（概念图谱/简报/研究），双方都不易过载。

### 1.2 智谱 API 错误码速查

| HTTP | code | 含义 | 应对 |
|------|------|------|------|
| **429** | 1302 | 账户级速率限制（请求太频繁） | 降低并发、请求间隔 |
| **529** | 1305 | 模型过载（当前访问量过大） | 长退避重试（10-30s） |
| **400** | 1301 | 内容安全过滤（敏感内容） | 不可恢复，跳过该 item |
| **404** | — | base_url 缺 `/v1`，或端点路径错误 | 检查 `base_url` 配置 |

### 1.3 重试/退避策略（已实现）

| 调用点 | 重试次数 | 529/429 退避 | 普通错误退避 |
|--------|---------|-------------|------------|
| enrich batch | 3 次 | 10s/20s/30s | 2s/4s |
| enrich 单条 fallback | 3 次 | 10s/20s/30s | 2s/4s |
| signal 分类器 | 3 次 | 8s/16s/24s | 2s/4s |
| 每日简报 | 5 次 | 10s/20s/30s/40s | 2s/4s/6s/8s |
| 深度研究 | 4 次 | 8s/16s/24s | 2s/4s/6s |

关键代码：`_llmBackoff()` / `_isOverloadError()` 在 `llm.js` 中共享。

---

## 2. 常见故障与修复

### 2.1 "LLM returned empty response"

**症状**：流水线某步骤（概念图谱/简报/enrich）失败，错误信息是笼统的 "empty response"。

**根因**：`ClaudeProvider._post()` 原来不检查 HTTP 状态码，非 2xx 的错误 body 被当正常返回 → JSON 解析失败 → 返回 `null` → 上层报 "empty response"。

**已修复**：`_post()` 现在对非 2xx 抛出带 HTTP 状态码和 body 片段的错误（如 `LLM HTTP 529: ...`），真实错误能冒泡到调用方。

**排错步骤**：
1. 查 `server.log` 里 `❌` / `⚠` 开头的行，看真实 HTTP 错误
2. 用 `curl http://127.0.0.1:3019/api/settings/llm/test` 快速测 LLM 连通性
3. 如果是 404 → 检查 `base_url` 是否含 `/v1`
4. 如果是 529 → glm-5.2 过载，等几分钟或切 glm-4.5-air
5. 如果是 429 → 请求太频繁，检查并发数

### 2.2 Enrich 大面积 failed（50%+）

**根因 A — 并发太高**：
- 原配置 `ENRICH_LLM_BATCH_CONCURRENCY=16`（16 路并发）
- 实测拐点：8 路 = 0% 429，12 路 = 8%，16 路 = 19%
- **已修复**：默认降到 8

**根因 B — 模型过载（529）**：
- glm-5.2 间歇性过载，不是代码问题
- **已修复**：enrich 分到 glm-4.5-air（不过载）+ 529 长退避

**根因 C — batch 失败静默**：
- 原 `generateItemSummariesBatch` 失败返回 `[]` 无日志
- **已修复**：失败打印真实错误 + 重试 3 次

**调优参数**（`.env`）：
```
ENRICH_LLM_BATCH_CONCURRENCY=6    # 并发 worker 数（8=激进，6=稳定，4=极端保守）
ENRICH_LLM_BATCH_ITEMS=20         # 每批 item 数
ENRICH_LLM_MODEL=glm-4.5-air      # enrich 专用模型
TRANSLATE_LLM_BATCH_WORKERS=6     # translate 并发（同 enrich 策略）
```

> **2026-07-02 实测基准**（6 路并发 glm-4.5-air）：
> - enrich: 96 条 → failed=1（1%）
> - translate: 200 条 → failed=2（1%）
> - 全流水线 0 失败步骤，耗时 1944s
> - 8 路并发时 glm-4.5-air 也 0 失败，但 6 路更保险（给智谱更多喘息空间）

### 2.2b 中文卡片回填（translate）大批量 failed

**根因**：与 enrich 相同——translate 用 `getProvider()`（glm-5.2）+ 8 路并发 batch，紧跟 enrich 之后跑，glm-5.2 尚未恢复 → 429 限流。

**已修复**（与 enrich 同策略）：
- 4 处 `getProvider()` 全改 `getEnrichProvider()` → 走 glm-4.5-air
- batch 重试 2→3 次 + 529/429 长退避
- 单条 fallback 重试 2→3 次 + 529/429 长退避

**核心规则**：所有大批量、对质量要求中等的任务（enrich、translate）都走 `getEnrichProvider()`（glm-4.5-air）。只有概念图谱、每日简报、深度研究等低频高价值任务才用 `getProvider()`（glm-5.2）。

### 2.3 ITEM RESEARCH 批量 429

**根因**：`scoreSignals(autoResearch:true)` 对所有高 alpha items **同时** `runJob(ITEM_RESEARCH)`，N 个 job 瞬间并发 → 智谱账户级限流 429。

**已修复**：
- `signals.js`：每个 ITEM_RESEARCH 之间隔 2s
- `research.js`：单个 research 加 4 次重试 + 529/429 长退避

### 2.4 ccr-dev 端口被 Anthropic 代理占用

**背景**：ccr-dev（`~/.claude-code-router/ccr-menu.py --dev`）曾从 OpenAI 代理重构为 Anthropic 代理（只认 `/v1/messages`，给 Claude Code 用）。eagleye 是 OpenAI/Anthropic 客户端，需要确认走哪个协议。

**当前配置**：eagleye 走 ccr-dev 的 **Anthropic 协议**（`provider: 'claude'`, `base_url: http://127.0.0.1:3458/v1`），`ClaudeProvider` 发 `/v1/messages` 请求。

**注意**：ccr-dev 的 OpenAI 代理（`OpenAIDevProxy`）只在 `mode_run`（启动其它 OpenAI 客户端）时用，不在 `--dev` 模式。

---

## 3. 连接器故障

连接器健康度面板（设置页）显示 🔴 = 最近 7 天 `digest_date` 下的 items 为 0。

### 3.1 App Store Trend（top-grossing 404）

**根因**：Apple 下线了 `top-grossing` chart type，RSS API 返回 404。
**修复**：改用 `top-paid`（`server/connectors/appstore.js`）。
**验证**：`curl -s -o /dev/null -w "%{http_code}" "https://rss.marketingtools.apple.com/api/v2/us/apps/top-paid/10/apps.json"`

### 3.2 Product Hunt（Cloudflare 反爬）

**根因**：Cloudflare 对 EagleyeBot UA 和无头请求返回 403（JS challenge）。
**修复**：改用官方 Atom feed（`/feed`）+ 浏览器 UA（`server/connectors/producthunt.js`）。

### 3.3 Startup Archive（Cloudflare + TLS 指纹 + 页面结构变更）

**根因**（三重）：
1. UA 被拦 → 改浏览器 UA
2. **TLS 指纹（JA3）被拦** → node 的 TLS 握手被 Cloudflare 识别为 bot，curl 不会 → 降级到 curl 子进程
3. 页面从纯文本改为 React SSR（`<time>` + `<h2>`）→ 重写解析正则

**修复**：`server/connectors/startup-archive.js` 的 `fetchStartupArchiveHtml()` 先试 node fetchURL，403 时降级到 curl 子进程。

### 3.4 通用连接器排错

```bash
# 单独触发某连接器抓取
curl -X POST "http://127.0.0.1:3019/api/jobs/fetch-source?slug=<source-slug>"

# 直接测试连接器代码
node -e "
require('./server/db/connection').getDB();
const { XxxConnector } = require('./server/connectors/xxx');
new XxxConnector().fetch().then(items => console.log(items.length, 'items'));
"
```

常见模式：`fetchURL` 的默认 UA `EagleyeBot/1.0` 会被 Cloudflare 拦。需要浏览器 UA 的连接器，传 `{ headers: BROWSER_HEADERS }` 给 `fetchURL`。

---

## 4. 外网访问（Cloudflare Tunnel）

### 4.1 架构

```
eagleye.udify.fun → Cloudflare Edge → cloudflared tunnel (本机) → 127.0.0.1:3019 (eagleye)
```

- cloudflared 配置：`~/.cloudflared/config.yml`
- LaunchAgent（开机自启+崩溃重启）：`~/Library/LaunchAgents/com.cloudflare.cloudflared-eagleye.plist`
- 日志：`~/.cloudflared/logs/cloudflared.err.log`

### 4.2 隧道 530 错误（Clash TUN 劫持）

**根因**：Clash Verge 的 TUN 模式用 `0/1 + 128/1` 覆盖路由劫持全部流量到 `utun1024`，包括 cloudflared 连 Cloudflare 边缘的隧道流量 → TLS 握手被掐断（EOF）→ 530。

**规则层无法修复**：Clash Verge 的订阅脚本增强会过滤掉 `PROCESS-NAME` 规则，`PROCESS-NAME,cloudflared,DIRECT` 加载不进运行时。

**已修复**（路由层）：给 Cloudflare 边缘网段 `198.41.0.0/16` 加静态路由走真实网卡。

```bash
# 手动添加（换网络后需重跑）
sudo bash /Users/chillbit/Proj/eagleye/scripts/cloudflared-route-install.sh

# 或直接
sudo route -n add -net 198.41.0.0/16 <物理网关>
```

**LaunchDaemon 守护**（每 60s 自动检查补回路由）：
```
/Library/LaunchDaemons/com.eagleye.cloudflared-route.plist
```

### 4.3 IPv6 边缘 TLS EOF

**根因**：本机无真实 IPv6 通路（en0 只有 link-local），cloudflared 尝试 IPv6 边缘必然失败。
**修复**：cloudflared 配置加 `edge-ip-version: "4"`（强制只用 IPv4 边缘）。
**位置**：`~/.cloudflared/config.yml`（已持久化）。

### 4.4 验证隧道

```bash
# /ready 状态
curl http://127.0.0.1:20241/ready

# 外网域名
curl -o /dev/null -w "%{http_code}" https://eagleye.udify.fun/

# cloudflared 日志
tail ~/.cloudflared/logs/cloudflared.err.log
```

---

## 5. 前端排错

### 5.1 Papers 页面 authors 报错

**症状**：`paper.authors?.[0]?.split is not a function`
**根因**：`paper.authors` 有两种结构——arXiv 是字符串数组 `["Name"]`，hugging-face 是对象数组 `[{_id, name}]`。代码只兼容了字符串。
**修复**：`js/modules/pages.js` 的 `renderPapers` 内新增 `normalizeAuthors()` 归一化函数，4 处使用点全部统一。

---

## 6. 运维常用命令

```bash
# 重启前后端（server.js 同时托管前端静态文件）
pkill -f "node server.js 3019"; sleep 2
nohup node server.js 3019 >> server.log 2>&1 & echo $! > server.pid

# 测 LLM 连通性
curl -X POST http://127.0.0.1:3019/api/settings/llm/test

# 查当前 provider 配置
node -e "require('dotenv').config(); require('./server/db/connection').getDB(); console.log(require('./server/services/llm-provider').getLLMConfig())"

# 单独跑概念图谱
node -e "require('dotenv').config(); require('./server/db/connection').getDB(); require('./server/services/tag-hierarchy').buildTagHierarchy().then(c=>console.log(c))"

# 单独跑 enrich（N 条）
node -e "require('dotenv').config(); require('./server/db/connection').getDB(); require('./server/services/llm').enrichItems(80,{}).then(r=>console.log(r))"

# 重启 cloudflared
launchctl kickstart -k gui/$(id -u)/com.cloudflare.cloudflared-eagleye

# ccr-dev 状态
curl http://127.0.0.1:3458/v1/ccr/status
```

---

## 7. 关键配置速查

| 配置项 | 位置 | 当前值 | 说明 |
|--------|------|--------|------|
| 主 LLM 模型 | DB `user_data.llm_config` | `glm-5.2` | 概念图谱/简报/研究 |
| Enrich/Translate 模型 | `.env` ENRICH_LLM_MODEL | `glm-4.5-air` | 摘要/标签/实体/中文卡片 |
| LLM 端点 | DB `user_data.llm_config` | `http://127.0.0.1:3458/v1` | ccr-dev Anthropic 代理（必须含 `/v1`） |
| Enrich 并发 | `.env` ENRICH_LLM_BATCH_CONCURRENCY | `6` | 实测 6=稳定 / 8=激进 |
| Translate 并发 | `.env` TRANSLATE_LLM_BATCH_WORKERS | `6` | 同 enrich 策略 |
| eagleye 端口 | `server.js 3019` | `3019` | 前端+API |
| cloudflared 端口 | `~/.cloudflared/config.yml` | `3019 → eagleye.udify.fun` | 隧道 |
| cloudflared metrics | 自分配 | `127.0.0.1:20241` | /ready 端点 |
