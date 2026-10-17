# Eagleye MCP Server（只读数据服务）

Eagleye 附带一个独立的只读 MCP（Model Context Protocol）服务器，供 ChatGPT、Claude、MCP Inspector 等客户端查询生产业务数据。它是一个独立进程，与主服务（server.js, 3019）互不影响。

## 安全模型

- 业务库以 `readonly: true` + `query_only` 打开，进程层面无法写入。
- 所有查询都是服务端预定义的参数化 SELECT（12 个工具，含研究 search/fetch），客户端只能传过滤参数，不能传 SQL。
- `users`、`sessions`、`api_keys`、`verification_codes`、`user_data` 等敏感表永远不会被引用；输出还会按键名二次打码（api_key/token/password 等 → `[REDACTED]`）。
- HTTP 调用写入独立审计库 `mcp-audit.sqlite`（append-only），与业务库物理隔离。新记录只保存参数/错误摘要指纹与长度，并以响应头 `X-Eagleye-Request-Id` 对应审计 request_id；工具错误与协议错误分别记录。JSON-RPC batch 在创建 transport 和执行工具之前以 HTTP 400/-32600 拒绝，并记录一条 `batch_rejected`，每次只允许一个请求。旧审计历史不会被自动改写；stdio 审计不在本次 HTTP 改造范围内。
- 并发上限 2、排队上限 10（超出返回 429）、单响应 256KB 截断，不影响主服务性能。
- 默认只监听 `127.0.0.1`，公网暴露必须由反向代理完成（见下文）。
- 管理开关（见下文）默认开启；服务仅绑定 127.0.0.1 且要求 Bearer token，公网暴露仍必须经反代。

## 管理开关

位置：Eagleye 设置页 → 「MCP 服务」卡片（仅管理员可见）。

- 状态存储在业务库 `user_data` 表，key=`mcp_server_config`，全局作用域。
- 开关关闭时 MCP 进程继续运行但所有 tools/call 返回 "disabled" 错误；轮询间隔 5 秒，切换最多 5 秒生效，无需重启进程。
- 直接改库等效：`INSERT OR REPLACE INTO user_data (key, user_id, value) VALUES ('mcp_server_config', '', '{"enabled":true}')`。

对应管理 API（需管理员登录态）：

```
GET /api/settings/mcp   → { status: "ok", config: { enabled: false } }
PUT /api/settings/mcp   → body { "enabled": true }
```

## 启动

```bash
npm run mcp                 # HTTP 模式，默认 127.0.0.1:3020
npm run mcp -- 3100        # 指定端口
npm run mcp -- --stdio      # 本地 stdio 模式
```

鉴权 token 按优先级读取：环境变量 `EAGLEYE_MCP_TOKEN` → `config/mcp-token` 文件（不存在则自动生成，权限 600）。所有请求需带 `Authorization: Bearer <token>`；`GET /health` 免鉴权。

注意：MCP Streamable HTTP 要求请求头 `Accept: application/json, text/event-stream`，缺失会被协议层以 406 拒绝。

## 客户端接入

### 本地 stdio（Claude Desktop / Inspector 等）

```json
{
  "mcpServers": {
    "eagleye": {
      "command": "node",
      "args": ["/path/to/eagleye/mcp/server.js", "--stdio"]
    }
  }
}
```

### 本地 HTTP（MCP Inspector）

```bash
npm run mcp -- 3020
# Inspector → Transport: Streamable HTTP → URL http://127.0.0.1:3020/mcp
# Authentication: Bearer → 粘贴 token
```

### ChatGPT（云端 connector）

ChatGPT 云端无法访问本机端口，当前已接入的链路是「本机代理 + 命名隧道」三层：

```
ChatGPT 云端
  → https://eagleye-mcp.udify.fun/<secret>/mcp   （Cloudflare 命名隧道，稳定 URL）
  → 127.0.0.1:3021                                （mcp/chatgpt-proxy.js，校验 URL 中的 secret）
  → 127.0.0.1:3020                                （MCP 服务，仅绑定本机）
```

secret 首次启动 proxy 时自动生成到 `config/mcp-tunnel-secret`（600 权限），完整 URL 即凭据：secret 在 URL 路径中，等同于密码，不要发到公开场合。真实 token 不出现在 URL 中，由 proxy 注入 `Authorization` 头后转发，token 不离开服务器。

本地起链路（三个进程，主服务 3019 可选）：

```bash
npm run mcp        # 3020，MCP 服务
npm run mcp:proxy  # 3021，校验 secret 并注入 token
cloudflared tunnel --config ~/.cloudflared/config.yml --no-prechecks run
# ingress 中已配置 eagleye-mcp.udify.fun -> http://127.0.0.1:3021
```

在 ChatGPT → Settings → Apps & Connectors → Advanced settings 打开 Developer mode → Create，填入完整 URL `https://eagleye-mcp.udify.fun/<secret>/mcp`，认证选 No authentication（secret 已在 URL 中）。

替代方案（其他反代，如 nginx）：

```nginx
location /mcp/ {
    proxy_pass http://127.0.0.1:3020/mcp;
    proxy_set_header Authorization "Bearer <token-from-config/mcp-token>";
    proxy_http_version 1.1;
}
```

在 ChatGPT → Settings → Connectors → Create 中填入代理 URL。建议在代理层再加 IP 允许名单或 Cloudflare Access；MCP 服务本身绑定 127.0.0.1，不会直接暴露。

## 工具清单（12 个，全部只读）

`system_overview`、`list_sources`、`search_items`、`get_item`、`list_digests`、`get_digest`、`search_topics`、`query_entities`、`llm_usage_stats`、`job_status`。参数与返回结构见 `mcp/tools.js`，实现见 `mcp/queries.js`。

另有研究兼容工具 `search(query)` 和 `fetch(id)`，复用现有只读文章查询、管理员开关、鉴权和独立审计。所有工具声明 `readOnlyHint: true`，两个研究工具额外声明 outputSchema，并同时返回相同数据的 `structuredContent` 与 JSON 文本 content。

- `search`：query 为 1–200 字符，按现有 FTS 搜索标题/摘要；最多返回 20 条 `{id, title, url}`。id 格式为 `item:<文章ID>`，只允许字母、数字、下划线和连字符。返回 `{results: []}` 表示没有可引用结果。
- `fetch`：只接收上述文章 id 及 `system:overview` / `system:llm-usage` 两个固定 id，返回 `{id,title,text,url,metadata}`；不会下载 URL、打开任意文件或接受调用方 SQL。text 至多 12,000 字符，其中文章原文摘录至多 2,000 字符，AI 摘要明确标注可能有误。
- URL 使用已有 canonical_url，仅保留已知来源的身份参数（HN `/item?id=<数字>`、YouTube `/watch?v=<视频ID>`），去除其他查询参数和片段，拒绝凭据、localhost/IP 地址、连接器路径及疑似不透明密钥路径。不合格 URL 对应文章不会出现在研究结果中；直接 fetch 同样拒绝。其他依赖查询参数定位的来源需补充经过验证的身份参数规则。
- metadata 包含 `generated_at`、`source_fetched_at`、`summary_created_at`、`mutable: true` 和 `excerpt_only: true`。稳定 id 指向可变的当前记录，并非不可变快照；需要复现实验时应由调用方保存整份结果及版本。
- 研究文本额外过滤可识别的 Bearer/API key 等内联凭据，但这不能代替入库前的数据分类与脱敏。现有 curated 工具保持原返回格式。
- 产品证据：中英文系统/产品/健康/指标等关键词返回 `system:overview` 与 `system:llm-usage`；模型/用量/成本/延迟等词返回用量文档。它们仅复用 `systemOverview()` / `llmUsageStats({days:7})`，不读取私有配置。用量最多返回 30 个聚合组并说明总组数，token 数不等于金额。所有文章与系统搜索结果合计不超过 20 条。
- 系统文档 URL 指向实际产品 `/settings` 页面（主站来源：`docs/ops-runbook.zh.md`；路由来源：`js/modules/app-main.js`）。它不是公开的不可变快照接口，访问可能需要登录；返回的 `citation_kind: product_page_not_snapshot` 明确这一点。系统概览使用现有最新抓取水位；用量接口没有精确最新事件时间，文档明确未知，不拿生成时间冒充数据新鲜度。
- canonical_url 拒绝 MCP 服务主机标签、`/mcp` 等完整敏感路径段和疑似密钥路径段，保留普通长文章 slug 及 `api-key-management` 等文章标题；仍可能保守排除合法的不透明长 ID。
- HTTP 协议测试通过不代表 ChatGPT Deep Research 已完成连接器验收。

## 排障

| 现象 | 原因 |
| --- | --- |
| 401 Unauthorized | 缺少或错误的 Bearer token |
| 406 Not Acceptable | 请求缺 `Accept: application/json, text/event-stream` 头 |
| 429 Server busy | 并发超过 2 且队列超过 10 |
| tools/call 返回 "disabled" | 管理开关关闭，等待 5 秒轮询或到设置页开启 |
| "Business database not found" | `EAGLEYE_DB_PATH` 未指向 eagleye.db，且 cwd 不在项目根 |
