import { qualitySlot, renderQuality } from './intelligence-quality.js';
/** AI education intelligence: a source-linked view over the existing corpus. */
import { $, escapeAttr, escapeHtml } from '../utils.js';
import { getLanguage } from '../i18n.js';
import { API_BASE, fetchJSON, pickZh, showLoader } from './shared.js';

const CATEGORIES = [
  { key: 'teaching_practice', zh: '教学实践', en: 'Teaching practice', detailZh: '课堂、教师与教学方法', detailEn: 'Classrooms, educators and pedagogy' },
  { key: 'learning_product', zh: '学习产品', en: 'Learning products', detailZh: '学习工具、平台与应用', detailEn: 'Learning tools, platforms and apps' },
  { key: 'research', zh: '研究', en: 'Research', detailZh: '论文、评测与学习科学', detailEn: 'Papers, evaluations and learning science' },
  { key: 'policy', zh: '政策', en: 'Policy', detailZh: '治理、规范与课程', detailEn: 'Governance, guidance and curricula' },
];
const PAGE_SIZE = 24;
let requestNumber = 0;

function safeLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch { return ''; }
}

function dateLabel(value, zh) {
  if (!value) return zh ? '日期未知' : 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return zh ? '日期未知' : 'Date unavailable';
  return date.toLocaleDateString(zh ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export async function renderEducation() {
  const container = $('#pageContent');
  const zh = getLanguage() === 'zh';
  const request = ++requestNumber;
  const params = new URLSearchParams(window.location.search);
  const category = CATEGORIES.some(c => c.key === params.get('category')) ? params.get('category') : 'all';
  const days = [30, 90, 180].includes(Number(params.get('days'))) ? Number(params.get('days')) : 30;
  const rawOffset = Number(params.get('offset'));
  const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const href = (changes = {}) => {
    const next = new URLSearchParams({ category, days: String(days), ...changes });
    return `/ai-education?${next}`;
  };
  showLoader(container, zh ? '正在整理 AI 教育资讯…' : 'Loading AI education intelligence…');

  try {
    const query = new URLSearchParams({ category, days: String(days), limit: String(PAGE_SIZE), offset: String(offset) });
    const data = await fetchJSON(`${API_BASE}/education?${query}`);
    if (request !== requestNumber || window.location.pathname !== '/ai-education') return;
    const items = Array.isArray(data.items) ? data.items : [];
    const counts = new Map((data.categories || []).map(c => [c.key, Number(c.count) || 0]));
    const allCount = CATEGORIES.reduce((sum, c) => sum + (counts.get(c.key) || 0), 0);
    const total = Number(data.stats?.total) || 0;
    const categoryName = key => {
      const found = CATEGORIES.find(c => c.key === key);
      return found ? (zh ? found.zh : found.en) : (zh ? 'AI 教育' : 'AI education');
    };
    const card = item => {
      const title = pickZh(item.title, item.title_zh) || (zh ? '无标题' : 'Untitled');
      const aiSummary = pickZh(item.one_liner, item.one_liner_zh || item.short_summary_zh) || '';
      const summary = aiSummary || item.original_summary || '';
      const url = safeLink(item.url);
      const titleHtml = url
        ? `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)} <span aria-hidden="true">↗</span></a>`
        : escapeHtml(title);
      return `<article class="education-item">
        <div class="education-item-meta"><span class="education-item-category">${escapeHtml(categoryName(item.category))}</span><span>${escapeHtml(item.source_label || item.source_slug || (zh ? '来源未知' : 'Unknown source'))}</span><time>${escapeHtml(dateLabel(item.published_at || item.digest_date, zh))}</time></div>
        <h3>${titleHtml}</h3>
        ${summary ? `<p><span class="education-summary-label">${aiSummary ? (zh ? 'AI 摘要' : 'AI summary') : (zh ? '原文摘要' : 'Source summary')}</span> ${escapeHtml(summary)}</p>` : ''}
      </article>`;
    };

    container.innerHTML = `<section class="page-section education-page">
      <header class="education-hero">
        <div><div class="education-eyebrow">EAGLEYE / AI EDUCATION</div>
          <h2>${zh ? 'AI 教育情报' : 'AI education intelligence'}</h2>
          <p>${zh ? '关注 AI 如何改变教与学：从课堂实践、学习产品到研究与政策。' : 'Follow how AI is changing teaching and learning, from classroom practice and products to research and policy.'}</p>
        </div>
        <div class="education-hero-note"><span>${zh ? '观察范围' : 'COVERAGE'}</span><strong>${zh ? `最近 ${days} 天` : `Last ${days} days`}</strong><small>${zh ? '来自 Eagleye 已收录的信息源' : 'From sources collected by Eagleye'}</small></div>
      </header>${qualitySlot()}
      <div class="education-overview" aria-label="${zh ? '分类概览' : 'Category overview'}">
        ${CATEGORIES.map(c => `<a class="education-overview-card ${category === c.key ? 'is-active' : ''}" href="${escapeAttr(href({ category: c.key }))}"><span>${escapeHtml(zh ? c.zh : c.en)}</span><strong>${counts.get(c.key) || 0}</strong><small>${escapeHtml(zh ? c.detailZh : c.detailEn)}</small></a>`).join('')}
      </div>
      <div class="education-content-head"><div><div class="education-eyebrow">${zh ? '专题资讯' : 'THE LATEST'}</div><h3>${zh ? '探索动态' : 'Explore the feed'}</h3><p>${zh ? '按 AI 与教育的相关线索筛选，打开原文查看完整上下文。' : 'Selected using AI and education signals. Open the original source for context.'}</p></div>
        <nav class="education-periods" aria-label="${zh ? '时间范围' : 'Time range'}">${[30, 90, 180].map(n => `<a href="${escapeAttr(href({ days: String(n) }))}" class="${days === n ? 'is-active' : ''}" ${days === n ? 'aria-current="true"' : ''}>${zh ? `${n} 天` : `${n} days`}</a>`).join('')}</nav>
      </div>
      <nav class="education-filters" aria-label="${zh ? '内容分类' : 'Content categories'}">
        <a href="${escapeAttr(href({ category: 'all' }))}" class="${category === 'all' ? 'is-active' : ''}" ${category === 'all' ? 'aria-current="true"' : ''}>${zh ? '全部' : 'All'} <span>${allCount}</span></a>
        ${CATEGORIES.map(c => `<a href="${escapeAttr(href({ category: c.key }))}" class="${category === c.key ? 'is-active' : ''}" ${category === c.key ? 'aria-current="true"' : ''}>${escapeHtml(zh ? c.zh : c.en)} <span>${counts.get(c.key) || 0}</span></a>`).join('')}
      </nav>
      <div class="education-results-count">${data.stats?.truncated ? (zh ? `已检索部分结果：${total} 条 · 按发布时间排序` : `${total} results in the searched sample · newest first`) : (zh ? `共 ${total} 条 · 按发布时间排序` : `${total} results · newest first`)}</div>
      <div class="education-feed">${items.length ? items.map(card).join('') : `<div class="education-empty"><strong>${zh ? '这个时间范围内暂无匹配内容' : 'No matching stories in this period'}</strong><p>${zh ? '试试扩大时间范围，或切换到其他分类。' : 'Try a longer time range or another category.'}</p></div>`}</div>
      ${offset > 0 || offset + items.length < total ? `<nav class="education-pagination" aria-label="${zh ? '分页' : 'Pagination'}">${offset > 0 ? `<a href="${escapeAttr(href({ offset: String(Math.max(0, offset - PAGE_SIZE)) }))}">← ${zh ? '上一页' : 'Previous'}</a>` : '<span></span>'}${offset + items.length < total && items.length ? `<a href="${escapeAttr(href({ offset: String(offset + PAGE_SIZE) }))}">${zh ? '下一页' : 'Next'} →</a>` : ''}</nav>` : ''}
    </section>`;
    void renderQuality(container, 'education', days);
  } catch {
    if (request !== requestNumber || window.location.pathname !== '/ai-education') return;
    container.innerHTML = `<section class="page-section education-page"><div class="education-empty" role="alert"><strong>${zh ? '暂时无法加载 AI 教育资讯' : 'Unable to load AI education intelligence'}</strong><p>${zh ? '请稍后重试。' : 'Please try again later.'}</p><button type="button" class="action-btn" id="educationRetry">${zh ? '重试' : 'Retry'}</button></div></section>`;
    container.querySelector('#educationRetry')?.addEventListener('click', () => renderEducation());
  }
}
