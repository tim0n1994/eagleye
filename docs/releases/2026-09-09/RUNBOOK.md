# Eagleye 1.1 启动、验收与回退

## 运行环境

- Node `^22.21.0 || >=24.5.0`，当前验收为 22.22.2；内建 HTTP(S) Agent 的环境代理支持要求该版本范围。
- Python ≥3.11、uv；KG 依赖由 `kg-worker/pyproject.toml` 管理。
- 一个 Node 服务进程共享一个模型池。多个进程的并发额度不会跨进程共享。
- 端点网关须先启动；本轮五条路由均是 `127.0.0.1:56185` 的 Anthropic Messages 协议，不能按 Gemini/DeepSeek 名称改成其他协议。

在仓库根目录安装依赖：

```sh
npm ci --legacy-peer-deps
uv sync --project kg-worker
```

当前 npm 10.9.7 在更新 Vitest 的可选 peer 图时出现 Arborist `edgesOut` 错误；采用 `--legacy-peer-deps` 后安装成功，随后 `npm ls --all` 和安全审计通过。Vitest 与 coverage-v8 保持同一 4.1.11 补丁版本。没有安装未经审查的全局工具。

## 本次隔离候选

```sh
cd /Users/chillbit/Proj/eagleye
EAGLEYE_DB_PATH=/Users/chillbit/.codex/tmp/eagleye-1.1-acceptance.sqlite \
EAGLEYE_HOST=127.0.0.1 \
PYTHONDONTWRITEBYTECODE=1 \
node server.js 3029
```

访问 `http://127.0.0.1:3029`。当前管理员浏览器会话可查看配置。验收副本含专门的测试账户，不能作为生产账户库直接发布。原业务库位于仓库根目录 `eagleye.db`，本轮没有替换它。

正式切换必须先选择目标数据库、确认备份及账户，再使用 `EAGLEYE_DB_PATH` 启动。省略该变量会使用原数据库，启动时会应用迁移；不要把隔离验证命令误改成无变量启动。新库的自助注册需要可用的 `RESEND_API_KEY` 与邮件发件配置；当前未验证真实投递。

## 备份与回退

SQLite 使用 WAL，运行时备份应通过 SQLite backup API，不能只复制 `.db` 而忽略 WAL。以下脚本拒绝覆盖已存在的目标，输入与输出路径应明确选择：

```sh
python3 -B - "$SOURCE_DB" "$NEW_BACKUP_DB" <<'PY'
import os, sqlite3, sys
from pathlib import Path
source = Path(sys.argv[1]).resolve(strict=True)
target = Path(sys.argv[2]).resolve()
fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
os.close(fd)
with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as src:
    with sqlite3.connect(target) as dst:
        src.backup(dst)
PY
```

回退时先终止本次启动的 Eagleye 进程，保留出错的候选文件及日志；用备份的另一个文件路径启动已确认的代码版本。不要对当前含既有未提交工作的目录执行 `reset --hard` 或全目录 restore。本次未创建发布提交，因此不能把当前分支名当成已锁定发布版本。

SIGTERM/SIGINT 会停止调度、关闭模型池并终止本模块创建的 KG 子进程组。最多等待 10 秒，然后把未完成任务标为中断。重启不自动重放这些任务；管理员根据阶段产出选择有限批量重试。

## 配置与任务预算

管理员在设置页粘贴完整多端点块、检查路径与协议后保存。密钥只存本地运行配置；修改并发或任务范围不需要重新输入密钥。设置文件/数据库应按凭据文件管理，不纳入发布包。

本轮保留全局并发 5、单路 1、队列上限 100、请求总时限 120 秒、排队时限 30 秒、最多 2 次不同路由尝试。不要根据单次实验直接调高到 10 或 20。`lane-1` 出现过一次真实摘要 HTTP 错误，但后续分类、结构化研究成功；错误记录保留，持续观察不同任务失败率再调整各路任务范围。

只读任务状态：`GET /api/jobs/:id`。取消：`POST /api/jobs/:id/cancel`。管理员受控样例：

```text
POST /api/jobs/fetch-source?slug=hacker-news&limit=5&date=20260909
POST /api/jobs/fetch-source?slug=github-trending&limit=5&date=20260909
POST /api/enrich?batch=20&background=true
```

日期需要换成实际目标日期。受控单源抓取跳过隐含富集；HN 最多一个列表加指定数量详情请求，GitHub/HF 一次列表请求后限制入库条数。其他旧连接器的网络请求上限尚未逐一验收。

定时调度默认保持关闭。启用前检查服务端时区、任务类型、下一次时间和最近结果；遇到 `enqueue_unknown` 不自动重复当天付费任务，先查看现有任务记录。

## 工程与性能复现

```sh
npm run test:coverage -- --maxWorkers=4
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=kg-worker python3 -B -m unittest discover -s kg-worker/tests -v
npm run lint
npm run knip
npm audit
git diff --check
```

覆盖率报告当前配置仅统计前端 modules，不能将该百分比当成后端覆盖率。后端通过单独的行为测试验证权限、迁移、队列、协议、取消和输出契约。

吞吐复现会产生真实模型请求，须显式提供私密配置及新的输出路径：

```sh
node scripts/acceptance/benchmark-llm-pool.js \
  --config "$PRIVATE_CONFIG" \
  --output "$NEW_BENCHMARK_REPORT"
```

输入为 `{ "endpoints": [...] }`，每条至少包含 `id`、`protocol`、完整 `endpoint_url`、`api_key`、`model`。必须恰有五条且包含 `lane-5`。不要将真实 key 写入示例、命令历史或源码。测试样本是明确的合成事实，不写业务库。
