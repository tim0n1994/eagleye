/**
 * Eagleye — Startup Archive Connector
 *
 * Scrapes the Startup Archive website for daily founder/CEO insights.
 * No public API available, so we parse the HTML listing page.
 */

const { execSync } = require('child_process');
const { BaseConnector } = require('./base');
const { fetchURL } = require('../services/utils');

// Cloudflare 对该站同时做 UA + TLS 指纹(JA3) 判定：node 的 TLS 握手
// 会被 403，即便 UA 完全模仿浏览器。curl 的 TLS 指纹能通过，因此对
// 这个站用 curl 子进程取页面。
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchStartupArchiveHtml() {
  // 先尝试 node fetchURL（轻量），403 时降级到 curl（绕过 TLS 指纹）
  try {
    return await fetchURL('https://www.startuparchive.org/', {
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
  } catch (e) {
    if (!String(e.message).includes('403')) throw e;
  }
  // curl 降级路径
  return execSync(`curl -s -m 20 -A "${BROWSER_UA}" "https://www.startuparchive.org/"`, {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
}

class StartupArchiveConnector extends BaseConnector {
  constructor() {
    super('startup-archive');
  }

  async fetch(date) {
    try {
      const html = await fetchStartupArchiveHtml();
      const items = [];

      // 页面结构（React SSR）：<time>Jan 1, 2026</time> ... <h2 ...>Title text</h2>
      // 每个 entry 的日期在 <time> 标签里，紧跟其后的 <h2> 是
      // "{Person} on/— {insight}" 格式的标题。
      const entryRegex = /<time[^>]*>([A-Z][a-z]{2,}\s+\d{1,2},\s+\d{4})<\/time>[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/gi;
      let match;

      while ((match = entryRegex.exec(html)) !== null) {
        const dateStr = date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
        if (date && dateStr !== date) continue;

        // 标题里可能是 "Person on topic" 或 "Person: quote"，拆出人名
        const rawTitle = match[2].replace(/<[^>]*>/g, '').trim();
        const sep = rawTitle.match(/\s+(?:on|—|–|-|:|explains|recounts|says)\s+/i);
        const person = sep ? rawTitle.slice(0, sep.index).trim() : rawTitle.split(' ')[0];
        const insight = sep ? rawTitle.slice(sep.index + sep[0].length).trim() : '';
        const title = insight ? `${person}: ${insight}` : rawTitle;

        items.push({
          ...this.normalize({
            title,
            url: `https://www.startuparchive.org/`,
            description: insight ? `${person} — ${insight}` : rawTitle,
            publishedAt: new Date(match[1]).toISOString(),
            author: person,
            sourcePayload: {
              person,
              insight,
              date_raw: match[1],
              platform: 'startup-archive',
              type: 'founder-insight',
            },
            popularity: {},
            score: 0,
          }),
          digest_date: dateStr,
        });
      }

      return items;
    } catch (err) {
      console.error('Startup Archive fetch error:', err.message);
      return [];
    }
  }

  _normalizeDate(dateStr) {
    try {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        return d.toISOString().slice(0, 10).replace(/-/g, '');
      }
    } catch {}
    return '';
  }
}

module.exports = { StartupArchiveConnector };
