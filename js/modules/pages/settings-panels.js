/**
 * Eagleye — Settings panels
 *
 * The self-refreshing blocks on the settings page: LLM status, scheduler, system
 * health, user management, service API keys and the MCP server switch. Each
 * renders into its own section element and exposes the window.__ handlers its
 * markup references.
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
    if (!data.stats || !Number.isFinite(data.stats.total_items)) throw new Error(getLanguage() === 'zh' ? '系统状态未知：响应缺少统计数据' : 'System status unknown: missing statistics');
    const s = data.stats;
    const zh = getLanguage() === 'zh';
    const unknown = zh ? '未知' : 'Unknown';
    const pct = (count, total) => {
      if (!Number.isFinite(count) || !Number.isFinite(total)) return unknown;
      if (total <= 0) return '—';
      const rounded = Math.round(count / total * 10000) / 100;
      return count < total && rounded === 100 ? '>99.99%' : rounded + '%';
    };
    const enrichmentPct = pct(s.enrichment_success ?? s.summaries, s.total_items);
    const scorePct = pct(s.scored, s.total_items);
    const uncPct = pct(s.uncategorized, s.scored);
    const number = value => Number.isFinite(value) ? value.toLocaleString() : unknown;
    const freshness = state => {
      if (!state || state.status === 'unknown') return unknown;
      if (state.status === 'empty') return zh ? '无数据' : 'No data';
      if (state.status === 'current') return zh ? '今日数据' : 'Current date';
      return zh ? `历史数据 · ${state.age_days} 天前` : `Stale · ${state.age_days} days old`;
    };
    const stat = (label, val, color) => `<div class="metric-stat"><div class="metric-stat-value" ${color ? `style="color:${color}"` : ''}>${val}</div><div class="metric-stat-label">${escapeHtml(label)}</div></div>`;
    panel.innerHTML =
      `<div class="metrics-stat-grid">` +
      stat(zh ? '条目' : 'Items', number(s.total_items)) +
      stat(zh ? '已富集' : 'Enriched', enrichmentPct) +
      stat(zh ? '已评分' : 'Scored', scorePct) +
      stat(zh ? '未分类' : 'Uncategorized', uncPct) +
      stat(zh ? '实体' : 'Entities', number(s.entities)) +
      stat(zh ? '研究报告' : 'Reports', number(s.research_reports)) +
      stat(zh ? 'KG 特征覆盖' : 'KG feature coverage', pct(s.kg_features, s.total_items)) +
      `</div>` +
      `<div class="metrics-block" style="margin-top:12px">` +
      `<p role="status">${escapeHtml(freshness(s.data_freshness))} · ${zh ? '最新数据日期' : 'Latest data date'}: ${escapeHtml(s.latest_digest_date || unknown)}</p>` +
      `<p class="subtle">${zh ? '最近存入条目' : 'Last item fetched'}: ${escapeHtml(s.latest_item_fetched_at || unknown)}</p>` +
      `<p class="subtle">${zh ? '有效摘要条目' : 'Items with valid summaries'}: ${number(s.enrichment_success ?? s.summaries)} / ${number(s.total_items)} · ${zh ? '可重试' : 'Retryable'}: ${number(s.enrichment_backlog)} · ${zh ? '重试耗尽' : 'Retries exhausted'}: ${number(s.enrichment_exhausted ?? s.poisoned_items)}</p>` +
      (s.total_items === 0 ? `<p class="subtle">${zh ? '无数据，覆盖率不适用。' : 'No data; coverage is not applicable.'}</p>` : '') +
      (s.translation_backlog > 0 ? `<p class="subtle">⚠ ${zh ? '翻译积压' : 'Translation backlog'}: ${s.translation_backlog}</p>` : '') +
      `<p class="subtle">${zh ? '数据库大小' : 'DB size'}: ${number(s.db_size_mb)} MB</p>` +
      (s.vector_models || []).map(v => `<p class="subtle">${escapeHtml(v.model_name)} · ${escapeHtml(v.vector_type || unknown)} · ${v.kind === 'hash' ? (zh ? '哈希向量（非语义模型）' : 'Hash vectors (not semantic embeddings)') : v.kind === 'semantic' ? (zh ? '语义向量' : 'Semantic vectors') : unknown}: ${number(v.items)} / ${number(s.total_items)} (${pct(v.items, s.total_items)})</p>`).join('') +
      `<p class="subtle">${zh ? '最近流水线' : 'Latest pipeline'}: ${s.last_pipeline ? escapeHtml(s.last_pipeline.status) + ' · ' + escapeHtml(s.last_pipeline.completed_at || s.last_pipeline.created_at || unknown) : (zh ? '无运行记录' : 'No recorded run')}${s.last_pipeline?.stages_known === false ? ` · ${zh ? '阶段详情未知' : 'Stage details unknown'}` : ''}</p>` +
      (s.last_pipeline?.failed_stages || []).map(stage => `<p class="subtle">⚠ ${escapeHtml(stage.key || unknown)}: ${escapeHtml(stage.error || (zh ? '阶段失败' : 'Stage failed'))}</p>`).join('') +
      `</div>` +
      (s.connectors && s.connectors.length > 0
        ? `<div class="metrics-block" style="margin-top:12px">` +
          `<h3 class="metrics-block-title">${zh ? '连接器健康' : 'Connector Health'}</h3>` +
          `<table class="metrics-table"><thead><tr><th>${zh ? '信息源' : 'Source'}</th><th>7d</th><th>${zh ? '总计' : 'Total'}</th><th>${zh ? '最后抓取尝试' : 'Last fetch attempt'}</th><th>${zh ? '实际数据日期 / 新鲜度' : 'Data date / freshness'}</th></tr></thead><tbody>` +
          s.connectors.map(c => {
            return `<tr><td>${escapeHtml(c.label)}</td><td>${number(c.items_7d)}</td><td>${number(c.total_items)}</td><td style="font-size:10px;color:var(--fg-mute)">${escapeHtml(c.last_fetched_at || unknown)}</td><td>${escapeHtml(c.latest_digest_date || unknown)} · ${escapeHtml(freshness(c.data_freshness))}</td></tr>`;
          }).join('') +
          `</tbody></table></div>`
        : '');
  } catch (err) {
    panel.innerHTML = `<p class="subtle" role="status">${getLanguage() === 'zh' ? '系统状态未知，无法加载统计' : 'System status unknown; statistics unavailable'}: ${escapeHtml(err.message)}</p>`;
  }
}

// Scheduler control panel: shows enable/disable, time, task, last run.
export async function refreshSchedulerPanel() {
  const panel = document.getElementById('schedulerPanel');
  if (!panel || window.__currentUser?.()?.role !== 'admin') return;
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
      `<span>${getLanguage() === 'zh' ? '时区（服务端）' : 'Timezone (server)'}: <strong id="schedTimezone">${escapeHtml(cfg.timezone || '—')}</strong></span>` +
      `<button class="action-btn primary" id="schedSave">${getLanguage() === 'zh' ? '保存' : 'Save'}</button>` +
      `</div>` +
      `<p class="subtle">${getLanguage() === 'zh' ? '下次计划' : 'Next due'}: ${escapeHtml(cfg.next_due || '—')}</p>` +
      `<p class="subtle">${getLanguage() === 'zh' ? '上次任务' : 'Last job'}: ${escapeHtml(cfg.last_job_id || '—')} · ${getLanguage() === 'zh' ? '结果' : 'Outcome'}: ${escapeHtml(cfg.last_outcome || '—')}</p>` +
      `<p class="subtle">${getLanguage() === 'zh' ? '任务状态' : 'Job status'}: ${escapeHtml(cfg.last_job_status || '—')} · ${getLanguage() === 'zh' ? '最近尝试' : 'Last attempt'}: ${escapeHtml(cfg.last_attempt || '—')}</p>` +
      (cfg.lastRun ? `<p class="subtle">${getLanguage() === 'zh' ? '上次运行' : 'Last run'}: ${escapeAttr(cfg.lastRun)}</p>` : '') +
      `<p id="schedResult" role="status" aria-live="polite"></p>`;
    const saveBtn = panel.querySelector('#schedSave');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const body = {
          enabled: panel.querySelector('#schedEnabled').checked,
          time: panel.querySelector('#schedTime').value,
          task: panel.querySelector('#schedTask').value,
        };
        saveBtn.disabled = true;
        try {
          const response = await fetch(`${API_BASE}/scheduler`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          await refreshSchedulerPanel();
          panel.querySelector('#schedResult').textContent = getLanguage() === 'zh' ? '调度配置已保存并重新读取。' : 'Scheduler settings saved and reloaded.';
        } catch (err) {
          const output = panel.querySelector('#schedResult');
          if (output) output.textContent = `${getLanguage() === 'zh' ? '保存失败' : 'Save failed'}: ${err.message}`;
        } finally { saveBtn.disabled = false; }
      });
    }
  } catch (err) {
    panel.innerHTML = `<p class="subtle">${escapeHtml(err.message)}</p>`;
  }
}

// MCP Server switch (admin only): enables the read-only MCP data service for
// external AI clients. State is stored server-side in user_data (global scope).
export async function refreshMcpServerPanel() {
  const panel = document.getElementById('mcpServerPanel');
  if (!panel || window.__currentUser?.()?.role !== 'admin') return;
  try {
    const data = await fetchJSON(`${API_BASE}/settings/mcp`);
    const enabled = data?.config?.enabled === true;
    panel.innerHTML =
      `<div class="settings-card-header"><span class="settings-card-title">${t('settings.mcp_title')}</span></div>` +
      `<div class="settings-card-body">` +
      `<p class="subtle">${t('settings.mcp_description')}</p>` +
      `<label><input type="checkbox" id="mcpEnabled" ${enabled ? 'checked' : ''}/> ${t('settings.mcp_enable')}</label>` +
      `<p class="subtle" id="mcpServerStatus" role="status" aria-live="polite">${t('settings.mcp_status', { state: enabled ? t('settings.mcp_state_on') : t('settings.mcp_state_off') })}</p>` +
      `</div>`;
    panel.querySelector('#mcpEnabled').addEventListener('change', async event => {
      const input = event.currentTarget;
      input.disabled = true;
      try {
        const response = await fetch(`${API_BASE}/settings/mcp`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: input.checked }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.error) throw new Error(result.error || `HTTP ${response.status}`);
        const savedEnabled = result.config?.enabled === true;
        await refreshMcpServerPanel();
        const status = panel.querySelector('#mcpServerStatus');
        if (status) status.textContent = `${t('settings.mcp_status', { state: savedEnabled ? t('settings.mcp_state_on') : t('settings.mcp_state_off') })} · ${t('settings.mcp_saved')}`;
      } catch (err) {
        input.checked = !input.checked;
        const status = panel.querySelector('#mcpServerStatus');
        if (status) status.textContent = t('settings.mcp_save_failed', { msg: err.message });
        input.disabled = false;
      }
    });
  } catch (err) {
    panel.innerHTML = `<p class="subtle">${escapeHtml(err.message)}</p>`;
  }
}

export async function refreshLLMStatus() {
  const card = document.getElementById('llmCurrent');
  const badge = document.getElementById('llmStatusBadge');
  if (!card || !badge || window.__currentUser?.()?.role !== 'admin') return;

  try {
    const res = await fetch('/api/settings/llm');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.config) throw new Error('No config returned');

    const cfg = data.config;
    const sourceLabel = cfg.source === 'env' ? 'ENV FALLBACK' : (cfg.source || 'RUNTIME');

    badge.textContent = `${String(cfg.provider || 'none').toUpperCase()} · ${sourceLabel} · ${getLanguage() === 'zh' ? '配置记录，健康未验证' : 'Configured; health unverified'}`;
    badge.className = 'settings-card-badge';

    card.innerHTML = `
      <div class="kv-grid">
        <div class="kv"><label>Provider</label><span>${escapeHtml(cfg.provider || '—')}</span></div>
        <div class="kv"><label>Model</label><span>${escapeHtml(cfg.model || '—')}</span></div>
        <div class="kv"><label>Base URL</label><span class="mono">${escapeHtml(cfg.base_url || '—')}</span></div>
        <div class="kv"><label>API Key</label><span class="mono">${cfg.api_key ? '••••' : '—'}</span></div>
        <div class="kv"><label>Source</label><span>${escapeHtml(cfg.source || 'env')}</span></div>
        <div class="kv"><label>Updated</label><span class="mono">${escapeHtml(cfg.updated_at || '—')}</span></div>
      </div>
    `;

    // Pre-fill the manual fields if the parsed config has values
    const fProvider = document.getElementById('llmProvider');
    const fBase = document.getElementById('llmBaseUrl');
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
