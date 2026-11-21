import { getLanguage } from '../i18n.js';

export function publishingTabs(arxiv = false) {
  if (window.__currentUser?.()?.role !== 'admin') return '';
  const zh = getLanguage() === 'zh';
  return `<nav class="pub-workbench-tabs" aria-label="${zh ? '创作工作台' : 'Publishing workspace'}">
    <a href="/publishing" ${arxiv ? '' : 'aria-current="page"'}>${zh ? '个人创作' : 'Personal publishing'}</a>
    <a href="/publishing/arxiv" ${arxiv ? 'aria-current="page"' : ''}>${zh ? '每日 arXiv 精选' : 'Daily arXiv'}</a>
  </nav>`;
}
