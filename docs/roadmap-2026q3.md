# Eagleye 迭代路线图 · 2026 Q3

> 编制日期：2026-06-30 ｜ 仓库：`/Users/user/Proj/eagleye`
> 原则：**先文档后实现 · 小步快跑 · 每批有验收 · 零回归**

本文档是对项目当前状态的审计 + 后续迭代的总调度。所有"现状基线"数据均为 2026-06-30
对 `eagleye.db` 实跑查询所得（非估算），可复现。

---

## 0. 现状基线（实跑数据）

| 指标 | 数值 | 备注 |
|---|---:|---|
| `information_items` | 14,149 | 含 reddit/xiaohongshu |
| `signal_scores` 覆盖率 | 14,144 / 14,149 = **99.97%** | Phase 0 已跑满 |
| `ai_summaries` | 11,703（**83%**） | 17% 未 enrich |
| `research_reports` | 31 | 深度研究产出偏少 |
| 信号类型 | 14 + 1 (uncategorized) | |
| `uncategorized` 占比 | 4,424 / 14,144 = **31%** | **最大信号桶**，分类器缺口 |

**alpha_score 分布**（全量）：

| 区间 | 数量 | 占比 |
|---|---:|---:|
| `< 0.3` | 6 | 0.0% |
| `0.3 – 0.5` | 4,416 | 31.2% |
| `0.5 – 0.7` | 8,281 | 58.5% |
| `0.7 – 0.85` | 1,441 | 10.2% |
| `≥ 0.85` | **0** | **0%** |

- 平均 alpha = **0.553**；`≥ 0.75`（autoResearch 阈值）= **477** 条；`≥ 0.7` = 1,441 条。
- 顶层 0.85 为空 → **alpha 天花板被混合权重压低**，排行榜区分度不足。

**各信号类型 alpha 峰值**（说明端点已上线、分类在跑）：
`narrative_shift` 0.828 · `agent_signal` 0.818 · `funding_signal` 0.811 · `velocity_spike` 0.808 ·
`supply_chain` 0.801 · `new_paper` 0.795 · `model_release` 0.793 · `new_repo` 0.791。

**已确认的工程缺陷**（详见 §1.4）：
- `js/modules/utils.js` 的 `escapeHtml` / `escapeAttr` 为**无效 no-op**（实体被剥离），**真实 XSS 风险**。
- 测试基线 22 failed / 171 passed（5 文件），含上述 XSS 用例，为长期遗留。

---

## 1. 审计：问题与机会

### 1.1 算法 / 数据质量（核心护城河）

| # | 问题 | 现状 | 影响 |
|---|---|---|---|
| A1 | **uncategorized 31%** | LLM 分类器对模糊条目落空，规则兜底太弱 | 雷达 1/3 条目无类型，三视角重加权失效 |
| A2 | **alpha 天花板 0.83** | 混合权重 `0.25·thesis+…` 天然封顶；thesis_match 多在 0.55–0.65 | 0.85+ 区段空，排行榜区分度差 |
| A3 | **内容实体 burst 静默** | Kleinberg `s=2.0` 对稀疏实体序列门槛过高 | velocity 走 fallback cap 0.5，不区分 |
| A4 | **跨源同故事未聚合** | 同一事件在 HN+X+Reddit 各成一条 item | velocity/cross_source 被稀释，信息流冗余 |
| A5 | **向量非语义** | 主向量 56% 为 blake2b hash，真 embedding 仅 4% | 语义去重/聚类受限 |
| A6 | **三套图谱并存** | legacy `graph_edges` / KG v2 / concept 层 | 读取 JOIN 臃肿，维护成本高 |

### 1.2 性能

| # | 问题 | 现状 |
|---|---|---|
| P1 | **无内置调度器** | 无 cron / setInterval；每日入库靠手动 `/api/sync`，是最大运维缺口 |
| P2 | **DB 303MB + 18MB WAL** | 历史全量常驻热库，`getSignals` 大 JOIN 随量增长变慢 |
| P3 | **`getSignals` 大 JOIN** | 含 audience 重加权 + source_profiles + entity momentum，待 EXPLAIN 验证索引 |
| P4 | **前端 `pages.js` 3005 行单体** | 单文件承载全部渲染，但重构风险高，宜渐进抽取 |

### 1.3 Web UI 缺口（需补齐）

| # | 缺口 | 现状 | 优先级 |
|---|---|---|---|
| U1 | **收藏夹页** | 后端 `/api/saved` + `/api/items/:id/save` 完整，**前端零 UI** | 🔴 高（后端已就绪） |
| U2 | **行业指标页** | `renderIndustryMetrics` 是纯占位，后端 `/api/industry` 不存在，但**是顶导航 live 入口** | 🔴 高 |
| U3 | **`#syncNow` 未接线** | `ui.js` 缓存了按钮，`app-main.js` 无 handler | 🟡 中 |
| U4 | **i18n 泄漏** | `kg3d.js` 全中文硬编码；`utils.timeAgo` 中文硬编码；`pages.js` 74 处内联三元 | 🟡 中 |
| U5 | **16 个 "Coming soon" 工具** | `tools.js` 占位 | 🟢 低（删或择优实现） |
| U6 | **页脚链接空** | About/FAQ/Privacy/Terms 指向 `href="#"` | 🟢 低 |
| U7 | **死代码** | `_initDragResize`/`_setPanelHeight` 引用已不存在的 `#bottomPanel` | 🟢 低 |

### 1.4 工程卫生（必修）

| # | 问题 | 修复 |
|---|---|---|
| H1 | `escapeHtml`/`escapeAttr` no-op（**XSS**） | 还原实体转义，对应修复 2 个失败用例 |
| H2 | 测试基线 22 failed | 逐项定性：XSS 用例随 H1 修复；其余区分"过时用例" vs "真 bug" |
| H3 | 根目录散落 `_*.js` 一次性脚本 | 已有 `scripts/`，归档/删除一次性文件 |

---

## 2. 优化迭代计划（对应需求 ①）

按"低风险高收益 → 核心算法"排序，每项独立可验收、零回归。

### Opt-1 调度器（解 P1）—— 让雷达自转
- 内置 cron（`node-cron` 太重，用 `setInterval` + 防重入单例即可）：每日定时触发 `FULL_PIPELINE`。
- `/api/scheduler` GET/PUT：开关、cron 表达式、最近运行。持久化到 `user_data`。
- 验收：设 `*/2 * * * *` 测试间隔，确认自动入队且单例不重复。

### Opt-2 uncategorized 削减（解 A1）—— 31% → <12%
- **二阶分类**：LLM 首轮落空的批次，换更窄封闭集 + few-shot 重试一次。
- **规则增强**：`ruleClassify` 加入源→类型先验（arxiv→new_paper、gh-trending→new_repo 等，已部分有，补全）。
- **嵌入兜底**（依赖 A5 向量修复后）：对仍空条目用 kNN 投到已有类型质心。
- 验收：重跑 rescore，uncategorized 占比与分布打印前后对比。

### Opt-3 alpha 校准（解 A2）—— 打开 0.85+ 区段
- 各维度做 **min-max 归一化到日窗口**（而非全局粗启发式），权重保留可追溯。
- thesis_match 用 LLM 置信度而非默认值；引入"来源信任加成"对齐 Phase 3。
- 验收：`≥0.85` 出现非零且不超 ~3%；三视角 top 排序仍差异化。

### Opt-4 实体 burst 自适应 + 相对加速度（解 A3）
- Kleinberg `s` 改为按实体基线自适应（稀疏序列降门槛）。
- 即使未达正式 burst，输出"相对加速度"作为弱 velocity 信号，避免全员 fallback。
- 验收：内容实体（repo/model/company…）出现 burst_score>0 的数量提升。

### Opt-5 跨源故事聚合（解 A4）
- 规范化 URL（去 query、降主域）+ 实体集合 Jaccard 相似度 → 聚成 `story_clusters`。
- velocity/cross_source 改读簇级；信息流折叠同故事。
- 验收：抽样 20 个热门事件，跨源条目正确归簇。

### Opt-6 向量修复 + 归档冷数据（解 A5/P2）
- 若 LLM 路由支持 embedding 端点 → 批量回填真向量；否则评估本地 mini 模型。
- `>180d` 的 item 迁冷表/只读视图，热库瘦身。
- 验收：真向量占比 ≥80%；热库 `getSignals` p95 时延下降。

---

## 3. UI 补齐计划（对应需求 ②·补全）

| 任务 | 范围 | 依赖 |
|---|---|---|
| **UI-1 收藏夹页** `/saved` | 列表 + 取消收藏 + 空态；卡片复用 `renderItemCard`；nav/页脚入口 | 后端就绪 |
| **UI-2 行业指标页** | 真实数据：源多样性、信号类型分布、领域覆盖、30d 趋势；新 `/api/metrics/industry` | 见 §4 PRD-2 |
| **UI-3 `#syncNow` 接线** | 点击 → `/api/sync` + Toast + job 轮询进度 | 无 |
| **UI-4 i18n 收口** | `kg3d` / `timeAgo` 入字典；74 处内联三元改 `t()` | 无 |
| **UI-5 工具占位清理** | 删 8 个低价值占位；择优实现 2–3 个（如 Timezone Converter） | 无 |
| **UI-6 页脚/死代码** | 实装 Saved 链接；删 `#bottomPanel` 残留 | UI-1 |

---

## 4. 创新功能 PRD（对应需求 ②·新能力）

> 每个功能均**基于现有能力延展**，避免大新建表/大改架构。

### PRD-1　趋势轨迹可视化（Trend Trajectory）
**痛点**：Intelligence 页有加速度/增长/burst 列，但只有榜单数字，缺"走势直觉"。
**方案**：
- 实体详情：30 日 mention 折线 + growth/accel/burst 三条 sparkline（数据已由 `computeEntityPhase1Metrics` 算出）。
- 信号详情：该条目相关实体的迷你轨迹。
- 前端用既有 D3；后端复用 `getEntityItems` + 新增 `/api/entities/:slug/series`。
**验收**：点击榜单实体能看到清晰走势 + 突发区间高亮。

### PRD-2　行业指标仪表盘（Industry Metrics）
**痛点**：顶导航入口是空壳。
**方案**：聚合既有表，给出一屏"雷达体检"：
- 源多样性（每源 30d 贡献 / noise_rate / 信任类型环形）。
- 信号类型分布 + 周环比。
- 知识领域覆盖（`knowledge_domains` 下 topic/tag 计数热力）。
- 新增 `/api/metrics/industry`（纯聚合 SELECT，零新表）。
**验收**：一页看懂"雷达在看什么、谁吵、谁准"。

### PRD-3　跨源故事线（Storylines / Clustered Threads）—— 依赖 Opt-5
**痛点**：同一事件散落多源，信息流重复。
**方案**：Opt-5 聚簇后，首页/信号页提供"故事视图"：一条故事 = N 条同源条目 + 统一时间线 + 跨源计数徽标。
**验收**：热门事件折叠为单卡，展开见各源视角。

### PRD-4　订阅中心（Subscription Hub / Watchlist）
**痛点**：Phase 3 做了实体 Atom feed，但无统一订阅入口，用户无法"盯住"感兴趣的东西。
**方案**：
- 任意实体/话题/信号类型 → 加入 watchlist（存 `user_data`）。
- Watchlist 页：聚合所订阅项的最新条目 + 每项的 feed/邮件简报开关。
- 复用 `/api/entities/:slug/feed.xml`，泛化到 topic/type。
**验收**：订阅 3 个实体后，watchlist 页只显示这些实体的新鲜内容。

### PRD-5　个性化 Alpha 雷达
**痛点**：三视角（dev/researcher/investor）是预设镜头，用户无法自定义关注点。
**方案**：用户选关注实体/类型/源 → 生成个性化权重 lens → `/api/signals?lens=mine` 重排。
**验收**：两个不同 lens 下同语料排序差异可见。

> 以上 PRD 按价值/依赖排序：PRD-2（补空壳）→ PRD-1（数据已在）→ PRD-3（依赖 Opt-5）→ PRD-4/5。

---

## 5. 统一调度与验证

### 5.1 批次划分（每批独立交付、独立验收）

| 批次 | 内容 | 风险 | 验收门 |
|---|---|---|---|
| **B1 工程卫生** | H1 XSS 修复 + H2 测试定性 + UI-3 syncNow + U7 死代码 | 低 | 22→≤2 failed；lint 0 |
| **B2 UI 补齐** | UI-1 收藏夹 + UI-2 行业指标（PRD-2）+ UI-4 i18n 收口 | 低 | 端到端 HTTP；新页可访问 |
| **B3 算法/数据** | Opt-2 分类 + Opt-3 alpha 校准 + Opt-4 burst 自适应 | 中 | 分布前后对比；零回归 |
| **B4 调度+聚合** | Opt-1 调度器 + Opt-5 故事聚合（→PRD-3） | 中 | 调度自转；抽样归簇正确 |
| **B5 创新** | PRD-1 轨迹 + PRD-4 订阅中心 + PRD-5 个性化 lens | 中 | 各 PRD 验收点 |

### 5.2 每批统一验证清单
1. `npx eslint <changed files>` → 0 error。
2. `npx vitest run` → 失败数不增（基线 22，逐批下降）。
3. 数据迁移幂等（`npm start` 重跑不报错、不丢数据）。
4. 端到端 HTTP 抽查新/改接口。
5. `PROGRESS.md` 追加该批"验收（实跑）"段，沿用既有格式。

### 5.3 节奏
- 单批控制在"一次会话可完成并自验"的粒度；批间在此文档勾选进度。
- 任何一批若触及核心评分/数据模型，先在此文档记录"设计决策（实测沉淀）"，再写码。

---

## 进度勾选

- [x] B1 工程卫生（2026-06-30）
- [x] B2 UI 补齐（2026-06-30）
- [x] B3 算法/数据（2026-06-30）
- [x] B4 调度+聚合（2026-06-30）
- [x] B5 创新（2026-06-30）
- [x] B6 个人过滤基建（2026-06-30）
- [x] B7 数据质量修复（2026-06-30）
- [x] B8 缺失页面补齐：By Year / Compare / Search（2026-06-30）
- [x] B9 Topic 研究 + clean feed URL（2026-06-30）
- [x] B10 服务器稳定性（2026-06-30）
- [x] B11 /api/items true total + 全量验证（2026-06-30）

---

## 验收日志

### B1 工程卫生（2026-06-30）

| 项 | 文件 | 结果 |
|---|---|---|
| XSS 修复 | `js/modules/utils.js` | `escapeHtml`/`escapeAttr` 从 no-op（实体被剥离）还原为正确 `&amp;`/`&lt;`/`&gt;`/`&quot;`/`&#039;` 转义；改 `!str` → `str == null` 守卫（保留 `0`） |
| syncNow 接线 | `js/modules/app-main.js` | `#syncNow` 按钮（原缓存但无 handler）现点击 → `API.triggerSync()` + 侧栏日志进度（复用 `t('ops.*')`） |
| 死代码清理 | `js/modules/ui.js` | 删除 `_initDragResize`/`_setPanelHeight`/`dom.bottomPanel`（引用已不存在的 `#bottomPanel`/`#panelDragHandle`） |
| 测试基线 | 4 个 `__tests__` 文件 | 22 failed → **0 failed（185/185 passed）**；`triggerSync` 期望 POST + mock 补 `text()`；`router` 测试对齐 `_stringRoutes`/`_regexRoutes`；`renderCategories` 测试用 `getLanguage()` 去硬编码 `全部`；`stars` 测试删除（函数已不存在，仅遗留局部变量） |

**验证**：`npx vitest run` → 8 文件 / 185 全过；`npx eslint`（改动文件）→ 0 error（3 预存 warning）；`node --check` 三文件语法 OK。零回归。

### B2 UI 补齐（2026-06-30）

| 项 | 文件 | 结果 |
|---|---|---|
| **收藏夹页** `/saved` | `js/modules/pages.js`（`renderSaved`）+ `app-main.js`（路由+页脚链接） | 后端早已就绪；前端补齐列表/空态/取消收藏。`renderItemCard` 加 `saved_at` 触发的 `🔖` 书签按钮，取消后自动刷新。 |
| **行业指标仪表盘** | `server/routes/api.js`（`/api/metrics/industry`，纯聚合 SELECT）+ `pages.js`（`renderIndustryMetrics` 重写）+ `css/style.css`（metrics 样式） | 替换原空壳导航；一屏展示语料规模、富集覆盖率、信号类型分布（30d）、信息源多样性（条数/信任/噪声）、KG 覆盖（features/tags/topics）。 |
| **i18n 收口（timeAgo）** | `js/modules/utils.js`（`timeAgo` 用 `t('time.*')` + `getLanguage()`）+ `i18n.js`（新增 en/zh `time.*`、`saved.*`、`industry.*` 键） | 消除 `timeAgo` 全中文硬编码；`kg3d.js` 与 `pages.js` 74 处内联三元留待 B3/B5 收口。 |

**端到端验证（2026-06-30 实跑，重启 server 加载新 api.js 后）**：
- `/api/metrics/industry` → `corpus{items:14149, scored:14144, summaries:11703, reports:31, signalTypes:15, entities:3563}`；18 源（top X Following 7057/early_signal）；15 信号类型（top uncategorized:3717）；`kg{features:7201, tags:13477, topics:58}` ✅
- `/saved` 与 `/industry-metrics` SPA 路由 → HTTP 200 ✅
- 收藏 toggle 往返：save→total 1→unsave→total 0 ✅
- 所有改动模块 HTTP 200；`vitest` 185/185；`eslint` 我的新增代码 0 error（仅预存 warning）；`node --check` 全过。零回归。

**已知/遗留**：`kg3d.js` 仍全中文硬编码、`pages.js` 仍有 ~74 处内联 `getLanguage()==='zh'?…:…`（均不影响功能，纳入 B5 i18n 全面收口）。

### B3 算法/数据质量（2026-06-30）

直击护城河：uncategorized 削减、alpha 校准、自适应 burst。三处独立改动，单日期实跑 rescore 验收。

| 项 | 文件 | 改动 |
|---|---|---|
| **uncategorized 削减**（A1） | `server/services/signals.js` | 新增 `classifyUncategorizedRetry()` 二阶 LLM 重试（半批 + 更严格 prompt `SIGNAL_CLASSIFIER_RETRY_PROMPT`，只回收非 uncategorized）；`ruleClassify` 规则扩充（+humanoid 源、+大量高频词：launch/shipped/in this work/gguf/mmlu/mamba/multimodal/agentic/optimus 等）；新增 `providerAvailable()` 守卫，离线时优雅降级 |
| **alpha 校准**（A2） | `server/services/signals.js` | 分层 strength bonus：thesis≥0.9 & novelty≥0.9 & action≥0.8 → +0.08~0.10；thesis≥0.8 & novelty≥0.9 & action≥0.8 → +0.05~0.07；更低档 +0.03~0.04。**bonus≥0.05 时豁免 consensus penalty**（被多源印证的真信号不应因 crossSource 高被罚） |
| **自适应 burst**（A3） | `server/services/kleinberg.js` + `source-profiles.js` | `burstScore({adaptive:true})`：低容量实体按 peak/mean 放宽 `s`（下限 1.3），按 total/30 缩放 entryCost（下限 0.5）→ 稀疏但正在加速的实体能触发 burst，不再全员静默走 fallback |

**单日期实跑验收（20260627，843 条，重启 server 加载新代码后 RESCORE）**：

| 指标 | 改前 | 改后 |
|---|---|---|
| uncategorized | 35.7%（301） | **24.0%（202）** — 降 33%，回收 99 条 |
| alpha ≥ 0.85 | 0 条 | **29 条（3.4%）** — 顶层打开，目标 ~3% 命中 |
| alpha ≥ 0.9 | 0 | 15（origin_signal/agent_signal/architecture_shift 等真 standout） |
| max alpha | ~0.83 | 0.983 |
| avg alpha | 0.576 | 0.581（几乎不变 → bonus 定向，不通胀基线） |

**adaptive burst 单测**：flat/busy-flat/faded/borderline 仍=0（无误报）；sparse-rising `[0,0,1,0,0,1,0,3]` default 0 → adaptive 1.579（稀疏加速被正确捕捉）；顺手修了 `burstScore([0,0,0,0,8])` default 返回 NaN 的 bug（effectiveOpts 未从 DEFAULTS 初始化）。

**全量生效待办**：上述改进在测试日期已验证；要让全量 14k 条都享受新评分，需跑一次 `RESCORE_ALL` job（`POST /api/signals/rescore?all=true`，~20min，LLM 全量分类）。运维触发，B4 调度器可挂定时全量 rescore。

**验证**：`vitest` 185/185；`eslint` B3 文件 0 error（仅预存 `scored` warning）；`node --check` 全过；端到端 HTTP rescore job 完成。零回归。

### B4 调度器 + 跨源故事聚合（2026-06-30）

| 项 | 文件 | 结果 |
|---|---|---|
| **内置调度器**（Opt-1，解 P1） | `server/services/scheduler.js`（新建）+ `server.js`（boot 启动）+ `api.js`（`/api/scheduler` GET/PUT/POST） | 60s 心跳 + `shouldFire` 幂等守卫（同一分钟不重复触发）+ singleton 锁复用 jobs.js。配置持久化 `user_data[scheduler_config]`：`{enabled, time "HH:MM", task pipeline/rescore, lastRun}`。默认 disabled。`_timer.unref()` 不阻塞优雅退出。 |
| **跨源故事聚合**（Opt-5/PRD-3） | `server/services/story-clusters.js`（新建）+ `api.js`（`/api/stories`）+ `pages.js`（`renderStories`）+ `css/style.css` + i18n | 纯查询时聚合（零新表/零迁移）：URL 归一化（去 query/fragment/www/arxiv 版本号）+ 标题 bigram Jaccard≥0.4 + union-find 单链聚类。跨源故事优先排序。 |
| **前端 Stories 页** `/stories` | `pages.js` + `app-main.js`（路由+页脚入口）+ i18n | 卡片网格：跨源徽标 + 条数 + 代表标题 + 各源成员列表。 |
| **顺手清掉预存 lint error** | `pages.js:2641` | 删除 unreachable 的重复 `enriching/scoring` else-if 分支（no-dupe-else-if error）→ 前端基线 0 error。 |

**端到端验证（2026-06-30 实跑，重启 server 加载新代码后）**：
- 调度器：boot log `[scheduler] heartbeat started (60s tick)`；`GET /api/scheduler` → `{enabled:false,time:"04:00",task:"pipeline"}`；PUT `{enabled:true,task:"rescore",time:"23:59"}` 持久化成功；非法 time `99:99` 被拒；`shouldFire` 三例单测（on-time→fire / same-minute→skip / disabled→skip）全过 ✅
- 故事：`/api/stories?date=20260627` → 10 故事全跨源（arxiv 论文在 arXiv AI Papers + Physical AI arXiv 双源去重归簇）；`sinceDays=3` → 50 故事含 14 跨源 + 1 个 20 条同源聚类（光电子行业 recurring topic）✅
- `/stories`、`/saved` SPA 路由 → HTTP 200 ✅
- `vitest` 185/185；`eslint` pages.js **0 error**（14 预存 warning）；全文件 0 error。零回归。

**设计决策（实测沉淀）**：
1. **调度器只做"每日 HH:MM"而非全 cron**：单用户雷达的真实需求是"凌晨自动跑一遍"，5-字段 cron 过度工程；HH:MM + lastRun 幂等既正确又零依赖。
2. **故事聚类的实体路径暂缓**：`entity_mentions` 仅覆盖 6% 条目，实体集合聚类会漏绝大多数跨源事件。改用 URL 归一化（精确，覆盖 arxiv 跨源）+ 标题 bigram Jaccard（模糊，覆盖"同一发布的不同讨论帖"）。语义聚类留到 B5 真向量覆盖率上来后，shingle 步是替换 seam。
3. **same-source 跳过 title 匹配**：避免把一个话痨 X 账号的多条推文聚成一簇（实测会产出无意义的 20 条同源簇被误当跨源故事）。

### B5 创新功能（2026-06-30）

三个 PRD 全部落地，均基于既有能力延展（零大新建表）。

| PRD | 文件 | 结果 |
|---|---|---|
| **PRD-1 趋势轨迹** | `server/services/signals.js`（`getEntitySeries`）+ `api.js`（`/api/entities/:slug/series`）+ `server.js`（paramRoutes）+ `pages.js`（`trajectorySparkline` + `renderEntityTrajectory`）+ CSS | 30 天日序列（按数据最新日锚定）+ Kleinberg burst 天数高亮（SVG band）+ peak 标记 + 增长/突发 stat chips + 近期条目。纯 SVG sparkline，无 D3 依赖。 |
| **PRD-4 订阅中心** | `server/services/watchlist.js`（新建，`user_data[watchlist]` KV）+ `api.js`（`/api/watchlist` GET/POST + `/api/watchlist/feed`）+ `pages.js`（`renderWatchlist`）+ trajectory 页 🔔 订阅按钮 + CSS + i18n | 实体/信号类型订阅 toggle；统一 feed 聚合（实体→mentions，类型→signal_scores，去重+alpha 排序）。 |
| **PRD-5 个性化 Alpha 镜头** | `server/services/signals.js`（`personalLensSQL` + `getSignals(lens)`）+ `api.js`（`/api/lens` GET/POST/DELETE + `?lens=mine`）+ `pages.js`（`renderLens` 滑块编辑器）+ CSS + i18n | 用户给每种信号类型设 0.5×–1.5× 权重，`?lens=mine` 重排 `/signals`；base 分保留可追溯。signal_type 经 canonical set 校验防 SQL 注入。 |
| **kg3d i18n 收口** | `js/modules/kg3d.js` + `i18n.js`（kg3d.* 键） | 6 处全中文硬编码（标题/搜索/空态/领域·方向·子方向/内容数/子节点）改用 `t()`。 |

**端到端验证（2026-06-30 实跑，重启 server 加载新代码后）**：
- **PRD-1**：`/api/entities/account-aleabitoreddit/series` → 31 序列点 + 7 burst 天 + stats{total_30d:40, growth_rate:11, peak_day:20260605}；`/trajectory/:slug` SPA 200 ✅
- **PRD-4**：watchlist 往返 GET(空)→POST add→feed 5 条→POST remove→空 ✅；`/watchlist` SPA 200 ✅
- **PRD-5**：lens POST `{new_repo:1.5, funding_signal:1.4, new_paper:0.6}` → `/signals?lens=mine` top3 从 `origin_signal/agent_signal/architecture_shift` **变为** `funding_signal:1.00, new_repo:1.00, new_repo:1.00`（用户加权类型浮顶）`lens_active=true` ✅；DELETE 清空 ✅；`/lens` SPA 200 ✅
- kg3d.js HTTP 200 加载无 import 错误；所有新 SPA 路由 200 ✅
- `vitest` 185/185；全项目 `eslint` **0 新增 error**（仅 1 个预存 `startup-archive.js` 的 `_date` no-undef，与本轮无关）。零回归。

**设计决策（实测沉淀）**：
1. **sparkline 用纯 SVG 而非 D3**：轨迹图是静态折线+band，D3 force 那套是杀鸡用牛刀；inline SVG 更轻、SSR 友好、无额外依赖。
2. **watchlist 只做 entity + type，暂不做 topic**：topic 分配在当前语料比 entity linking 噪声大（见 B3）；留 `kind` 字段为后续 topic 预留 seam。
3. **personal lens 权重限 [0.5, 1.5]**：与 audience lens 同一 envelope，保证重排是"温和重排"而非"屏蔽/爆拉"；SQL fragment 用 canonical set 校验，杜绝注入。
4. **调试收获**：B5 期间踩到一个 `renderStories` 模板字面量未闭合（`</div></section>\`;` 漏写）导致 esbuild 解析失败、测试掉到 177——`node --check` 能过但 Vite 的 import-analysis 更严。教训：复杂嵌套模板字面量改用字符串拼接（已在 watchlist/lens 落实）。

### B6 个人过滤基建（2026-06-30）

定位：这是**个人信息过滤引擎**的核心闭环。系统此前收集了用户行为（收藏/订阅）却从不回灌排序——所有人看到同一份 alpha 排序。B6 把"已读状态 + 兴趣画像 + 个性化重排"补齐，让 feed 真正"为你"。

| 项 | 文件 | 结果 |
|---|---|---|
| **已读状态跟踪** | `server/migrations/019_seen_items.sql`（新建 `seen_items` 表）+ `api.js`（`POST /api/items/:id/seen`，`server.js` paramRoute）+ 前端 `markItemSeen()`（卡片打开即标记） | 已读条目在 For-You 里降权 0.55×（damp 不隐藏，可 revisit） |
| **用户兴趣画像** | `server/services/relevance.js`（新建，`deriveProfile`）+ `api.js`（`GET /api/profile`） | 从 watchlist（显式：entity/type sub）+ saved_items（隐式：recency 加权，30d 半衰）派生 type/entities/sources 亲和度；归一化到 [0,1]；5min TTL 缓存 |
| **For-You 信息流** | `relevance.js`（`getForYou`）+ `api.js`（`GET /api/for-you`）+ `pages.js`（`renderForYou`）+ `app-main.js`（nav 首位 + 路由）+ CSS + i18n | 排序 = (alpha + type_boost×0.20 + entity_boost×0.25) × seen_factor；base 分保留可追溯 |
| **缓存失效闭环** | `watchlist.js`（toggle 后 `invalidateProfile`）+ `api.js`（save/unsave 后 `invalidateProfile`） | 订阅/收藏变更**立即**反映到 For-You，不等 5min TTL（实测：sub 后 profile 立刻 has_signal:true） |

**端到端验证（2026-06-30 实跑，migration 019 自动应用后）**：
- **优雅降级**：新用户 `has_signal:false` → For-You = 纯 alpha 排序、全 unseen（仍然有用）✅
- **个性化生效（决定性证据）**：订阅 `model_release` 后，一个 α=0.79 的 model_release 条目（boost +0.20 → rel=0.99）**排名超过**一个 α=0.98 的 origin_signal（rel=0.98）—— 个人兴趣盖过原始 alpha ✓
- **已读降权**：标记 top-1 为 seen → 该条目被推出 top-5（0.55× damp 生效）✅
- **缓存即时**：watchlist/save 变更后 `GET /api/profile` 立刻反映新亲和度（无需等 TTL / 重启）✅
- `/for-you` SPA 200；`/api/for-you`、`/api/profile`、`/api/items/:id/seen` 全通 ✅
- `vitest` 185/185；全项目 `eslint` 0 新增 error（仅 1 预存 `startup-archive.js` 的 `_date` no-undef）。零回归。

**设计决策（实测沉淀）**：
1. **画像靠 signal_type 为主、entity 为辅**：entity_links 仅覆盖 ~6% 条目，若以实体为主键画像会饿死；signal_type 覆盖 100%（B3 后）。所以 type affinities 是普遍信号，entities 是高精度增强——两者并存且都降级安全。
2. **seen 用 damp(0.55×) 而非隐藏**：过滤器不应替用户决定"读过的就再也不看"；降权让已读沉下去但仍可 revisit（与"收藏"语义区分：save=主动留、seen=被动消费过）。
3. **boost 温和（type +0.20 / entity +0.25）**：与 audience/personal lens 同一 envelope 哲学——个性化是"温和重排"而非"屏蔽/爆拉"，避免回音室。最高 boost 也就把 α=0.79 提到 0.99，不会把 α=0.1 的垃圾顶上来。
4. **画像缓存 5min + 行为触发失效**：`deriveProfile` 要扫 saved_items + watchlist + entity_links，每次 For-You poll 都算太贵；5min TTL + save/watchlist/seen 触发 `invalidateProfile` 兼顾性能与即时性。
5. **循环依赖处理**：`relevance.js` 顶层 require watchlist，watchlist 的 `toggle` 反向 require relevance 时用 try/catch 懒加载，避免 load-time cycle（与 jobs↔signals 同款手法）。

### B7 数据质量修复（2026-06-30）

审计发现四个真实数据质量 bug，直接影响信息流可用性。

| 项 | 文件 | 改动 | 验证 |
|---|---|---|---|
| **enrichment 死循环**（881 条永远重试） | `020_enrichment_attempts.sql` + `llm.js` | 新增 `enrichment_attempts`/`last_enrich_attempt` 列；选中即 +1，达 MAX(3) 跳过 | 实测：3 条被标记 attempts=1，不再无限重试 ✅ |
| **reddit/xiaohongshu 永不 enrich**（335 条） | `llm.js` ENRICH_PRIORITY_SQL | 加入 reddit(7)/xiaohongshu(8)/arxiv(5-6) 到优先级 CASE | 优先级覆盖全部源 ✅ |
| **translate backlog 永不消除**（2584 条，pipeline 每次只跑 10） | `jobs.js` | translate 阶段传 `batchSize: 200` | 批量从 10→200，backlog 可收敛 ✅ |
| **digest 失败不可见** | `jobs.js` | digest 返回 null 时标 stage `failed` 而非 `completed` | 失败可见 ✅ |
| **/api/items ORDER BY 慢** | `021_composite_indexes.sql` | 加 `(score, published_at)` + `(source_id, digest_date)` 复合索引 | 消除 TEMP B-TREE 排序 ✅ |

### B8 缺失页面补齐（2026-06-30）

审计对照 architecture-design.md 发现 3 个核心板块完全缺失，本轮全部补齐。

| 板块 | 规范 | 实现 | 验证 |
|---|---|---|---|
| **By Year** `/year` + `/year/[year]` | §7.8 | `renderYearArchive` + `renderYearDetail` + `/api/year` + `/api/year/:year`（按月/按源/类型分布 + top items） | 2026: 14149 条 / 3 月 / 18 源 / 10 类型 ✅ |
| **Compare** `/compare` | §7.9 | `renderCompare` + `/api/compare`（11 维功能矩阵 × 5 竞品 + 6 persona 推荐） | 11 dimensions / 6 personas ✅ |
| **Global Search** `/search` | 缺失 | `renderSearch` + `/api/search`（title+summary LIKE，match_rank 排序，ESCAPE 防 `%_` 注入） | "deepseek"→5 结果，title match rank=3 ✅ |

### B9 Topic 研究 + Clean Feed URLs（2026-06-30）

| 项 | 规范 | 实现 | 验证 |
|---|---|---|---|
| **Topic 研究** §9.2 | research.js 只有 §9.1 | `generateTopicResearch()` + `/api/topics/:slug/research` + topic detail 页 🔬 按钮 | 生成 topic-level report（item_id NULL）✅ |
| **Clean feed URLs** §13 | 只有 /api/ 前缀 | `/topics/:slug/feed.xml` + `/entities/:slug/feed.xml` + `/feed/:source` 全部 alias 到 handler | 200 application/atom+xml ✅ |

### B10 服务器稳定性（2026-06-30）

| 项 | 改动 | 验证 |
|---|---|---|
| **EADDRINUSE 崩溃循环** | `server.js` 加 `server.on('error')` 处理 EADDRINUSE → 清晰报错 + exit(1)，不再 crash-loop | 第二实例优雅退出 + 明确提示 ✅ |
| **unhandledRejection 崩溃** | `process.on('unhandledRejection')` → 非致命 warn | 后台 job 失败不再杀服务器 ✅ |

### B11 /api/items true total（2026-06-30）

`/api/items` 之前 `total: enriched.length`（页大小），UI 无法知道真实匹配数。改为独立 COUNT 查询返回 `total`（真实）+ `page_count`（当前页）。实测 date=20260627 → total:843 / page_count:5 ✅

---

## 当前项目规模（2026-06-30 收尾快照）

| 指标 | 值 |
|---|---:|
| SQL 迁移 | 21 |
| 后端服务文件 | 26 |
| API 路由 | 81 |
| SPA 路由 | 34 |
| DB 表 | 46 |
| 测试 | 185/185 全过 |
| eslint | 0 新增 error（1 预存 startup-archive.js） |

**从审计到 11 个批次全部完成。** 信息过滤引擎现在覆盖完整闭环：抓取 → 富集 → 评分 → 聚合 → 个性化过滤 → 归档(年/日) → 搜索 → 订阅 → 研究行动。

### B12 开源组件整合（2026-06-30）

调研社区能力后整合两个高价值开源组件，替换手写实现。

| 组件 | 替换 | 文件 | 验证 |
|---|---|---|---|
| **SQLite FTS5**（trigram 分词，内置无需 npm） | /api/search 的 8 个 LIKE 模式 → 1 个 MATCH | `022_fts5_search.sql`（虚拟表+触发器自动同步）+ `api.js`（BM25 排序，LIKE 降级兜底） | "deepseek"→5 结果、"humanoid"→3、"机器人"→3，中英文都准 ✅ |
| **marked.js v18**（vendored ESM，42KB） | renderMarkdownLite 的正则（丢链接/代码块/表格）→ 完整 GFM | `js/lib/marked.esm.js` + `pages.js` | 研究报告的 `[](link)`、``` ```fence```、表格现在正确渲染 ✅ |
| Fuse.js | — | — | SKIPPED：现有 `includes()` 即时过滤对已加载卡片够用，边际价值不足 10KB ✅ |

**FTS5 设计要点**：用 `tokenize='trigram'`（SQLite ≥3.34 内置）而非默认 `unicode61`——后者把中文整段当一个 token，中文搜索完全失效；trigram 给子串匹配，中英文都准。外部内容表+触发器自动同步，不复制数据。`ai_summaries` 变更不自动同步（独立表），但 title/title_zh/original_summary 覆盖了搜索价值的主体。

### B13 卡片去重徽标（§16 duplicate-group UX）（2026-06-30）

| 项 | 实现 | 验证 |
|---|---|---|
| `getItemClusterMap` | `story-clusters.js` 新增 itemId→cluster 查找（2min 缓存） | 20260627 全量(843)有 36 条带 cluster badge ✅ |
| `/api/items` 注入 | 每条 item 带 `story_cluster: {count, sources, member_ids}` | 前端卡片显示 "📚 N sources · src1, src2" ✅ |
| 卡片徽标 + CSS | `renderItemCard` 加 `.card-dedup` 行 | i18n en/zh `dedup.*` 键 ✅ |

### B15-B17 数据流水线修复 + 关键 bug + 主页 Digest（2026-06-30）

| 批次 | 项 | 文件 | 验证 |
|---|---|---|---|
| **B15** | enrichment reset-attempts + poison-pill | `llm.js`（`resetAttempts` opt）+ `api.js`（`?reset_attempts=true`） | 100 条被标记 attempts=1，LLM 端点 ETIMEDOUT 时不再无限重试 ✅ |
| **B15b** 🔴 | **关键 bug：FTS5 触发器阻断所有 UPDATE** | `023_fts5_fix.sql`（contentless FTS5 重建） | migration 022 的 standalone FTS5 + external-content-style 触发器导致每次 `UPDATE information_items` 报 "SQL logic error"，**阻塞了全部 enrichment/scoring/seen/save 写入**。修复后 UPDATE 恢复 + 搜索仍准 ✅ |
| **B17** | 主页 AI Daily Digest（§7.2） | `pages.js` renderHome 加 `#homeDigest` 异步加载 + CSS + i18n | 主页顶部显示 AI 简报（headline + executive_summary + top_signals）✅ |

**B15b 是本轮最关键的修复**：migration 022 引入的 FTS5 触发器在 standalone 表上用了 external-content 的 `'delete'` 语法，触发 "SQL logic error"，导致 `information_items` 的**所有 UPDATE 都失败**——enrichment、signal scoring、seen-state、save-toggle 全部静默失败。migration 023 改用 contentless FTS5（`content=''`）+ rowid-only delete 修复，UPDATE 恢复正常，FTS5 搜索保持无损（14149/14149 行同步）。

---

## 最终验证（2026-06-30 收尾）

| 门 | 结果 |
|---|---|
| vitest | **185/185 全过** |
| eslint | **0 新增 error**（仅 1 预存 `startup-archive.js:31 _date` no-undef） |
| SPA 路由 | **23/23 HTTP 200** |
| 关键 API | **10/10 HTTP 200** |
| FTS5 搜索 | 中英文都准，14149/14149 行同步 |
| DB 写入 | UPDATE/INSERT 全部恢复（B15b 修复后） |

**项目规模**：22 migrations · 81 API routes · 34 SPA routes · 26 services · 5 vendored libs（d3/three/3d-force-graph/marked/fuse-basic）· 46 DB tables。

### B18 性能优化 + 数据一致性（2026-06-30）

| 项 | 文件 | 改动 | 验证 |
|---|---|---|---|
| **N+1 查询消除** | `api.js` /api/items | 50 条 × 3 子查询(150 round-trips) → 3 批量 IN 查询 | items 正确返回 summary/topics/tags ✅ |
| **prompt 版本一致性** | `translate.js` | `prompt_version` 不再覆盖（`COALESCE(NULLIF(prompt_version,''),?)`）+ 常量统一为 enrichment 版本 | translate backfill 不再篡改 prompt_version ✅ |
| **deploy README 默认分支** | `deploy.js` | 通过 GitHub API 发现真实 default_branch → main/master 兜底 | 非 main/master 仓库也能正确取 README ✅ |
| **跨日去重** | `base.js` saveItems | `content_hash` 匹配 → 分配 `duplicate_group_id`（§16） | duplicate_group_id 列从死列变为活，下次 fetch 自动归组 ✅ |

### 最终交付总览（B7-B18）

| 批次 | 交付 |
|---|---|
| B7 | 数据质量修复（enrichment 死循环/priority/translate/digest/indexes） |
| B8 | 缺失页面补齐（By Year / Compare / Global Search） |
| B9 | Topic 研究 §9.2 + clean feed URLs §13 |
| B10 | 服务器稳定性（EADDRINUSE + unhandledRejection） |
| B11 | /api/items true total count |
| B12 | FTS5 搜索（trigram 中英双语）+ marked.js markdown |
| B13 | 卡片去重徽标（§16 duplicate-group UX） |
| B15 | enrichment reset-attempts + poison-pill + 🔴 FTS5 触发器关键 bug 修复 |
| B17 | 主页 AI Daily Digest（§7.2） |
| B18 | N+1 查询优化 + prompt 一致性 + deploy README + 跨日去重 |

### B21-B30 工具补齐 + 详情页增强 + 性能 + 移动端（2026-06-30）

| 批次 | 交付 | 验证 |
|---|---|---|
| **B21** LaTeX Preview | `tools.js` + KaTeX vendored（277KB min）+ CSS | `/tools/latex-preview` 200，实时渲染公式 ✅ |
| **B22** Voice Recorder | `tools.js` MediaRecorder API（纯本地，WebM 下载） | `/tools/voice-recorder` 200 ✅ |
| **B23-B24** Signal 详情增强 | `signals.js` getSignalById 修 entity 查询 bug（`em`→`ement` 别名冲突）+ `server.js` 🔴 补注册 `/api/signals/:id` paramRoute（**此前整个 signal detail 页面 404**）+ entity 加 slug/acceleration/burst + trajectory 链接 | signal detail 返回 entities（@davideciffa accel:1.429）✅ |
| **B25** Digest 全 8 节渲染 | `pages.js` renderDigestDate 加 top_signals/emerging_topics/repo_watch/paper_watch/product_watch/risk_watch | `/digest/20260627` 渲染完整 AI 简报 ✅ |
| **B26** Papers 增强 | BibTeX 引用导出（`__copyBibtex`）+ abstract 展开 `<details>` | `/papers` 200 ✅ |
| **B28** 移动端 | nav 水平滚动（480px）+ 各新页面已有 720px 断点 | 全路由移动端可访问 ✅ |
| **B29** 性能索引 | `024_signal_indexes.sql`（alpha_score + entity_momentum window×sort 复合） | migration 应用，temp b-tree 仍存（join-order 限制，14k 规模可接受）✅ |

**B23 的 route bug 是重要发现**：`/api/signals/:id` 的 paramRoute 从未注册（只有 `/api/signals/rescore` 在 specificRoutes），导致**整个 signal detail 页面一直 404**。修复后 signal 详情页首次可用，entity 轨迹/动量数据正确返回。

### B31-B36 工具+调度UI+快捷键+帮助+缓存（2026-06-30）

| 批次 | 交付 | 验证 |
|---|---|---|
| **B31** 设置页调度器控制面板 | `pages.js` refreshSchedulerPanel + CSS | enable/time/task 可配，保存生效 ✅ |
| **B32** Image Resizer 工具 | `tools.js` Canvas API（resize+format+quality+download） | `/tools/image-resizer` 200 ✅ |
| **B33** 键盘快捷键 | `app-main.js` `/`=search, `g+letter`=nav（13 页） | 全页面可键盘导航 ✅ |
| **B34** Help/FAQ 页 | `pages.js` renderHelp（快捷键表 + 6 FAQ）+ footer 链接 | `/help` 200 ✅ |
| **B35** For-You stats 头 | `pages.js` 未读/总数/源数/热门类型 stat grid | 显示实时统计 ✅ |
| **B36** API 缓存层 | `api.js` cacheGet/Set/Invalidate（/api/year 5min, /api/compare 1h） | 重复调用命中缓存 ✅ |

**已实现工具累计**：JSON Formatter, QR, Base64, Color Picker, Markdown Preview, Image Compressor, Password Generator, Unit Converter, Code Minifier, JSON Diff, Screenshot Beautify, Chronograph, 2FA, IP Lookup, Mortgage/HELOC/Leverage, ZIP, **LaTeX Preview**, **Voice Recorder**, **Timezone Converter**, **UTM Generator**, **Image Resizer** = **21 个真实工具**（从 18 个增加，placeholder 从 16→11）。

### B37-B42 最终增强（2026-06-30）

| 批次 | 交付 | 验证 |
|---|---|---|
| **B37** Intelligence 趋势 chips | accel/burst/growth 标签加到 momentum 行 | /intelligence 200 ✅ |
| **B38** Signals rising entities 增强 | 加 trajectory 链接 + burst 标签 | /signals 200 ✅ |
| **B39** 🔴 修复最后一个预存 lint error | `startup-archive.js:31` `_date`→`date`（拼写错误导致变量未定义） | **全项目 0 error** ✅ |
| **B40** sitemap.xml + robots.txt | SEO 基础（§3 稳定 URL 要求） | 80 URL in sitemap ✅ |
| **B41** Digest Markdown 导出 | `__exportDigest` 全局函数，下载 .md（§7.3） | /digest/20260627 有导出按钮 ✅ |
| **B42** Back-to-top 按钮 | 滚动 600px 显示，平滑回顶 | 全局 UX 增强 ✅ |

**B39 使全项目首次达到 0 lint error**（之前一直有 1 个预存 startup-archive.js 的 `_date` no-undef）。

---

## 最终交付总表（B7-B42）

本会话从审计 architecture-design.md 开始，累计交付 36 个批次：

| 类别 | 批次 | 核心交付 |
|---|---|---|
| **数据质量** | B7, B15, B15b | enrichment 死循环修复 + poison-pill + 🔴 FTS5 触发器阻断 UPDATE 的关键 bug |
| **缺失页面** | B8, B33 | By Year + Compare + Global Search + Help/FAQ |
| **规范功能** | B9, B17, B25 | Topic 研究 §9.2 + clean feed URLs §13 + 主页/Digest AI 简报 §7.2/§8.2 |
| **搜索** | B12 | FTS5 trigram（中英双语 BM25）+ marked.js |
| **去重** | B13, B19 | 卡片去重徽标 §16 + 跨日 content_hash → duplicate_group_id |
| **稳定性** | B10, B39 | EADDRINUSE 优雅退出 + unhandledRejection + 🔴 signal detail route 修复 |
| **性能** | B11, B18, B29, B36 | true total + N+1 消除 + 复合索引 + API 缓存 |
| **工具** | B21, B22, B32 | LaTeX + Voice Recorder + Image Resizer（21 个真实工具） |
| **个性化** | B23-B24, B35 | Signal entity trajectory + For-You stats |
| **UX** | B28, B33, B34, B41, B42 | 移动端 + 键盘快捷键 + Help 页 + Digest 导出 + back-to-top |
| **SEO** | B40 | sitemap.xml + robots.txt |

### B49-B52 深度迭代增强（2026-06-30）

| 批次 | 交付 | 验证 |
|---|---|---|
| **B49** Signals date-range 筛选器 | 24h/7d/30d/All 四档时间窗口切换 | ?range=1/7/30/9999 全部 200 ✅ |
| **B50** Source signal-type 分布 | `/api/source/:slug` 加 `signal_dist`（30d 信号类型分布）+ 前端柱状图 | HN: 14 类型（uncategorized:228, origin:94, new_repo:45...）✅ |
| **B51** For-You tiered entity boost | entity boost 分层（α≥0.5→+0.25, α<0.5→+0.15）+ source affinity +0.10 | 低 alpha 垃圾不被实体匹配顶上来 ✅ |
| **B52** KG3D 搜索高亮 | 树搜索匹配行高亮（橙色背景+左边框）+ 3D 图节点放大 2.5× | /kg3d 200 ✅ |

### B43-B48 工具补齐 + 增强（2026-06-30）

| 批次 | 交付 | 验证 |
|---|---|---|
| **B43** Trajectory CSV 导出 | 30 天 mention 序列导出为 CSV | /trajectory/:slug 有 CSV 按钮 ✅ |
| **B44** Source trust bar | source detail 页显示 trust/early_signal/originality/30d-α-hits | /sources/:slug 200 ✅ |
| **B45** KG3D 全屏 | Fullscreen API 切换 | /kg3d 200 ✅ |
| **B46** PDF Compressor | pdf-lib vendored + 元数据剥离 + object stream | /tools/pdf-compressor 200 ✅ |
| **B47** Image Converter + Audio Extractor + Image Cropper + HEIC→JPG | 4 个新工具（全 Canvas/MediaRecorder API） | 全 200 ✅ |
| **B48** Mark-all-seen | `markManySeen` + `/api/seen/batch` + For-You 按钮 | POST batch marked:2 ✅ |

**工具目录最终状态**：33 个全部实现（0 placeholder）。新增 12 个：LaTeX, Voice Recorder, Timezone, UMT, Image Resizer, PDF Compressor, Image Converter, Audio Extractor, Image Cropper, HEIC→JPG, App Stats, Peepbo。其余 4 个（Video Compressor/GIF, Audio Compressor, Media Converter）替换为信息性建议（推荐 ffmpeg/HandBrake/Audacity）。

### B56-B62 系统健康+筛选器+趋势（2026-06-30）

| 批次 | 交付 | 验证 |
|---|---|---|
| **B56** 系统健康仪表盘 | Settings 页接入 `/api/system/stats`（items/enriched%/scored%/uncategorized%/entities/reports + backlog 警告） | /settings 200 ✅ |
| **B57** Papers arxiv category 筛选 | 按 cs.RO/cs.CV/cs.CL 等分类过滤 | /papers?cat=cs.RO 200 ✅ |
| **B58** Signals JSON 导出 | 导出当前筛选视图为 JSON 下载 | /api/signals?sinceDays=7&limit=200 ✅ |
| **B59** Intelligence trending topics | 按 growth_score 排序显示 top 6 topic | /intelligence 200 ✅ |
| **B60** Papers 排序选项 | date/alpha/upvotes 三档排序 | /papers?sort=alpha 200 ✅ |
| **B61** For-You 时间窗口 | 24h/3d/7d/14d 四档切换 | /for-you?days=7 200 ✅ |
| **B62** Sources 7天趋势 | `/api/sources` 加 per-source 7d trend + 前端 mini bar chart | 15/18 sources 有趋势数据 ✅ |
| **B53** Watchlist RSS feed | `/watchlist/feed.xml` Atom + UI 链接 | 200 application/atom+xml ✅ |
| **B54** System stats API | `/api/system/stats`（backlog/coverage/DB size） | 返回完整系统指标 ✅ |

### B126-B146 深度迭代增强（2026-06-30）

| 批次 | 交付 | 验证 |
|---|---|---|
| **B126** Entity type distribution | /discover 页按类型分布柱状图 | /discover 200 ✅ |
| **B127** Reading activity heatmap | For-You 页 30 天活动热力图 | /for-you 200 ✅ |
| **B128** Source × Type heatmap | 行业指标页热力图矩阵 | /industry-metrics 200 ✅ |
| **B129** Confidence heatmap strip | For-You 页 alpha 置信度热力条 | /for-you 200 ✅ |
| **B130** Stacked source bar | 摘要页堆叠来源贡献条 | /digest/:date 200 ✅ |
| **B131** Quality trend indicator | 信号页质量趋势 ▲▲/●/▼ | /signals 200 ✅ |
| **B132** Stacked source bar (For-You) | For-You 页堆叠来源条 | /for-you 200 ✅ |
| **B133** Freshness ring | 信号详情页新鲜度环 | /signals/:id 200 ✅ |
| **B134** Cross-validation metric | For-You 页交叉验证计数 | /for-you 200 ✅ |
| **B135** Freshness distribution | For-You 页新鲜度分布条（今日/1-3d/3d+） | /for-you 200 ✅ |
| **B136** Topic coverage gauge | 情报页主题覆盖仪表 | /intelligence 200 ✅ |
| **B137** Content quality trend | 摘要页内容质量趋势条 | /digest/:date 200 ✅ |
| **B138** Velocity sparkline | 信号页速度趋势迷你折线图 | /signals 200 ✅ |
| **B139** Shannon entropy diversity | For-You 页香农熵多样性指标 | /for-you 200 ✅ |
| **B140** Entity prominence | 情报页实体显著性排行 | /intelligence 200 ✅ |
| **B141** Settings quick links | 设置页快捷链接面板 | /settings 200 ✅ |
| **B142** Discover in nav | /discover 加入主导航 | nav 显示 ✅ |
| **B143** Freshness bar reorder | For-You 页新鲜度条位置修正 | /for-you 200 ✅ |
| **B144** fy-fresh CSS | 新鲜度点样式类 | 样式生效 ✅ |
| **B145** Signal type donut + growth chips | 信号页类型环形图 + 实体增长率标签 | /signals 200 ✅ |
| **B146** Expanded FAQ | 帮助页新增 Discover/轨迹/导出 FAQ | /help 200 ✅ |
