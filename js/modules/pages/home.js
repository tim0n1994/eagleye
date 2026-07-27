/**
 * Eagleye — home page module
 *
 * The front page: hero digest, source-grouped feed and progressive loading.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml, localDateStr } from '../utils.js';
import { getLanguage, t } from '../i18n.js';
import { progressiveDateFeed } from '../progressive.js';
import { router } from '../router.js';
import { API_BASE, fetchJSON, orderedSourceEntries, pickZh, renderItemMiniCard, showError, showLoader , setSourcesCache } from './shared.js';


// ─── Home / News ─────────────────────────────────────────

export async function renderHome(params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING SIGNALS...' : t('common.loading'));

try {
      const queryDate = params?.date || new URLSearchParams(window.location.search).get('date');
      const today = queryDate || localDateStr();
      const isToday = today === localDateStr();

      // Fetch sources to get full list (14 sources)
     const srcData = await fetchJSON(`${API_BASE}/sources`);
     const allSources = srcData.sources || [];
     setSourcesCache(allSources);

     // Fetch today's items (initial batch: 60, progressive loading picks up the rest)
     let data = await fetchJSON(`${API_BASE}/items?date=${today}&limit=60`);

     // If no items for today, try getting most recent date with data
     let displayDate = today;
     let dateIsToday = isToday;
     if ((data.items || []).length === 0 && !queryDate) {
       // Try yesterday
       const yesterday = new Date();
       yesterday.setDate(yesterday.getDate() - 1);
       const yesterdayStr = localDateStr(yesterday);
       data = await fetchJSON(`${API_BASE}/items?date=${yesterdayStr}&limit=60`);
       displayDate = yesterdayStr;
       dateIsToday = false;
     }

     // Build by_source map from items (items come with source_label)
     const bySourceMap = {};
     for (const item of data.items || []) {
       const src = item.source_label || 'Other';
       if (!bySourceMap[src]) bySourceMap[src] = [];
       bySourceMap[src].push(item);
     }

     // Build label-to-slug map including _zh variants so anchor nav and section headers
     // can show the localized name regardless of which language the user picks.
     const labelToObj = {};
     for (const s of allSources) {
       labelToObj[s.label] = s;
       if (s.label_zh) labelToObj[s.label_zh] = s;
     }

     // Ensure all sources appear, even empty today
     for (const src of allSources) {
       const label = src.label;
       if (!(label in bySourceMap)) {
         bySourceMap[label] = [];
       }
     }

      const html = `
       <section class="page-section">
         <div class="issue-header">
          <div class="issue-meta">
            <span class="issue-number">ISSUE #${displayDate}</span>
            <span class="issue-date">${new Date(displayDate.slice(0,4)+'-'+displayDate.slice(4,6)+'-'+displayDate.slice(6,8)).toLocaleDateString(getLanguage() === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' })}${dateIsToday ? ` (${t('home.today')})` : ''}</span>
          </div>
          <div class="issue-nav">
            <button class="nav-btn" onclick="window.__changeDate(-1)">← PREV</button>
            <button class="nav-btn" onclick="window.__changeDate(1)">NEXT →</button>
          </div>
        </div>

         <div class="hero-banner">
           <div class="hero-content">
             <h2 class="hero-title">EAGLEYE</h2>
             <p class="hero-subtitle">${t('brand.tagline')} Radar</p>
             <div class="hero-stats" id="heroStats">
               <span class="hero-stat">${Object.keys(bySourceMap).length} ${getLanguage() === 'zh' ? '信息源' : 'SOURCES'}</span>
               <span class="hero-stat">${Object.values(bySourceMap).reduce((sum, arr) => sum + arr.length, 0)} ${getLanguage() === 'zh' ? '今日信号' : 'SIGNALS'}</span>
               <span class="hero-stat">⏱ ${(() => {
                 // Estimate total reading time: sum all item summaries' word counts.
                 let totalWords = 0;
                 for (const items of Object.values(bySourceMap)) {
                   for (const item of items) {
                     const text = (item.ai_summary?.short_summary_zh || item.ai_summary?.short_summary || item.original_summary || item.title || '').toString();
                     totalWords += text.length / 3;
                   }
                 }
                 const mins = Math.round(totalWords / 200);
                 return mins > 60 ? Math.round(mins / 60) + 'h' : mins + 'm';
               })()} ${getLanguage() === 'zh' ? '阅读' : 'READ'}</span>
               <span class="hero-stat" id="heroStatExtra"></span>
             </div>
           </div>
         </div>

        <div id="homeDigest" class="home-digest-loading"><span class="spinner"></span> ${t('home.loading_digest')}</div>

        <div class="search-wrap search-wrap-full">
          <input type="text" class="search-input-hero" id="heroSearchInput" placeholder="${escapeAttr(t('common.search_ph'))}" autocomplete="off">
        </div>

         <div class="section-anchor-nav" id="sectionNav">
           ${orderedSourceEntries(bySourceMap, allSources).map(([src, _items, sourceObjFromOrder]) => {
             const sourceObj = sourceObjFromOrder || labelToObj[src];
             const slug = sourceObj ? sourceObj.slug : '';
             const displayName = sourceObj ? pickZh(sourceObj.label, sourceObj.label_zh) : src;
             return `<a href="/sources/${escapeAttr(slug)}" class="anchor-link">${escapeHtml(displayName)}</a>`;
           }).join('')}
         </div>

         <div class="items-by-source">
           ${orderedSourceEntries(bySourceMap, allSources).map(([source, items, sourceObjFromOrder]) => {
             const sourceObj = sourceObjFromOrder || labelToObj[source];
             const displayName = sourceObj ? pickZh(sourceObj.label, sourceObj.label_zh) : source;
             return `
             <section id="section-${escapeAttr(source)}" class="source-section">
               <div class="source-section-header">
                 <h3 class="source-section-title">${escapeHtml(displayName)}</h3>
                 <span class="source-section-count">${items.length} ITEMS</span>
               </div>
               <div class="feed-list">
                 ${items.map(item => renderItemMiniCard(item)).join('')}
               </div>
             </section>
           `;}).join('')}
         </div>

        <details style="margin-top:24px;border-top:1px solid var(--rule);padding-top:16px">
          <summary style="cursor:pointer;font-size:11px;text-transform:uppercase;letter-spacing:0.16em;color:var(--fg-mute)">${getLanguage() === 'zh' ? '📄 文本视图（可复制）' : '📄 Text View (copyable)'}</summary>
          <div id="textDigestView" style="margin-top:12px;font-family:var(--font-mono);font-size:12px;line-height:1.8;color:var(--fg-dim);white-space:pre-wrap">${(() => {
            // Build a plain-text digest of all items grouped by source (§7.2 SSR text view).
            let txt = `${getLanguage() === 'zh' ? ' Eagleye 每日信息流' : ' Eagleye Daily Feed'} — ${displayDate}\n${'='.repeat(60)}\n\n`;
            for (const [src, srcItems] of orderedSourceEntries(bySourceMap, allSources)) {
              const sourceObj = labelToObj[src];
              const displayName = sourceObj ? pickZh(sourceObj.label, sourceObj.label_zh) : src;
              txt += `\n## ${displayName} (${srcItems.length})\n\n`;
              for (const item of srcItems.slice(0, 30)) {
                const title = item.ai_summary?.ai_title_zh || item.title_zh || item.title || '';
                txt += `  • ${title}\n    ${item.canonical_url || ''}\n`;
              }
            }
            return escapeHtml(txt);
          })()}</div>
        </details>

        <div class="metrics-block" style="margin-top:24px">
          <h3 class="metrics-block-title">${getLanguage() === 'zh' ? '近 7 天活动' : 'Last 7 Days Activity'}</h3>
          <div id="insightStrip" style="display:flex;gap:8px;overflow-x:auto;padding:4px 0">
            <span class="subtle">Loading...</span>
          </div>
        </div>
      </section>
    `;

    container.innerHTML = html;

    // Async: fetch last 7 days activity strip.
    fetchJSON(`${API_BASE}/digest/coverage`).then(covData => {
      const strip = document.getElementById('insightStrip');
      if (!strip) return;
      const coverage = covData.coverage || {};
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const ds = localDateStr(d);
        days.push({ date: ds, count: coverage[ds] || 0, label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) });
      }
      const maxC = Math.max(1, ...days.map(d => d.count));
      strip.innerHTML = days.map(d => {
        const h = Math.max(4, (d.count / maxC) * 40);
        const opacity = d.count > 0 ? 0.4 + 0.6 * (d.count / maxC) : 0.1;
        return `<a href="/digest/${d.date}" style="display:flex;flex-direction:column;align-items:center;gap:4px;min-width:60px;text-decoration:none">` +
          `<div style="width:40px;height:${h}px;background:var(--accent);opacity:${opacity};border-radius:3px" title="${d.count} items"></div>` +
          `<span style="font-size:9px;color:var(--fg-mute);font-family:var(--font-mono)">${d.label.split(' ')[0]}</span>` +
          `<span style="font-size:10px;color:${d.count > 0 ? 'var(--accent)' : 'var(--fg-mute)'};font-weight:600">${d.count}</span>` +
          `</a>`;
      }).join('');
    }).catch(() => { const s = document.getElementById('insightStrip'); if (s) s.style.display = 'none'; });

    // Async: fetch system stats for the hero badge (entities, total items).
    fetchJSON(`${API_BASE}/system/stats`).then(sysData => {
      const el = document.getElementById('heroStatExtra');
      if (!el || !sysData.stats) return;
      const s = sysData.stats;
      el.textContent = `${(s.entities || 0).toLocaleString()} ${getLanguage() === 'zh' ? '实体' : 'ENTITIES'} · ${(s.scored || 0).toLocaleString()} ${getLanguage() === 'zh' ? '已评分' : 'SCORED'}`;
    }).catch(() => { const el = document.getElementById('heroStatExtra'); if (el) el.style.display = 'none'; });

    // Fetch and render the AI Daily Digest for this date (§7.2: homepage must
    // show an AI-generated digest above the source sections). Non-blocking —
    // if no digest exists or the fetch fails, the section stays hidden.
    fetchJSON(`/api/digest?date=${encodeURIComponent(displayDate)}`).then(digestData => {
      const digest = digestData.digest;
      const el = document.getElementById('homeDigest');
      if (!el) return;
      if (!digest || !digest.headline) { el.style.display = 'none'; return; }
      const parseList = (field) => {
        try { const arr = typeof field === 'string' ? JSON.parse(field) : field; return Array.isArray(arr) ? arr : []; } catch { return []; }
      };
      const topSignals = parseList(digest.top_signals);
      const signals = topSignals.slice(0, 5).map(s =>
        `<li class="digest-signal"><span class="digest-signal-title">${escapeHtml(s.title || '')}</span>${s.reason ? `<span class="digest-signal-reason">${escapeHtml(s.reason)}</span>` : ''}</li>`
      ).join('');
      el.className = 'home-digest';
      el.innerHTML =
        `<div class="digest-head"><h3>🤖 ${t('home.ai_digest')}</h3><span class="digest-date">${escapeHtml(digest.digest_date || displayDate)}</span></div>` +
        `<h4 class="digest-headline">${escapeHtml(digest.headline)}</h4>` +
        (digest.executive_summary ? `<p class="digest-summary">${escapeHtml(digest.executive_summary)}</p>` : '') +
        (signals ? `<ul class="digest-signals">${signals}</ul>` : '') +
        `<a href="/digest/${escapeAttr(digest.digest_date || displayDate)}" class="digest-link">${t('home.full_digest')} →</a>`;
    }).catch(() => { const el = document.getElementById('homeDigest'); if (el) el.style.display = 'none'; });

    // Wire search input on homepage
    const heroSearchInput = /** @type {HTMLInputElement | null} */ (document.getElementById('heroSearchInput'));
    if (heroSearchInput) {
      heroSearchInput.addEventListener('input', () => {
        const q = heroSearchInput.value.trim().toLowerCase();
        const cards = container.querySelectorAll('.info-card');
        cards.forEach(card => {
          const title = card.querySelector('.card-title')?.textContent?.toLowerCase() || '';
          const summary = card.querySelector('.card-summary')?.textContent?.toLowerCase() || '';
          const src = card.querySelector('.card-source')?.textContent?.toLowerCase() || '';
          const oneLiner = card.querySelector('.card-one-liner')?.textContent?.toLowerCase() || '';
          const visible = !q || title.includes(q) || summary.includes(q) || src.includes(q) || oneLiner.includes(q);
          card.style.display = visible ? '' : 'none';
          // Highlight matching text
          const titleEl = card.querySelector('.card-title a') || card.querySelector('.card-title');
          if (visible && q && titleEl) {
            if (titleEl.dataset.original === undefined) titleEl.dataset.original = titleEl.innerHTML;
            const originalHtml = titleEl.dataset.original;
            const r = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
            titleEl.innerHTML = originalHtml.replace(r, '<mark style="background:var(--accent); color:#000; padding:0 2px;">$1</mark>');
          } else if (titleEl && titleEl.dataset.original !== undefined) {
            titleEl.innerHTML = titleEl.dataset.original;
          }
        });
        // Update visible counts for source sections
        container.querySelectorAll('.source-section').forEach(section => {
          const cards = section.querySelectorAll('.info-card');
          const visible = Array.from(cards).filter(c => c.style.display !== 'none').length;
          const countEl = section.querySelector('.source-section-count');
          if (countEl) countEl.textContent = `${visible} ITEMS`;
        });
      }, { passive: true });
    }

    // Sticky section nav behavior
    const sections = container.querySelectorAll('.source-section');
    const nav = container.querySelector('#sectionNav');
    if (nav && sections.length > 0) {
      const onScroll = () => {
        let current = '';
        sections.forEach(sec => {
          const top = sec.getBoundingClientRect().top;
          if (top < 200) current = sec.id;
        });
        nav.querySelectorAll('.anchor-link').forEach(a => {
          a.classList.toggle('active', a.getAttribute('href') === `#${current}`);
        });
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      // The listener outlives the DOM it updates, so without this it stacks up
      // one live copy per visit to the home page.
      router.onCleanup(() => window.removeEventListener('scroll', onScroll));
    }

    /** @type {any} */ (window).__changeDate = (delta) => {
      // Parse current date from URL or use today
      const queryDate = new URLSearchParams(window.location.search).get('date')
        || params?.date
        || localDateStr();
      const d = new Date(queryDate.slice(0,4)+'-'+queryDate.slice(4,6)+'-'+queryDate.slice(6,8));
      d.setDate(d.getDate() + delta);
      const newDate = localDateStr(d);
      if ((/** @type {any} */ (window)).__router) {
        (/** @type {any} */ (window)).__router.navigate(`/news/${newDate}`);
      }
    };

    // Progressive loading: append more items as user scrolls
    const feedContainer = container.querySelector('.items-by-source');
    if (feedContainer) {
      progressiveDateFeed({
        container: feedContainer,
        date: displayDate,
        batchSize: 40,
        renderItem: (item) => {
          const src = item.source_label || 'Other';
          let section = feedContainer.querySelector(`#section-${CSS.escape(src)}`);
          if (!section) {
            const wrapper = document.createElement('section');
            wrapper.id = `section-${CSS.escape(src)}`;
            wrapper.className = 'source-section';
            wrapper.innerHTML = `<div class="source-section-header"><h3 class="source-section-title">${escapeHtml(src)}</h3><span class="source-section-count">0 ITEMS</span></div><div class="feed-list"></div>`;
            feedContainer.appendChild(wrapper);
            section = wrapper;
          }
          const list = section.querySelector('.feed-list');
          if (list) {
            const count = section.querySelector('.source-section-count');
            const currentCount = list.querySelectorAll('.mini-card').length + 1;
            if (count) count.textContent = `${currentCount} ITEMS`;
          }
          return `<div>${renderItemMiniCard(item)}</div>`;
        },
      });
    }
  } catch (err) {
    showError(container, err.message);
  }
}
