/**
 * Eagleye — reader-page dictionary extensions
 *
 * Page-local translations and mappings for backend-provided labels.
 * xt() follows the same interpolation contract as t() in ../i18n.js.
 */

import { getLanguage, getLocale } from '../i18n.js';

const EN = {
  'reader.loading_years': 'Loading archive…',
  'reader.loading_year': 'Loading year…',
  'reader.loading_compare': 'Loading comparison…',
  'reader.loading_saved': 'Loading saved items…',
  'reader.loading_stories': 'Loading stories…',
  'reader.loading_lens': 'Loading lens…',
  'reader.loading_for_you': 'Loading For You…',
  'reader.loading_digest': 'Loading digest…',
  'reader.loading_date': 'Loading {date}…',
  'reader.loading_entities': 'Loading…',
  'reader.compare': 'Compare',
  'reader.entity_compare_title': 'Entity Compare',
  'reader.entity_compare_subtitle': 'Compare normalized 30-day trajectories for multiple entities.',
  'reader.entity_compare_placeholder': 'Enter entity slugs, separated by commas',
  'reader.top_entities': 'Top entities (click to add):',
  'reader.enter_entity_slugs': 'Enter at least 2 entity slugs.',
  'reader.need_valid_entities': 'At least 2 valid entities are required.',
  'reader.entities_normalized': 'Each entity is normalized to its own peak (0–100) to compare trend shape across scales.',
  'reader.items': '{count} items',
  'reader.item': 'item',
  'reader.items_short': '{count} items',
  'reader.less': 'Less',
  'reader.more': 'More',
  'reader.count_items': '{count} items',
  'reader.prev': 'Previous',
  'reader.next': 'Next',
  'reader.markdown': 'Markdown',
  'reader.export_json': 'Export JSON',
  'reader.topic': 'Topic',
  'reader.stale': 'Stale',
  'reader.today': 'Today',
  'reader.days_1_3': '1–3 days',
  'reader.days_3_plus': '3+ days',
  'reader.low_alpha': 'Low α',
  'reader.high_alpha': 'High α',
  'reader.window': 'Window',
  'reader.window_1d': '24 hours',
  'reader.window_3d': '3 days',
  'reader.window_7d': '7 days',
  'reader.window_14d': '14 days',
  'reader.saving': 'Saving…',
  'reader.saved': 'Saved',
  'reader.marking_read': 'Marking…',
  'reader.email': 'Email',
  'reader.password': 'Password',
  'reader.password_min_6': 'Password (min 6 chars)',
  'reader.sign_in': 'Sign In',
  'reader.signing_in': 'Signing in…',
  'reader.register': 'Register',
  'reader.creating_account': 'Creating account…',
  'reader.resend_code': 'Resend verification code',
  'reader.resending_code': 'Resending…',
  'reader.verify': 'Verify',
  'reader.verifying': 'Verifying…',
  'reader.no_account': 'No account?',
  'reader.have_account': 'Already have an account?',
};

const ZH = {
  'reader.loading_years': '正在加载归档…',
  'reader.loading_year': '正在加载年度数据…',
  'reader.loading_compare': '正在加载对比…',
  'reader.loading_saved': '正在加载收藏…',
  'reader.loading_stories': '正在加载故事…',
  'reader.loading_lens': '正在加载信号镜头…',
  'reader.loading_for_you': '正在加载为你推荐…',
  'reader.loading_digest': '正在加载简报…',
  'reader.loading_date': '正在加载 {date}…',
  'reader.loading_entities': '加载中…',
  'reader.compare': '对比',
  'reader.entity_compare_title': '实体对比',
  'reader.entity_compare_subtitle': '对比多个实体的 30 天归一化轨迹。',
  'reader.entity_compare_placeholder': '输入实体 slug，使用英文逗号分隔',
  'reader.top_entities': '热门实体（点击添加）：',
  'reader.enter_entity_slugs': '请至少输入 2 个实体 slug。',
  'reader.need_valid_entities': '至少需要 2 个有效实体。',
  'reader.entities_normalized': '各实体归一化到自身峰值（0–100），便于跨规模对比趋势形态。',
  'reader.items': '{count} 条',
  'reader.item': '条',
  'reader.items_short': '{count} 条',
  'reader.less': '少',
  'reader.more': '多',
  'reader.count_items': '{count} 条',
  'reader.prev': '前一天',
  'reader.next': '后一天',
  'reader.markdown': 'Markdown',
  'reader.export_json': '导出 JSON',
  'reader.topic': '主题',
  'reader.stale': '延迟',
  'reader.today': '今日',
  'reader.days_1_3': '1–3 天',
  'reader.days_3_plus': '3 天以上',
  'reader.low_alpha': '低 Alpha',
  'reader.high_alpha': '高 Alpha',
  'reader.window': '时间窗口',
  'reader.window_1d': '24 小时',
  'reader.window_3d': '3 天',
  'reader.window_7d': '7 天',
  'reader.window_14d': '14 天',
  'reader.saving': '保存中…',
  'reader.saved': '已保存',
  'reader.marking_read': '标记中…',
  'reader.email': '邮箱',
  'reader.password': '密码',
  'reader.password_min_6': '密码（至少 6 位）',
  'reader.sign_in': '登录',
  'reader.signing_in': '登录中…',
  'reader.register': '注册',
  'reader.creating_account': '创建账户中…',
  'reader.resend_code': '重发验证码',
  'reader.resending_code': '重发中…',
  'reader.verify': '验证',
  'reader.verifying': '验证中…',
  'reader.no_account': '没有账户？',
  'reader.have_account': '已有账户？',
};

const READER_DICTIONARY = { en: EN, zh: ZH };

export function xt(key, params) {
  const language = getLanguage();
  const value = READER_DICTIONARY[language]?.[key] ?? EN[key] ?? key;
  if (!params) return value;
  return String(value).replace(/\{(\w+)\}/g, (_, name) => {
    const replacement = params[name];
    return replacement === undefined || replacement === null ? `{${name}}` : String(replacement);
  });
}

// The compare matrix is curated by the backend. Keep English values as delivered
// and translate only the known product definitions; unknown content stays honest.
const READER_TEXT_ZH = {
  'Source coverage': '信息源覆盖',
  '19 sources incl. Reddit/XiaoHongShu': '19 个信息源，含 Reddit、小红书',
  '~15': '约 15 个',
  'user RSS': '用户 RSS',
  '~20 curated': '约 20 个人工精选',
  '~12 dev': '约 12 个开发者信息源',
  'AI summary per item': '逐条 AI 摘要',
  '✓ Chinese knowledge card': '✓ 中文知识卡片',
  'editor summary': '编辑摘要',
  'Multi-dim alpha scoring': '多维 Alpha 评分',
  '✓ 6-dim + 3 audiences': '✓ 6 个维度 + 3 类受众',
  'Personal filter + watchlist': '个人过滤与关注列表',
  '✓ For-You + lens': '✓ For You + 信号镜头',
  '✓ ML': '✓ 机器学习',
  '✓ basic': '✓ 基础',
  'Cross-source story clustering': '跨源故事聚合',
  partial: '部分支持',
  '✓ editorial': '✓ 编辑精选',
  'Live knowledge graph': '实时知识图谱',
  '✓ Evidence-linked topics': '✓ 证据关联主题',
  '1-click deploy analysis': '一键部署分析',
  '✓ GitHub repos': '✓ GitHub 仓库',
  'Chinese-first': '中文优先',
  'Self-hosted / local': '自托管 / 本地运行',
  '✓ ext': '✓ 扩展支持',
  'Sign-up friction': '注册门槛',
  none: '无',
  account: '需要账户',
  'Solo developer': '独立开发者',
  'AI cards + deploy analysis': 'AI 卡片与部署分析',
  'AI researcher': 'AI 研究者',
  'arXiv + HF papers + topic graph + trajectories': 'arXiv 与 Hugging Face 论文、主题图谱和实体轨迹',
  'Indie hacker': '独立开发者',
  'Product Hunt + funding signals + alpha radar': 'Product Hunt、融资信号与 Alpha 雷达',
  'Founder / VC': '创始人 / VC',
  'Investor lens + entity momentum + stories': '投资人镜头、实体动量与故事',
  'Casual reader': '休闲读者',
  'Lowest friction, dev-community focus': '门槛最低，聚焦开发者社区',
  'Enterprise team': '企业团队',
  'Mature multi-user, MFA, integrations': '成熟的多用户、MFA 与集成能力',
};

export function rt(value) {
  const key = String(value ?? '');
  return getLanguage() === 'zh' ? (READER_TEXT_ZH[key] ?? value) : value;
}

const SIGNAL_LABELS = {
  origin_signal: { en: 'Origin Signal', zh: '源头信号' },
  new_repo: { en: 'New Repo', zh: '新仓库' },
  new_paper: { en: 'New Paper', zh: '新论文' },
  model_release: { en: 'Model Release', zh: '模型发布' },
  benchmark_claim: { en: 'Benchmark Claim', zh: '基准声明' },
  architecture_shift: { en: 'Architecture Shift', zh: '架构迁移' },
  narrative_shift: { en: 'Narrative Shift', zh: '叙事迁移' },
  velocity_spike: { en: 'Velocity Spike', zh: '加速信号' },
  novel_combination: { en: 'Novel Combination', zh: '新组合' },
  contradiction: { en: 'Contradiction', zh: '矛盾信号' },
  funding_signal: { en: 'Funding Signal', zh: '融资信号' },
  hiring_signal: { en: 'Hiring Signal', zh: '招聘信号' },
  supply_chain: { en: 'Supply Chain', zh: '供应链信号' },
  agent_signal: { en: 'Agent Signal', zh: '智能体信号' },
  non_tech: { en: 'Non-tech', zh: '非技术噪音' },
  uncategorized: { en: 'Uncategorized', zh: '未分类' },
};

export function signalLabel(value) {
  const key = String(value || '').toLowerCase();
  const label = SIGNAL_LABELS[key];
  if (label) return getLanguage() === 'zh' ? label.zh : label.en;
  return String(value || '').replace(/_/g, ' ');
}

export function monthLabel(value) {
  const month = Number(String(value || '').replace(/^0+/, '').replace(/\D/g, ''));
  if (!Number.isInteger(month) || month < 1 || month > 12) return String(value || '');
  return new Intl.DateTimeFormat(getLocale(), {
    timeZone: 'UTC',
    month: 'short',
  }).format(new Date(Date.UTC(2000, month - 1, 1)));
}

const ERROR_MESSAGES_ZH = {
  'Authentication required': '需要登录。',
  'Authentication required (use ?key=<api key> for RSS readers)': '需要认证（RSS 阅读器可在地址中加入 ?key=<API key>）。',
  'Admin access required': '需要管理员权限。',
  'Invalid email': '邮箱无效。',
  'Valid email required': '请输入有效邮箱。',
  'Email and password required': '请输入邮箱和密码。',
  'Password must be at least 6 characters': '密码至少需要 6 个字符。',
  'Email already registered': '该邮箱已注册。',
  'Verification code sent': '验证码已发送。',
  'Email and code required': '请输入邮箱和验证码。',
  'Invalid or expired verification code': '验证码无效或已过期。',
  'User not found': '用户不存在。',
  'Account disabled': '账户已停用。',
  'Email not verified': '邮箱尚未验证。',
  'Invalid email or password': '邮箱或密码不正确。',
  'Email registration is unavailable. Contact the administrator for access.': '邮箱注册暂不可用，请联系管理员开通访问。',
  'Verification email could not be sent. Use resend to try again later.': '验证邮件发送失败，请稍后使用重发功能。',
  'Verification email could not be sent. Try again later.': '验证邮件发送失败，请稍后重试。',
  'If registration is pending, a verification email has been sent.': '如果该邮箱存在待验证注册，验证邮件已发送。',
  'Method not allowed': '请求方法不受支持。',
  'Method not allowed; use POST': '请求方法不受支持；请使用 POST。',
  'Failed to fetch': '网络请求失败，请确认服务可用后重试。',
  'Database not available': '数据库不可用。',
};

const HTTP_MESSAGES_ZH = {
  400: '请求无效。',
  401: '需要登录或认证。',
  403: '没有执行此操作的权限。',
  404: '请求的资源不存在。',
  409: '请求与当前状态冲突。',
  429: '请求过于频繁，请稍后重试。',
  500: '服务处理请求时出错。',
  502: '上游服务暂时不可用。',
  503: '服务暂时不可用，请稍后重试。',
  504: '上游服务响应超时。',
};

export function readerError(value) {
  const message = String(value ?? '').trim();
  if (!message) return '';
  if (getLanguage() !== 'zh') return message;
  if (ERROR_MESSAGES_ZH[message]) return ERROR_MESSAGES_ZH[message];
  const retryAfter = /^(?:Too many attempts\. Try again in )(\d+)s\.$/.exec(message);
  if (retryAfter) return '尝试次数过多，请在 ' + retryAfter[1] + ' 秒后重试。';
  const http = /^HTTP (\d{3})$/.exec(message);
  if (http) return HTTP_MESSAGES_ZH[Number(http[1])] || message;
  return message;
}
