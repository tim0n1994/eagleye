/** Physical AI intelligence, organized as a source-linked topic briefing. */
import { $, escapeAttr, escapeHtml } from '../utils.js';
import { getLanguage } from '../i18n.js';
import { API_BASE, fetchJSON, pickZh, showLoader } from './shared.js';

const CATEGORIES = [
  { key: 'research', zh: '研究论文', en: 'Research', detailZh: '论文、方法与评测', detailEn: 'Papers, methods and evaluations' },
  { key: 'humanoid', zh: '机器人动态', en: 'Robotics', detailZh: '人形机器人、产品与公司', detailEn: 'Humanoids, products and companies' },
  { key: 'open', zh: '开源与工具', en: 'Open source & tools', detailZh: '开源模型、代码、数据集与仿真工具', detailEn: 'Open models, code, datasets and simulators' },
  { key: 'applications', zh: '应用落地', en: 'Real-world applications', detailZh: '真实场景验证、试点与部署', detailEn: 'Real-world validation, pilots and deployments' },
];
const PAGE_SIZE = 24;
const SOURCE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const APPLICATION_STAGES = new Map([
  ['prototype', { zh: '阶段：原型', en: 'Stage: Prototype' }],
  ['pilot', { zh: '阶段：试点', en: 'Stage: Pilot' }],
  ['deployed', { zh: '阶段：部署', en: 'Stage: Deployed' }],
  ['unknown', { zh: '阶段未说明', en: 'Stage: Not specified' }],
]);
let requestNumber = 0;

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return '';
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
}

function safeLink(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch { return ''; }
}

function safeSourceHref(value) {
  return typeof value === 'string' && SOURCE_SLUG_RE.test(value) ? `/sources/${value}` : '';
}

function applicationStageLabel(value, zh) {
  const stage = APPLICATION_STAGES.get(value);
  return stage ? (zh ? stage.zh : stage.en) : '';
}

function dateLabel(value, zh) {
  if (!value) return zh ? '发布日期未知' : 'Publication date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return zh ? '发布日期未知' : 'Publication date unavailable';
  return date.toLocaleDateString(zh ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export async function renderPhysicalAI() {
  const container = $('#pageContent');
  const zh = getLanguage() === 'zh';
  const request = ++requestNumber;
  const params = new URLSearchParams(window.location.search);
  const requestedCategory = params.get('category');
  const category = CATEGORIES.some(c => c.key === requestedCategory) ? requestedCategory : 'all';
  const days = [30, 90, 180].includes(Number(params.get('days'))) ? Number(params.get('days')) : 30;
  const date = validDate(params.get('date'));
  const rawOffset = Number(params.get('offset'));
  const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const href = (changes = {}) => {
    const next = new URLSearchParams({ category, days: String(days) });
    if (date) next.set('date', date);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, String(value));
    }
    return `/physical-ai?${next}`;
  };
  showLoader(container, zh ? '正在整理具身智能资讯…' : 'Loading physical AI intelligence…');

  try {
    const query = new URLSearchParams({ category, days: String(days), limit: String(PAGE_SIZE), offset: String(offset) });
    if (date) query.set('date', date);
    const data = await fetchJSON(`${API_BASE}/physical-ai?${query}`);
    if (request !== requestNumber || window.location.pathname !== '/physical-ai') return;
    const items = Array.isArray(data.items) ? data.items : [];
    const categoryData = new Map((data.categories || []).map(c => [c.key, c]));
    const count = key => Number(categoryData.get(key)?.count) || 0;
    const allCount = CATEGORIES.reduce((sum, c) => sum + count(c.key), 0);
    const total = Number(data.stats?.total) || 0;
    const findCategory = item => CATEGORIES.find(c => c.key === item.category);
    const card = item => {
      const section = findCategory(item);
      const title = pickZh(item.title, item.ai_title_zh || item.title_zh) || (zh ? '无标题' : 'Untitled');
      const aiSummary = pickZh(item.one_liner || item.short_summary, item.one_liner_zh || item.short_summary_zh) || '';
      const summary = aiSummary || item.original_summary || '';
      const url = safeLink(item.canonical_url);
      const resourceUrl = safeLink(item.resource_url);
      const stageLabel = applicationStageLabel(item.application_stage, zh);
      const licenseLabel = resourceUrl && item.resource_license ? `${zh ? '许可证' : 'License'}: ${item.resource_license}` : '';
      const titleHtml = url ? `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)} <span aria-hidden="true">↗</span></a>` : escapeHtml(title);
      const source = item.source_label || item.source_slug || (zh ? '来源未知' : 'Unknown source');
      const sourceHref = safeSourceHref(item.source_slug);
      const sourceHtml = sourceHref ? `<a href="${escapeAttr(sourceHref)}">${escapeHtml(source)}</a>` : escapeHtml(source);
      const published = dateLabel(item.published_at, zh);
      const evidenceHtml = stageLabel || resourceUrl
        ? `<div class="pa-evidence">${stageLabel ? `<span class="pa-stage">${escapeHtml(stageLabel)}</span>` : ''}${licenseLabel ? `<span class="pa-stage">${escapeHtml(licenseLabel)}</span>` : ''}${resourceUrl ? `<a href="${escapeAttr(resourceUrl)}" target="_blank" rel="noopener noreferrer">${zh ? '资源' : 'Resource'} <span aria-hidden="true">↗</span></a>` : ''}</div>`
        : '';
      return `<article class="education-item pa-item">
        <div class="education-item-meta"><span class="education-item-category">${escapeHtml(section ? (zh ? section.zh : section.en) : (zh ? '具身 AI' : 'Physical AI'))}</span><span>${sourceHtml}</span><time${item.published_at ? ` datetime="${escapeAttr(item.published_at)}"` : ''}>${escapeHtml(published)}</time></div>
        <h3>${titleHtml}</h3>
        ${summary ? `<p><span class="education-summary-label">${aiSummary ? (zh ? 'AI 摘要' : 'AI summary') : (zh ? '原文摘要' : 'Source summary')}</span> ${escapeHtml(summary)}</p>` : ''}
        ${evidenceHtml}
      </article>`;
    };
    const selected = categoryData.get(category);
    const sourceDisabled = selected && (selected.is_active === 0 || selected.is_active === false);
    const emptyMessage = sourceDisabled
      ? (zh ? '该分类的信息源当前已停用，所选范围内暂无内容。' : 'This source is currently disabled and has no stories in the selected period.')
      : (zh ? '试试扩大时间范围，或切换到其他分类。' : 'Try a longer time range or another category.');

    container.innerHTML = `<section class="page-section education-page pa-page">
      <header class="education-hero">
        <div><div class="education-eyebrow">EAGLEYE / PHYSICAL AI</div>
          <h2>${zh ? '具身智能情报' : 'Physical AI intelligence'}</h2>
          <p>${zh ? '追踪 AI 走向物理世界的进展：从机器人研究、人形产品到开源工具与应用落地。' : 'Follow AI in the physical world, from robotics research and humanoid products to open tools and real-world applications.'}</p>
        </div>
        <div class="education-hero-note"><span>${zh ? '观察范围' : 'COVERAGE'}</span><strong>${date ? escapeHtml(date) : (zh ? `最近 ${days} 天` : `Last ${days} days`)}</strong><small>${date ? (zh ? '按采集日期查看快照' : 'Collection-date snapshot') : (zh ? '来自 Eagleye 已收录的信息源' : 'From sources collected by Eagleye')}</small></div>
      </header>
      <div class="education-overview" aria-label="${zh ? '分类概览' : 'Category overview'}">
        ${CATEGORIES.map(c => `<a class="education-overview-card ${category === c.key ? 'is-active' : ''}" href="${escapeAttr(href({ category: c.key }))}" ${category === c.key ? 'aria-current="true"' : ''}><span>${escapeHtml(zh ? c.zh : c.en)}</span><strong>${count(c.key)}</strong><small>${escapeHtml(zh ? c.detailZh : c.detailEn)}${categoryData.get(c.key)?.is_active === 0 || categoryData.get(c.key)?.is_active === false ? ` · ${zh ? '信息源已停用' : 'Source disabled'}` : ''}</small></a>`).join('')}
      </div>
      <div class="education-content-head"><div><div class="education-eyebrow">${zh ? '专题资讯' : 'THE LATEST'}</div><h3>${zh ? '探索动态' : 'Explore the feed'}</h3><p>${zh ? '按领域和时间筛选，打开原文查看完整上下文。' : 'Explore by field and time, and open the original source for context.'}</p></div>
        <nav class="education-periods" aria-label="${zh ? '时间范围' : 'Time range'}">${[30, 90, 180].map(n => `<a href="${escapeAttr(href({ days: n, date: null }))}" class="${!date && days === n ? 'is-active' : ''}" ${!date && days === n ? 'aria-current="true"' : ''}>${zh ? `${n} 天` : `${n} days`}</a>`).join('')}</nav>
      </div>
      <nav class="education-filters" aria-label="${zh ? '内容分类' : 'Content categories'}">
        <a href="${escapeAttr(href({ category: 'all' }))}" class="${category === 'all' ? 'is-active' : ''}" ${category === 'all' ? 'aria-current="true"' : ''}>${zh ? '全部' : 'All'} <span>${allCount}</span></a>
        ${CATEGORIES.map(c => `<a href="${escapeAttr(href({ category: c.key }))}" class="${category === c.key ? 'is-active' : ''}" ${category === c.key ? 'aria-current="true"' : ''}>${escapeHtml(zh ? c.zh : c.en)} <span>${count(c.key)}</span></a>`).join('')}
      </nav>
      <form class="pa-date-filter" action="/physical-ai" method="get">
        <input type="hidden" name="category" value="${escapeAttr(category)}"><input type="hidden" name="days" value="${days}">
        <label for="physicalDate">${zh ? '采集日快照' : 'Collection-date snapshot'}</label>
        <input id="physicalDate" name="date" type="date" value="${escapeAttr(date)}" required>
        <button type="submit">${zh ? '查看快照' : 'View snapshot'}</button>
        ${date ? `<a href="${escapeAttr(href({ date: null }))}">${zh ? '返回最近动态' : 'Back to recent'}</a>` : ''}
        <span>${zh ? '按采集批次筛选，条目显示实际发布日期。' : 'Filters the collection batch; items show their publication dates.'}</span>
      </form>
      <div class="education-results-count">${zh ? `共 ${total} 条 · 按发布时间排序` : `${total} results · newest first`}</div>
      <div class="education-feed pa-feed">${items.length ? items.map(card).join('') : `<div class="education-empty"><strong>${zh ? '这个范围内暂无匹配内容' : 'No matching stories in this period'}</strong><p>${emptyMessage}</p></div>`}</div>
      ${offset > 0 || offset + items.length < total ? `<nav class="education-pagination" aria-label="${zh ? '分页' : 'Pagination'}">${offset > 0 ? `<a href="${escapeAttr(href({ offset: Math.max(0, offset - PAGE_SIZE) }))}">← ${zh ? '上一页' : 'Previous'}</a>` : '<span></span>'}${offset + items.length < total && items.length ? `<a href="${escapeAttr(href({ offset: offset + PAGE_SIZE }))}">${zh ? '下一页' : 'Next'} →</a>` : ''}</nav>` : ''}
    </section>`;
  } catch {
    if (request !== requestNumber || window.location.pathname !== '/physical-ai') return;
    container.innerHTML = `<section class="page-section education-page pa-page"><div class="education-empty" role="alert"><strong>${zh ? '暂时无法加载具身智能资讯' : 'Unable to load physical AI intelligence'}</strong><p>${zh ? '请稍后重试。' : 'Please try again later.'}</p><button type="button" class="action-btn" id="physicalRetry">${zh ? '重试' : 'Retry'}</button></div></section>`;
    container.querySelector('#physicalRetry')?.addEventListener('click', () => renderPhysicalAI());
  }
}
