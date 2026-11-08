/**
 * Eagleye — papers page module
 *
 * arXiv paper browsing and the Physical AI stream.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml, timeAgo } from '../utils.js';
import { KnowledgeGraph } from '../graph-viz.js';
import { getLanguage, t } from '../i18n.js';
import { API_BASE, fetchJSON, pickZh, showError, showLoader, tagHref } from './shared.js';


// ─── Papers ────────────────────────────────────────────────

export async function renderPapers(_params) {
  const container = $('#pageContent');
  showLoader(container, getLanguage() === 'zh' ? '正在加载论文流...' : 'LOADING PAPERS...');

  // Normalize authors: API returns either ["Name", ...] (arXiv) or
  // [{_id, name, hidden}, ...] (hugging-face). Unify to string array.
  const normalizeAuthors = (raw) => {
    let arr = raw;
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { return []; } }
    if (!Array.isArray(arr)) return [];
    return arr.map(a => typeof a === 'string' ? a : (a && a.name) || '').filter(Boolean);
  };
  try {
    const url = new URL(window.location.href);
    const currentSource = url.searchParams.get('source') || 'all';
    const currentSort = url.searchParams.get('sort') || 'date';
    const currentView = url.searchParams.get('view') || 'list';
    const data = await fetchJSON(`${API_BASE}/papers?source=${encodeURIComponent(currentSource)}&limit=80`);
    const papers = data.papers || [];
    const sources = data.sources || [];
    const stats = data.stats || {};

    // Sort papers based on the selected sort option.
    const sorted = [...papers];
    if (currentSort === 'alpha') {
      sorted.sort((a, b) => (b.alpha_score || 0) - (a.alpha_score || 0));
    } else if (currentSort === 'upvotes') {
      sorted.sort((a, b) => {
        const av = typeof a.upvotes === 'number' ? a.upvotes : (a.popularity?.upvotes || 0);
        const bv = typeof b.upvotes === 'number' ? b.upvotes : (b.popularity?.upvotes || 0);
        return bv - av;
      });
    } else {
      // default: date (most recent first)
      sorted.sort((a, b) => new Date(b.published_at || 0).getTime() - new Date(a.published_at || 0).getTime());
    }

    const sourceTabs = [
      { slug: 'all', label: t('papers.all'), count: stats.total || 0 },
      ...sources.map(s => ({ slug: s.slug, label: s.label, count: s.count || 0 })),
    ];

    const renderSourceTab = (source) => {
      const href = source.slug === 'all' ? '/papers' : `/papers?source=${encodeURIComponent(source.slug)}`;
      const active = source.slug === currentSource;
      return `
        <a class="sources-tab-pill ${active ? 'active' : ''}" href="${href}">
          <span class="sources-tab-pill-icon">${source.slug === 'all' ? '📚' : '📄'}</span>
          <span>${escapeHtml(source.label)}</span>
          <span class="sources-tab-pill-count">${source.count}</span>
        </a>
      `;
    };

    const renderPaper = (paper) => {
      const title = pickZh(paper.title, paper.title_zh);
      const oneLiner = pickZh(paper.one_liner_zh || paper.short_summary_zh, paper.one_liner_zh || paper.short_summary_zh);
      // Normalize authors: API returns either ["Name", ...] (arXiv) or
      // [{_id, name, hidden}, ...] (hugging-face). Unify to string array.
      const authorNames = (paper.authors || []).map(a => typeof a === 'string' ? a : (a && a.name) || '').filter(Boolean);
      const authors = authorNames.slice(0, 5).join(', ');
      const categories = (paper.categories || []).slice(0, 4).map(cat => `<span class="mini-topic">${escapeHtml(cat)}</span>`).join('');
      const tags = (paper.tags || []).slice(0, 6).map(tag =>
        `<a href="${escapeAttr(tagHref(tag))}" class="tag-chip">#${escapeHtml(tag.name)}</a>`
      ).join(' ');
      const pdf = paper.pdf_url
        ? `<a class="mini-action mini-action-link" href="${escapeAttr(paper.pdf_url)}" target="_blank" rel="noopener">PDF ↗</a>`
        : '';
      // Abstract expansion: show a truncated version with a toggle.
      const abstract = paper.abstract || paper.original_summary || '';
      const abstractHtml = abstract
        ? `<details class="paper-abstract"><summary>${getLanguage() === 'zh' ? '摘要' : 'Abstract'}</summary><p>${escapeHtml(abstract)}</p></details>`
        : '';
      // BibTeX citation export: generates a valid BibTeX entry from paper metadata.
      const arxivId = paper.arxiv_id || '';
      const citeKey = (authorNames[0]?.split(' ').pop() || 'anon').toLowerCase() + (paper.published_at?.slice(0,4) || '2026') + (title.split(' ')[0]?.toLowerCase() || 'paper');
      const bibtex = `@article{${citeKey},\n  title = {${title}},\n  author = {${authorNames.join(' and ')}},\n  ${arxivId ? `eprint = {${arxivId}},\n  archivePrefix = {arXiv},\n  ` : ''}url = {${paper.canonical_url || ''}},\n  year = {${paper.published_at?.slice(0,4) || '2026'}},\n}`;
      const bibtexBtn = `<button class="mini-action" onclick='window.__copyBibtex(${JSON.stringify(bibtex).replace(/'/g,"\\'")})'>📋 BibTeX</button>`;
      return `
        <article class="mini-card paper-card">
          <div class="mini-card-top">
            <h4 class="mini-title">
              <a href="${escapeAttr(paper.canonical_url || '#')}" target="_blank" rel="noopener">${escapeHtml(title)}</a>
            </h4>
            ${oneLiner ? `<p class="mini-oneliner">${escapeHtml(oneLiner)}</p>` : ''}
          </div>
          <div class="mini-card-mid">
            <span class="mini-source">${escapeHtml(paper.source_label || '')}</span>
            ${paper.provider ? `<span class="mini-lang">${escapeHtml(paper.provider)}</span>` : ''}
            ${paper.published_at ? `<span class="mini-time">${timeAgo(paper.published_at)}</span>` : ''}
          </div>
          ${authors ? `<p class="paper-authors">${escapeHtml(authors)}</p>` : ''}
          ${abstractHtml}
          ${categories ? `<div class="mini-card-bottom">${categories}</div>` : ''}
          ${tags ? `<div class="card-tags paper-tags">${tags}</div>` : ''}
          <div class="mini-card-actions">
            ${bibtexBtn}
            ${pdf}
            <a class="mini-action mini-action-link" href="${escapeAttr(paper.canonical_url || '#')}" target="_blank" rel="noopener">${escapeHtml(getLanguage() === 'zh' ? '原文' : 'Source')} ↗</a>
          </div>
        </article>
      `;
    };

    container.innerHTML = `
      <section class="page-section papers-page">
        <div class="page-header">
          <h2 class="page-title">📄 ${t('papers.title')}</h2>
          <p class="page-description">${t('papers.subtitle')}</p>
        </div>

        <div class="source-stats">
          <div class="stat-card"><span class="stat-value">${stats.total || 0}</span><span class="stat-label">${t('papers.all')}</span></div>
          <div class="stat-card"><span class="stat-value">${stats.with_pdf || 0}</span><span class="stat-label">${t('papers.with_pdf')}</span></div>
          <div class="stat-card"><span class="stat-value">${stats.tagged || 0}</span><span class="stat-label">${t('papers.tagged')}</span></div>
        </div>

        <nav class="sources-tab-nav papers-source-nav" aria-label="${escapeAttr(t('papers.title'))}">
          <div class="sources-tab-nav-inner">
            <div class="sources-tab-nav-list" role="tablist">
              ${sourceTabs.map(renderSourceTab).join('')}
            </div>
          </div>
        </nav>

        ${(() => {
          // Category filter: collect unique arxiv categories from loaded papers.
          const allCats = new Set();
          for (const p of papers) {
            let cats;
            try { cats = typeof p.categories === 'string' ? JSON.parse(p.categories) : (p.categories || []); } catch { cats = []; }
            if (Array.isArray(cats)) cats.forEach(c => allCats.add(c));
          }
          const cats = [...allCats].sort();
          if (cats.length === 0) return '';
          const urlCat = new URLSearchParams(window.location.search).get('cat') || '';
          return `<div class="range-tabs" style="margin:8px 0">` +
            `<a href="/papers${currentSource !== 'all' ? '?source=' + currentSource : ''}" class="range-tab ${!urlCat ? 'active' : ''}">All cats</a>` +
            cats.map(c => {
              const params = new URLSearchParams();
              if (currentSource !== 'all') params.set('source', currentSource);
              if (c !== urlCat) params.set('cat', c);
              const qs = params.toString();
              return `<a href="/papers${qs ? '?' + qs : ''}" class="range-tab ${urlCat === c ? 'active' : ''}">${escapeHtml(c)}</a>`;
            }).join('') +
            `</div>` +
            `<div class="search-box" style="margin:4px 0 8px;max-width:300px"><input type="text" id="paperAuthorFilter" placeholder="${getLanguage() === 'zh' ? '按作者筛选…' : 'Filter by author...'}" value="${escapeAttr(new URLSearchParams(window.location.search).get('author') || '')}" style="width:100%"/></div>` +
            `<script>document.getElementById('paperAuthorFilter')?.addEventListener('keydown',function(e){if(e.key==='Enter'){var p=new URLSearchParams();${currentSource !== 'all' ? `p.set('source','${currentSource}');` : ''}${urlCat ? `p.set('cat','${urlCat}');` : ''}if(this.value)p.set('author',this.value);var qs=p.toString();window.location.href='/papers'+(qs?'?'+qs:'');}});</script>`;
        })()}

        ${(() => {
          // Sort selector: date / alpha / upvotes + view toggle (list/authors)
          const buildQs = (extra, view) => {
            const p = new URLSearchParams();
            if (currentSource !== 'all') p.set('source', currentSource);
            const urlCat = new URLSearchParams(window.location.search).get('cat');
            if (urlCat) p.set('cat', urlCat);
            if (extra) p.set('sort', extra);
            if (view) p.set('view', view);
            const qs = p.toString();
            return qs ? '?' + qs : '';
          };
          return `<div class="range-tabs" style="margin:4px 0 8px">` +
            `<span class="subtle" style="margin-right:8px">${getLanguage() === 'zh' ? '排序' : 'Sort'}:</span>` +
            `<a href="/papers${buildQs('date', currentView === 'authors' ? 'authors' : '')}" class="range-tab ${currentSort === 'date' ? 'active' : ''}">${getLanguage() === 'zh' ? '最新' : 'Date'}</a>` +
            `<a href="/papers${buildQs('alpha', currentView === 'authors' ? 'authors' : '')}" class="range-tab ${currentSort === 'alpha' ? 'active' : ''}">${getLanguage() === 'zh' ? 'Alpha' : 'Alpha'}</a>` +
            `<a href="/papers${buildQs('upvotes', currentView === 'authors' ? 'authors' : '')}" class="range-tab ${currentSort === 'upvotes' ? 'active' : ''}">${getLanguage() === 'zh' ? '点赞' : 'Upvotes'}</a>` +
            `<span style="margin:0 8px;color:var(--rule)">|</span>` +
            `<a href="/papers${buildQs(currentSort, '')}" class="range-tab ${currentView !== 'authors' && currentView !== 'network' ? 'active' : ''}">${getLanguage() === 'zh' ? '列表' : 'List'}</a>` +
            `<a href="/papers${buildQs(currentSort, 'authors')}" class="range-tab ${currentView === 'authors' ? 'active' : ''}">${getLanguage() === 'zh' ? '作者' : 'Authors'}</a>` +
            `<a href="/papers${buildQs(currentSort, 'network')}" class="range-tab ${currentView === 'network' ? 'active' : ''}">${getLanguage() === 'zh' ? '合作网络' : 'Network'}</a>` +
            `</div>`;
        })()}

        ${(() => {
          // Filter papers by selected category AND/OR author, then use sorted order.
          const urlCat = new URLSearchParams(window.location.search).get('cat') || '';
          const urlAuthor = new URLSearchParams(window.location.search).get('author') || '';
          const renderList = (list) => list.length
            ? `<div class="feed-list papers-list">${list.map(renderPaper).join('')}</div>`
            : `<p class="empty-state">${escapeHtml(t('papers.empty'))}</p>`;
          let result = sorted;
          if (urlCat) {
            result = result.filter(p => {
              let cats;
              try { cats = typeof p.categories === 'string' ? JSON.parse(p.categories) : (p.categories || []); } catch { cats = []; }
              return Array.isArray(cats) && cats.includes(urlCat);
            });
          }
          if (urlAuthor) {
            result = result.filter(p => {
              const authors = normalizeAuthors(p.authors);
              return authors.some(a => a.toLowerCase().includes(urlAuthor.toLowerCase()));
            });
          }
          if (currentView === 'authors') {
            // Author aggregate view: group papers by first author, show counts.
            const authorMap = {};
            for (const p of result) {
              const authors = normalizeAuthors(p.authors);
              if (authors[0]) {
                const a = authors[0];
                if (!authorMap[a]) authorMap[a] = { name: a, count: 0, papers: [] };
                authorMap[a].count++;
                authorMap[a].papers.push(p);
              }
            }
            const authorList = Object.values(authorMap).sort((a, b) => b.count - a.count).slice(0, 30);
            if (authorList.length === 0) return `<p class="empty-state">No author data.</p>`;
            return `<div class="metrics-block"><ul class="metrics-bars">` +
              authorList.map(a => {
                const maxCount = Math.max(1, ...authorList.map(x => x.count));
                const pct = Math.round((a.count / maxCount) * 100);
                return `<div class="metrics-bar-row">` +
                  `<span class="metrics-bar-label">${escapeHtml(a.name)}</span>` +
                  `<div class="metrics-bar"><div class="metrics-bar-fill" style="width:${pct}%"></div></div>` +
                  `<span class="metrics-bar-pct">${a.count}</span></div>`;
              }).join('') + `</ul></div>`;
          }
          if (currentView === 'network') {
            // Author collaboration network: build co-author edges from papers.
            const nodeMap = new Map();
            const edges = [];
            const edgeSet = new Set();
            for (const p of result) {
              const authors = normalizeAuthors(p.authors);
              if (authors.length < 2) continue;
              for (const a of authors.slice(0, 5)) {
                if (!nodeMap.has(a)) nodeMap.set(a, { id: a, label: a, type: 'author' });
              }
              // Create edges between all pairs of co-authors in this paper.
              for (let i = 0; i < authors.length && i < 5; i++) {
                for (let j = i + 1; j < authors.length && j < 5; j++) {
                  const key = [authors[i], authors[j]].sort().join('||');
                  if (!edgeSet.has(key)) {
                    edgeSet.add(key);
                    edges.push({ source: authors[i], target: authors[j], weight: 1 });
                  } else {
                    const e = edges.find(e => (e.source === authors[i] && e.target === authors[j]) || (e.source === authors[j] && e.target === authors[i]));
                    if (e) e.weight++;
                  }
                }
              }
            }
            const nodes = [...nodeMap.values()];
            if (nodes.length < 2 || edges.length === 0) return `<p class="empty-state">Not enough co-author data for a network.</p>`;
            // Render as a D3 KnowledgeGraph (reuse the existing class).
            setTimeout(async () => {
              const el = document.getElementById('papersNetworkGraph');
              if (el && typeof KnowledgeGraph !== 'undefined') {
                try {
                  const g = new KnowledgeGraph('papersNetworkGraph');
                  await g.init({ nodes, edges: edges.map(e => ({ ...e, source: e.source, target: e.target })) });
                } catch { el.innerHTML = '<p class="subtle">Graph render failed.</p>'; }
              }
            }, 100);
            return `<div id="papersNetworkGraph" style="height:400px;border:1px solid var(--rule);border-radius:var(--radius);margin-top:8px"></div>` +
              `<p class="subtle" style="margin-top:4px">${nodes.length} ${getLanguage() === 'zh' ? '位作者' : 'authors'} · ${edges.length} ${getLanguage() === 'zh' ? '条合作边' : 'collaboration edges'}</p>`;
          }
          return renderList(result);
        })()}
      </section>
    `;
  } catch (err) {
    showError(container, err.message);
  }
}

// ─── Physical AI ──────────────────────────────────────────

// Source labels and latest-item timestamps are data-backed. Avoid promising
// a sync cadence or inferring a source's enabled state from an empty response.
const PHYSICAL_AI_SECTIONS = [
  { slug: 'physical-ai-arxiv', icon: '📄', label: 'Physical AI — arXiv', labelZh: '具身智能 · arXiv' },
  { slug: 'physical-ai-humanoid', icon: '🤖', label: 'Physical AI — Humanoid', labelZh: '具身智能 · 人形机器人' },
  { slug: 'physical-ai-cn-photonics', icon: '🔬', label: 'Physical AI — CN Photonics', labelZh: '具身智能 · 中国光电',
    emptyNote: { zh: '该源暂无可用资讯。', en: 'No content available from this source yet.' } },
  { slug: 'physical-ai-sec-8k', icon: '🏛️', label: 'Physical AI — SEC 8-K', labelZh: '具身智能 · SEC 8-K',
    emptyNote: { zh: '暂无 SEC 申报记录，请在信息源中查看状态。', en: 'No SEC filings available. Check the source for its status.' } },
];

function physicalAiSectionLabel(sec) {
  return getLanguage() === 'zh' ? sec.labelZh : sec.label;
}

function physicalAiEmptyHtml(sec) {
  const text = sec.emptyNote
    ? (getLanguage() === 'zh' ? sec.emptyNote.zh : sec.emptyNote.en)
    : t('physical.empty');
  return `<p class="pa-empty">${escapeHtml(text)}</p>`;
}

function physicalAiItemHtml(item) {
  const title = pickZh(item.title || '[untitled]', item.ai_summary?.ai_title_zh || item.ai_title_zh || item.title_zh || '');
  const generatedSummary = item.ai_summary && pickZh(
    item.ai_summary.one_liner || item.ai_summary.short_summary || '',
    item.ai_summary.one_liner_zh || item.ai_summary.short_summary_zh || ''
  );
  const summaryRaw = generatedSummary || item.original_summary || '';
  const summary = String(summaryRaw || '').trim();
  let url = '';
  try {
    const parsed = new URL(item.canonical_url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = parsed.href;
  } catch { /* Render a title without a link when no safe original URL exists. */ }
  const published = item.published_at
    ? `<time class="pa-item-time" datetime="${escapeAttr(item.published_at)}">${escapeHtml(timeAgo(item.published_at))}</time>`
    : '';
  return `
    <article class="pa-item">
      <div class="pa-item-head">
        ${url ? `<a class="pa-item-title" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>` : `<span class="pa-item-title">${escapeHtml(title)}</span>`}
        ${published}
      </div>
      ${summary ? `<p class="pa-item-summary"><span class="pa-summary-label">${generatedSummary ? (getLanguage() === 'zh' ? 'AI 摘要' : 'AI summary') : (getLanguage() === 'zh' ? '原文摘要' : 'Source summary')}</span> ${escapeHtml(summary)}</p>` : ''}
    </article>
  `;
}

function physicalAiLoadingHtml() {
  return `
    <div class="pa-loading" role="status">
      <span class="pa-spinner" aria-hidden="true"></span>
      <span>${escapeHtml(t('common.loading'))}</span>
    </div>
  `;
}

async function loadPhysicalAiSection(sectionEl, sec, date = '') {
  const listEl = sectionEl.querySelector('.pa-items');
  if (!sec || !listEl) return;
  listEl.innerHTML = physicalAiLoadingHtml();
  try {
    // sort=recent: newest first (score-first ranking hides fresh items in
    // these low-score sources); dedupe=1: hide soft-marked duplicates
    // (cn-photonics was 690/700 duplicates); exclude_placeholders=1: drop
    // source_payload.is_placeholder rows before pagination. All three are
    // optional, backward-compatible /api/items params.
    const data = await fetchJSON(`${API_BASE}/items?source=${encodeURIComponent(sec.slug)}&limit=10&sort=recent&dedupe=1&exclude_placeholders=1${date ? `&date=${encodeURIComponent(date)}` : ''}`);
    const items = data.items || [];
    const newest = items.reduce(
      (acc, item) => (item.published_at && (!acc || item.published_at > acc) ? item.published_at : acc),
      null
    );
    const freshnessEl = sectionEl.querySelector('.pa-freshness');
    if (newest && freshnessEl) {
      freshnessEl.textContent = `${getLanguage() === 'zh' ? '最新' : 'Latest'} ${timeAgo(newest)}`;
      freshnessEl.hidden = false;
    }
    if (items.length === 0) {
      listEl.innerHTML = physicalAiEmptyHtml(sec);
      return;
    }
    listEl.innerHTML = items.map(physicalAiItemHtml).join('');
  } catch (err) {
    listEl.innerHTML = `
      <p class="pa-error">${escapeHtml(err && err.message ? err.message : t('common.error'))}</p>
      <button type="button" class="pa-retry">${getLanguage() === 'zh' ? '重试' : 'Retry'}</button>
    `;
    listEl.querySelector('.pa-retry')?.addEventListener('click', () => loadPhysicalAiSection(sectionEl, sec, date));
  }
}

export async function renderPhysicalAI(_params) {
  const container = $('#pageContent');
  const zh = getLanguage() === 'zh';
  const selectedDate = new URLSearchParams(window.location.search).get('date') || '';
  const parsedDate = new Date(`${selectedDate}T00:00:00Z`);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(selectedDate) && !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === selectedDate ? selectedDate : '';
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING PHYSICAL AI BRIEF...' : t('common.loading'));

  container.innerHTML = `
    <section class="page-section pa-page">
      <div class="page-header">
        <h2 class="page-title">${escapeHtml(t('physical.title'))}</h2>
        <p class="page-description">${escapeHtml(t('physical.subtitle'))}</p>
      </div>
      <form class="pa-date-filter" action="/physical-ai" method="get">
        <label for="physicalDate">${zh ? '采集日期' : 'Collection date'}</label>
        <input id="physicalDate" name="date" type="date" value="${escapeAttr(date)}" required>
        <button type="submit">${zh ? '查看当日快照' : 'View daily snapshot'}</button>
        ${date ? `<a href="/physical-ai?">${zh ? '查看最新' : 'View latest'}</a>` : ''}
        <span>${zh ? '按采集批次筛选，发布时间以条目为准。' : 'Filters the collection batch; each item shows its publication time.'}</span>
      </form>
      <div class="pa-grid">
        ${PHYSICAL_AI_SECTIONS.map(sec => `
          <section class="pa-section" data-slug="${escapeAttr(sec.slug)}" aria-label="${escapeAttr(physicalAiSectionLabel(sec))}">
            <header class="pa-section-header">
              <span class="pa-icon" aria-hidden="true">${sec.icon}</span>
              <h3 class="pa-section-title"><a class="pa-section-title-link" href="/sources/${escapeAttr(sec.slug)}">${escapeHtml(physicalAiSectionLabel(sec))}</a></h3>
              <span class="pa-freshness" hidden></span>
            </header>
            <div class="pa-items">${physicalAiLoadingHtml()}</div>
          </section>
        `).join('')}
      </div>
    </section>
  `;

  for (const sec of PHYSICAL_AI_SECTIONS) {
    const el = container.querySelector(`.pa-section[data-slug="${sec.slug}"]`);
    if (el) loadPhysicalAiSection(el, sec, date);
  }
}
