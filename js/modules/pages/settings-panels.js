/**
 * Eagleye — Settings panels
 *
 * The self-refreshing blocks on the settings page: LLM status, scheduler, system
 * health, user management and service API keys. Each renders into its own
 * section element and exposes the window.__ handlers its markup references.
 */

import { escapeAttr, escapeHtml } from '../utils.js';
import { getLanguage, t } from '../i18n.js';
import { API } from '../api.js';
import { API_BASE, fetchJSON } from './shared.js';

export const SAMPLE_PASTE = `Provider:  🌐 AliCloud SG
Upstream:  https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions
Protocol:  OpenAI Chat Completions
Local Endpoint:
  Base URL:           http://127.0.0.1:3458/v1
  Chat URL:           http://127.0.0.1:3458/v1/chat/completions
  Models URL:         http://127.0.0.1:3458/v1/models
  API Key:             test
  Model:               qwq-plus

curl:
  curl http://127.0.0.1:3458/v1/chat/completions \\
    -H 'Authorization: Bearer test' \\
    -H 'Content-Type: application/json' \\
    -d '{"model":"qwq-plus","messages":[{"role":"user","content":"hi"}],"stream":false}'`;

// User management panel (admin only): list users, change roles, enable/disable.
export async function refreshUserManagement() {
  const panel = document.getElementById('userMgmtPanel');
  if (!panel) return;
  const zh = getLanguage() === 'zh';
  const currentUser = (window).__currentUser ? (window).__currentUser() : null;
  if (!currentUser || currentUser.role !== 'admin') {
    panel.style.display = 'none';
    return;
  }
  try {
    const data = await API.adminUsers();
    const users = data.users || [];
    panel.innerHTML = `
      <h3 class="settings-card-title">👥 ${zh ? '用户管理' : 'User Management'}</h3>
      <table class="user-mgmt-table">
        <thead><tr>
          <th>${zh ? '邮箱' : 'Email'}</th>
          <th>${zh ? '角色' : 'Role'}</th>
          <th>${zh ? '状态' : 'Status'}</th>
          <th>${zh ? '注册时间' : 'Joined'}</th>
          <th>${zh ? '操作' : 'Actions'}</th>
        </tr></thead>
        <tbody>
          ${users.map(u => `
            <tr>
              <td>${escapeHtml(u.email)}${u.id === currentUser.id ? ' <span style="color:var(--accent)">(' + (zh ? '你' : 'you') + ')</span>' : ''}</td>
              <td><span class="user-mgmt-badge ${u.role}">${u.role}</span></td>
              <td><span class="user-mgmt-badge ${u.status}">${u.status}</span></td>
              <td style="font-size:11px;color:var(--fg-mute)">${(u.created_at || '').slice(0, 10)}</td>
              <td>
                ${u.id !== currentUser.id ? `
                  <button class="user-mgmt-action" onclick="window.__toggleRole('${u.id}','${u.role}')">${u.role === 'admin' ? '↓ user' : '↑ admin'}</button>
                  <button class="user-mgmt-action" onclick="window.__toggleStatus('${u.id}','${u.status}')">${u.status === 'active' ? '🚫 ' + (zh ? '禁用' : 'Disable') : '✅ ' + (zh ? '启用' : 'Enable')}</button>
                ` : '<span style="color:var(--fg-mute)">—</span>'}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    panel.innerHTML = `<p class="subtle">${zh ? '用户管理面板加载失败' : 'Failed to load'}: ${escapeHtml(err.message)}</p>`;
  }
}

// Expose admin actions globally for inline onclick handlers
(/** @type {any} */ (window)).__toggleRole = async (userId, currentRole) => {
  const newRole = currentRole === 'admin' ? 'user' : 'admin';
  try { await API.adminSetRole(userId, newRole); refreshUserManagement(); } catch (e) { alert(e.message); }
};
(/** @type {any} */ (window)).__toggleStatus = async (userId, currentStatus) => {
  const action = currentStatus === 'active' ? 'disable' : 'enable';
  try { await API.adminSetStatus(userId, action); refreshUserManagement(); } catch (e) { alert(e.message); }
};

// Service API keys panel (admin only): list/create/revoke keys for
// service-to-service callers (e.g. Argus). Mirrors the user-management
// panel pattern: metrics-block section + window.__xxx inline handlers.
export async function refreshApiKeys() {
  const panel = document.getElementById('apiKeysPanel');
  if (!panel) return;
  const zh = getLanguage() === 'zh';
  const currentUser = (window).__currentUser ? (window).__currentUser() : null;
  if (!currentUser || currentUser.role !== 'admin') {
    panel.style.display = 'none';
    return;
  }
  try {
    const res = await fetch('/api/settings/api-keys');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const keys = data.keys || [];
    const mask = (k) => `${k.slice(0, 8)}…${k.slice(-4)}`;
    panel.innerHTML = `
      <h3 class="settings-card-title">🔑 ${zh ? '服务 API Key' : 'Service API Keys'}</h3>
      <p class="subtle" style="margin:4px 0 10px">${zh
        ? '供外部服务（如 Argus）调用 /api/signals 等接口。撤销即时生效。'
        : 'For service-to-service callers (e.g. Argus) hitting /api/signals. Revocation is immediate.'}</p>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <input id="apiKeyName" class="form-input" style="max-width:220px" type="text"
               placeholder="${zh ? '用途名称，如 Argus' : 'Name, e.g. Argus'}">
        <button class="action-btn primary" onclick="window.__createApiKey()">＋ ${zh ? '签发新 Key' : 'Create key'}</button>
        <span class="action-link" id="apiKeyResult"></span>
      </div>
      ${keys.length === 0 ? `<p class="subtle">${zh ? '还没有 API Key。' : 'No keys yet.'}</p>` : `
      <table class="user-mgmt-table">
        <thead><tr>
          <th>${zh ? '名称' : 'Name'}</th>
          <th>Key</th>
          <th>${zh ? '创建' : 'Created'}</th>
          <th>${zh ? '最后使用' : 'Last used'}</th>
          <th>${zh ? '状态' : 'Status'}</th>
          <th>${zh ? '操作' : 'Actions'}</th>
        </tr></thead>
        <tbody>
          ${keys.map(k => `
            <tr>
              <td>${escapeHtml(k.name || '—')}</td>
              <td style="font-family:var(--mono,monospace);font-size:11px">${escapeHtml(mask(k.key))}</td>
              <td style="font-size:11px;color:var(--fg-mute)">${(k.created_at || '').slice(0, 10)}</td>
              <td style="font-size:11px;color:var(--fg-mute)">${(k.last_used_at || '').slice(0, 16) || '—'}</td>
              <td><span class="user-mgmt-badge ${k.active ? 'active' : 'disabled'}">${k.active ? (zh ? '启用' : 'active') : (zh ? '已撤销' : 'revoked')}</span></td>
              <td>
                <button class="user-mgmt-action" onclick="window.__copyApiKey('${escapeAttr(k.key)}')">📋 ${zh ? '复制' : 'Copy'}</button>
                ${k.active ? `<button class="user-mgmt-action" onclick="window.__revokeApiKey('${escapeAttr(k.key)}')">🚫 ${zh ? '撤销' : 'Revoke'}</button>` : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>`}
    `;
  } catch (err) {
    panel.innerHTML = `<p class="subtle">${zh ? 'API Key 面板加载失败' : 'Failed to load API keys'}: ${escapeHtml(err.message)}</p>`;
  }
}

(/** @type {any} */ (window)).__createApiKey = async () => {
  const zh = getLanguage() === 'zh';
  const name = (document.getElementById('apiKeyName') || {}).value || '';
  const out = document.getElementById('apiKeyResult');
  try {
    const res = await fetch('/api/settings/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    try { await navigator.clipboard.writeText(data.key); } catch { /* clipboard optional */ }
    if (out) out.textContent = zh ? `✓ 已签发并复制：${data.key.slice(0, 10)}…` : `✓ Created & copied: ${data.key.slice(0, 10)}…`;
    refreshApiKeys();
  } catch (e) {
    if (out) out.textContent = `⚠ ${e.message}`;
  }
};

(/** @type {any} */ (window)).__revokeApiKey = async (key) => {
  const zh = getLanguage() === 'zh';
  if (!confirm(zh ? `撤销 ${key.slice(0, 10)}… ？使用它的服务会立即 401。` : `Revoke ${key.slice(0, 10)}…? Callers using it get 401 immediately.`)) return;
  try {
    await fetch('/api/settings/api-keys/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    refreshApiKeys();
  } catch (e) { alert(e.message); }
};

(/** @type {any} */ (window)).__copyApiKey = async (key) => {
  try { await navigator.clipboard.writeText(key); } catch { prompt('Copy:', key); }
};

// System health dashboard: shows enrichment/translation backlogs, coverage, DB size.
export async function refreshSystemHealth() {
  const panel = document.getElementById('systemHealthPanel');
  if (!panel) return;
  try {
    const data = await fetchJSON(`${API_BASE}/system/stats`);
    const s = data.stats || {};
    const zh = getLanguage() === 'zh';
    const enrichmentPct = s.total_items > 0 ? Math.round((1 - s.enrichment_backlog / s.total_items) * 100) : 0;
    const scorePct = s.total_items > 0 ? Math.round((s.scored / s.total_items) * 100) : 0;
    const uncPct = s.scored > 0 ? Math.round((s.uncategorized / s.scored) * 100) : 0;
    const stat = (label, val, color) => `<div class="metric-stat"><div class="metric-stat-value" ${color ? `style="color:${color}"` : ''}>${val}</div><div class="metric-stat-label">${escapeHtml(label)}</div></div>`;
    panel.innerHTML =
      `<div class="metrics-stat-grid">` +
      stat(zh ? '条目' : 'Items', (s.total_items || 0).toLocaleString()) +
      stat(zh ? '已富集' : 'Enriched', enrichmentPct + '%') +
      stat(zh ? '已评分' : 'Scored', scorePct + '%') +
      stat(zh ? '未分类' : 'Uncategorized', uncPct + '%', uncPct > 25 ? 'var(--accent)' : '') +
      stat(zh ? '实体' : 'Entities', (s.entities || 0).toLocaleString()) +
      stat(zh ? '研究报告' : 'Reports', s.research_reports || 0) +
      `</div>` +
      `<div class="metrics-block" style="margin-top:12px">` +
      (s.enrichment_backlog > 0 ? `<p class="subtle">⚠ ${zh ? '富集积压' : 'Enrichment backlog'}: ${s.enrichment_backlog} ${zh ? '条（LLM 端点恢复后运行 POST /api/enrich?reset_attempts=true）' : 'items (run POST /api/enrich?reset_attempts=true when LLM is back)'}</p>` : '') +
      (s.translation_backlog > 0 ? `<p class="subtle">⚠ ${zh ? '翻译积压' : 'Translation backlog'}: ${s.translation_backlog}</p>` : '') +
      (s.db_size_mb ? `<p class="subtle">${zh ? '数据库大小' : 'DB size'}: ${s.db_size_mb} MB</p>` : '') +
      `</div>` +
      (s.connectors && s.connectors.length > 0
        ? `<div class="metrics-block" style="margin-top:12px">` +
          `<h3 class="metrics-block-title">${zh ? '连接器健康' : 'Connector Health'}</h3>` +
          `<table class="metrics-table"><thead><tr><th>${zh ? '信息源' : 'Source'}</th><th>7d</th><th>${zh ? '总计' : 'Total'}</th><th>${zh ? '最后抓取' : 'Last fetched'}</th><th>${zh ? '新鲜度' : 'Fresh'}</th></tr></thead><tbody>` +
          s.connectors.map(c => {
            const health = c.items_7d > 0 ? '🟢' : '🔴';
            // Compute relative freshness from last_fetched_at.
            let freshBar = '—';
            if (c.last_fetched_at) {
              const age = (Date.now() - new Date(c.last_fetched_at + 'Z').getTime()) / 3600000;
              const freshPct = Math.max(0, Math.min(100, 100 - age * 2));
              const freshColor = age < 6 ? '#34d399' : age < 24 ? '#facc15' : '#f87171';
              freshBar = `<div style="width:40px;height:5px;background:var(--bg-side);border-radius:2px;overflow:hidden;display:inline-block"><div style="height:100%;width:${freshPct}%;background:${freshColor};border-radius:2px"></div></div>`;
            }
            return `<tr><td>${health} ${escapeHtml(c.label)}</td><td>${c.items_7d}</td><td>${c.total_items}</td><td style="font-size:10px;color:var(--fg-mute)">${escapeHtml(c.last_fetched_at || '—')}</td><td>${freshBar}</td></tr>`;
          }).join('') +
          `</tbody></table></div>`
        : '');
  } catch (err) {
    panel.innerHTML = `<p class="subtle">${escapeHtml(err.message)}</p>`;
  }
}

// Scheduler control panel: shows enable/disable, time, task, last run.
export async function refreshSchedulerPanel() {
  const panel = document.getElementById('schedulerPanel');
  if (!panel) return;
  try {
    const data = await fetchJSON(`${API_BASE}/scheduler`);
    const cfg = data.config || {};
    panel.innerHTML =
      `<div class="scheduler-row">` +
      `<label><input type="checkbox" id="schedEnabled" ${cfg.enabled ? 'checked' : ''}/> ${getLanguage() === 'zh' ? '启用' : 'Enabled'}</label>` +
      `<label>${getLanguage() === 'zh' ? '时间' : 'Time'} <input type="time" id="schedTime" value="${escapeAttr(cfg.time || '04:00')}" class="form-input" style="width:auto;display:inline-block"/></label>` +
      `<label>${getLanguage() === 'zh' ? '任务' : 'Task'} <select id="schedTask" class="form-input" style="width:auto;display:inline-block">` +
      `<option value="pipeline" ${cfg.task === 'pipeline' ? 'selected' : ''}>FULL_PIPELINE</option>` +
      `<option value="rescore" ${cfg.task === 'rescore' ? 'selected' : ''}>RESCORE_ALL</option></select></label>` +
      `<button class="action-btn primary" id="schedSave">${getLanguage() === 'zh' ? '保存' : 'Save'}</button>` +
      `</div>` +
      (cfg.lastRun ? `<p class="subtle">${getLanguage() === 'zh' ? '上次运行' : 'Last run'}: ${escapeAttr(cfg.lastRun)}</p>` : '');
    const saveBtn = panel.querySelector('#schedSave');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const body = {
          enabled: panel.querySelector('#schedEnabled').checked,
          time: panel.querySelector('#schedTime').value,
          task: panel.querySelector('#schedTask').value,
        };
        try {
          await fetch(`${API_BASE}/scheduler`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          saveBtn.textContent = '✓';
          setTimeout(() => refreshSchedulerPanel(), 500);
        } catch (err) { console.warn('Scheduler save failed:', err.message); }
      });
    }
  } catch (err) {
    panel.innerHTML = `<p class="subtle">${escapeHtml(err.message)}</p>`;
  }
}

export async function refreshLLMStatus() {
  const card = document.getElementById('llmCurrent');
  const badge = document.getElementById('llmStatusBadge');
  if (!card || !badge) return;

  try {
    const res = await fetch('/api/settings/llm');
    const data = await res.json();
    if (!data || !data.config) throw new Error('No config returned');

    const cfg = data.config;
    const active = data.active || {};
    const sourceLabel = cfg.source === 'env' ? 'ENV FALLBACK' : (cfg.source || 'RUNTIME');

    badge.textContent = `${(active.provider || cfg.provider).toUpperCase()} · ${sourceLabel}`;
    badge.className = 'settings-card-badge ' + (active.provider === 'none' ? 'warn' : 'ok');

    card.innerHTML = `
      <div class="kv-grid">
        <div class="kv"><label>Provider</label><span>${escapeHtml(active.provider || cfg.provider)}</span></div>
        <div class="kv"><label>Model</label><span>${escapeHtml(active.model || cfg.model || '—')}</span></div>
        <div class="kv"><label>Base URL</label><span class="mono">${escapeHtml(cfg.base_url || active.base_url || '—')}</span></div>
        <div class="kv"><label>API Key</label><span class="mono">${escapeHtml(cfg.api_key || '••••')}</span></div>
        <div class="kv"><label>Source</label><span>${escapeHtml(cfg.source || 'env')}</span></div>
        <div class="kv"><label>Updated</label><span class="mono">${escapeHtml(cfg.updated_at || '—')}</span></div>
      </div>
    `;

    // Pre-fill the manual fields if the parsed config has values
    const fProvider = document.getElementById('llmProvider');
    const fBase = document.getElementById('llmBaseUrl');
    const fKey = document.getElementById('llmApiKey');
    const fModel = document.getElementById('llmModel');
    if (fProvider && cfg.provider) fProvider.value = cfg.provider;
    if (fBase && cfg.base_url) fBase.value = cfg.base_url;
    if (fModel && cfg.model) fModel.value = cfg.model;
  } catch (err) {
    badge.textContent = t('common.error_cap');
    badge.className = 'settings-card-badge error';
    const failedToLoad = getLanguage() === 'zh' ? `加载失败: ${escapeHtml(err.message)}` : `Failed to load: ${escapeHtml(err.message)}`;
    card.innerHTML = `<div class="empty-state">${failedToLoad}</div>`;
  }
}

