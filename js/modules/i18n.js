/**
 * Eagleye — i18n module
 *
 * Simple dictionary-based translator with English (en) and Chinese (zh).
 *   t('key')                          → translated string
 *   t('hello_name', {name: 'JC'})     → substituted string with {name} placeholders
 *   setLanguage('zh')                 → switch + persist + dispatch 'eagleye:langchange'
 *   getLanguage()                     → 'en' | 'zh'
 *
 * Missing keys fall back to English, then to the key itself.
 */

const STORAGE_KEY = 'eagleye-lang';

import { DICTIONARY } from './i18n/dictionary.js';

let _current = detectInitial();
const _listeners = new Set();

function detectInitial() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch {
    // ignore
  }
  const nav = (typeof navigator !== 'undefined' && navigator.language) || 'en';
  if (String(nav).toLowerCase().startsWith('zh')) return 'zh';
  return 'en';
}

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = params[key];
    return v === undefined || v === null ? `{${key}}` : String(v);
  });
}

export function t(key, params) {
  const dict = DICTIONARY[_current] || DICTIONARY.en;
  let s = dict[key];
  if (s === undefined) s = DICTIONARY.en[key];
  if (s === undefined) return key;
  return interpolate(s, params);
}

export function getLanguage() {
  return _current;
}

export function setLanguage(lang) {
  if (lang !== 'en' && lang !== 'zh') return;
  if (lang === _current) return;
  _current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore
  }
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
    document.documentElement.setAttribute('data-lang', lang);
  }
  _listeners.forEach((fn) => {
    try {
      fn(lang);
    } catch {
      // ignore
    }
  });
}

export function toggleLanguage() {
  setLanguage(_current === 'en' ? 'zh' : 'en');
}

export function onLanguageChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

const LANGS = ['en', 'zh'];

/**
 * Walk the current DOM and replace any `data-i18n` or `data-i18n-attr` elements
 * with the translated string. Idempotent.
 */
export function applyI18n(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (!key) return;
    el.textContent = t(key);
  });
  scope.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    const spec = el.getAttribute('data-i18n-attr');
    if (!spec) return;
    spec.split(';').forEach((pair) => {
      const idx = pair.indexOf('|');
      if (idx < 0) return;
      const attr = pair.slice(0, idx).trim();
      const key = pair.slice(idx + 1).trim();
      if (!attr || !key) return;
      el.setAttribute(attr, t(key));
    });
  });
}
