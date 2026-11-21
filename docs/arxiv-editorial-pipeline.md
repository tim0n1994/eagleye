# 每日 arXiv 工程师笔记

每日从 Eagleye 已入库的 arXiv 论文选出候选，读原文后产出同一期的 X 串帖、公众号文章和小红书图文。成稿进入私有审稿目录，由作者核对、修改，再在各平台后台发布。

## 参考风格

阅读样本包括三条可直接定位的原帖和 Eagleye 收录的工程案例。样本用来定叙事方法，文章事实全部来自当期论文。

| 样本 | 观察 | 在论文解读里怎么用 |
| --- | --- | --- |
| [过时文档与代码冲突](https://x.com/mylifcc/status/2114613498416419304) | 第一行讲一个读者认得的失败，再给实验次数和干预前后变化。 | 先交代实验遇到的任务，给出可比条件，再说明读者值得验证的做法。 |
| [核对 Agent 的测试记录](https://x.com/mylifcc/status/2122248377618559030) | 一句话抛出疑问，随后用一次明确的输入和输出回答。 | 短帖也要有可查的机制或观察。没有亲历时写「论文报告」，不代作者声称亲测。 |
| [Unity 工程插件](https://x.com/mylifcc/status/2112770862013128777) | 从 API 猜测和文件报错写起，顺着安装、技能和实际校验讲。 | 用操作链解释抽象方法。每个术语说明它在这一步承担的工作。 |
| [两台工作站做本地推理](https://x.com/mylifcc/status/2123190011873169420) | 先说显存和通信上的现实约束，再解释不同并行方式为什么会卡。 | 先讲瓶颈和替代方案，再解释数字在什么硬件、负载与基线下成立。 |
| [五周制作农场游戏](https://x.com/mylifcc/status/2123884588573536510) | 从结果和意外事件进入，随后用实际构建步骤解释背后的工程。 | 有反差就用细节说明来源。有研究限制就留出一句话讲清边界。 |

「工程师读论文」抓的是具体卡点、过程解释、实测条件和收尾的适用边界。X 用一个明确的问题切入，每条只推进一步。公众号用完整叙事讲明机制和对照。小红书逐张图卡安排问题、方法和适用条件。

## 工作流

1. `shortlist` 只读查询 Eagleye 的论文与入库时间。限最近 48 小时，排除既往记录与已有成稿的 arXiv ID。标题和摘要的关注词、实验线索及主题分散度都参与排序。期次按美西日期，论文的提交日期另存。
2. `daily` 从前三名中取第一篇有可回查正文证据的论文。支持人工从同一期选一至三篇并写一段自己的观察。读取 arXiv 版本化 HTML，失败后用 Poppler 的 `pdftotext` 读取 PDF 的前 24 页。人工选稿允许仅摘要输出，自动成稿要求方法或结果正文。
3. 模型按一个证据编号体系写三个平台。程序按编号直接取出原文段落，并检查正文和图卡引用、论文链接、字段和 X 计权长度。审稿单列出原文位置、解读主张和摘录，方便人工核对指标上下文。结论和外推仍需审稿。
4. 内置封面用问题、机制、边界画一张解读示意图。图中没有合成实验数据，原论文的实验图表可以由作者选定并替换。公众号和小红书沿用 Eagleye 的 HTML、Markdown、PNG 排版。
5. 每一期保存候选、可编辑稿件和发布包。重跑遇到现有稿件时保留用户的编辑。发布包只收录对外成品，证据审稿内容保留在期次目录中。

## 运行和改稿

在安装依赖的 Eagleye 目录运行。生成使用 Eagleye 配置的 `EAGLEYE_PUBLISHING_TEXT_MODEL` 和相应网关，未指定时沿用已有模型池。

```sh
node scripts/arxiv-editorial.js shortlist --db /path/to/eagleye.db --out /path/to/editions
node scripts/arxiv-editorial.js compose --out /path/to/editions --picks 2611.25905 \
  --angle '我想从工程取舍切入，先解释它对真实工作负载的影响'
node scripts/arxiv-editorial.js daily --db /path/to/eagleye.db --out /path/to/editions
node scripts/arxiv-editorial.js pack --dir /path/to/editions/YYYY-MM-DD/成稿
node scripts/arxiv-editorial.js pack --dir /path/to/editions/YYYY-MM-DD/成稿 --cover /path/to/my-image.png
```

- `选题清单.md` 对照候选和原始摘要。可用 `--focus` 传入逗号分隔的小写英文关注词，用 `--angle-file` 持久提供写作方向。
- `公众号正文.md` 直接改文字，保留对应的 `[E1]` 等证据标记。
- `稿件.json` 里改公众号标题、小红书文案和图卡，以及 X 的串帖。
- `封面.png` 可以替换。用 `pack` 重排版并重新生成 ZIP，继续使用已存的证据和文字。
- `证据与审稿.md` 用于确认四件事：题目是否兑现、方法解释是否符合原文、数字是否伴有基线和实验条件、限制有没有写明。

日程可用 [systemd 用户服务](../deploy/thinkpad/eagleye-arxiv-editorial.service) 与 [定时器](../deploy/thinkpad/eagleye-arxiv-editorial.timer)。服务从私有运行目录执行锁定版本，每日美西时间 07:30 检查，成功产出后保留该期。模型失败时保留候选，日志可以用 `journalctl --user -u eagleye-arxiv-editorial.service` 查看。

沿用 [Cheerio](https://github.com/cheeriojs/cheerio) 抽取 HTML，[Poppler](https://poppler.freedesktop.org/) 读取 PDF，[twitter-text](https://github.com/twitter/twitter-text) 验证标准 X 帖计权长度，[resvg-js](https://github.com/thx/resvg-js) 和 [JSZip](https://github.com/Stuk/jszip) 绘制并打包，已有生产站的创作工作区和账号数据由原服务管理。
