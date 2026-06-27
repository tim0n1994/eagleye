/**
 * Eagleye — i18n module
 *
 * Simple dictionary-based translator with English (en) and Chinese (zh).
 *   t('key')                          → translated string
 *   t('hello_name', {name: 'JC'})     → substituted string with {name} placeholders
 *   setLanguage('zh')                 → switch + persist + dispatch 'eagleye:langchange'
 *   getLanguage()                     → 'en' | 'zh'
 *
 * Missing keys fall back to English, then to the key itself.
 */

const STORAGE_KEY = 'eagleye-lang';

const DICTIONARY = {
  en: {
    // ── Brand / chrome ──
    'brand.subtitle': 'INTELLIGENCE RADAR',
    'brand.tagline': 'AI-Driven Technology Intelligence',
    'lang.toggle': '中文 / EN',
    'lang.switchTo': 'Switch to English',
    'nav.news': 'News',
    'nav.papers': 'Papers',
    'nav.digest': 'Daily Digest',
    'nav.topics': 'Topics',
    'nav.signals': 'Signals',
    'nav.sources': 'Sources',
    'nav.tools': 'Tools',
    'nav.skills': 'Skills',
    'nav.tags': '🏷️ Tags',
    'nav.kg3d': '🧠 KG 3D',
    'nav.physical_ai': 'Physical AI',
    'nav.intelligence': 'Intelligence',
    'nav.industry': 'Industry Metrics',
    'nav.settings': 'Settings',
    'header.title_attr': 'Settings — LLM Endpoint',
    'header.theme_attr': 'Toggle Dark/Light Theme',
    'header.graph_attr': 'Knowledge Graph',
    'header.sync_attr': 'Sync Sources',
    'header.sidebar_attr': 'Toggle Sidebar',
    'header.close_sidebar_attr': 'Close sidebar',
    'system.online': 'SYSTEMS ONLINE',
    'system.ready': 'System ready. Waiting for activity...',
    'system.cleared': 'Log cleared.',
    'system.research_failed': 'RESEARCH FAILED',

    // ── Footer ──
    'footer.read': 'Read',
    'footer.make': 'Make',
    'footer.company': 'Company',
    'footer.follow': 'Follow',
    'footer.about': 'About',
    'footer.faq': 'FAQ',
    'footer.privacy': 'Privacy',
    'footer.terms': 'Terms',
    'footer.saved': 'Saved',
    'footer.copyright': '© {year} Eagleye. Open source.',

    // ── Right sidebar ──
    'sidebar.agents': 'AGENT PROGRESS',
    'sidebar.log': 'MESSAGE LOG',
    'sidebar.idle': 'IDLE — No active research',
    'sidebar.clear': 'Clear log',

    // ── Common UI ──
    'common.loading': 'LOADING...',
    'common.error': 'Error',
    'common.empty': 'No items yet. Try triggering a sync.',
    'common.original': 'ORIGINAL',
    'common.deep_research': 'Deep Research',
    'common.connecting_graph': 'CONNECTING TO KNOWLEDGE GRAPH...',
    'common.graph_void': 'GRAPH DATA VOID',
    'common.graph_error': 'Graph Error: {msg}',
    'common.analysing': 'ANALYZING SIGNAL...',
    'common.search_ph': 'SEARCH SIGNALS...',
    'common.last_updated': 'LAST UPDATED',
    'common.synced': 'Synced',
    'common.signal_lost': 'SIGNAL LOST // NO ITEMS FOUND',
    'common.research_analysing': 'Analyzing signal, please wait...',
    'common.researching': 'Researching: {title}',
    'common.start_research': 'Starting deep research: {title}',
    'common.collecting': 'Collecting context from sources...',
    'common.research_success': 'Research report generated successfully',
    'common.research_error': 'Research error: {msg}',
    'common.deploy_unavailable': 'Deployment analysis not yet available for this item.',
    'common.deploy_generating': 'GENERATING DEPLOYMENT PLAN...',
    'common.deploy_feasibility': 'ANALYZING DEPLOYMENT FEASIBILITY...',
    'common.research_agent': 'Research Agent',
    'common.context_collector': 'Context Collector',
    'common.llm_analyst': 'LLM Analyst',
    'common.analyzing': 'Analyzing...',
    'common.waiting': 'Waiting',
    'common.done': 'Done',
    'common.complete': 'Complete',
    'common.error_cap': 'ERROR',
    'common.fetching': 'Fetching data',

    // ── Home / News ──
    'home.eyebrow': 'INTELLIGENCE RADAR',
    'home.title': 'Today in Technology',
    'home.subtitle': 'Curated signal from {n} sources across the AI & software frontier.',
    'home.today': 'TODAY',
    'home.view_all': 'View full archive',
    'home.empty': 'No items captured for {date}. Run a sync to populate the feed.',
    'home.filter_all': 'All Sources',
    'home.search_ph': 'Search signals...',
    'home.issue_date_today': '(TODAY)',

    // ── Digest ──
    'digest.title': 'Daily Digest',
    'digest.subtitle': 'AI-curated briefings generated every 24 hours.',
    'digest.empty': 'No digest yet for {date}. The daily brief auto-builds at 00:00.',
    'digest.today': 'Today',
    'digest.yesterday': 'Yesterday',
    'digest.days_ago': '{n} days ago',
    'digest.view_full': 'View Full Digest',
    'digest.popular': 'Most Discussed',

    // ── Sources ──
    'sources.title': 'SOURCES',
    'sources.subtitle': 'All information sources at a glance',
    'sources.tab_all': 'All',
    'sources.total': '{n} total',
    'sources.today_count': '{n} today',
    'sources.detail_subtitle': 'Latest items from this connector',
    'sources.items_count': '{n} items',
    'sources.visit': 'Visit Source →',
    'sources.feed': 'Feed',
    'sources.all_sources': 'All Sources',
    'sources.no_items': 'No items yet. Try triggering a sync.',
    'sources.nav_collapse': 'Collapse source list',
    'sources.nav_expand': 'Expand source list',
    'sources.jump_to': 'Jump to source',

    // ── Topics ──
    'topics.title': 'TOPICS',
    'topics.subtitle': 'Live graph + curated watchlist',
    'topics.all': 'All',
    'topics.detail_subtitle': 'Connected entities, related items, and sub-topics',
    'topics.auto_yes': 'Yes',
    'topics.auto_no': 'No (seed)',
    'topics.items': '{n} items',
    'topics.entities': '{n} entities',
    'topics.related_topics': 'Related Topics',
    'topics.recent_items': 'Recent Items',
    'topics.all_items': 'View all {n} items',

    // ── Tools ──
    'tools.title': 'TOOLS',
    'tools.subtitle': 'Browser-based utilities for makers',
    'tools.all': 'All',
    'tools.search_ph': 'Search tools...',
    'tools.count': '{n} tools',
    'tools.use_tool': 'Open tool →',

    // ── Skills ──
    'skills.title': 'SKILLS',
    'skills.subtitle': 'Curated agent skills from the open-source community',
    'skills.search_ph': 'Search skills...',
    'skills.all': 'All',
    'skills.install_cmd': 'INSTALL COMMAND',
    'skills.unknown_author': 'Unknown',

    // ── Physical AI ──
    'physical.title': 'PHYSICAL AI BRIEF',
    'physical.subtitle': 'Robotics, embodied AI, and frontier compute',
    'physical.empty': 'No items yet. Sources will be populated on next sync.',
    'papers.title': 'Papers',
    'papers.subtitle': 'Open preprints from Hugging Face Papers, arXiv AI, and embodied AI research streams.',
    'papers.empty': 'No papers yet. Run the full pipeline to populate this view.',
    'papers.all': 'All Papers',
    'papers.with_pdf': 'With PDF',
    'papers.tagged': 'Tagged',

    // ── Intelligence / Industry ──
    'intel.title': 'INTELLIGENCE',
    'intel.subtitle': 'Cross-source trends and topic velocity',
    'signals.trending_subtitle': 'Cross-source trends and topic velocity',
    'signals.trending_entities': 'Trending Entities',
    'signals.no_momentum_data': 'No entity momentum data yet. Run the full pipeline to populate.',
    'signals.mentions': 'Mentions',
    'signals.sources': 'Sources',
    'signals.velocity_zscore': 'Velocity (z-score)',
    'signals.source_quality': 'Source Quality',
    'signals.noise_rate': 'Noise rate',
    'signals.system_metrics': 'System Metrics',
    'signals.enriched_items': 'Enriched items',
    'signals.graph_edges': 'Graph edges',
    'signals.entities_count': 'Entities',
    'signals.noisy': 'Noisy',
    'signals.early_signal': 'Early Signal',
    'signals.originator': 'Originator',
    'signals.amplifier': 'Amplifier',
    'industry.title': 'INDUSTRY METRICS',
    'industry.subtitle': 'Top sources, domains, and adoption signals',

    // ── Settings (LLM) ──
    'settings.title': 'SETTINGS',
    'settings.subtitle': 'Configure the LLM endpoint that powers summarization, daily digest, research, and deployment plans.',
    'settings.current': 'CURRENT ENDPOINT',
    'settings.paste': 'PASTE ENDPOINT CONFIG',
    'settings.direct': 'OR EDIT FIELDS DIRECTLY',
    'settings.after': 'AFTER SAVING',
    'settings.provider': 'PROVIDER',
    'settings.base_url': 'BASE URL',
    'settings.model': 'MODEL',
    'settings.api_key': 'API KEY',
    'settings.source': 'SOURCE',
    'settings.updated': 'UPDATED',
    'settings.load_sample': 'LOAD SAMPLE',
    'settings.parse': 'PARSE',
    'settings.save_activate': 'SAVE & ACTIVATE',
    'settings.save_fields': 'SAVE FIELDS',
    'settings.reset': 'RESET TO .ENV',
    'settings.test': 'TEST ENDPOINT',
    'settings.fields_provider': 'Provider',
    'settings.fields_base_url': 'Base URL',
    'settings.fields_model': 'Model',
    'settings.fields_api_key': 'API Key',
    'settings.saving': 'Saving…',
    'settings.parse_failed': '⚠ {msg}',
    'settings.no_config': 'No config returned',
    'settings.source_env': 'ENV FALLBACK',
    'settings.source_runtime': 'RUNTIME',
    'settings.saved_active': 'Active endpoint: {base} ({model})',
    'settings.test_ok': '✓ Endpoint responds. PONG received.',
    'settings.test_fail': '✗ Endpoint failed: {msg}',
    'settings.enrich_hint': 'Run enrichment with the new endpoint:',
    'settings.digest_hint': 'Rebuild today\u2019s digest:',
    'settings.empty': 'No endpoint configured yet. Paste one above or use the direct fields.',

    // ── Operations card (data ingestion) ──
    'ops.title': 'DATA OPERATIONS',
    'ops.subtitle': 'Trigger fetch, enrich, digest, and translation jobs manually.',
    'ops.sync': 'SYNC ALL SOURCES',
    'ops.sync_desc': 'Fetch latest items from all 15 connectors (Hacker News, GitHub, etc.).',
    'ops.enrich': 'ENRICH ITEMS',
    'ops.enrich_desc': 'Generate AI summaries for items without cards. Priority queue: X, Hacker News, GitHub Trending, Hugging Face. Default queue: 1600 items; local LLM sub-batch: 20 with 10 parallel workers.',
    'ops.digest': 'BUILD DIGEST',
    'ops.digest_desc': 'Rebuild today\u2019s executive digest from enriched items.',
    'ops.pipeline': 'FULL PIPELINE',
    'ops.pipeline_desc': 'Fetch → Enrich → Digest in one shot. Slowest but most complete.',
    'ops.translate': 'BACKFILL TRANSLATIONS',
    'ops.translate_desc': 'Translate all pending item titles + feed summaries to Chinese.',
    'ops.xsync': 'SYNC X FOLLOWING',
    'ops.xsync_desc': 'Fetch latest tweets from your configured X account list (Jina Reader).',
    'ops.running': 'Running…',
    'ops.queued': 'Queued: {id}',
    'ops.done': '✓ Done: {msg}',
    'ops.failed': '✗ Failed: {msg}',
    'ops.jobs': 'RECENT JOBS',
    'ops.stop': 'STOP',
    'ops.cancelling': 'Cancelling…',
    'ops.cancelled': '⛔ Cancelled',
    'ops.stream_idle': 'Idle',
    'ops.stream_running': '⏳ Running {elapsed}s',
    'ops.stream_done': '✓ Done in {elapsed}s',
    'ops.stream_failed': '✗ Failed after {elapsed}s',
    'ops.stream_cancelled': '⛔ Stopped at {elapsed}s',

    // X Following config (bilingual)
    'xconfig.title': 'X (TWITTER) FOLLOWING',
    'xconfig.subtitle': 'Curated list of X accounts. Tweets are fetched via Jina Reader (no API key, no login).',
    'xconfig.users': 'X USERS (one per line, no @)',
    'xconfig.save': 'SAVE LIST',
    'xconfig.saved': '✓ Saved {n} users',
    'xconfig.load_error': '⚠ Could not load config: {msg}',
    'xconfig.blocklist_title': 'BLOCKED ACCOUNTS',
    'xconfig.blocklist_subtitle': 'Posts from these handles are filtered before saving and can be purged from signals.',
    'xconfig.blocklist_ph': 'noisy_handle1\nnoisy_handle2',
    'xconfig.save_blocklist': 'SAVE BLOCKLIST',
    'xconfig.blocklist_saved': '✓ Saved {n} blocked handles',
    'xconfig.cleanup': 'PURGE FROM SIGNALS',
    'xconfig.cleanup_running': 'Purging…',
    'xconfig.cleanup_done': '✓ Purged {n} signal scores',

    // ── News item card ──
    'item.rank': 'RANK #{n}',
    'item.visit': 'VISIT',
    'item.summary_na': 'No summary available.',

    // ── Research modal states ──
    'research.title': 'Deep Research',
    'research.failed_title': 'Research Failed',
  },
  zh: {
    'brand.subtitle': '情报雷达',
    'brand.tagline': 'AI 驱动的科技情报',
    'lang.toggle': 'EN / 中文',
    'lang.switchTo': '切换为中文',
    'nav.news': '新闻',
    'nav.papers': '论文',
    'nav.digest': '每日简报',
    'nav.topics': '主题',
    'nav.signals': '信号',
    'nav.sources': '信息源',
    'nav.tools': '工具',
    'nav.skills': '技能',
    'nav.tags': '🏷️ 标签',
    'nav.kg3d': '🧠 知识图谱3D',
    'nav.physical_ai': '具身 AI',
    'nav.intelligence': '情报分析',
    'nav.industry': '行业指标',
    'nav.settings': '设置',
    'header.title_attr': '设置 — LLM 接口',
    'header.theme_attr': '切换深色/浅色主题',
    'header.graph_attr': '知识图谱',
    'header.sync_attr': '同步数据源',
    'header.sidebar_attr': '切换侧边栏',
    'header.close_sidebar_attr': '关闭侧边栏',
    'system.online': '系统已就绪',
    'system.ready': '系统就绪，等待活动...',
    'system.cleared': '日志已清空。',
    'system.research_failed': '研究失败',

    'footer.read': '阅读',
    'footer.make': '工具',
    'footer.company': '公司',
    'footer.follow': '关注',
    'footer.about': '关于',
    'footer.faq': '常见问题',
    'footer.privacy': '隐私',
    'footer.terms': '条款',
    'footer.saved': '收藏',
    'footer.copyright': '© {year} Eagleye. 开源.',

    'sidebar.agents': '智能体进度',
    'sidebar.log': '消息日志',
    'sidebar.idle': '空闲 — 无正在运行的研究',
    'sidebar.clear': '清空日志',

    'common.loading': '加载中...',
    'common.error': '错误',
    'common.empty': '暂无内容。请尝试同步。',
    'common.original': '原文',
    'common.deep_research': '深度研究',
    'common.connecting_graph': '正在连接知识图谱...',
    'common.graph_void': '图谱数据为空',
    'common.graph_error': '图谱错误：{msg}',
    'common.analysing': '正在分析信号...',
    'common.search_ph': '搜索信号...',
    'common.last_updated': '最近更新',
    'common.synced': '已同步',
    'common.signal_lost': '信号丢失 // 未找到内容',
    'common.research_analysing': '正在分析信号，请稍候...',
    'common.researching': '研究：{title}',
    'common.start_research': '开始深度研究：{title}',
    'common.collecting': '正在从信息源收集上下文...',
    'common.research_success': '研究报告已生成',
    'common.research_error': '研究错误：{msg}',
    'common.deploy_unavailable': '该项目尚无可用的部署分析。',
    'common.deploy_generating': '正在生成部署方案...',
    'common.deploy_feasibility': '正在分析部署可行性...',
    'common.research_agent': '研究智能体',
    'common.context_collector': '上下文收集',
    'common.llm_analyst': 'LLM 分析师',
    'common.analyzing': '分析中...',
    'common.waiting': '等待中',
    'common.done': '完成',
    'common.complete': '已完成',
    'common.error_cap': '错误',
    'common.fetching': '获取数据',

    'home.eyebrow': '情报雷达',
    'home.title': '今日科技动态',
    'home.subtitle': '汇聚来自 {n} 个信息源的精选信号。',
    'home.today': '今天',
    'home.view_all': '查看完整归档',
    'home.empty': '{date} 暂无内容。请运行同步以填充信息流。',
    'home.filter_all': '全部信息源',
    'home.search_ph': '搜索信号...',
    'home.issue_date_today': '（今天）',

    'digest.title': '每日简报',
    'digest.subtitle': '每 24 小时自动生成的 AI 简报。',
    'digest.empty': '{date} 暂无简报。每日简报会在 00:00 自动生成。',
    'digest.today': '今天',
    'digest.yesterday': '昨天',
    'digest.days_ago': '{n} 天前',
    'digest.view_full': '查看完整简报',
    'digest.popular': '讨论最多',

    'sources.title': '信息源',
    'sources.subtitle': '所有信息源概览',
    'sources.tab_all': '全部',
    'sources.total': '共 {n} 条',
    'sources.today_count': '今日 {n} 条',
    'sources.detail_subtitle': '该连接器的最新条目',
    'sources.items_count': '共 {n} 条',
    'sources.visit': '访问信息源 →',
    'sources.feed': '订阅源',
    'sources.all_sources': '全部信息源',
    'sources.no_items': '暂无内容。请尝试同步。',
    'sources.nav_collapse': '收起信息源列表',
    'sources.nav_expand': '展开信息源列表',
    'sources.jump_to': '跳转到信息源',

    'topics.title': '主题',
    'topics.subtitle': '实时图谱 + 精选关注列表',
    'topics.all': '全部',
    'topics.detail_subtitle': '相关实体、条目和子主题',
    'topics.auto_yes': '是',
    'topics.auto_no': '否（种子）',
    'topics.items': '{n} 条',
    'topics.entities': '{n} 个实体',
    'topics.related_topics': '相关主题',
    'topics.recent_items': '最近条目',
    'topics.all_items': '查看全部 {n} 条',

    'tools.title': '工具',
    'tools.subtitle': '面向创作者的浏览器端实用工具',
    'tools.all': '全部',
    'tools.search_ph': '搜索工具...',
    'tools.count': '共 {n} 个工具',
    'tools.use_tool': '打开工具 →',

    'skills.title': '技能',
    'skills.subtitle': '来自开源社区的精选智能体技能',
    'skills.search_ph': '搜索技能...',
    'skills.all': '全部',
    'skills.install_cmd': '安装命令',
    'skills.unknown_author': '未知',

    'physical.title': '具身 AI 简报',
    'physical.subtitle': '机器人、具身智能与前沿算力',
    'physical.empty': '暂无内容。将在下次同步后填充。',
    'papers.title': '论文',
    'papers.subtitle': '聚合 Hugging Face Papers、arXiv AI 与具身 AI 预印本，进入统一 tag 和知识图谱。',
    'papers.empty': '暂无论文。运行完整流水线后这里会自动更新。',
    'papers.all': '全部论文',
    'papers.with_pdf': '有 PDF',
    'papers.tagged': '已打标签',

    'intel.title': '情报分析',
    'intel.subtitle': '跨源趋势与主题热度',
    'signals.trending_subtitle': '跨源趋势与实体动量',
    'signals.trending_entities': '热门实体',
    'signals.no_momentum_data': '暂无实体动量数据。请运行完整流水线以填充。',
    'signals.mentions': '提及数',
    'signals.sources': '来源数',
    'signals.velocity_zscore': '速度（z-score）',
    'signals.source_quality': '源质量',
    'signals.noise_rate': '噪音率',
    'signals.system_metrics': '系统指标',
    'signals.enriched_items': '已摘要条目',
    'signals.graph_edges': '图谱边数',
    'signals.entities_count': '实体数',
    'signals.noisy': '高噪音',
    'signals.early_signal': '早期信号',
    'signals.originator': '源头',
    'signals.amplifier': '放大器',
    'industry.title': '行业指标',
    'industry.subtitle': '顶级信息源、领域与采用信号',

    'settings.title': '设置',
    'settings.subtitle': '配置用于摘要、每日简报、研究和部署方案的 LLM 接口。',
    'settings.current': '当前接口',
    'settings.paste': '粘贴接口配置',
    'settings.direct': '或直接编辑字段',
    'settings.after': '保存之后',
    'settings.provider': '提供商',
    'settings.base_url': '基础 URL',
    'settings.model': '模型',
    'settings.api_key': 'API 密钥',
    'settings.source': '来源',
    'settings.updated': '更新时间',
    'settings.load_sample': '载入示例',
    'settings.parse': '解析',
    'settings.save_activate': '保存并启用',
    'settings.save_fields': '保存字段',
    'settings.reset': '重置为 .ENV',
    'settings.test': '测试接口',
    'settings.fields_provider': '提供商',
    'settings.fields_base_url': '基础 URL',
    'settings.fields_model': '模型',
    'settings.fields_api_key': 'API 密钥',
    'settings.saving': '保存中…',
    'settings.parse_failed': '⚠ {msg}',
    'settings.no_config': '未返回配置',
    'settings.source_env': '环境变量回退',
    'settings.source_runtime': '运行时',
    'settings.saved_active': '当前接口：{base}（{model}）',
    'settings.test_ok': '✓ 接口响应正常。已收到 PONG。',
    'settings.test_fail': '✗ 接口失败：{msg}',
    'settings.enrich_hint': '使用新接口运行 enrichment：',
    'settings.digest_hint': '重建今日简报：',
    'settings.empty': '尚未配置接口。请粘贴配置或直接填写字段。',

    // ── Operations card (数据操作) ──
    'ops.title': '数据操作',
    'ops.subtitle': '手动触发抓取、enrichment、简报和翻译任务。',
    'ops.sync': '抓取所有信息源',
    'ops.sync_desc': '从 15 个 connector 拉取最新条目 (Hacker News、GitHub 等)。',
    'ops.enrich': 'AI 摘要批量',
    'ops.enrich_desc': '为没有知识卡片的 item 生成 AI 摘要。优先处理 X、Hacker News、GitHub 趋势榜、Hugging Face；默认队列 1600 条，本地 LLM 子批次 20 条，10 个并发 worker。',
    'ops.digest': '生成每日简报',
    'ops.digest_desc': '基于已 enrich 的 item 重建今日执行简报。',
    'ops.pipeline': '完整流水线',
    'ops.pipeline_desc': '抓取 → Enrich → 简报 一气呵成。最慢但最完整。',
    'ops.translate': '回填中文翻译',
    'ops.translate_desc': '将所有待处理的 item 标题和信息流摘要译为中文。',
    'ops.xsync': '同步 X 关注',
    'ops.xsync_desc': '从你配置的 X 账号列表拉取最新推文 (Jina Reader)。',
    'ops.running': '执行中…',
    'ops.queued': '已排队: {id}',
    'ops.done': '✓ 完成: {msg}',
    'ops.failed': '✗ 失败: {msg}',
    'ops.jobs': '最近任务',
    'ops.stop': '停止',
    'ops.cancelling': '停止中…',
    'ops.cancelled': '⛔ 已停止',
    'ops.stream_idle': '空闲',
    'ops.stream_running': '⏳ 运行中 {elapsed}秒',
    'ops.stream_done': '✓ 完成 (耗时 {elapsed}秒)',
    'ops.stream_failed': '✗ 失败 (耗时 {elapsed}秒)',
    'ops.stream_cancelled': '⛔ 已停止 ({elapsed}秒)',

    // X 关注配置
    'xconfig.title': 'X (推特) 关注列表',
    'xconfig.subtitle': '你关注的 X 账号列表。通过 Jina Reader 抓取推文 (无 API key, 无需登录)。',
    'xconfig.users': 'X 用户 (每行一个, 不带 @)',
    'xconfig.save': '保存列表',
    'xconfig.saved': '✓ 已保存 {n} 个用户',
    'xconfig.load_error': '⚠ 加载配置失败: {msg}',
    'xconfig.blocklist_title': '屏蔽账号',
    'xconfig.blocklist_subtitle': '这些账号的推文会在入库前被过滤，也可以从信号系统中清除。',
    'xconfig.blocklist_ph': '噪音账号1\n噪音账号2',
    'xconfig.save_blocklist': '保存屏蔽列表',
    'xconfig.blocklist_saved': '✓ 已保存 {n} 个屏蔽账号',
    'xconfig.cleanup': '从信号清除',
    'xconfig.cleanup_running': '清除中…',
    'xconfig.cleanup_done': '✓ 已清除 {n} 条信号评分',

    'item.rank': '排名 #{n}',
    'item.visit': '访问',
    'item.summary_na': '暂无摘要。',

    'research.title': '深度研究',
    'research.failed_title': '研究失败',
  },
};

let _current = detectInitial();
const _listeners = new Set();

function detectInitial() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch {
    // ignore
  }
  const nav = (typeof navigator !== 'undefined' && navigator.language) || 'en';
  if (String(nav).toLowerCase().startsWith('zh')) return 'zh';
  return 'en';
}

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = params[key];
    return v === undefined || v === null ? `{${key}}` : String(v);
  });
}

export function t(key, params) {
  const dict = DICTIONARY[_current] || DICTIONARY.en;
  let s = dict[key];
  if (s === undefined) s = DICTIONARY.en[key];
  if (s === undefined) return key;
  return interpolate(s, params);
}

export function getLanguage() {
  return _current;
}

export function setLanguage(lang) {
  if (lang !== 'en' && lang !== 'zh') return;
  if (lang === _current) return;
  _current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore
  }
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
    document.documentElement.setAttribute('data-lang', lang);
  }
  _listeners.forEach((fn) => {
    try {
      fn(lang);
    } catch {
      // ignore
    }
  });
}

export function toggleLanguage() {
  setLanguage(_current === 'en' ? 'zh' : 'en');
}

export function onLanguageChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export const LANGS = ['en', 'zh'];

/**
 * Walk the current DOM and replace any `data-i18n` or `data-i18n-attr` elements
 * with the translated string. Idempotent.
 */
export function applyI18n(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (!key) return;
    el.textContent = t(key);
  });
  scope.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    const spec = el.getAttribute('data-i18n-attr');
    if (!spec) return;
    spec.split(';').forEach((pair) => {
      const idx = pair.indexOf('|');
      if (idx < 0) return;
      const attr = pair.slice(0, idx).trim();
      const key = pair.slice(idx + 1).trim();
      if (!attr || !key) return;
      el.setAttribute(attr, t(key));
    });
  });
}
