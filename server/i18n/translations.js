/**
 * Eagleye — Static i18n translations
 *
 * Hand-curated Chinese translations for stable, low-cardinality content
 * (sources + seed topics). Item content is translated dynamically via LLM
 * and stored in *_zh fields on ai_summaries and information_items.
 *
 * Seeded into DB on server startup (idempotent).
 */

const SOURCE_TRANSLATIONS = {
  'hacker-news': {
    label_zh: 'Hacker News',
    description_zh: 'Y Combinator 社区的技术新闻与讨论',
  },
  'github-trending': {
    label_zh: 'GitHub 趋势榜',
    description_zh: 'GitHub 当日热门仓库',
  },
  'product-hunt': {
    label_zh: 'Product Hunt',
    description_zh: '新产品发布与科技产品',
  },
  'hugging-face': {
    label_zh: 'Hugging Face',
    description_zh: 'AI / ML 论文与模型',
  },
  'techmeme': {
    label_zh: 'Techmeme',
    description_zh: '科技行业新闻聚合',
  },
  'solidot': {
    label_zh: 'Solidot 奇客资讯',
    description_zh: '中文科技与科学资讯',
  },
  'startup-archive': {
    label_zh: 'Startup Archive',
    description_zh: '创业故事与创始人访谈',
  },
  'app-store-rank': {
    label_zh: 'App Store 排行榜',
    description_zh: 'App Store 排名与趋势（免费榜）',
  },
  'app-store-trend': {
    label_zh: 'App Store 热门榜',
    description_zh: 'App Store 热门应用（畅销榜）',
  },
  'physical-ai-arxiv': {
    label_zh: '具身智能 · arXiv',
    description_zh: '来自 arXiv 的具身 AI、机器人与人形机器人论文',
  },
  'physical-ai-humanoid': {
    label_zh: '具身智能 · 人形机器人',
    description_zh: '人形机器人公司行业新闻',
  },
  'physical-ai-cn-photonics': {
    label_zh: '具身智能 · 中国光电',
    description_zh: '中国光电与半导体行业动态',
  },
  'physical-ai-sec-8k': {
    label_zh: '具身智能 · SEC 8-K',
    description_zh: '半导体、机器人、光电公司 SEC 8-K 文件',
  },
  'v2ex': {
    label_zh: 'V2EX',
    description_zh: '中文技术社区热门话题',
  },
  'lobsters': {
    label_zh: 'Lobste.rs',
    description_zh: '社区投票的技术新闻聚合',
  },
};

const TOPIC_TRANSLATIONS = {
  'llms-generative-ai': {
    name_zh: '大模型与生成式 AI',
    description_zh: '大语言模型、GPT、Claude、Gemini 与生成式 AI 技术',
  },
  'ai-machine-learning': {
    name_zh: 'AI 与机器学习',
    description_zh: '通用 AI/ML 研究、深度学习、强化学习与 AI 基础设施',
  },
  'ai-coding-tools': {
    name_zh: 'AI 编程工具',
    description_zh: 'AI 编程助手、代码生成与开发者生产力工具',
  },
  'security': {
    name_zh: '安全',
    description_zh: '网络安全、漏洞、攻击与安全工具',
  },
  'web-development': {
    name_zh: 'Web 开发',
    description_zh: 'Web 框架、浏览器、JavaScript 生态与前后端技术',
  },
  'devops-infra': {
    name_zh: 'DevOps 与基础设施',
    description_zh: '云基础设施、CI/CD、容器、Kubernetes 与平台工程',
  },
  'startups': {
    name_zh: '创业',
    description_zh: '创业公司新闻、融资、商业模式与企业家精神',
  },
  'robotics': {
    name_zh: '机器人',
    description_zh: '机器人、具身 AI、人形机器人与自动化',
  },
  'crypto-web3': {
    name_zh: '加密与 Web3',
    description_zh: '加密货币、区块链、DeFi、NFT 与 Web3',
  },
  'design': {
    name_zh: '设计',
    description_zh: 'UI/UX 设计、设计系统、字体与视觉设计',
  },
};

/**
 * Apply static translations to DB. Idempotent — only writes where the _zh field
 * is empty. Safe to call on every server boot.
 */
function applyStaticTranslations(db) {
  if (!db) return { sources: 0, topics: 0 };

  let sourcesUpdated = 0;
  const updateSource = db.prepare(`
    UPDATE sources SET label_zh = ?, description_zh = ?, translation_status = 'translated'
    WHERE slug = ? AND (label_zh IS NULL OR label_zh = '')
  `);
  for (const [slug, t] of Object.entries(SOURCE_TRANSLATIONS)) {
    const info = updateSource.run(t.label_zh, t.description_zh, slug);
    if (info.changes > 0) sourcesUpdated++;
  }

  let topicsUpdated = 0;
  const updateTopic = db.prepare(`
    UPDATE topics SET name_zh = ?, description_zh = ?, translation_status = 'translated'
    WHERE slug = ? AND (name_zh IS NULL OR name_zh = '')
  `);
  for (const [slug, t] of Object.entries(TOPIC_TRANSLATIONS)) {
    const info = updateTopic.run(t.name_zh, t.description_zh, slug);
    if (info.changes > 0) topicsUpdated++;
  }

  return { sources: sourcesUpdated, topics: topicsUpdated };
}

module.exports = {
  SOURCE_TRANSLATIONS,
  TOPIC_TRANSLATIONS,
  applyStaticTranslations,
};
