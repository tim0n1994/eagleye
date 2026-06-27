/**
 * Utils module
 */

export const $ = (sel, ctx) => (ctx || document).querySelector(sel);
export function timeAgo(dateStr) {
  const now = Date.now();
  const date = new Date(dateStr);
  const diff = now - date.getTime();
  if (diff < 0) return '刚刚';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return mins + ' 分钟前';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + ' 小时前';
  const days = Math.floor(hours / 24);
  if (days < 30) return days + ' 天前';
  return date.toLocaleDateString('zh-CN');
}

export function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function truncate(text, len = 120) {
  if (!text) return '';
  return text.length > len ? text.slice(0, len) + '…' : text;
}

export function stripHtml(html) {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || div.innerText || '';
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#039;');
}

export function escapeAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&')
    .replace(/"/g, '"')
    .replace(/'/g, '&#039;')
    .replace(/</g, '<')
    .replace(/>/g, '>');
}

export function localDateStr(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}