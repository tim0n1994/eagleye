/**
 * Utils module
 */

import { t, getLanguage } from './i18n.js';

export const $ = (sel, ctx) => (ctx || document).querySelector(sel);
export function timeAgo(dateStr) {
  const now = Date.now();
  const date = new Date(dateStr);
  const diff = now - date.getTime();
  if (diff < 0) return t('time.now');
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('time.now');
  if (mins < 60) return t('time.minutes', { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('time.hours', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('time.days', { n: days });
  return date.toLocaleDateString(getLanguage() === 'zh' ? 'zh-CN' : 'en-US');
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
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function escapeAttr(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function localDateStr(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}