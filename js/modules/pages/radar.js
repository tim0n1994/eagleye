import { $, escapeHtml as h, escapeAttr as a } from '../utils.js';
import { getLanguage } from '../i18n.js';
import { router } from '../router.js';
import { showLoader, showError } from './shared.js';

const text = (zh,en) => getLanguage() === 'zh' ? zh : en;
const name = row => getLanguage() === 'zh' ? row.name_zh || row.name || row.slug : row.name || row.name_zh || row.slug;
const title = item => getLanguage() === 'zh' ? item.title_zh || item.title : item.title;
const safeUrl = raw => { try { const u = new URL(raw); return ['http:','https:'].includes(u.protocol) ? u.href : '#'; } catch { return '#'; } };
function link(path, params, changes = {}) {
  const q = new URLSearchParams(params);
  for (const [key,value] of Object.entries(changes)) {
    if (value === null || value === '') q.delete(key); else q.set(key,String(value));
  }
  q.delete('view');
  return `${path}${q.size ? `?${q}` : ''}`;
}
function followButton(kind,value,label,subs) {
  const active = subs.some(s => s.kind === kind && s.value === value);
  return `<button type="button" class="radar-follow ${active ? 'is-following' : ''}" data-follow-kind="${a(kind)}" data-follow-value="${a(value)}" data-follow-label="${a(label)}" aria-pressed="${active}">${active ? text('已关注','Following') : text('＋ 关注','＋ Follow')}</button>`;
}
function empty(message) {
  return `<div class="radar-empty"><h3>${h(message)}</h3><p>${text('可调整日期或时间范围，或从专题中选择关注方向。','Change the date or period, or follow a subject from Topics.')}</p><a href="/topics">${text('浏览专题 →','Browse topics →')}</a></div>`;
}
function timeline(points = []) {
  if (!points.length) return '';
  const max = Math.max(1,...points.map(p => p.count));
  return `<div class="radar-spark" role="img" aria-label="${a(points.map(p => `${p.date}: ${p.count}`).join('; '))}">${points.map(p => `<span style="height:${Math.max(3,p.count / max * 100)}%" title="${a(`${p.date}: ${p.count}`)}"></span>`).join('')}</div>`;
}
function coverage(meta) {
  const generated = new Date(meta.generated_at).toLocaleString(getLanguage() === 'zh' ? 'zh-CN' : 'en-US');
  return `<div class="radar-coverage"><span>${h(meta.start)} — ${h(meta.date)}</span><span>${text('按收录日期 · 已排除标记重复项 · 当天数据仍会变化','By collection date · duplicates excluded · today is still updating')}</span><span>${text('更新','Updated')} ${h(generated)}</span></div>
    ${meta.partial ? `<p class="radar-notice" role="status">${text(`当前窗口已收录 ${meta.current_items} 条用于展示，上期 ${meta.previous_items} 条；每期最多读取 ${meta.limit_per_period} 条，已触及上限。这里只展示部分材料，停用增长率和变化量，请缩短时间范围。`,`Showing ${meta.current_items} current and ${meta.previous_items} previous items; the ${meta.limit_per_period}-item per-period cap was reached. Results are partial; change metrics are disabled. Choose a shorter period.`)}</p>` : ''}`;
}
function controls(view,params,data) {
  const meta = data.meta;
  const options = [1,7,30].map(n => `<option value="${n}" ${meta.days === n ? 'selected' : ''}>${text(`近 ${n} 天`,`${n} days`)}</option>`).join('');
  return `<form class="radar-controls" id="radarFilters">
    <label>${text('截至日期','Through')}<input name="date" type="date" value="${a(meta.date)}" required></label>
    <label>${text('时间范围','Period')}<select name="days">${options}</select></label>
    ${view === 'discover' ? `<label>${text('专题','Topic')}<select name="topic"><option value="">${text('全部专题','All topics')}</option>${(data.topics || []).map(t => `<option value="${a(t.slug)}" ${params.topic === t.slug ? 'selected' : ''}>${h(name(t))}</option>`).join('')}</select></label>
      <label>${text('排序','Sort')}<select name="sort"><option value="recent">${text('最新收录','Recently collected')}</option><option value="sources" ${params.sort === 'sources' ? 'selected' : ''}>${text('多来源覆盖','Source diversity')}</option></select></label>` : ''}
    ${view === 'trends' ? `<label>${text('分析对象','Analyze')}<select name="kind"><option value="entity">${text('实体','Entities')}</option><option value="topic" ${params.kind === 'topic' ? 'selected' : ''}>${text('专题','Topics')}</option></select></label>` : ''}
    <button class="radar-primary" type="submit">${text('查看','Apply')}</button>
    ${params.entity ? `<input type="hidden" name="entity" value="${a(params.entity)}"><a href="${a(link('/discover',params,{entity:null,offset:null}))}">${text('清除实体筛选','Clear entity filter')}</a>` : ''}
    </form>`;
}
function eventCards(data,params,subs) {
  const topicMap = new Map((data.topics || []).map(t => [t.slug,t]));
  return data.events.length ? `<div class="radar-feed">${data.events.map(event => {
    const item = event.representative;
    const summary = getLanguage() === 'zh' ? item.one_liner_zh || item.one_liner : item.one_liner || item.one_liner_zh;
    const description = summary || item.original_summary || '';
    return `<article class="radar-event">
      <div class="radar-event-meta"><span>${h(item.source_label)}</span><span>${h(item.digest_date)}</span><span>${event.source_count} ${text('个来源','sources')} · ${event.evidence_count} ${text('条材料','records')}</span></div>
      <h3><a href="${a(safeUrl(item.canonical_url))}" target="_blank" rel="noopener noreferrer">${h(title(item))} <span aria-hidden="true">↗</span></a></h3>
      ${description ? `<p class="radar-summary"><span>${summary ? text('AI 摘要','AI summary') : text('来源摘要','Source excerpt')}</span> ${h(description)}</p>` : ''}
      <div class="radar-tags">${event.topics.slice(0,4).map(slug => `<a href="${a(link(`/topics/${encodeURIComponent(slug)}`,{date:data.meta.date,days:data.meta.days}))}">${h(name(topicMap.get(slug) || {slug}))}</a>`).join('')}</div>
      ${event.entities.length ? `<div class="radar-objects">${event.entities.slice(0,3).map(e => `<span><a href="${a(link('/discover',{date:data.meta.date,days:data.meta.days,entity:e.slug}))}">${h(e.name)}</a>${followButton('entity',e.slug,e.name,subs)}</span>`).join('')}</div>` : ''}
      <details class="radar-evidence"><summary>${text('查看证据与发布时间','Evidence & publication dates')} (${event.evidence_count})</summary><ul>${event.evidence.map(e => `<li><a href="${a(safeUrl(e.canonical_url))}" target="_blank" rel="noopener noreferrer">${h(e.source_label)} · ${h(title(e))}</a><small>${text('发布','Published')}: ${h(e.published_at || text('未知','Unknown'))} · ${text('收录','Collected')}: ${h(e.digest_date)}</small></li>`).join('')}</ul>${event.evidence_truncated ? `<p>${text('仅展开前 12 条材料。','Showing the first 12 records.')}</p>` : ''}<p>${text('相同原文链接合并展示；不同链接不会自动推断为同一事件。','Records sharing an original URL are grouped. Different URLs are not inferred to be the same event.')}</p></details>
    </article>`;
  }).join('')}</div>` : empty(text('这个范围内没有匹配的材料','No matching records in this period'));
}
function topicCards(data,params,subs) {
  return `<div class="radar-topic-grid">${data.topics.map(topic => `<article class="radar-topic-card">
    <div class="radar-topic-heading"><h3><a href="${a(link(`/topics/${encodeURIComponent(topic.slug)}`,{date:data.meta.date,days:data.meta.days}))}">${h(name(topic))}</a></h3>${followButton('topic',topic.slug,name(topic),subs)}</div>
    <p>${h(getLanguage() === 'zh' ? topic.description_zh || topic.description || '' : topic.description || '')}</p>
    <div class="radar-topic-foot"><span><strong>${topic.count}</strong> ${text('条材料','records')} · ${topic.source_count} ${text('个来源','sources')}</span><a href="${a(link(`/topics/${encodeURIComponent(topic.slug)}`,{date:data.meta.date,days:data.meta.days}))}" aria-label="${a(name(topic))}">→</a></div>
    ${timeline(topic.timeline)}
  </article>`).join('')}</div>`;
}
function trendRows(data,params,subs) {
  if (!data.rows.length) return empty(text('这个范围内没有可比较的数据','No comparable data in this period'));
  return `<p class="radar-explanation">${text('比较相邻等长收录窗口。提及量按条目去重，不代表市场份额或业务增长；新增来源、停采和补采都会影响结果。','Comparison of adjacent collection periods. Mentions count distinct records, not market share or business growth; source changes and backfills affect results.')}<br>${h(data.meta.previous_start)} — ${h(data.meta.previous_end)} → ${h(data.meta.start)} — ${h(data.meta.date)}</p>
    <div class="radar-table-wrap"><table class="radar-table"><thead><tr><th>${text('对象 / 方向','Entity / topic')}</th><th>${text('本期 / 上期','Current / previous')}</th><th>${text('变化','Change')}</th><th>${text('来源 本期 / 上期','Sources now / before')}</th><th>${text('收录时间分布','Collection timeline')}</th><th>${text('追踪','Follow')}</th></tr></thead><tbody>${data.rows.map(row => {
      const target = data.kind === 'topic' ? link(`/topics/${encodeURIComponent(row.slug)}`,{date:data.meta.date,days:data.meta.days}) : link('/discover',{date:data.meta.date,days:data.meta.days,entity:row.slug});
      const delta = row.delta === null ? '—' : `${row.delta > 0 ? '+' : ''}${row.delta}`;
      const growth = row.growth === null ? row.first_in_window ? text('上期未收录','Absent in prior period') : '' : `${row.growth > 0 ? '+' : ''}${Math.round(row.growth * 100)}%`;
      return `<tr><td><a href="${a(target)}">${h(name(row))}</a><small>${h(row.type || '')}</small>${row.examples?.length ? `<details><summary>${text('支撑材料','Evidence')}</summary>${row.examples.map(e => `<a class="radar-example" href="${a(safeUrl(e.canonical_url))}" target="_blank" rel="noopener noreferrer">${h(title(e))}</a>`).join('')}</details>` : ''}</td><td><strong>${row.count}</strong> / ${row.previous}</td><td class="${row.delta > 0 ? 'radar-rise' : ''}">${delta}<small>${h(growth)}</small></td><td>${row.source_count} / ${row.previous_source_count}</td><td>${timeline(row.timeline)}</td><td>${followButton(data.kind,row.slug,name(row),subs)}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}
function systemStatus(data) {
  const total = data.sources.reduce((n,s) => n+s.items,0);
  const summarized = data.sources.reduce((n,s) => n+s.summaries,0);
  return `<div class="radar-topic-overview"><strong>${total} ${text('条已收录材料','collected records')}</strong><span>${data.sources.length} ${text('个有数据的来源','sources with records')}</span><span>${text('摘要覆盖','Summary coverage')} ${total ? Math.round(summarized/total*100)+'%' : '—'}</span><a href="/settings">${text('采集与任务设置 →','Collection & task settings →')}</a></div>
    <p class="radar-explanation">${text('仅统计所选窗口实际读取的材料。没有出现的来源可能未采集、停用或没有新内容，不能据此判为健康；这些是站内加工指标，不是行业指标。','Counts cover records read in this period. Missing sources may be inactive, unavailable or have no new content; absence is not a health assessment. These are processing metrics, not industry metrics.')}</p>
    <div class="radar-table-wrap"><table class="radar-table"><thead><tr><th>${text('来源','Source')}</th><th>${text('材料','Records')}</th><th>${text('有摘要','With summary')}</th><th>${text('有专题','With topic')}</th><th>${text('有实体','With entities')}</th></tr></thead><tbody>${data.sources.map(s => `<tr><td><a href="/sources/${a(encodeURIComponent(s.slug))}">${h(s.label)}</a></td><td>${s.items}</td><td>${s.summaries}</td><td>${s.topics}</td><td>${s.entities}</td></tr>`).join('')}</tbody></table></div>`;
}

function subscriptions(subs) {
  return `<div class="radar-subscriptions"><h2>${text('我的关注','Following')} <small>${subs.length}</small></h2>${subs.length ? `<div class="radar-objects">${subs.map(s => `<span><a href="${a(s.kind === 'topic' ? `/topics/${encodeURIComponent(s.value)}` : s.kind === 'entity' ? `/discover?entity=${encodeURIComponent(s.value)}` : `/signals?type=${encodeURIComponent(s.value)}`)}">${h(s.label || s.value)}</a>${followButton(s.kind,s.value,s.label || s.value,subs)}</span>`).join('')}</div>` : `<p>${text('从专题或趋势中关注方向和实体，这里会汇总它们的新材料。','Follow topics or entities to collect their updates here.')}</p><a href="/topics">${text('选择专题 →','Choose topics →')}</a>`}</div>`;
}
function pagination(data,params) {
  const offset = Number(params.offset || 0);
  return `<nav class="radar-pagination" aria-label="${text('翻页','Pagination')}">${offset > 0 ? `<a href="${a(link(window.location.pathname,params,{offset:Math.max(0,offset-30)}))}">← ${text('上一页','Previous')}</a>` : '<span></span>'}<span>${text('第','Page')} ${Math.floor(offset/30)+1} ${text('页','')}</span>${data.has_more ? `<a href="${a(link(window.location.pathname,params,{offset:offset+30}))}">${text('下一页','Next')} →</a>` : '<span></span>'}</nav>`;
}

async function render(view,params = {}) {
  const container = $('#pageContent');
  const controller = new AbortController();
  router.onCleanup(() => controller.abort());
  showLoader(container,text('正在读取情报…','Loading intelligence…'));
  const query = new URLSearchParams({view});
  for (const key of ['date','days','offset','topic','entity','sort','kind']) if (params[key]) query.set(key,params[key]);
  if (view === 'topic') query.set('topic',params.slug);
  const request = async url => {
    const response = await fetch(url,{signal:controller.signal});
    if (!response.ok) throw new Error(`${text('请求失败','Request failed')} (${response.status})`);
    return response.json();
  };
  try {
    const [data,watchlist] = await Promise.all([request(`/api/radar?${query}`),request('/api/watchlist')]);
    if (controller.signal.aborted) return;
    const subs = watchlist.subs || [];
    const headings = { discover:text('发现','Discover'),topics:text('专题','Topics'),topic:name(data.topic || {}),trends:text('趋势','Trends'),following:text('关注动态','Following updates'),system:text('系统状态','System status') };
    const descriptions = {
      discover:text('从新材料出发，找到值得持续追踪的事。','Start with new evidence. Find what deserves your attention.'),
      topics:text('按方向积累知识，把最新进展放回上下文。','Explore a field and put its latest developments in context.'),
      topic:getLanguage() === 'zh' ? data.topic?.description_zh || data.topic?.description || '' : data.topic?.description || '',
      trends:text('看见变化，也看见变化背后的证据。','See what changed, with the evidence behind it.'),
      following:text('你的方向、对象与持续更新的证据。','Your subjects, entities and their latest evidence.'),
      system:text('检查当前收录窗口的内容加工覆盖，区分数据缺失与真实变化。','Inspect processing coverage within this collection window.'),
    };
    const body = view === 'system' ? systemStatus(data) : view === 'topics' ? topicCards(data,params,subs) : view === 'trends' ? trendRows(data,params,subs) : `${view === 'following' ? subscriptions(data.subs || []) : ''}
      ${view === 'topic' ? `<div class="radar-topic-overview"><span>${data.topic_stats?.count || 0} ${text('条材料','records')} · ${data.topic_stats?.source_count || 0} ${text('个来源','sources')}</span>${followButton('topic',data.topic.slug,name(data.topic),subs)}${timeline(data.topic_stats?.timeline)}</div>
        ${data.related.length ? `<div class="radar-tags">${data.related.map(t => `<a href="${a(link(`/topics/${encodeURIComponent(t.slug)}`,{date:data.meta.date,days:data.meta.days}))}">${h(name(t))}</a>`).join('')}</div>` : ''}
        ${data.entities.length ? `<details class="radar-topic-entities"><summary>${text('相关实体','Related entities')} (${data.entities.length})</summary><div class="radar-objects">${data.entities.map(e => `<span><a href="${a(link('/discover',{date:data.meta.date,days:data.meta.days,entity:e.slug}))}">${h(e.name)}</a>${followButton('entity',e.slug,e.name,subs)}</span>`).join('')}</div></details>` : ''}` : ''}
      ${eventCards(data,params,subs)}`;
    container.innerHTML = `<section class="radar-page"><header class="radar-header"><div><p class="radar-eyebrow">EAGLEYE / ${text('情报工作台','INTELLIGENCE')}</p>${view === 'topic' ? '<a href="/topics" class="radar-back">← '+text('全部专题','All topics')+'</a>' : ''}<h1>${h(headings[view])}</h1><p>${h(descriptions[view])}</p></div><a class="radar-archive" href="/news">${text('查看每日原始信息流 ↗','Daily source archive ↗')}</a></header>
      ${controls(view,params,data)}${coverage(data.meta)}<p class="radar-feedback" role="status" aria-live="polite"></p>${body}${!['topics','system'].includes(view) ? pagination(data,params) : ''}</section>`;
    container.querySelector('#radarFilters').addEventListener('submit',event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      router.navigate(link(window.location.pathname,values));
    });
    container.querySelectorAll('[data-follow-kind]').forEach(button => button.addEventListener('click',async () => {
      const { followKind:kind,followValue:value,followLabel:label } = button.dataset;
      const add = button.getAttribute('aria-pressed') !== 'true';
      // A repeated entity can have several buttons on this page.
      const matching = [...container.querySelectorAll('[data-follow-kind]')].filter(b => b.dataset.followKind === kind && b.dataset.followValue === value);
      matching.forEach(b => { b.disabled = true; });
      const feedback = container.querySelector('.radar-feedback');
      try {
        const response = await fetch('/api/watchlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,value,label,add}),signal:controller.signal});
        if (!response.ok) throw new Error(text('关注保存失败，请重试。','Could not save follow preference. Please retry.'));
        if (controller.signal.aborted) return;
        matching.forEach(b => { b.setAttribute('aria-pressed',String(add));b.classList.toggle('is-following',add);b.textContent = add ? text('已关注','Following') : text('＋ 关注','＋ Follow'); });
        feedback.textContent = add ? text('已加入关注。','Added to Following.') : text('已取消关注。','Unfollowed.');
        if (view === 'following') { controller.abort();render(view,params); }
      } catch (error) { if (!controller.signal.aborted) feedback.textContent = error.message; }
      finally { matching.forEach(b => { b.disabled = false; }); }
    }));
  } catch (error) {
    if (controller.signal.aborted) return;
    showError(container,error.message);
    const retry = document.createElement('button');retry.className='radar-primary';retry.textContent=text('重试','Retry');
    retry.addEventListener('click',() => { controller.abort();render(view,params); });container.appendChild(retry);
  }
}
export const renderRadarDiscover = params => render('discover',params);
export const renderRadarTopics = params => render('topics',params);
export const renderRadarTopic = params => render('topic',params);
export const renderRadarTrends = params => render('trends',params);
export const renderRadarFollowing = params => render('following',params);

export const renderRadarSystem = params => render('system',params);
