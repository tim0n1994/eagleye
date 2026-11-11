/**
 * Eagleye — sources page module
 *
 * Source index and per-source detail.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml } from '../utils.js';
import { formatNumber, getLanguage, t } from '../i18n.js';
import { progressiveSourceFeed } from '../progressive.js';
import { API_BASE, fetchJSON, hydrateSourceNavPills, pickZh, renderItemMiniCard, renderSourceNav, showError, showLoader, sourceIcon, trustBadge , setSourcesCache } from './shared.js';


// ─── D4 stale-source detection (R1.1 field fix) ──────────
// A source is "stale" when it is enabled but its last successful fetch
// round is older than 48 hours.
//
// R1.1 field selection: the badge keys off sources.last_success_at — the
// field the fetch bookkeeping refreshes on EVERY successful round, including
// dup-only ones (ruling 2: an all-duplicate round is not an empty round; the
// source is alive). It falls back to sources.last_fetched_at only while
// last_success_at is NULL, so rows whose runtime writer has not fired yet
// (e.g. sources added after migration 037's one-shot backfill) don't flash
// red on deploy night. last_fetched_at alone must NOT be read: it refreshes
// only on rounds with output (cross-day duplicates don't count), so a source
// whose every round is dup-only keeps it frozen and would be false-flagged
// red after 48h. NULL / unreadable timestamps on both fields count as even
// older. Strictly-greater semantics: exactly 48h ago is still fresh.
const STALE_SOURCE_THRESHOLD_MS = 48 * 60 * 60 * 1000;

function parseTimestampMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  // SQLite datetime('now') emits "YYYY-MM-DD HH:MM:SS" (UTC, no zone marker);
  // normalize to ISO-Z so it parses as UTC like full ISO timestamps.
  const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(raw);
  const normalized = hasZone ? raw : `${raw.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

export function isStaleSource(src, nowMs = Date.now()) {
  if (!src || src.is_active === 0) return false;
  const lastOkMs = parseTimestampMs(src.last_success_at)
    ?? parseTimestampMs(src.last_fetched_at);
  if (lastOkMs === null) return true;
  return nowMs - lastOkMs > STALE_SOURCE_THRESHOLD_MS;
}

// ─── Round 2 ⑤: per-source fetch duration formatting ─────
// sources.last_fetch_duration_ms is integer milliseconds. Human-readable:
// under a second stays in ms; a second and up renders seconds with one
// decimal (4200 → "4.2s", 19000 → "19.0s").
export function formatFetchDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`;
}

// ─── Sources ──────────────────────────────────────────────

export async function renderSources(_params) {
  const container = $('#pageContent');
  const zh = getLanguage() === 'zh';
  showLoader(container, zh ? '正在加载信息源…' : 'Loading sources...');

  try {
    const data = await fetchJSON(`${API_BASE}/sources?include_disabled=1`);
    setSourcesCache((data.sources || []).filter(s => s.is_active));
    const zh = getLanguage() === 'zh';
    const groups = [
      { key: 'public', title: zh ? '公共来源' : 'Public sources', description: zh ? '与 OrangeBot 对照的公共信号，以及技术社区补充。WSJ 尚未接入；App Store 当前仅覆盖美国免费与付费榜各 25 项。' : 'Public signals and developer communities. WSJ is not connected; App Store covers US free and paid top 25 only.' },
      { key: 'x', title: zh ? 'X 关注网络' : 'X network', description: zh ? '实例级 Following 时间线；静态名单用于配置与降级抓取，不代表全部关注账号已被覆盖。' : 'Instance-wide Following timeline. The static list supports configuration and fallback, not proof of complete account coverage.' },
      { key: 'specialist', title: zh ? '专题来源 · 具身、AI 教育与脑科学' : 'Specialist sources · Robotics, AI education and neuroscience', description: zh ? '论文、官方项目版本与开发者实践分别保留来源。社区帖子和版本更新不等于已验证的研究结论或应用落地。' : 'Papers, official releases and developer practice retain their provenance. Community posts and releases are not verified research or deployments.' },
    ];
    const x = data.x_network;
    const xSummary = x ? `<p class="source-network-summary">${escapeHtml(zh ? `采集模式：${x.mode} · 配置名单 ${x.configured} · 屏蔽 ${x.blocked}` : `Mode: ${x.mode} · Configured ${x.configured} · Blocked ${x.blocked}`)}${x.snapshot ? `<br>${escapeHtml(zh ? `历史导出 ${x.snapshot.count} · 重合 ${x.snapshot.common} · 仅配置 ${x.snapshot.only_configured} · 仅导出 ${x.snapshot.only_exported}（非实时关注数，不自动增删名单）` : `Historical export ${x.snapshot.count} · Common ${x.snapshot.common} · Configuration only ${x.snapshot.only_configured} · Export only ${x.snapshot.only_exported}; not a live count.`)}` : `<br>${zh ? '历史导出不可用，差异未知。' : 'Historical export unavailable.'}`}</p>` : '';

    const html = `
      <section class="page-section">
        ${renderSourceNav(null)}
        <div class="page-header">
          <h2 class="page-title">${t('sources.title')}</h2>
          <p class="page-description">${t('sources.subtitle')}
            <a href="/opml.xml" download="eagleye-sources.opml" class="action-link" style="font-size:11px;margin-left:8px">${zh ? 'OPML（导入 RSS 阅读器）' : 'OPML (import to RSS reader)'}</a>
          </p>
        </div>
        <div class="source-architecture-overview">${zh ? '信息采集 → 原文与去重 → 专题筛选 → 发现 / 行业简报' : 'Collection → Evidence and deduplication → Topic filtering → Discovery / Briefings'}<br><small>${zh ? '页面只读取已入库数据；来源启用不代表采集健康。' : 'Pages read stored data; enabled does not mean healthy.'}</small></div>
        ${groups.map(group => {
          const members = (data.sources || []).filter(src => src.group === group.key);
          return `<section class="source-group" aria-labelledby="source-group-${group.key}">
          <h3 id="source-group-${group.key}">${group.title} <small>${members.filter(s => s.is_active).length} / ${members.length} ${zh ? '启用' : 'enabled'}</small></h3>
          <p class="page-description">${group.description}</p>
          ${group.key === 'x' ? xSummary : ''}
          <div class="sources-grid">
          ${members.map(src => {
            const icon = sourceIcon(src.slug);
            const statsParts = [];
            // Content volume is separate from connector health.
            const freshness = '';
            if (src.today_items > 0) {
              statsParts.push(`<span class="source-stat">${freshness} ${formatNumber(src.today_items)} ${zh ? '今日' : 'today'}</span>`);
            } else {
              statsParts.push(`<span class="source-stat">${freshness} 0 ${zh ? '今日' : 'today'}</span>`);
            }
            statsParts.push(`<span class="source-stat">${zh ? `累计 ${formatNumber(src.total_items || 0)}` : `${formatNumber(src.total_items || 0)} total`}</span>`);
            // Round 2 ⑤: latest fetch round duration. sources.last_fetch_duration_ms
            // (043) is stamped on every round — success, empty, and failure alike —
            // and holds the most recent round only. NULL / missing (rows predating
            // the migration, or old API payloads) = never measured → no stat.
            const durationRaw = src.last_fetch_duration_ms;
            const durationMs = durationRaw == null ? null : Number(durationRaw);
            const durationBadge = durationMs != null && Number.isFinite(durationMs) && durationMs >= 0
              ? `<span class="source-stat" title="${zh ? '最近一轮抓取耗时（含失败轮）' : 'Latest fetch round duration (failures included)'}">${formatFetchDuration(durationMs)}</span>`
              : '';
            // D4: enabled but no successful fetch in over 48h → red stale badge.
            const stale = Boolean(src.last_attempt_at) && isStaleSource(src);
            const staleBadge = stale
              ? `<span class="source-stat stale-badge" title="${zh ? '启用中但超过 48 小时无成功抓取' : 'Enabled but no successful fetch in over 48h'}"><span aria-hidden="true" style="color:var(--color-error)">●</span> ${zh ? '停摆' : 'stale'}</span>`
              : '';
            // Source quality badge from source_profiles (noise_rate)
            let qualityBadge = '';
            if (src.noise_rate != null) {
              const pct = Math.round(src.noise_rate * 100);
              const dot = pct < 10
                ? '<span aria-hidden="true" style="color:var(--color-success)">●</span>'
                : pct < 30 ? '<span aria-hidden="true" style="color:var(--color-warning)">●</span>' : '<span aria-hidden="true" style="color:var(--color-error)">●</span>';
              const label = src.source_type === 'noisy' ? t('signals.noisy') :
                            src.source_type === 'early_signal' ? t('signals.early_signal') :
                            src.source_type === 'originator' ? t('signals.originator') :
                            t('signals.amplifier');
              qualityBadge = `<span class="source-stat" title="${t('signals.noise_rate')}: ${pct}%">${dot} ${escapeHtml(label)} ${pct}%</span>`;
            }
            return `
            <a href="/sources/${escapeAttr(src.slug)}" class="source-card${stale ? ' source-stale' : ''}">
              <div class="source-card-header">
                <span class="source-name">${icon} ${escapeHtml(pickZh(src.label, src.label_zh))}</span>
                <span class="source-connector-type">${escapeHtml(src.connector_type || 'rss')}</span>
              </div>
              <p class="source-description">${escapeHtml(pickZh(src.description, src.description_zh) || '')}</p>
              <div class="source-stats">
                <span class="source-stat">${!src.is_active ? (zh ? '已停用' : 'Disabled') : !src.last_attempt_at ? (zh ? '待首次抓取' : 'Awaiting first fetch') : src.health_status === 'failing' ? (zh ? '最近失败' : 'Failing') : (zh ? '已启用' : 'Enabled')}</span>
                ${src.reference_source ? `<span class="source-stat">OrangeBot</span>` : ''}
                ${statsParts.join('')}
                ${durationBadge}
                ${qualityBadge}
                ${staleBadge}
              </div>
              <p class="source-last-success">${zh ? '最近成功' : 'Last success'}: ${src.last_success_at ? escapeHtml(new Date(parseTimestampMs(src.last_success_at)).toLocaleString(zh ? 'zh-CN' : 'en-US')) : (zh ? '暂无记录' : 'Not recorded')}</p>
              ${src.collection ? `<p class="source-last-success">${escapeHtml(zh ? ({ stored: '已入库', unchanged: '内容已收录', empty: '请求成功，暂无内容', not_modified: '没有更新（304）', failed: '采集失败，等待重试' }[src.collection.outcome] || src.collection.outcome) : src.collection.outcome)} · ${zh ? '新增' : 'New'} ${Number(src.collection.inserted) || 0} · ${zh ? '重复' : 'Duplicates'} ${Number(src.collection.duplicates) || 0}</p>
              ${src.is_active ? `<p class="source-last-success">${zh ? '下次采集' : 'Next collection'}: ${escapeHtml(new Date(src.collection.next_due_at).toLocaleString(zh ? 'zh-CN' : 'en-US'))}</p>` : ''}` : ''}
              ${(src.trend && src.trend.length > 0) ? (() => {
                const maxC = Math.max(1, ...src.trend.map(t => t.count));
                return `<div class="source-trend-bars" title="${zh ? '近 7 天条目趋势' : '7-day item trend'}">` +
                  src.trend.map(t => `<span class="trend-bar" style="height:${Math.max(2, (t.count / maxC) * 24)}px" title="${t.date}: ${formatNumber(t.count)}"></span>`).join('') +
                  `</div>`;
              })() : ''}
              ${(src.feed_url || src.homepage_url) ? `
              <div class="source-links">
                ${src.homepage_url ? `<span class="source-link-label">${zh ? '主页' : 'Web'}</span><span class="source-link-url">${escapeHtml(src.homepage_url)}</span>` : ''}
                ${src.feed_url ? `<span class="source-link-label">${zh ? '订阅源' : 'Feed'}</span><span class="source-link-url">${escapeHtml(src.feed_url)}</span>` : ''}
              </div>` : ''}
            </a>
          `;}).join('')}
          </div></section>`;
        }).join('')}
      </section>
    `;

    container.innerHTML = html;
    await hydrateSourceNavPills();
  } catch (err) {
    showError(container, err.message);
  }
}

export async function renderSourceDetail(params) {
  const container = $('#pageContent');
  const slug = params?.slug || '';
  showLoader(container, `${t('common.loading')} ${slug}...`);

  try {
    const data = await fetchJSON(`${API_BASE}/source/${slug}`);
    const src = data.source || {};
    const items = data.items || [];
    const signalDist = data.signal_dist || [];

    // Signal-type distribution bars (last 30d).
    const maxSig = Math.max(1, ...signalDist.map(s => s.count));
    const distHtml = signalDist.length > 0
      ? `<div class="metrics-block" style="margin-top:16px"><h3 class="metrics-block-title">${getLanguage() === 'zh' ? '信号类型分布（30天）' : 'Signal Type Distribution (30d)'}</h3>` +
        `<ul class="metrics-bars">` +
        signalDist.slice(0, 10).map(s => {
          const pct = Math.round((s.count / maxSig) * 100);
          return `<div class="metrics-bar-row"><span class="metrics-bar-label">${escapeHtml(s.signal_type.replace(/_/g, ' '))}</span>` +
            `<div class="metrics-bar"><div class="metrics-bar-fill" style="width:${pct}%"></div></div>` +
            `<span class="metrics-bar-pct">${formatNumber(s.count)}</span></div>`;
        }).join('') + `</ul></div>`
      : '';

    const icon = sourceIcon(src.slug);
    const homepageLink = src.homepage_url
      ? `<a href="${escapeAttr(src.homepage_url)}" target="_blank" rel="noopener" class="source-meta-link">${t('sources.visit')}</a>`
      : '';
    const feedLink = src.feed_url
      ? `<a href="/rss-proxy?url=${encodeURIComponent(src.feed_url)}" class="source-meta-link">${t('sources.feed')}</a>`
      : '';
    const desc = src.description ? `<span class="source-meta-desc">${escapeHtml(pickZh(src.description, src.description_zh))}</span>` : '';

    const html = `
      <section class="page-section">
        ${renderSourceNav(slug)}
        <div class="source-detail-bar">
          <span class="source-detail-icon">${icon}</span>
          <span class="source-detail-name">${escapeHtml(pickZh(src.label, src.label_zh) || slug)}</span>
          <span class="source-detail-count" id="sourceItemCount">${t('sources.items_count', { n: items.length })}</span>
          ${desc}
          <span class="source-detail-actions">${homepageLink}${feedLink}</span>
        </div>
        ${src.source_type ? `<div class="source-trust-bar">${trustBadge(src.source_type, src.noise_rate)}${src.early_signal_rate != null ? ` <span class="source-stat">${getLanguage() === 'zh' ? '早期信号' : 'early signal'}: ${(src.early_signal_rate * 100).toFixed(0)}%</span>` : ''}${src.originality_rate != null ? ` <span class="source-stat">${getLanguage() === 'zh' ? '原创性' : 'originality'}: ${(src.originality_rate * 100).toFixed(0)}%</span>` : ''}${src.last_30d_alpha_hits != null ? ` <span class="source-stat">${getLanguage() === 'zh' ? '30 天 α 命中' : '30d α-hits'}: ${src.last_30d_alpha_hits}</span>` : ''}</div>` : ''}
        ${distHtml}
        <div class="source-items-grid" id="sourceItemsGrid">
          ${items.map(item => renderItemMiniCard(item)).join('')}
          ${items.length === 0 ? `<p class="empty-state">${t('sources.no_items')}</p>` : ''}
        </div>
      </section>
    `;

    container.innerHTML = html;
    await hydrateSourceNavPills();

    // Progressive loading for source detail
    const grid = container.querySelector('#sourceItemsGrid');
    if (grid && items.length >= 30) {
      progressiveSourceFeed({
        container: grid,
        sourceSlug: slug,
        batchSize: 40,
        renderItem: (item) => {
          const countEl = document.getElementById('sourceItemCount');
          if (countEl) {
            const current = grid.querySelectorAll('.mini-card').length + 1;
          countEl.textContent = getLanguage() === 'zh' ? `${formatNumber(current)} 条` : `${formatNumber(current)} items`;
          }
          return `<div>${renderItemMiniCard(item)}</div>`;
        },
      });
    }
  } catch (err) {
    showError(container, err.message);
  }
}
