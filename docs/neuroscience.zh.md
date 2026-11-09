# 脑科学专题（2026-11-09）

入口 `/neuroscience`，接口 `/api/neuroscience`。四类内容：研究论文、脑机接口与信号、开源工具与数据、社区实践。支持 30/90/180 天、来源过滤及 24 条分页。显示预印本、期刊内容、官方版本、社区讨论的来源类型；期刊 feed 也可能含评论、更正和关注声明，具体评审状态以原文为准。

## 独立来源

- arXiv q-bio.NC：神经与认知预印本，复用 arXiv Atom API，每轮最多 40 条。
- Nature Neuroscience：https://www.nature.com/neuro.rss
- eLife 神经科学：https://elifesciences.org/rss/subject/neuroscience.xml
- MNE-Python：https://github.com/mne-tools/mne-python/releases.atom
- PyNWB：https://github.com/NeurodataWithoutBorders/pynwb/releases.atom
- BrainFlow：https://github.com/brainflow-dev/brainflow/releases.atom
- Neurostars：https://neurostars.org/latest.rss

项目选择参考 GitHub awesome-neuroscience 社区目录及官方项目；研究、社区来源通过实际 XML 订阅确认。RSS/Atom 每个来源沿用已有条件请求、时间窗、错误记录和去重，每轮最多 30 条。不抓取每次提交，不改变个人 X 关注配置。

搜索确认的 Allen Institute X 账号 https://x.com/AllenInstitute 仅作为“延伸关注”链接，未声称已自动抓取。此次自动采集全部通过独立公共来源。社区目录为发现工具提供线索，不将目录本身当作研究结论。

## 读取与分类

后端仅读取上述专题来源；不会以通用 neural network 关键词把普通深度学习新闻混入脑科学。研究来源中标题明确含脑机接口、EEG/MEG、神经假体线索的条目归入脑机接口与信号，其余保留研究分类；BrainFlow 版本更新归入信号工具。分类与来源类型分别保存，预印本仍显示预印本。

`(source_id, published_at DESC)` 复合索引支持每个来源最多 400 条时间窗内非重复记录，超过上限明确标记为部分结果。按原文 URL 再去重后全局排序，过滤和分页共用一分钟缓存，缓存最多三个时间窗。页面按需加载，无外部请求、模型调用或新增依赖。暂停来源的历史条目仍可阅读，暂停状态单独展示。

数据库迁移 053 为增量来源登记和索引，不改动已有来源启用状态。上线后通过已有 fetch-source 后台任务做首次真实采集，不额外触发生成或翻译任务。基础验证包括语法、订阅连通、服务启动和接口读取，真实内容质量由用户验收。
