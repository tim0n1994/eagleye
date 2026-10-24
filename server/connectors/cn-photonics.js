/**
 * Eagleye — Physical AI CN Photonics Connector
 *
 * Fetches photonics, semiconductor, and optical communication news
 * from Chinese sources via RSS feeds and web scraping.
 *
 * Targets:
 * - OFweek (photonics industry portal)
 * - Laser Fair / CIOE news
 * - Key Chinese photonics companies
 * - C114 (optical communications)
 */

const { BaseConnector } = require('./base');
const { fetchURL, currentFetchDeadline } = require('../services/utils');
const { isWithinFetchWindow, compactDigestDate, todayDigestDate } = require('../services/date-contract');

// P0 热修 B②（2026-10-23）：原 8 个 feed 经双路由探活（mihomo 代理 + 直连，
// CTO 2026-10-23 02:33）确认全部死亡，config 级整体移除：
//   laser/optics/semiconductor.ofweek.com /rss.xml — 404 / TLS reset（主机活，RSS 已下线）
//   www.c114.com.cn /rss/optical.xml、/rss/all.xml — 404
//   www.eeworld.com.cn /rss/semiconductor.xml — 403（WAF 拦 RSS 路径）
//   www.laoyaoba.com /rss — 200 但回 SPA HTML，0 个 <item>（RSS 已停）
//   www.gelonghui.com /feed/semiconductor — 404
// 清空后 fetch() 自动落回 CN_COMPANIES 占位路径（10 条/轮）。替代源寻源记 ROADMAP。
const CN_FEEDS = [];

// P0 热修 B①（2026-10-23）per-feed 预算保护。事故：10-23 01:00 轮 OFweek×3 的
// 10s/45s 退避重试吃掉 ~100s+，剩余 5 个 feed 在 01:03:57 被源级 180s 预算集体
// 杀死 → 整源 ERRORED（last_error_class=timeout, 180002ms）。单 feed 的总成本
// （首请求 + 重试 + 退避 + 放弃等待）现被钉死在 min(PER_FEED_CAP_MS, 源级剩余
// 预算的一半)——单个挂死/拒连 feed 最多吃掉一半剩余预算，好 feed 必然还有份。
const PER_FEED_CAP_MS = 30000;
const PER_FEED_POLL_CHUNK_MS = 250;

// Major Chinese photonics/semiconductor public companies for news scraping
const CN_COMPANIES = [
  { name: 'Accelink Technologies', ticker: '002281.SZ', sector: 'photonics' },
  { name: 'Hisense Broadband', ticker: '600060.SH', sector: 'photonics' },
  { name: 'ZTE Corporation', ticker: '000063.SZ', sector: 'telecom' },
  { name: 'FiberHome Technologies', ticker: '600498.SH', sector: 'photonics' },
  { name: 'Yuanjie Semiconductor', ticker: '688234.SH', sector: 'semiconductor' },
  { name: 'JCET Group', ticker: '600584.SH', sector: 'semiconductor' },
  { name: 'NAURA Technology', ticker: '002371.SZ', sector: 'semiconductor' },
  { name: 'AMEC', ticker: '688012.SH', sector: 'semiconductor' },
  { name: 'Huaqin Technology', ticker: '603296.SH', sector: 'photonics' },
  { name: 'Raytron Technology', ticker: '688002.SH', sector: 'photonics' },
];

class CNPhotonicsConnector extends BaseConnector {
  constructor() {
    super('physical-ai-cn-photonics');
  }

  async fetch(date, opts = {}) {
    const items = [];
    // D2: digest date basis is the requested local digest date (fallback:
    // local today), never the item's own UTC day.
    const dateStr = date || compactDigestDate(todayDigestDate());

    // P0 热修 B①（2026-10-23）注入 seam（与 rss.js fetch(date,{signal,sleep,stats})
    // 同族）：feeds 覆盖 feed 列表；sleep/stats/deadline 与 fetchSource 的 ambient
    // store 同义（deadline 为 epoch 毫秒绝对值）。生产路径 fetchSource 传
    // {limit, stats, signal}，源级 deadline 经 utils currentFetchDeadline() 读取。
    const feeds = Array.isArray(opts.feeds) ? opts.feeds : CN_FEEDS;
    const sourceDeadline = Number.isFinite(opts.deadline)
      ? Number(opts.deadline)
      : currentFetchDeadline();

    // Fetch from RSS feeds
    for (const feed of feeds) {
      if (sourceDeadline !== null && Date.now() >= sourceDeadline) {
        console.warn(`[${this.slug}] feed skipped — source budget already exhausted (${feed.name} ${feed.url})`);
        continue;
      }
      try {
        const xml = await this._fetchFeedWithCap(feed, opts, sourceDeadline);
        const parsed = this._parseRSS(xml, dateStr, feed);
        items.push(...parsed);
      } catch (err) {
        console.error(`[${this.slug}] RSS feed failed (${feed.name} ${feed.url}):`, err.message);
      }
    }

    // If no items from RSS, fall back to generating company updates
    if (items.length === 0) {
      for (const company of CN_COMPANIES) {
        items.push(this._generateCompanyPlaceholder(company, dateStr));
      }
    }

    return items;
  }

  /**
   * P0 热修 B①（2026-10-23）：抓单个 feed，带 per-feed 预算上限。
   * - capMs = min(PER_FEED_CAP_MS, 源级剩余预算 / 2)，作为显式 deadline 传给
   *   fetchURL → withFetchRetry 的预算感知会让"退避 + 一次请求"装不进 per-feed
   *   剩余预算时直接跳过重试（案1 同款机制，作用域收窄到单 feed）。
   * - giveUp 竞速兜底：对永不响应的 feed（请求挂死，重试决策没机会触发），按
   *   PER_FEED_POLL_CHUNK_MS 步进放弃计时（生产真实计时；测试经注入 sleep 走
   *   虚拟时钟零真实等待），到点 abort 当前请求并放弃该 feed，循环继续后续
   *   feed。每步先让出事件循环，让真实响应/错误有机会先送达。
   */
  _fetchFeedWithCap(feed, opts, sourceDeadline) {
    const now = Date.now();
    const sourceRemainingMs = Number.isFinite(sourceDeadline)
      ? Math.max(0, sourceDeadline - now)
      : 2 * PER_FEED_CAP_MS;
    const capMs = Math.min(PER_FEED_CAP_MS, Math.floor(sourceRemainingMs / 2));
    if (capMs <= 0) {
      const err = new Error(`per-feed budget exhausted before fetch (${feed.url})`);
      err.code = 'PER_FEED_BUDGET';
      return Promise.reject(err);
    }
    const feedDeadline = now + capMs;
    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort(opts.signal.reason);
      else opts.signal.addEventListener('abort', () => controller.abort(opts.signal.reason), { once: true });
    }
    const sleepFn = typeof opts.sleep === 'function'
      ? opts.sleep
      : (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
    const yieldToIo = () => new Promise((resolve) => { setTimeout(resolve, 0); });

    let settled = false;
    const fetchPromise = fetchURL(feed.url, {
      stats: opts.stats,
      sleep: opts.sleep,
      deadline: feedDeadline,
      signal: controller.signal,
    }).finally(() => { settled = true; });

    const giveUp = (async () => {
      while (!settled && Date.now() < feedDeadline) {
        await yieldToIo();
        if (settled) return;
        const remainMs = feedDeadline - Date.now();
        if (remainMs <= 0) break;
        await sleepFn(Math.min(PER_FEED_POLL_CHUNK_MS, remainMs));
      }
      if (settled) return;
      controller.abort();
      const err = new Error(`per-feed budget cap ${capMs}ms exceeded (${feed.url})`);
      err.code = 'PER_FEED_BUDGET';
      throw err;
    })();

    return Promise.race([fetchPromise, giveUp]);
  }

  _parseRSS(xml, dateStr, feed) {
    const items = [];
    const itemRegex = /<(item|entry)>([\s\S]*?)<\/\1>/gi;
    let match;

    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[2];

      const getField = (tag) => {
        const cdataMatch = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i'));
        if (cdataMatch) return cdataMatch[1];
        const m2 = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return m2 ? m2[1].trim() : '';
      };

      let link = getField('link');
      if (!link) {
        const linkHref = block.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
        link = linkHref ? linkHref[1] : '';
      }

      const pubDate = getField('pubDate') || getField('published') || getField('updated');
      const description = getField('description') || getField('summary') || '';
      const title = getField('title') || '[No Title]';

      // D2 time-window freshness replaces the digest-day == item-UTC-day
      // equality filter; items without a parseable pubDate keep the legacy
      // keep-behavior (judged against fetch time).
      const pubTs = Date.parse(pubDate);
      const effectiveTs = Number.isFinite(pubTs) ? pubTs : Date.now();
      if (dateStr && !isWithinFetchWindow(effectiveTs)) continue;

      items.push({
        ...this.normalize({
          title,
          url: link,
          description: description.replace(/<[^>]*>/g, '').slice(0, 2000),
          publishedAt: pubDate || new Date().toISOString(),
          language: feed.lang || 'zh',
          sourcePayload: {
            source_name: feed.name,
            feed_url: feed.url,
            category: 'chinese-photonics',
            sector: 'photonics-semiconductor',
          },
        }),
        digest_date: dateStr,
      });
    }

    return items;
  }

  _generateCompanyPlaceholder(company, dateStr) {
    const now = new Date();
    return {
      ...this.normalize({
        title: `${company.name} (${company.ticker}) — ${company.sector} sector update`,
        url: `https://www.google.com/search?q=${encodeURIComponent(company.name + ' photonics')}`,
        description: `${company.name} — ${company.sector} company listed on ${company.ticker}. Chinese photonics/semiconductor sector tracking.`,
        publishedAt: now.toISOString(),
        language: 'zh',
        sourcePayload: {
          company: company.name,
          ticker: company.ticker,
          sector: company.sector,
          source: 'chinese-photonics-tracker',
          category: 'photonics-semiconductor',
          is_placeholder: true,
        },
        popularity: {},
        score: 0.1,
      }),
      digest_date: dateStr,
    };
  }
}

module.exports = { CNPhotonicsConnector };
