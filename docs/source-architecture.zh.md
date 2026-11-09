# 信息源架构与补充（2026-11-09）

公共来源、实例级 X 网络、专题来源共用现有定时采集 → 规范化、去重与原文留存 → 专题筛选 → 页面只读数据库的链路。页面不触发外部抓取，不新增前端依赖。

公共来源对照附件 OrangeBot，包括 HN、GitHub、Product Hunt、Hugging Face、Techmeme、Solidot、App Store。Eagleye 直接采集上游，并非抓取 OrangeBot 快照；GitHub 当前是仓库搜索而非严格 Trending；WSJ 尚未接入；App Store 当前是美国免费/付费榜各 25 项，并非全品类。

X 的 feed 模式读取 Following 时间线；hybrid 模式增加受冷却限制的逐账号降级；per-user 是逐账号模式。静态名单与历史导出仅做差异核对，不等于实时关注列表，不自动增删。管理员可见数量差异，不返回账号或本地路径。未读取到导出时显示未知；当前配置列表计数不是实际时间线覆盖人数。

## 新增六个可订阅来源

| 板块 | 上游 | 用途 |
|---|---|---|
| 具身 | https://github.com/huggingface/lerobot/releases.atom | 成熟机器人学习项目的正式版本 |
| 具身 | https://github.com/isaac-sim/IsaacLab/releases.atom | 仿真、训练框架正式版本 |
| 具身 | https://planet.ros.org/rss20.xml | ROS 开发者实践，聚合社区博客 |
| AI 教育 | https://github.com/CAHLR/OATutor/releases.atom | 自适应辅导系统正式版本 |
| AI 教育 | https://github.com/HKUDS/DeepTutor/releases.atom | 个性化 AI 辅导项目正式版本 |
| AI 教育 | https://discuss.openedx.org/latest.rss | 最新讨论中含 AI/LLM/智能辅导的内容，非论坛全量 |

四个 GitHub 项目分别追踪 release，不采集每次 commit。每个来源独立健康状态；一次读取一个 feed，最多保留 30 条，复用现有条件请求、超时重试、36 小时时间窗和去重。无近期发布可以正常返回零条，不能据此判断停摆。新来源等下一轮定时采集，不自动回填旧发布、不触发额外 LLM 任务。

在原始标题前加上可追溯的项目/领域上下文，原标题仍保存在 source_payload.original_title，原发布 URL 和时间保留。具身新增“工程与社区”分类，避免把发布说明误标为论文、已验证落地或已校验许可证的开源资源。AI 教育沿用 AI 与教育双重相关性筛选。

Open Robotics 的论坛订阅和 Open edX 官网博客订阅本次连通检查未成功，未接入；前者以可读取的 ROS Planet 补充。OpenVLA 等无稳定 release 节奏的项目暂不扩展到逐提交抓取。

## 状态与验证边界

来源页可见已停用来源，并分别展示启用状态、最近失败、首次待抓取、最近成功时间与内容数量。默认 /api/sources 仍只返回启用来源，include_disabled=1 才包含停用行。只做语法、订阅可读取、启动和接口连通检查；真实内容质量由用户在线验收。
