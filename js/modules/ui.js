import { $, escapeHtml, escapeAttr, timeAgo } from './utils.js';
import { t } from './i18n.js';

function pad(n) {
  return String(n).padStart(2, '0');
}

function timestamp() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export const UI = {
  dom: {},

  cacheDom() {
    this.dom.itemsGrid = $('#itemsGrid');
    this.dom.categoryList = $('#categoryList');
    this.dom.lastUpdated = $('#lastUpdated');
    this.dom.syncBtn = $('#syncNow');
    this.dom.searchInput = $('#searchInput');
    this.dom.researchModal = $('#researchModal');
    this.dom.researchTitle = $('#researchTitle');
    this.dom.researchBody = $('#researchBody');
    this.dom.graphOverlay = $('#graphOverlay');
    this.dom.showGraph = $('#showGraph');
    this.dom.closeGraph = $('#closeGraph');
    this.dom.graphCanvas = $('#graphCanvas');

    // Bottom panel
    this.dom.agentList = $('#agentList');
    this.dom.agentCount = $('#agentCount');
    this.dom.logEntries = $('#logEntries');
    this.dom.clearLog = $('#clearLog');
  },

  /**
   * Initialize sidebar toggle and event listeners.
   */
  initBottomPanel() {
    // Sidebar toggle button
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebar = document.getElementById('rightSidebar');
    const sidebarClose = document.getElementById('sidebarClose');

    if (sidebarToggle && sidebar) {
      sidebarToggle.addEventListener('click', () => {
        sidebar.classList.add('open');
        localStorage.setItem('eagleye-sidebar-open', 'true');
      });
    }

    if (sidebarClose && sidebar) {
      sidebarClose.addEventListener('click', () => {
        sidebar.classList.remove('open');
        localStorage.setItem('eagleye-sidebar-open', 'false');
      });
    }

    // Clear log button
    if (this.dom.clearLog) {
      this.dom.clearLog.addEventListener('click', () => {
        this.clearLog();
      });
    }

    // Restore saved state
    const savedOpen = localStorage.getItem('eagleye-sidebar-open');
    if (savedOpen === 'true' && sidebar) {
      sidebar.classList.add('open');
    }
  },

  /**
   * Add a message to the log panel.
   * @param {string} msg - The message text
   * @param {'info'|'success'|'error'|'warning'|'agent'|'system'} [type='info'] - Log type
   */
  log(msg, type = 'info') {
    const container = this.dom.logEntries;
    if (!container) return;

    // Remove empty state if present
    const empty = container.querySelector('.log-entry.log-info');
    if (empty && container.children.length === 1) {
      const txt = empty.textContent || '';
      if (txt.includes('System ready') || txt.includes('系统就绪')) {
        container.innerHTML = '';
      }
    }

    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    entry.innerHTML = `<span class="log-time">${timestamp()}</span><span class="log-msg">${escapeHtml(msg)}</span>`;
    container.appendChild(entry);

    // Auto-scroll to bottom
    container.scrollTop = container.scrollHeight;
  },

  /**
   * Clear all log entries.
   */
  clearLog() {
    const container = this.dom.logEntries;
    if (!container) return;
    container.innerHTML = `<div class="log-entry log-info">
      <span class="log-time">${timestamp()}</span>
      <span class="log-msg">${t('system.cleared')}</span>
    </div>`;
  },

  /**
   * Add or update an agent in the progress panel.
   * @param {string} agentId - Unique agent identifier
   * @param {string} name - Display name
   * @param {'waiting'|'running'|'completed'|'failed'} status - Agent status
   * @param {string} [statusText] - Short status description
   */
  updateAgent(agentId, name, status, statusText) {
    const container = this.dom.agentList;
    if (!container) return;

    // Remove empty state
    const empty = container.querySelector('.agent-empty');
    if (empty) {
      container.innerHTML = '';
    }

    let item = container.querySelector(`[data-agent-id="${agentId}"]`);

    if (!item) {
      item = document.createElement('div');
      item.className = 'agent-item';
      item.dataset.agentId = agentId;
      item.innerHTML = `
        <span class="agent-status-dot"></span>
        <span class="agent-name"></span>
        <span class="agent-status-text"></span>
      `;
      container.appendChild(item);
    }

    item.className = `agent-item ${status}`;
    item.querySelector('.agent-name').textContent = name;
    item.querySelector('.agent-status-text').textContent = (statusText || status).toUpperCase();

    // Update count
    const count = container.querySelectorAll('.agent-item').length;
    if (this.dom.agentCount) {
      this.dom.agentCount.textContent = count;
    }
  },

  /**
   * Remove an agent from the progress panel.
   * @param {string} agentId
   */
  removeAgent(agentId) {
    const container = this.dom.agentList;
    if (!container) return;

    const item = container.querySelector(`[data-agent-id="${agentId}"]`);
    if (item) {
      item.remove();
    }

    // Update count
    const count = container.querySelectorAll('.agent-item').length;
    if (this.dom.agentCount) {
      this.dom.agentCount.textContent = count;
    }

    // Show empty state if no agents
    if (count === 0) {
      container.innerHTML = `<div class="agent-empty">${t('sidebar.idle')}</div>`;
    }
  },

  /**
   * Clear all agents.
   */
  clearAgents() {
    const container = this.dom.agentList;
    if (!container) return;
    container.innerHTML = `<div class="agent-empty">${t('sidebar.idle')}</div>`;
    if (this.dom.agentCount) {
      this.dom.agentCount.textContent = '0';
    }
  },

  renderCategories(categories) {
    const list = this.dom.categoryList;
    if (!list) return;

    const currentActive = $('.category-item.active', list)?.dataset.category || 'All';

    let html = `<a href="#" class="category-item ${currentActive === 'All' ? 'active' : ''}" data-category="All">
      <span>${t('home.filter_all')}</span> <span class="category-count">LIVE</span>
    </a>`;

    // Sort categories alphabetically
    const sorted = [...categories].sort((a, b) => a.category.localeCompare(b.category));

    sorted.forEach(cat => {
      html += `<a href="#" class="category-item ${currentActive === cat.category ? 'active' : ''}" data-category="${escapeAttr(cat.category)}">
        <span>${escapeHtml(cat.category)}</span> <span class="category-count">${cat.count}</span>
      </a>`;
    });

    list.innerHTML = html;
  },

  renderModules(items, searchQuery = '', _activeCategory = 'All') {
    const container = this.dom.itemsGrid;
    container.innerHTML = '';

    if (items.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 100px 0; opacity: 0.5;">
          <div style="font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.2em;">${t('common.signal_lost')}</div>
        </div>
      `;
      return;
    }

    const listContainer = document.createElement('div');
    listContainer.className = 'items-list';
    container.appendChild(listContainer);

    items.forEach(item => {
      if (searchQuery && !item.title.toLowerCase().includes(searchQuery.toLowerCase()) && !item.summary.toLowerCase().includes(searchQuery.toLowerCase())) {
        return;
      }
      listContainer.appendChild(this.createItemRow(item, searchQuery));
    });
  },

  createItemRow(item, searchQuery) {
    const row = document.createElement('div');
    row.className = 'item-row fade-in';
    
    const tagsHtml = (item.tags || []).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
    const displayTitle = item.ai_summary?.ai_title_zh || item.title_zh || item.ai_summary?.one_liner_zh || item.title;
    const highlightedTitle = this.highlightText(displayTitle, searchQuery);
    const researchTitle = displayTitle || item.title || '';
    
    row.innerHTML = `
      <div class="item-header">
        <span class="item-source-tag">${escapeHtml(item.source)}</span>
        <span class="item-importance">${t('item.rank', { n: item.importance || 5 })}</span>
      </div>
      <a href="${escapeAttr(item.url)}" target="_blank" rel="noopener">
        <h3 class="item-title">${highlightedTitle}</h3>
      </a>
      <p class="item-summary">${escapeHtml(item.summary || t('item.summary_na'))}</p>
      <div class="item-tags">${tagsHtml}</div>
      <div class="item-actions">
        <button class="research-btn" data-item-id="${escapeAttr(item.id || item._id || '')}" data-url="${escapeAttr(item.url)}" data-title="${escapeAttr(researchTitle)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          ${t('common.deep_research')}
        </button>
        <a href="${escapeAttr(item.url)}" target="_blank" rel="noopener" style="margin-left: auto; color: var(--fg-mute); font-size: 11px; font-weight: 700; display: flex; align-items: center; gap: 4px;">
          ${t('common.original')}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>
        </a>
      </div>
      <div style="font-size: 9px; font-family: var(--font-mono); color: var(--fg-mute); margin-top: 8px;">
        ${timeAgo(item.created_at)}
      </div>
    `;
    
    return row;
  },

  highlightText(text, query) {
    if (!query || !text) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('(' + q + ')', 'gi');
    return escaped.replace(regex, '<mark style="background: var(--accent); color: #000; padding: 0 2px;">$1</mark>');
  },

  showResearch(title, content) {
    this.dom.researchTitle.textContent = title;
    // Simple markdown-ish formatter
    const html = content
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^> (.*$)/gim, '<blockquote>$1</blockquote>')
      .replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>')
      .replace(/\*(.*)\*/gim, '<em>$1</em>')
      .replace(/\n/g, '<br>');
    
    this.dom.researchBody.innerHTML = html;
    this.dom.researchModal.style.display = 'block';
  }
};
