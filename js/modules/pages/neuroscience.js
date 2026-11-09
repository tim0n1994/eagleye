/** Neuroscience briefing. Lazy-loaded, source-linked and without a chart runtime. */
import { $, escapeAttr, escapeHtml } from '../utils.js';
import { getLanguage } from '../i18n.js';
import { API_BASE, fetchJSON, pickZh, showLoader } from './shared.js';

const CATEGORIES = [
  { key: 'research', zh: '研究论文', en: 'Research', detailZh: '神经、认知与脑机制研究', detailEn: 'Neural, cognitive and brain mechanisms' },
  { key: 'bci', zh: '脑机接口与信号', en: 'BCI & signals', detailZh: '脑电、接口与信号采集处理', detailEn: 'Brain interfaces and neural signals' },
  { key: 'tools', zh: '开源工具与数据', en: 'Tools & data', detailZh: '分析工具、数据标准与版本更新', detailEn: 'Analysis software, data standards and releases' },
  { key: 'community', zh: '社区实践', en: 'Community', detailZh: '开发者讨论与方法实践', detailEn: 'Developer discussions and practical methods' },
];
const EVIDENCE = { preprint: ['预印本', 'Preprint'], journal: ['期刊内容', 'Journal content'], release: ['官方版本更新', 'Official release'], community: ['社区讨论', 'Community discussion'] };
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

export async function renderNeuroscience() {
  const container = $('#pageContent');
  const zh = getLanguage() === 'zh';
  const request = ++requestNumber;
  const params = new URLSearchParams(window.location.search);
  const category = CATEGORIES.some(c => c.key === params.get('category')) ? params.get('category') : 'all';
  const days = [30, 90, 180].includes(Number(params.get('days'))) ? Number(params.get('days')) : 30;
  const source = /^neuroscience-[a-z-]+$/.test(params.get('source') || '') ? params.get('source') : 'all';
  const rawOffset = Number(params.get('offset'));
  const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const href = (changes = {}) => {
    const next = new URLSearchParams({ category, source, days: String(days), ...changes });
    return `/neuroscience?${next}`;
  };
  showLoader(container, zh ? '正在整理脑科学资讯…' : 'Loading neuroscience intelligence…');

  try {
    const query = new URLSearchParams({ category, source, days: String(days), limit: String(PAGE_SIZE), offset: String(offset) });
    const data = await fetchJSON(`${API_BASE}/neuroscience?${query}`);
    if (request !== requestNumber || window.location.pathname !== '/neuroscience') return;
    const items = Array.isArray(data.items) ? data.items : [];
    const counts = new Map((data.categories || []).map(c => [c.key, Number(c.count) || 0]));
    const allCount = CATEGORIES.reduce((sum, c) => sum + (counts.get(c.key) || 0), 0);
    const total = Number(data.stats?.total) || 0;
    const sources = Array.isArray(data.sources) ? data.sources : [];
    const sourceState = s => !s.is_active ? (zh ? '停用' : 'Disabled') : !s.last_attempt_at ? (zh ? '待首次抓取' : 'Awaiting first fetch') : s.consecutive_empty > 0 && !s.last_error_class ? (zh ? '最近无新内容' : 'No recent new content') : s.health_status === 'healthy' ? (zh ? '采集正常' : 'Healthy') : s.health_status === 'failing' ? (zh ? '最近失败' : 'Failing') : s.health_status === 'stale' ? (zh ? '待更新' : 'Stale') : (zh ? '健康状态未知' : 'Health unknown');
    const categoryName = key => {
      const found = CATEGORIES.find(c => c.key === key);
      return found ? (zh ? found.zh : found.en) : (zh ? '脑科学' : 'neuroscience');
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
        <div class="education-item-meta"><span class="education-item-category">${escapeHtml(categoryName(item.category))}</span><span>${escapeHtml((EVIDENCE[item.evidence_kind] || ['来源未分类', 'Unclassified'])[zh ? 0 : 1])}</span><span>${escapeHtml(item.source_label || item.source_slug || (zh ? '来源未知' : 'Unknown source'))}</span><time>${escapeHtml(dateLabel(item.published_at || item.digest_date, zh))}</time></div>
        <h3>${titleHtml}</h3>
        ${summary ? `<p><span class="education-summary-label">${aiSummary ? (zh ? 'AI 摘要' : 'AI summary') : (zh ? '原文摘要' : 'Source summary')}</span> ${escapeHtml(summary)}</p>` : ''}
      </article>`;
    };

    container.innerHTML = `<section class="page-section education-page">
      <header class="education-hero">
        <div><div class="education-eyebrow">EAGLEYE / NEUROSCIENCE</div>
          <h2>${zh ? '脑科学情报' : 'neuroscience intelligence'}</h2>
          <p>${zh ? '追踪脑机制、认知研究与脑机接口，从论文到开源工具和社区实践。' : 'Follow brain and cognition research, brain interfaces, open tools and community practice.'}</p>
        </div>
        <div class="education-hero-note"><span>${zh ? '观察范围' : 'COVERAGE'}</span><strong>${zh ? `最近 ${days} 天` : `Last ${days} days`}</strong><small>${zh ? '独立的脑科学专题来源' : 'Dedicated neuroscience sources'}</small></div>
      </header>
      <div class="education-overview" aria-label="${zh ? '分类概览' : 'Category overview'}">
        ${CATEGORIES.map(c => `<a class="education-overview-card ${category === c.key ? 'is-active' : ''}" href="${escapeAttr(href({ category: c.key }))}"><span>${escapeHtml(zh ? c.zh : c.en)}</span><strong>${counts.get(c.key) || 0}</strong><small>${escapeHtml(zh ? c.detailZh : c.detailEn)}</small></a>`).join('')}
      </div>
      <div class="education-content-head"><div><div class="education-eyebrow">${zh ? '专题资讯' : 'THE LATEST'}</div><h3>${zh ? '探索动态' : 'Explore the feed'}</h3><p>${zh ? '区分预印本、期刊内容、版本更新和社区讨论，打开原文查看证据与评审状态。' : 'Preprints, journal content, releases and community discussions retain their source type. Open originals for evidence and review status.'}</p></div>
        <nav class="education-periods" aria-label="${zh ? '时间范围' : 'Time range'}">${[30, 90, 180].map(n => `<a href="${escapeAttr(href({ days: String(n) }))}" class="${days === n ? 'is-active' : ''}" ${days === n ? 'aria-current="true"' : ''}>${zh ? `${n} 天` : `${n} days`}</a>`).join('')}</nav>
      </div>
      <nav class="education-filters" aria-label="${zh ? '内容分类' : 'Content categories'}">
        <a href="${escapeAttr(href({ category: 'all' }))}" class="${category === 'all' ? 'is-active' : ''}" ${category === 'all' ? 'aria-current="true"' : ''}>${zh ? '全部' : 'All'} <span>${allCount}</span></a>
        ${CATEGORIES.map(c => `<a href="${escapeAttr(href({ category: c.key }))}" class="${category === c.key ? 'is-active' : ''}" ${category === c.key ? 'aria-current="true"' : ''}>${escapeHtml(zh ? c.zh : c.en)} <span>${counts.get(c.key) || 0}</span></a>`).join('')}
      </nav>
      <form class="neuroscience-source-filter" action="/neuroscience" method="get">
        <input type="hidden" name="category" value="${escapeAttr(category)}"><input type="hidden" name="days" value="${days}">
        <label for="neuroscienceSource">${zh ? '信息来源' : 'Source'}</label>
        <select id="neuroscienceSource" name="source"><option value="all">${zh ? '全部来源' : 'All sources'}</option>${sources.map(s => `<option value="${escapeAttr(s.slug)}" ${source === s.slug ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}</select>
        <button class="action-btn" type="submit">${zh ? '筛选' : 'Apply'}</button>
      </form>
      <div class="education-results-count">${data.stats?.truncated ? (zh ? `已检索部分结果：${total} 条 · 按发布时间排序` : `${total} results in the searched sample · newest first`) : (zh ? `共 ${total} 条 · 按发布时间排序` : `${total} results · newest first`)}</div>
      <div class="education-feed">${items.length ? items.map(card).join('') : `<div class="education-empty"><strong>${zh ? '这个时间范围内暂无匹配内容' : 'No matching stories in this period'}</strong><p>${zh ? '试试扩大时间范围，或切换到其他分类。' : 'Try a longer time range or another category.'}</p></div>`}</div>
      ${offset > 0 || offset + items.length < total ? `<nav class="education-pagination" aria-label="${zh ? '分页' : 'Pagination'}">${offset > 0 ? `<a href="${escapeAttr(href({ offset: String(Math.max(0, offset - PAGE_SIZE)) }))}">← ${zh ? '上一页' : 'Previous'}</a>` : '<span></span>'}${offset + items.length < total && items.length ? `<a href="${escapeAttr(href({ offset: String(offset + PAGE_SIZE) }))}">${zh ? '下一页' : 'Next'} →</a>` : ''}</nav>` : ''}
      <details class="neuroscience-sources">
        <summary>${zh ? '来源与采集状态' : 'Sources and collection status'} · ${sources.length}</summary>
        <div class="sources-grid">${sources.map(s => `<a class="source-card" href="/sources/${escapeAttr(s.slug)}"><div class="source-card-header"><span class="source-name">${escapeHtml(s.label)}</span><span class="source-stat">${sourceState(s)}</span></div><p class="source-description">${escapeHtml(s.description || '')}</p><p class="source-last-success">${zh ? '最近成功' : 'Last success'}: ${escapeHtml(dateLabel(s.last_success_at ? s.last_success_at.replace(' ', 'T') + (s.last_success_at.endsWith('Z') ? '' : 'Z') : null, zh))}</p></a>`).join('')}</div>
        <p>${zh ? '延伸关注（账号链接，未自动采集）' : 'Further reading (account links, not automatically collected)'}: ${(data.recommended_accounts || []).map(account => safeLink(account.url) ? `<a href="${escapeAttr(safeLink(account.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(account.label)}</a>` : '').join(' · ')}</p>
      </details>
    </section>`;
  } catch {
    if (request !== requestNumber || window.location.pathname !== '/neuroscience') return;
    container.innerHTML = `<section class="page-section education-page"><div class="education-empty" role="alert"><strong>${zh ? '暂时无法加载脑科学资讯' : 'Unable to load neuroscience intelligence'}</strong><p>${zh ? '请稍后重试。' : 'Please try again later.'}</p><button type="button" class="action-btn" id="neuroscienceRetry">${zh ? '重试' : 'Retry'}</button></div></section>`;
    container.querySelector('#neuroscienceRetry')?.addEventListener('click', () => renderNeuroscience());
  }
}
