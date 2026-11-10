import { escapeHtml as h, escapeAttr as a } from '../utils.js';
import { getLanguage } from '../i18n.js';
export function qualitySlot() { return '<div class="intelligence-quality" data-intelligence-quality aria-live="polite"></div>'; }
export async function renderQuality(container, industry, days) {
  const slot = container.querySelector('[data-intelligence-quality]');
  if (!slot) return;
  const zh = getLanguage() === 'zh';
  const eventDays = days > 7 ? 30 : 7;
  const eventLink = `<a href="/discover?industry=${a(industry)}&days=${eventDays}&sort=sources">${zh ? '查看合并事件与原文证据 →' : 'Merged events & original evidence →'}</a>`;
  slot.innerHTML = eventLink;
  try {
    const response = await fetch(`/api/intelligence-quality?industry=${encodeURIComponent(industry)}&days=${[1,7,30,90,180].includes(days) ? days : 30}`);
    if (!response.ok) throw new Error('Unavailable');
    const data = await response.json();
    if (!slot.isConnected) return;
    const n = data.totals.scanned || 0, matched = data.totals.matched || 0, effective = data.totals.effective || 0;
    const pct = value => (value === null || value === undefined) ? '—' : `${(value*100).toFixed(1)}%`;
    slot.innerHTML = `<details class="neuroscience-sources"><summary>${zh ? '专题有效内容率' : 'Topic yield'} · ${pct(n ? effective/n : null)} ${data.partial ? (zh ? '· 索引补齐中' : '· Indexing') : ''}</summary>
      <p>${zh ? `近 ${data.days} 天：已索引 ${n} 条收录内容，规则命中 ${matched} 条，合并后 ${effective} 个有效事件。` : `${data.days} days: ${n} indexed records, ${matched} rule matches, ${effective} distinct eligible events.`}</p>
      <p>${zh ? '有效率＝本专题有效事件数 ÷ 同期已索引收录条数。有效要求专题规则命中、标题与链接可用且未标记重复；这不是人工质量评分。跨来源同事件在总数中只计一次，在各来源中分别计数。' : 'Yield = eligible topic events / indexed records. Eligibility requires a topic rule match, usable title/URL and no duplicate marker. This is not an editorial quality score. Events count once overall and once per contributing source.'}</p>
      ${data.partial ? `<p>${zh ? `尚有 ${data.pending} 条待索引，当前比例为已处理部分。` : `${data.pending} pending records; rates cover indexed records only.`}</p>` : ''}
      <div class="radar-table-wrap"><table><thead><tr><th>${zh ? '来源' : 'Source'}</th><th>${zh ? '收录' : 'Indexed'}</th><th>${zh ? '命中' : 'Matches'}</th><th>${zh ? '有效事件' : 'Events'}</th><th>${zh ? '有效率' : 'Yield'}</th><th>${zh ? '重复/不可用占比' : 'Redundant/ineligible'}</th></tr></thead><tbody>${data.rows.map(r=>`<tr><td><a href="/sources/${a(r.slug)}">${h(r.label)}</a></td><td>${r.scanned}</td><td>${r.matched}</td><td>${r.effective}</td><td>${pct(r.effective_rate)}</td><td>${pct(r.redundancy_rate)}</td></tr>`).join('')}</tbody></table></div>
      <p>${zh ? '按原始内容规则统计；采用发布时间，缺失时使用入库时间。指标最多缓存一分钟。事件合并不代表独立交叉验证，也不删除原文。' : 'Raw-content rules; publication date falls back to collection time. Cached up to one minute. Grouping is not independent corroboration and does not delete originals.'}</p></details>${eventLink}`;
  } catch {
    if (slot.isConnected) slot.innerHTML = `<p>${zh ? '有效率暂时无法读取，请稍后刷新。' : 'Quality metrics unavailable; please retry.'}</p>${eventLink}`;
  }
}
