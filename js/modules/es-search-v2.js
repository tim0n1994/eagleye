/**
 * Eagleye — Aggregation Search v2 (ES 9.4 AI-powered)
 *
 * Perplexity-style 3-zone layout:
 *   Sidebar (facets) | Main column (AI answer → source cards → results → follow-ups)
 *
 * ES AI features: retrievers API, RRF + rerank, aggregations, RAG chat.
 * Fully on-theme: uses --bg-card / --fg / --fg-dim / --fg-mute / --accent.
 */

import { $, escapeHtml, escapeAttr, timeAgo, truncate } from './utils.js';
import { t, getLanguage } from './i18n.js';

const API_BASE = '/api';
const zh = () => getLanguage() === 'zh';

// ─── State ───────────────────────────────────────────────

let state = {
  q: '',
  mode: 'auto',           // 'auto' | 'keyword' | 'semantic' | 'hybrid'
  source: null,
  language: null,
  dateFrom: null,
  alphaRange: null,
  loading: false,
  aiLoading: false,
  aiVisible: false,
  lastResults: null,
};

// ─── Entry point ─────────────────────────────────────────

export async function renderESSearch(params) {
  const container = $('#pageContent');
  const urlParams = new URLSearchParams(window.location.search);
  const initialQ = params?.q || urlParams.get('q') || '';
  const initialMode = urlParams.get('mode') || 'auto';

  container.innerHTML = `
    <section class="es2-page">
      <!-- Search bar -->
      <div class="es2-search-header">
        <div class="es2-search-bar">
          <span class="es2-search-icon">🔍</span>
          <input type="text" id="es2Input" placeholder="${escapeAttr(zh() ? '搜索情报库… (AI 智能 · 关键词 · 语义 · 混合)' : 'Search intelligence corpus…')}" value="${escapeAttr(initialQ)}" autocomplete="off" />
          <div id="es2Suggest" class="es2-suggest" style="display:none"></div>
        </div>
        <div class="es2-mode-bar">
          ${modeBtn('auto', '✦ AI')}
          ${modeBtn('keyword', 'Aa')}
          ${modeBtn('semantic', '🧠')}
          ${modeBtn('hybrid', '⚡')}
          ${modeBtn('elser', '🔹')}
          <span class="es2-mode-tip" id="es2ModeTip"></span>
          <button class="es2-action-btn" id="es2SaveBtn" title="${zh() ? '保存搜索' : 'Save Search'}">🔖</button>
          <button class="es2-action-btn" id="es2TrendBtn" title="${zh() ? '趋势对比' : 'Trend Compare'}">📈</button>
        </div>
      </div>

      <!-- Body: sidebar + main -->
      <div class="es2-body">
        <aside class="es2-sidebar" id="es2Sidebar">
          <div id="es2Facets">
            <div class="es2-facet-section">
              <h4 class="es2-facet-title">${zh() ? '搜索后显示聚合' : 'Search to see facets'}</h4>
              <p style="font-size:11px;color:var(--fg-mute);margin:4px 0">${zh() ? '输入关键词后，这里会显示信息源/语言/时间/Alpha 等维度分布' : 'Source/language/timeline/alpha distributions will appear here after searching.'}</p>
            </div>
          </div>
        </aside>
        <main class="es2-main" id="es2Main">
          <div id="es2Filters" class="es2-filter-bar"></div>
          <div id="es2Stats" class="es2-stats"></div>
          <div id="es2AIPanel"></div>
          <div id="es2SourceCards"></div>
          <div id="es2Results"></div>
          <div id="es2FollowUps"></div>
        </main>
      </div>
    </section>
  `;

  // Update mode tip
  updateModeTip(initialMode);
  setActiveMode(initialMode);
  state.mode = initialMode;

  // Wire search input
  const input = container.querySelector('#es2Input');
  const btn = container.querySelector('#es2Input');

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { clearSuggest(); doSearch(); }
    if (e.key === 'Escape') input.blur();
  });

  // Debounced suggestions
  let suggTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(suggTimer);
    const val = input.value.trim();
    if (val.length < 2) { clearSuggest(); return; }
    suggTimer = setTimeout(() => fetchSuggest(val), 300);
  });

  // Mode buttons
  container.querySelectorAll('[data-mode-btn]').forEach(b => {
    b.addEventListener('click', () => {
      const m = b.dataset.modeBtn;
      setActiveMode(m);
      state.mode = m;
      updateModeTip(m);
      if (state.q) doSearch();
    });
  });

  // Save search button
  const saveBtn = container.querySelector('#es2SaveBtn');
  if (saveBtn) saveBtn.addEventListener('click', saveSearch);

  // Trend compare button
  const trendBtn = container.querySelector('#es2TrendBtn');
  if (trendBtn) trendBtn.addEventListener('click', toggleTrendPanel);

  // Health check
  checkHealth();

  // Auto-run if initial query
  if (initialQ) { state.q = initialQ; doSearch(); }
}

function modeBtn(mode, label) {
  return `<button class="es2-mode-btn" data-mode-btn="${mode}" title="${modeLabel(mode)}">${label}</button>`;
}

function modeLabel(m) {
  return ({ auto: zh() ? 'AI 智能搜索 (RRF + Rerank)' : 'AI Auto (RRF + Rerank)',
    keyword: zh() ? '关键词 (BM25)' : 'Keyword (BM25)',
    semantic: zh() ? '语义 (kNN)' : 'Semantic (kNN)',
    hybrid: zh() ? '混合 (RRF)' : 'Hybrid (RRF)',
    elser: zh() ? 'ELSER 语义 (ES 原生)' : 'ELSER (ES Native)' })[m] || m;
}

function setActiveMode(m) {
  document.querySelectorAll('[data-mode-btn]').forEach(b => {
    b.classList.toggle('active', b.dataset.modeBtn === m);
  });
}

function updateModeTip(m) {
  const tip = $('#es2ModeTip');
  if (tip) tip.textContent = modeLabel(m);
}

// ─── Health ──────────────────────────────────────────────

async function checkHealth() {
  try {
    const d = await (await fetch(`${API_BASE}/es/health`)).json();
    if (!d.connected) {
      const stats = $('#es2Stats');
      if (stats) stats.innerHTML = `<span class="es2-badge es2-badge-warn">⚠ ${t('es.es_down')}</span>`;
    }
  } catch { /* ignore */ }
}

// ─── Suggestions ─────────────────────────────────────────

function clearSuggest() {
  const box = $('#es2Suggest');
  if (box) box.style.display = 'none';
}

async function fetchSuggest(q) {
  const box = $('#es2Suggest');
  if (!box) return;
  try {
    const d = await (await fetch(`${API_BASE}/es/suggest?q=${encodeURIComponent(q)}`)).json();
    const sugs = d.suggestions || [];
    if (!sugs.length) { box.style.display = 'none'; return; }
    box.innerHTML = sugs.slice(0, 6).map(s =>
      `<div class="es2-suggest-item" data-text="${escapeAttr(s.text)}">${escapeHtml(truncate(s.text, 60))}${s.source ? ` <span class="es2-suggest-src">${escapeHtml(s.source)}</span>` : ''}</div>`
    ).join('');
    box.style.display = 'block';
    box.querySelectorAll('.es2-suggest-item').forEach(item => {
      item.addEventListener('click', () => {
        const inp = $('#es2Input');
        if (inp) { inp.value = item.dataset.text; state.q = item.dataset.text; }
        clearSuggest();
        doSearch();
      });
    });
  } catch { box.style.display = 'none'; }
}

// ─── Search ──────────────────────────────────────────────

async function doSearch() {
  const input = $('#es2Input');
  if (!input) return;
  state.q = input.value.trim();
  if (state.q.length < 2) return;

  syncURL();

  const resultsEl = $('#es2Results');
  if (resultsEl) resultsEl.innerHTML = `<div class="es2-loading">${t('common.loading')}</div>`;
  state.loading = true;

  const params = new URLSearchParams({ q: state.q, mode: state.mode, size: '25' });
  if (state.source) params.set('source', state.source);
  if (state.language) params.set('language', state.language);
  if (state.dateFrom) params.set('dateFrom', state.dateFrom);
  if (state.alphaRange) params.set('alphaRange', JSON.stringify(state.alphaRange));

  try {
    const data = await (await fetch(`${API_BASE}/es/search?${params}`)).json();
    state.lastResults = data;
    renderFilters();
    renderStats(data);
    renderFacets(data);
    renderResults(data);
    // Trigger AI answer if mode is auto (and there are results)
    if (state.mode === 'auto' && data.hits && data.hits.length > 0) {
      renderAIPanel(data);
    } else {
      const aiEl = $('#es2AIPanel');
      const scEl = $('#es2SourceCards');
      if (aiEl) aiEl.innerHTML = '';
      if (scEl) scEl.innerHTML = '';
    }
    renderFollowUps(null);
  } catch (err) {
    if (resultsEl) resultsEl.innerHTML = `<div class="es2-error">⚠ ${escapeHtml(err.message)}</div>`;
  } finally {
    state.loading = false;
  }
}

// ─── URL state ───────────────────────────────────────────

function syncURL() {
  const params = new URLSearchParams();
  params.set('q', state.q);
  if (state.mode !== 'auto') params.set('mode', state.mode);
  if (state.source) params.set('source', state.source);
  if (state.language) params.set('language', state.language);
  if (state.dateFrom) params.set('dateFrom', state.dateFrom);
  const newURL = `${window.location.pathname}?${params}`;
  history.replaceState(null, '', newURL);
}

// ─── Filter chips ────────────────────────────────────────

function renderFilters() {
  const el = $('#es2Filters');
  if (!el) return;
  const chips = [];
  if (state.source) chips.push({ label: state.source, key: 'source' });
  if (state.language) chips.push({ label: state.language, key: 'language' });
  if (state.dateFrom) chips.push({ label: `≥ ${state.dateFrom}`, key: 'dateFrom' });
  if (state.alphaRange) chips.push({ label: `α ${state.alphaRange.gte ?? '?'}-${state.alphaRange.lte ?? '?'}`, key: 'alphaRange' });

  if (!chips.length) { el.innerHTML = ''; return; }

  el.innerHTML = chips.map(c =>
    `<button class="es2-chip" data-filter="${c.key}">${escapeHtml(c.label)} <span class="es2-chip-x">×</span></button>`
  ).join('') + ` <button class="es2-chip-clear" id="es2ClearAll">${t('es.clear_all')}</button>`;

  el.querySelectorAll('[data-filter]').forEach(chip => {
    chip.addEventListener('click', () => { state[chip.dataset.filter] = null; doSearch(); });
  });
  const clearBtn = el.querySelector('#es2ClearAll');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    state.source = null; state.language = null; state.dateFrom = null; state.alphaRange = null;
    doSearch();
  });
}

// ─── Stats ───────────────────────────────────────────────

function renderStats(data) {
  const el = $('#es2Stats');
  if (!el) return;
  const total = data.total || 0;
  const took = data.took || 0;
  const engine = data.engine || '';
  const unique = data.aggs?.total_unique?.value;
  el.innerHTML = `<span class="es2-stats-count">${total}</span> ${zh() ? '条结果' : 'results'}${took ? ` · ${took}ms` : ''}${unique ? ` · ${unique} ${zh() ? '去重' : 'unique'}` : ''} <span class="es2-badge es2-badge-engine">${engine}</span>`;
}

// ─── Results ─────────────────────────────────────────────

function renderResults(data) {
  const el = $('#es2Results');
  const items = data.hits || [];
  if (!items.length) {
    el.innerHTML = `<div class="es2-empty">${t('search.no_results', { q: state.q })}</div>`;
    return;
  }
  el.innerHTML = `<div class="es2-result-list">${items.map(renderHit).join('')}</div>`;
  el.querySelectorAll('[data-seen-id]').forEach(a => {
    a.addEventListener('click', () => {
      fetch(`${API_BASE}/items/${a.dataset.seenId}/seen`, { method: 'POST' }).catch(() => {});
    });
  });
}

function renderHit(hit) {
  const title = hit.highlight?.title?.[0]
    || hit.highlight?.title_zh?.[0]
    || escapeHtml(truncate(hit.title_zh || hit.title || hit.ai_title || '', 120));
  const summary = hit.highlight?.short_summary_zh?.[0]
    || escapeHtml(truncate(hit.short_summary_zh || hit.one_liner || '', 160));
  const alpha = hit.sig_alpha != null ? Math.round(hit.sig_alpha * 100) : null;
  const novelty = hit.sig_novelty != null ? Math.round(hit.sig_novelty * 100) : null;
  const src = escapeHtml(hit.source_label || '?');

  return `
    <article class="es2-result-card">
      <div class="es2-result-meta">
        <span class="es2-result-src">${src}</span>
        ${hit.language ? `<span class="es2-result-lang">${escapeHtml(hit.language)}</span>` : ''}
        ${alpha != null ? `<span class="es2-score es2-score-alpha" title="Alpha">α${alpha}</span>` : ''}
        ${novelty != null ? `<span class="es2-score es2-score-nov" title="Novelty">✨${novelty}</span>` : ''}
        ${hit.published_at ? `<span class="es2-result-date">${escapeHtml(timeAgo(hit.published_at))}</span>` : ''}
      </div>
      <a href="${escapeAttr(hit.url || '#')}" target="_blank" rel="noopener" data-seen-id="${escapeAttr(hit.item_id || '')}" class="es2-result-title">${title}</a>
      ${summary ? `<p class="es2-result-summary">${summary}</p>` : ''}
    </article>
  `;
}

// ─── AI Panel (Perplexity-style) ─────────────────────────

function renderAIPanel(searchData) {
  const aiEl = $('#es2AIPanel');
  const scEl = $('#es2SourceCards');
  if (!aiEl) return;

  // Show a "thinking" state
  aiEl.innerHTML = `
    <div class="es2-ai-panel">
      <div class="es2-ai-header">
        <span class="es2-ai-icon">✦</span>
        <span class="es2-ai-label">${t('es.ai_answer')}</span>
        <span class="es2-ai-loading">${zh() ? '检索情报中…' : 'Searching corpus…'}</span>
      </div>
    </div>
  `;
  scEl.innerHTML = '';
  state.aiLoading = true;

  // Kick off RAG query
  doRAG(state.q);
}

async function doRAG(question) {
  const aiEl = $('#es2AIPanel');
  const scEl = $('#es2SourceCards');
  const fuEl = $('#es2FollowUps');

  const params = new URLSearchParams();
  if (state.source) params.set('source', state.source);
  if (state.language) params.set('language', state.language);
  if (state.dateFrom) params.set('dateFrom', state.dateFrom);

  try {
    const resp = await fetch(`${API_BASE}/es/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, mode: 'auto', source: state.source, language: state.language, dateFrom: state.dateFrom }),
    });
    const data = await resp.json();

    if (data.status !== 'ok') throw new Error(data.error || 'RAG failed');

    // Render AI answer
    const answer = escapeHtml(data.answer || '')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\[(\d+)\]/g, '<sup class="es2-cite" data-cite="$1">$1</sup>')
      .replace(/\n/g, '<br>');

    const degraded = data.degraded ? `<span class="es2-ai-degraded">${zh() ? '⚠ 无检索增强' : '⚠ no retrieval'}</span>` : '';
    const srcCount = (data.sources || []).length;

    aiEl.innerHTML = `
      <div class="es2-ai-panel">
        <div class="es2-ai-header">
          <span class="es2-ai-icon">✦</span>
          <span class="es2-ai-label">${t('es.ai_answer')}</span>
          ${degraded}
          <button class="es2-ai-regen" id="es2Regen" title="${t('es.regenerate')}">↻</button>
        </div>
        <div class="es2-ai-body">${answer}</div>
      </div>
    `;

    // Source cards
    const sources = data.sources || [];
    if (sources.length) {
      scEl.innerHTML = `
        <div class="es2-source-grid">
          ${sources.slice(0, 6).map((s, i) => `
            <a class="es2-source-card" href="${escapeAttr(s.url || '#')}" target="_blank" rel="noopener">
              <span class="es2-source-num">${i + 1}</span>
              <span class="es2-source-label">${escapeHtml(s.source || '')}</span>
              <span class="es2-source-title">${escapeHtml(truncate(s.title, 50))}</span>
            </a>
          `).join('')}
        </div>
      `;
    }

    // Follow-up questions
    const followUps = data.followUpQuestions || [];
    if (followUps.length) {
      renderFollowUps(followUps);
    }

    // Regenerate button
    const regen = aiEl.querySelector('#es2Regen');
    if (regen) regen.addEventListener('click', () => {
      aiEl.innerHTML = `<div class="es2-ai-panel"><div class="es2-ai-header"><span class="es2-ai-icon">✦</span><span class="es2-ai-loading">${zh() ? '重新生成…' : 'Regenerating…'}</span></div></div>`;
      doRAG(question);
    });

  } catch (err) {
    aiEl.innerHTML = `<div class="es2-ai-panel es2-error-panel"><span class="es2-ai-icon">⚠</span> ${escapeHtml(err.message)}</div>`;
  } finally {
    state.aiLoading = false;
  }
}

function renderFollowUps(questions) {
  const el = $('#es2FollowUps');
  if (!el) return;
  if (!questions || !questions.length) { el.innerHTML = ''; return; }

  el.innerHTML = `
    <div class="es2-followup-bar">
      <span class="es2-followup-label">${t('es.related')}</span>
      ${questions.map(q => `<button class="es2-followup-q" data-q="${escapeAttr(q)}">➤ ${escapeHtml(q)}</button>`).join('')}
    </div>
  `;
  el.querySelectorAll('[data-q]').forEach(b => {
    b.addEventListener('click', () => {
      const inp = $('#es2Input');
      if (inp) { inp.value = b.dataset.q; state.q = b.dataset.q; }
      doSearch();
    });
  });
}

// ─── Facets (sidebar) ────────────────────────────────────

function renderFacets(data) {
  const el = $('#es2Facets');
  if (!el || !data.aggs || data.es_down) {
    if (el) el.innerHTML = data.es_down ? `<div class="es2-facet-down">${t('es.es_down')}</div>` : '';
    return;
  }

  const a = data.aggs;
  el.innerHTML = `
    ${facetPanel('📊 ' + (zh() ? '信息源' : 'Sources'), a.by_source?.buckets || [], 'source', true)}
    ${facetPanel('🌐 ' + (zh() ? '语言' : 'Language'), a.by_language?.buckets || [], 'language', false)}
    ${facetTimeline('📅 ' + (zh() ? '时间' : 'Timeline'), a.over_time?.buckets || [])}
    ${facetAlpha('🎯 Alpha', a.alpha_buckets?.buckets || [])}
    ${facetSigTerms('🔥 ' + (zh() ? '热词' : 'Significant'), a.sig_terms?.buckets || [])}
  `;

  // Wire clicks
  el.querySelectorAll('[data-facet-key]').forEach(item => {
    item.addEventListener('click', () => {
      state[item.dataset.facetKey] = item.dataset.facetVal;
      doSearch();
    });
  });
  el.querySelectorAll('[data-date-from]').forEach(item => {
    item.addEventListener('click', () => { state.dateFrom = item.dataset.dateFrom; doSearch(); });
  });
  el.querySelectorAll('[data-alpha-range]').forEach(item => {
    item.addEventListener('click', () => { state.alphaRange = JSON.parse(item.dataset.alphaRange); doSearch(); });
  });
  el.querySelectorAll('[data-sig-term]').forEach(item => {
    item.addEventListener('click', () => {
      const inp = $('#es2Input');
      if (inp) { inp.value = item.dataset.sigTerm; state.q = item.dataset.sigTerm; }
      doSearch();
    });
  });
}

function facetPanel(title, buckets, facetKey, showSubStats) {
  if (!buckets.length) return '';
  const mx = buckets[0].doc_count || 1;
  const rows = buckets.slice(0, 10).map(b => {
    const pct = Math.round(b.doc_count / mx * 100);
    const sub = showSubStats && b.avg_alpha?.value != null
      ? ` <span class="es2-facet-sub">α${Math.round(b.avg_alpha.value * 100)}</span>` : '';
    return `<div class="es2-facet-row ${facetKey ? 'clickable' : ''}" ${facetKey ? `data-facet-key="${facetKey}" data-facet-val="${escapeAttr(String(b.key))}"` : ''}>
      <span class="es2-facet-label">${escapeHtml(truncate(String(b.key), 22))}${sub}</span>
      <div class="es2-facet-bar-track"><div class="es2-facet-bar" style="width:${pct}%"></div></div>
      <span class="es2-facet-count">${b.doc_count}</span>
    </div>`;
  }).join('');
  return `<div class="es2-facet-section"><h4 class="es2-facet-title">${escapeHtml(title)}</h4>${rows}</div>`;
}

function facetTimeline(title, buckets) {
  if (!buckets.length) return '';
  const sorted = [...buckets].sort((a, b) => a.key - b.key).slice(-12);
  const mx = Math.max(...sorted.map(b => b.doc_count), 1);
  const rows = sorted.map(b => {
    const dt = new Date(b.key).toISOString().slice(0, 10);
    const h = Math.max(3, Math.round(b.doc_count / mx * 32));
    const alpha = b.avg_alpha?.value != null ? ` <span class="es2-facet-sub">α${Math.round(b.avg_alpha.value * 100)}</span>` : '';
    return `<div class="es2-facet-row clickable" data-date-from="${dt}">
      <span class="es2-facet-date">${dt.slice(5)}</span>
      <div class="es2-facet-timeline-bar" style="height:${h}px"></div>
      <span class="es2-facet-count">${b.doc_count}</span>${alpha}
    </div>`;
  }).join('');
  return `<div class="es2-facet-section"><h4 class="es2-facet-title">${escapeHtml(title)}</h4><div class="es2-facet-timeline">${rows}</div></div>`;
}

function facetAlpha(title, buckets) {
  if (!buckets.length) return '';
  const labels = { high: '★ ≥0.7', mid: '0.3-0.7', low: '<0.3' };
  const ranges = { high: { gte: 0.7 }, mid: { gte: 0.3, lte: 0.7 }, low: { lte: 0.3 } };
  const total = buckets.reduce((s, x) => s + x.doc_count, 0);
  const rows = buckets.map(b => {
    const w = total ? Math.round(b.doc_count / total * 100) : 0;
    return `<div class="es2-facet-row clickable" data-alpha-range='${JSON.stringify(ranges[b.key])}'>
      <span class="es2-facet-label">${labels[b.key] || b.key}</span>
      <div class="es2-facet-bar-track"><div class="es2-facet-bar" style="width:${w}%"></div></div>
      <span class="es2-facet-count">${b.doc_count}</span>
    </div>`;
  }).join('');
  return `<div class="es2-facet-section"><h4 class="es2-facet-title">${escapeHtml(title)}</h4>${rows}</div>`;
}

function facetSigTerms(title, buckets) {
  if (!buckets.length) return '';
  const rows = buckets.slice(0, 8).map(b => {
    const pct = Math.round(b.doc_count / Math.max(b.bg_count, 1) * 100);
    return `<div class="es2-facet-row clickable es2-facet-sig" data-sig-term="${escapeAttr(b.key)}">
      <span class="es2-facet-label">${escapeHtml(b.key)}</span>
      <span class="es2-facet-pct">${pct}%</span>
    </div>`;
  }).join('');
  return `<div class="es2-facet-section"><h4 class="es2-facet-title">${escapeHtml(title)}</h4>${rows}</div>`;
}

// ─── Save Search ─────────────────────────────────────────

async function saveSearch() {
  if (!state.q || state.q.length < 2) return;
  const filters = {};
  if (state.source) filters.source = state.source;
  if (state.language) filters.language = state.language;
  if (state.dateFrom) filters.dateFrom = state.dateFrom;
  try {
    await fetch(`${API_BASE}/es/saved`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: state.q, mode: state.mode, filters }),
    });
    const btn = $('#es2SaveBtn');
    if (btn) { btn.textContent = '✅'; setTimeout(() => { if (btn) btn.textContent = '🔖'; }, 2000); }
  } catch (err) {
    console.warn('[es-search] saving this search failed:', err.message);
  }
}

// ─── Trend Comparison Panel ──────────────────────────────

let trendVisible = false;

async function toggleTrendPanel() {
  if (!state.q || state.q.length < 2) return;
  trendVisible = !trendVisible;
  if (!trendVisible) {
    const trendEl = $('#es2TrendPanel');
    if (trendEl) trendEl.remove();
    return;
  }
  await loadTrend(state.q);
}

async function loadTrend(q) {
  const main = $('#es2Main');
  const results = $('#es2Results');
  if (!main || !results) return;

  let panel = $('#es2TrendPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'es2TrendPanel';
    panel.className = 'es2-trend-panel';
    main.insertBefore(panel, results);
  }
  panel.innerHTML = `<div class="es2-loading">${zh() ? '计算趋势…' : 'Computing trend…'}</div>`;

  try {
    const data = await (await fetch(`${API_BASE}/es/trend?q=${encodeURIComponent(q)}`)).json();
    if (data.es_down || data.error) {
      panel.innerHTML = `<div class="es2-empty">${data.error || t('es.es_down')}</div>`;
      return;
    }
    const tw = data.this_week, lw = data.last_week;
    const growth = data.growth_pct;
    const arrow = growth > 0 ? '↑' : growth < 0 ? '↓' : '→';
    const growthColor = growth > 0 ? 'var(--olive)' : growth < 0 ? '#ef4444' : 'var(--fg-mute)';

    const weeks = data.weekly || [];
    const maxCount = Math.max(...weeks.map(w => w.count), 1);
    const weekBars = weeks.slice(-12).map(w => {
      const h = Math.max(3, Math.round(w.count / maxCount * 36));
      const dt = w.week.slice(5);
      return `<div class="es2-trend-bar-col" title="${w.week}: ${w.count} items">
        <div class="es2-trend-bar" style="height:${h}px"></div>
        <span class="es2-trend-bar-date">${dt}</span>
        <span class="es2-trend-bar-count">${w.count}</span>
      </div>`;
    }).join('');

    panel.innerHTML = `
      <div class="es2-trend-header">
        <span class="es2-trend-title">📈 ${zh() ? '趋势对比' : 'Trend Compare'}: "${escapeHtml(q)}"</span>
      </div>
      <div class="es2-trend-stats">
        <div class="es2-trend-stat">
          <span class="es2-trend-stat-label">${zh() ? '本周' : 'This Week'}</span>
          <span class="es2-trend-stat-val">${tw.count}</span>
          <span class="es2-trend-stat-sub">α ${tw.avg_alpha != null ? Math.round(tw.avg_alpha * 100) : '?'}%</span>
        </div>
        <div class="es2-trend-growth" style="color:${growthColor}">${arrow} ${Math.abs(growth)}%</div>
        <div class="es2-trend-stat">
          <span class="es2-trend-stat-label">${zh() ? '上周' : 'Last Week'}</span>
          <span class="es2-trend-stat-val">${lw.count}</span>
          <span class="es2-trend-stat-sub">α ${lw.avg_alpha != null ? Math.round(lw.avg_alpha * 100) : '?'}%</span>
        </div>
      </div>
      ${tw.sources && tw.sources.length ? `<div class="es2-trend-sources">${zh() ? '本周主力源' : 'Top sources'}: ${tw.sources.map(s => `${escapeHtml(s.key)} (${s.doc_count})`).join(', ')}</div>` : ''}
      ${weekBars ? `<div class="es2-trend-chart">${weekBars}</div>` : ''}
    `;
  } catch (err) {
    panel.innerHTML = `<div class="es2-error">⚠ ${escapeHtml(err.message)}</div>`;
  }
}
