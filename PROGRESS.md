# Eagleye → Alpha Radar — 项目进度

更新日期：2026-06-27  
仓库路径：`/Users/user/Proj/eagleye`  

---

## 0. 抓取层重构 — 基于 agent-reach（2026-06-27）

把脆弱/单一的数据抓取层升级为多后端架构，复用 agent-reach（13 平台、多后端路由）的能力。

### 架构：三层

```
config/*.txt (策展列表)        ← 复用 x-following-config 模式
        ↓
server/services/agent-reach.js ← agent-reach Node 桥接器（spawn + doctor 缓存 + 信封归一化）
        ↓
server/connectors/{x-following, reddit, xiaohongshu}.js ← 轻量归一化连接器
        ↓
connectors/index.js (注册表) + sync.js (编排，不动)
```

复杂度集中在桥接器一处，连接器只负责「调哪个命令 + 把字段拍平成 `normalize()` 形状」。参照既有 `kg-worker.js` 的 spawn 范式。

### 变更清单

| 操作 | 文件 | 说明 |
|---|---|---|
| 新建 | [server/services/agent-reach.js](server/services/agent-reach.js) | agent-reach Node 桥接器：`runReach()` spawn twitter/opencli，统一信封（twitter-cli `{ok,data}` ↔ opencli 裸数组），doctor 缓存（10min TTL），`isReachReady()` 早退门 |
| 重写 | [server/connectors/x-following.js](server/connectors/x-following.js) | fetch() 改用 `twitter user-posts`（结构化 metrics/ISO）；保留 Jina Reader 作 fallback；双后端熔断器（twitter 连续失败 N 次→切 Jina） |
| 新建 | [server/connectors/reddit.js](server/connectors/reddit.js) + [server/services/reddit-config.js](server/services/reddit-config.js) | opencli reddit subreddit 热门帖；`config/reddit-subreddits.txt` 策展 |
| 新建 | [server/connectors/xiaohongshu.js](server/connectors/xiaohongshu.js) + [server/services/xiaohongshu-config.js](server/services/xiaohongshu-config.js) | opencli 小红书搜索笔记；保留 xsec_token URL；3s 防验证码 |
| 新建 | [server/migrations/017_agent_reach_sources.sql](server/migrations/017_agent_reach_sources.sql) | s018 reddit / s019 xiaohongshu（`npm start` 自动应用） |
| 改 | [server/connectors/index.js](server/connectors/index.js) | 注册 reddit/xiaohongshu；排序里两者放尾部（不抢 X/HN/GitHub 优先位） |
| 新建 | config/reddit-subreddits.txt, config/xiaohongshu-keywords.txt | 默认策展（LocalLLaMA/MachineLearning/singularity/artificial；AI/大模型/AI Agent/具身智能） |

### agent-reach 后端实测 gotcha（已处理）

| 平台 | 后端 | 关键 gotcha | 处理 |
|---|---|---|---|
| Twitter | twitter-cli | `user-posts` 稳定；`search` 404 不稳定；cookie 用 env `TWITTER_AUTH_TOKEN`+`TWITTER_CT0` | 只用 user-posts；cookie 失效→Jina fallback |
| Reddit | opencli | `subreddit` 的赞数字段叫 `upvotes`，`search` 叫 `score`（同名异义）；需 Chrome 登录态 | 读 `upvotes` 兜底 `score`；桥断→返回 `[]` |
| 小红书 | opencli | `likes`/`published_at` 是字符串；读正文需 xsec_token URL；高频触发验证码 | 类型强转；canonical_url 保留 token；只存搜索结果不二次读正文 |

### 运维备注（实测）

- **Twitter 429 限流**：442 个关注账号批量抓取时，twitter-cli 会触发 429，每次重试约 40s（3 次内部重试）。可用 `X_FOLLOWING_CONCURRENCY`（默认 4）降并发、或 `X_FOLLOWING_TWEETS_PER_USER`（默认 10）减少每号拉取量来缓解。cookie 失效会自动切 Jina。
- **opencli 桥依赖桌面 Chrome**：reddit/小红书后端需 Chrome 打开且登录对应站点。Chrome 关闭时连接器返回 `[]` + console.warn，不 crash 全局 `allSettled`。
- **零新增 npm 依赖**：twitter-cli / opencli 都输出 JSON，Node 侧 `child_process.spawn` 解析即可。

---



## 1. 当前快照

| 指标 | 当前值 |
|---|---:|
| 信息源数量 | 17 |
| `information_items` | 7,125 |
| `ai_summaries` | 9,064 |
| `signal_scores` | 132 |
| 信号类型数 | 12 + 1 (uncategorized) |
| 服务地址 | `http://127.0.0.1:3001` |
| LLM 端点 | `http://127.0.0.1:3458/v1` |
| LLM 模型 | `qwen3.5-plus-2026-02-15` |

KG v2 状态：

| 表 | 行数 |
|---|---:|
| `item_features` | 5,605 |
| `kg_tags` | 12,675 |
| `item_tag_assignments` | 57,410 |
| `entity_mentions` | 8,143 |
| `canonical_entities` | 3,435 |
| `dynamic_topics` | 243 |
| `item_topic_assignments` | 8,899 |
| `kg_edges` | 74,452 |

---

## 2. Alpha Radar 第一期 — 信号评分系统（本轮最新）

### 架构概览

```
源抓取 (17 sources, parallel)
  → enrichment (LLM batch, 16 workers)
    → signal scoring (本地计算 + 规则分类 + LLM 分类)
      → WebUI 三栏信号控制台 (/signals)
```

### 2.1 信号类型系统

新增 12 种投研信号类型 + 源特定默认分类：

| # | Slug | 名称 | 检测方式 |
|---|------|------|---------|
| 1 | `origin_signal` | 源头信号 | 关键词 (launch/announcing/发布/宣布) |
| 2 | `new_repo` | 新仓库 | 源检测 (GitHub Trending) + 关键词 |
| 3 | `new_paper` | 新论文 | 源检测 (Hugging Face) + 关键词 |
| 4 | `model_release` | 模型发布 | 关键词 (release/model/gpt/部署) |
| 5 | `benchmark_claim` | 基准声明 | 关键词 (benchmark/sota/超越) |
| 6 | `architecture_shift` | 架构迁移 | 关键词 (architecture/范式) |
| 7 | `narrative_shift` | 叙事迁移 | 关键词 (dead/no longer/趋势) |
| 8 | `velocity_spike` | 加速信号 | 关键词 (trending/viral) |
| 9 | `novel_combination` | 新组合 | 关键词 (combined/+ /融合) |
| 10 | `contradiction` | 矛盾信号 | 关键词 (not true/并不/误解) |
| 11 | `funding_signal` | 融资信号 | 关键词 (funding/融资/亿美元) |
| 12 | `hiring_signal` | 招聘信号 | 关键词 (hiring/招聘/招人) |

### 2.2 四维评分模型

每个 item 计算：

```
novelty_score     = 1 - min(days_since_published, 90) / 90
velocity_score    = min(same_day_items / 15, 1)
cross_source_score = min(today_source_count / 10, 1)
source_quality_score = 0.5 * (1 + early_signal_rate - noise_rate)

alpha_score = 0.25 * thesis_match + 0.20 * novelty + 0.15 * actionability
            + 0.15 * cross_source + 0.10 * source_quality + 0.10 * velocity
            + 0.05 * (novelty > 0.8 ? 1 : 0)

final_alpha = alpha_score - consensus_penalty
```

### 2.3 数据库变更

新增 migration `009_alpha_radar.sql`：

- `signal_types` — 12+1 种信号类型定义
- `signal_scores` — 每条 item 的完整评分记录（带索引）
- `entity_momentum` — 实体 24h/7d/30d 趋势追踪
- `source_profiles` — 账号动态质量画像

### 2.4 WebUI 信号控制台

- **路由**: `/signals` (替代旧 `/topics`，旧路由兼容重定向)
- **布局**: 三栏 — 左: 信号类型过滤 (含今日计数) | 中: 信号卡片流 (alpha 降序) | 右: 详情面板
- **详情面板**: 评分柱状图 (6 维度) + 关联实体/话题 + 原因理由 + Deep Research 按钮
- **渐进加载**: IntersectionObserver 滚动加载 + 加载动画

---

## 3. 本轮已完成的性能优化

| 优化项 | 改动 | 效果 |
|--------|------|------|
| 源抓取并行化 | 17 源 `Promise.allSettled` | 90-120s → ~30s |
| HN 并行抓取 | `Promise.allSettled(ids.map(fetchURL))` | 6-9s → ~1s |
| fetchURL 连接池 | keep-alive Agent (32 sockets) | 消除 TCP 握手 |
| X-Following 加速 | 并发 2→4, 延迟 0ms | 消除 7.5s 等待 |
| Embedding 迁移 | `normalized_payload` → `item_vectors` | 消除 O(n²) JSON 反序列化 |
| 翻译批事务 | chunk 级 transaction | 减少写锁竞争 |
| LLM 并发提升 | enrich 16 workers, translate 8 workers, batch 16/20 | 吞吐翻倍 |
| entities 去重 | `UNIQUE(name COLLATE NOCASE, type)` | 消除并发竞态 |
| KG Worker 接入 | FULL_PIPELINE 自动跑 extract → embed → topics | 端到端自动化 |
| 前端渐进加载 | IntersectionObserver + 分页 | 首屏从 200 降到 60 条 |
| 翻译索引 | `ai_summaries` 覆盖索引 + `title_zh_status` | 全表扫描消除 |
| KG 复合索引 | `graph_edges(from_type,from_id,edge_type)` + `kg_edges(extractor)` | 自连接加速 |
| LLM SSL 重试 | `_post` 自动重试 ECONNRESET/EOF/EPIPE | 连接稳定性 |
| 双轨 topic 对齐 | `updateGrowthScores` 同时评分 v1+v2 | 243 个 v2 topic 首次纳入 |

---

## 4. 核心文件索引

| 领域 | 文件 |
|---|---|
| 信号评分引擎 | [server/services/signals.js](server/services/signals.js) |
| agent-reach 桥接器 | [server/services/agent-reach.js](server/services/agent-reach.js) |
| Reddit 连接器 | [server/connectors/reddit.js](server/connectors/reddit.js) |
| 小红书连接器 | [server/connectors/xiaohongshu.js](server/connectors/xiaohongshu.js) |
| 信号类型定义 | [server/migrations/009_alpha_radar.sql](server/migrations/009_alpha_radar.sql) |
| API 路由 | [server/routes/api.js](server/routes/api.js) |
| LLM Provider | [server/services/llm-provider.js](server/services/llm-provider.js) |
| LLM 卡片生成 | [server/services/llm.js](server/services/llm.js) |
| 后台任务 | [server/services/jobs.js](server/services/jobs.js) |
| 连接池 | [server/services/utils.js](server/services/utils.js) |
| KG Worker 包装 | [server/services/kg-worker.js](server/services/kg-worker.js) |
| 前端信号页 | [js/modules/pages.js](js/modules/pages.js) |
| 前端渐进加载 | [js/modules/progressive.js](js/modules/progressive.js) |
| 前端路由 | [js/modules/app-main.js](js/modules/app-main.js) |
| i18n | [js/modules/i18n.js](js/modules/i18n.js) |
| 样式 | [css/style.css](css/style.css) |
| 重构方案 | `.commandcode/plans/alpha-radar-refactor.md` |

---

## 5. 下一步方向

| 优先级 | 方向 | 说明 |
|--------|------|------|
| P0 | 全量中文卡片回填 | 7,125 条中翻译覆盖率需从当前水位继续提升 |
| P1 | 实体 momentum 追踪 | `entity_momentum` 表已建，需 pipeline 定期更新 |
| P1 | 账号动态评分 | `source_profiles` 表已建，需早期发现率/噪音率计算 |
| P2 | 叙事迁移识别 | event clustering → narrative 跨时间窗对比 |
| P2 | 行动闭环 | alpha_score > 0.75 自动触发 deep research |
| P2 | BERTopic/HDBSCAN | semantic-lite 升级为语义聚类 |
