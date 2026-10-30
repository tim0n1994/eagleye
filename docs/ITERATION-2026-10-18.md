# Eagleye 上线 ThinkPad 后的第一次迭代（2026-10-18）

## 核心定位（唯一主线）

Eagleye = **个人技术情报管线**：多源采集（X/小红书/Reddit/RSS/HN/arXiv/GitHub 等 18 源）
→ LLM 富化（中文知识卡片 + 实体/主题图谱）→ 每日日报 → Web UI + MCP 消费。

社区对标（ai-news-brief / TrendRadar / personal-knowledge-base）验证：这个闭环就是全部核心。

## 依据（运行时与数据证据）

- LLM 任务全史：enrich 3008 / classify 1328 / translate 793 / graph 145 / digest 72 / general 8。
- 活跃 job：full-pipeline / enrich-items / translate-backfill / fetch-source。
- 死透的功能：item-research（8/1 停）、score-signals（6/29 停）、research_reports（8/9 停）、
  signal_scores（6 月测试数据）、skills 表（无时间戳）、saved_items/research/topic_embeddings（0 行）。
- ES：thinkpad 无 ES 容器、.env 为空占位、embeddings.js 零引用——全链路死代码；搜索由 FTS5 承担。
- kg-worker venv（181MB fastembed/onnx）：主服务未设 hash 后端，item_vectors 73k 行，**在用，保留**。

## 砍削清单（本轮执行）

1. **Elasticsearch 全链路**：services/{elasticsearch,es-ai-setup,es-rag,embeddings}.js、
   routes/elasticsearch.js、js/modules/es-search-v2.js、api.js/app-main.js 挂载、.env ES_*。
2. **深研模块**：services/{research,skill-crawler}.js、routes/research.js、pages/research.js、
   jobs.js 的 item-research 注册、相关测试。历史数据表保留只读。
3. **前端工具箱**：js/modules/tools/（calc/devnet/files/image/media/shell/text）与 tools.js
   ——与情报管线无关的浏览器玩具。
4. **signals 评分半区**（谨慎项）：score-signals/rescore-all 注册与 signals-score/signal-rescore，
   仅当 full-pipeline 无引用时执行；signals-classify（活跃）保留。

## 归总

- 模型接入对齐 THINKPAD-MODEL-CONFIG.md：唯一入口 http://<private-test-address>:4000、
  global_concurrency 6→4（规范 §0.6 批量并发 ≤4）、.env 清死配置并落 LLM_* 规范变量。
- 搜索统一 FTS5；llm_config 兜底指向网关 auto。

## 核心优化

- 启动链路减负（ES 初始化移除）；enrich 并发结构维持（Gemini 优先 + auto 兜底，已实战验证）；
- 服务重启后 01:00 pipeline 验收为准。

## 明确不做（本轮）

- i18n 层拆除（扰动大收益小）；kg venv 瘦身（fastembed 在用）；DB VACUUM（风险大于收益）。

## 追加：吞吐迭代（2026-10-19 上午，ULW 小步）

**测量**：积压 8502 中 94% 是 x-following（7995）；非 x 源日增仅 ~126 条。
x-following 本就是 priority 0（用户关注流），问题不是选择而是吞吐与持续性。

**三步落地**：
1. 快车道：lane-1 → configured-primary-model（p2），新增 lane-3 auto 兜底（p3）；configured-fallback-model 保持
   enrich/translate 优先（p1，实测 18.8s/4卡批 ≈ 主力）。
2. 持续消化：~/.local/bin/eagleye-drain.py + argus-eagleye-drain.timer
   （每 2h，积压>200 时自动 fire batch=600 后台 enrich）。
3. 实测稳定吞吐 ~2700 卡/小时、零失败 → 日增 1400 需 ~35min 消化，积压可在数个
   窗口内清零。每日 01:00 pipeline 照旧。

**教训**：auto 均速 117s 的「慢」是死部署重试链的窗口现象（单测 3.8s），
评测模型延迟要用真实批提示 + 看分布而非均值。
