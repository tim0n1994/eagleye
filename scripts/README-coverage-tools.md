# Round 2 影子对比工具与门禁证据（审计链保全）

CTO 方案要求「覆盖率先行影子对比（同 24h 窗、30 随机账号、feed vs user-posts
按 canonical_url），<95% 停下不部署」。本目录保全判定所用的两个只读测量
工具与 2026-10-20 会话的三份判定输出快照（原文见 `coverage-evidence/`），
使合并/部署裁定的事后审计可复现。两工具均 READ-ONLY、不触碰 DB；凭据从
`/home/jc/.config/argus/eagleye-twitter.credentials` 等 env 文件加载，值
never printed or written（见 shadow-coverage.py 头注）。

## 工具与口径

### scripts/shadow-coverage.py — 字面口径直接对比
- 同一滑动 24h 窗：feed 侧 1 次 `twitter feed -t following -n 200 --json`；
  baseline 侧 30 账号串行 `twitter user-posts -n 40 --json`（每调用间
  INTERCALL_SLEEP_S=5s，较生产 4 并发 worker 更温和）。
- 样本：config/x-following.txt 以 SEED=20261020 固定随机抽 30 账号。
- 匹配键：canonical_url（`https://x.com/<screenName>/status/<id>`，小写
  归一），coverage = |baseline ∩ feed| / |baseline|。
- CLI 调用量：31 次/run vs 当时生产 442 user-posts/day（红线：不超当前
  水平——影子对比调用量已计入）。
- `--selftest` 纯函数自测，不发起 CLI 调用。

### scripts/deep-coverage.py — 深度测量（shadow 首测 0% 后的追因）
- 实测 CLI 单调用上限：`-n 3000` 实返 200（rateLimit.maxCount 默认）；
  临时 config 提到 maxCount=500 后 `-n 500` 实返 500（绝对上限，client.py
  `_ABSOLUTE_MAX_COUNT`）→ 单次调用覆盖 24h 不可能，增量 cadence 是唯一
  可行 feed 路径。
- 四个模型（常量前缀输出）：DIRECT（单拉下界）、REPLAY（快照回放下界）、
  CADENCE（密度兜底捕获模型，主判）、CURSOR（游标停止设计警告）。
- CADENCE 假设：R1 rank 单调恶化（rank_monotonicity_assumed）、R2 负载
  上界来自观测直方图、回复（leading @mention）视为 timeline 不可见。

## 判定输出快照（coverage-evidence/，原文摘录）

| 文件 | 判定 | 关键数字（原文） |
|---|---|---|
| shadow-coverage-run.out | 字面口径首测 | `coverage_pct=0.0 cli_calls=31 errors=7`（AGGREGATE baseline_union=35 matched=0） |
| recompute-deep.out | 修 runner 丢弃 bug 后复算 | `coverage_pct=4.29`（baseline_union=70 matched=3 errors=0） |
| deep-analysis.out | 深测 + 模型 | DIRECT `coverage_pct=21.43`；CADENCE(2h,n=200) `coverage_pct=100.0`；`CURSOR_WARNING ancient_items_rank_positions=[25,71,79,85,110,138,143,158,168,174] min_rank=25`；`LIMITATIONS ... rank_monotonicity_assumed=true` |

## 结论与状态（截至 2026-10-20 会话）

- 按 CTO 字面口径实测 0.0% / 4.29%，均 < 95% 停机线 → 未放行部署。
- `RECOMMENDED cadence=2h n=200 coverage_pct=100.0` 是 CADENCE 模型值，
  其 R1（rank 单调）假设恰被同一快照的 CURSOR_WARNING 实测违反（>7 天
  古老/置顶条目位于 200 条快照第 25 位起）——纯游标停止会截断翻页。
  部署裁定必须等游标最小页地板修复（Round 2 ① blocker）后重出，不得
  引用模型值放行。
- 原始 CLI 响应快照在运行机器 `/tmp/shadow-coverage-raw-<epoch>/`（本地
  临时目录，不随仓库保全；重跑工具即可再生成）。

## CTO 更正（2026-10-21 01:30）—「89/442」系截断假象

- 早期会话结论「（会话）关注 551 账号中仅 89 个在配置 442 内——feed-only
  过滤会困住 ≈80% 配置内容」是 **list_fetched=200 截断假象**：关注列表经
  CLI 拉取时被单调用 200 条上限截断，交集被人为压小。
- JC 手动导出核对实况：**439/442** 配置账号在关注列表（仅 alex_prompter /
  pluvio9yte / PunkAnimates 不在）。静态导出位于
  `/home/jc/.config/argus/x-following-set.json`；本更正以「只计数、不打印
  内容」方式复核：`config_n=442 exported_n=455 in_both=439
  config_not_in_export=3`。
- **裁决不变、理由更正**：「默认回退 per-user」维持，理由只写「字面覆盖率
  未达标」（上表 0.0/4.29 与 DIRECT 21.43 均 <95% 停机线），不得再引用
  结构性缺口作为依据。
- **禁 API 拉取**：程序禁止用 JC 账号拉关注列表——`twitter following` /
  `twitter whoami` 一律禁止（含影子工具）。任何基于关注列表的核对只能读
  上述静态导出，且只输出计数，不得打印列表内容。
- 工具现状核验（2026-10-21 grep，本仓库 scripts/）：shadow-coverage.py /
  deep-coverage.py 仅发起 `feed -t following` 与 `user-posts` 两类 CLI
  调用，无 whoami、无 following 列表拉取——无需改动调用；connector
  （server/connectors/x-following.js）同样只调用 feed，作者过滤读 config
  文件。同一结论表述（connector docstring、两个模式测试头注、
  deploy/thinkpad/README-x-following-incremental.md）已同批更正。

## 重跑

```bash
python3 scripts/shadow-coverage.py --selftest   # 无 CLI 调用
python3 scripts/shadow-coverage.py              # 需 twitter CLI env（约 31 次调用）
python3 scripts/deep-coverage.py                # 深测（见文件头 PLAN/预算说明）
```

（本 README 由 HN 泳道代为落地：现场实测泳道未署名、属主缺位，评审判定
为 Round 2 放行的唯一残留非代码项。）
