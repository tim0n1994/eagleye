import { escapeAttr, escapeHtml } from '../utils.js';
import { getLanguage } from '../i18n.js';

const POOL_API = '/api/settings/llm/pool';
const TASKS = ['enrich', 'classify', 'translate', 'digest', 'research', 'graph', 'general'];
const words = (zh, en) => getLanguage() === 'zh' ? zh : en;
const known = value => value === null || value === undefined ? '—' : String(value);

function displayUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of url.searchParams.keys()) {
      if (/key|token|secret|auth/i.test(key)) url.searchParams.set(key, '••••');
    }
    return url.toString();
  } catch { return words('无效地址', 'Invalid URL'); }
}

async function request(path = '', method = 'GET', body) {
  const res = await fetch(`${POOL_API}${path}`, {
    method,
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  let data;
  try { data = await res.json(); }
  catch { throw new Error(`HTTP ${res.status} · ${words('无效响应', 'Invalid response')}`); }
  if (!res.ok || data.status === 'error') {
    const messages = {
      400: path === '/parse'
        ? words('配置无法解析，请检查每路完整 Messages/Chat URL、模型及密钥。', 'Configuration could not be parsed. Check each complete Messages/Chat URL, model and API key.')
        : method === 'PUT'
          ? words('配置未保存，请检查端点字段、任务范围及并发和队列限额。新端点须提供完整地址、模型及密钥。', 'Configuration was not saved. Check endpoint fields, tasks, concurrency and queue limits. New endpoints need a complete URL, model and API key.')
          : words('请求无效，请刷新已保存配置后重试。', 'Invalid request. Refresh the saved configuration and try again.'),
      401: words('登录已失效，请使用管理员账户重新登录。', 'Your session has expired. Sign in again with an administrator account.'),
      403: words('此操作仅限管理员，请使用管理员账户。', 'This operation requires an administrator account.'),
      404: words('未找到已保存的端点，请刷新配置后重试。', 'Saved endpoint not found. Refresh the configuration and try again.'),
      429: words('请求过于频繁，请稍后重试。', 'Too many requests. Wait before trying again.'),
    };
    const message = messages[res.status] || words('服务暂时无法完成请求，请稍后重试或联系管理员。', 'The service could not complete the request. Retry later or contact the administrator.');
    throw new Error(`HTTP ${res.status} · ${message}`);
  }
  return data;
}

/** @param {HTMLElement} container @returns {Promise<void>} */
export async function renderLLMPoolPanel(container) {
  if (window.__currentUser?.()?.role !== 'admin') return;
  container.classList.add('llm-pool');
  let config = null;
  let previewText = '';
  const probeResults = new Map();
  const probing = new Set();
  container.innerHTML = `
    <div class="settings-card-header"><h3 class="settings-card-title">${words('模型端点池', 'Model endpoint pool')}</h3></div>
    <div class="settings-card-body">
      <p class="subtle">${words('协议与模型分别配置。探活只验证接口响应，不能证明业务质量。', 'Protocol and model are configured independently. A probe verifies a response, not business quality.')}</p>
      <label for="llmPoolPaste">${words('粘贴完整多端点配置', 'Paste the complete endpoint block')}</label>
      <textarea id="llmPoolPaste" class="settings-paste" rows="8" spellcheck="false" autocomplete="off"></textarea>
      <div class="settings-card-actions">
        <button class="action-btn" id="llmPoolParse">${words('解析预览', 'Preview')}</button>
        <button class="action-btn primary" id="llmPoolActivate" disabled>${words('保存并启用', 'Save and enable')}</button>
        <button class="action-btn" id="llmPoolClear">${words('清空输入', 'Clear input')}</button>
        <button class="action-btn" id="llmPoolRefresh">${words('刷新状态', 'Refresh status')}</button>
      </div>
      <div id="llmPoolPreview" hidden></div>
      <p id="llmPoolFeedback" role="status" aria-live="polite"></p>
      <div id="llmPoolSaved"></div>
    </div>`;
  const find = id => container.querySelector(`#${id}`);
  const feedback = text => { if (container.isConnected) find('llmPoolFeedback').textContent = text; };
  const endpointSummary = endpoint => `<strong>${escapeHtml(endpoint.label || endpoint.id)}</strong><br><span>${escapeHtml(endpoint.protocol)}</span><br><span class="mono" style="overflow-wrap:anywhere">${escapeHtml(displayUrl(endpoint.endpoint_url))}</span><br><span>${escapeHtml(endpoint.model)}</span><br><span>${words('密钥', 'Key')}: ${endpoint.api_key ? '••••' : words('未提供', 'Not supplied')}</span>`;

  async function refresh() {
    const data = await request();
    if (!container.isConnected) return;
    config = data.config;
    const runtime = data.runtime || {};
    const metrics = data.metrics || {};
    const states = runtime.endpoints || [];
    find('llmPoolSaved').innerHTML = `
      <p class="subtle">${words('当前池', 'Pool')}: ${config?.enabled ? words('已启用', 'Enabled') : words('未启用，保留单端点兼容', 'Disabled; single-endpoint compatibility remains')} · ${words('运行状态仅限当前进程', 'Runtime state is process-local')}</p>
      <p class="subtle">${words('运行 / 等待', 'Running / queued')}: ${escapeHtml(known(runtime.active ?? runtime.running))} / ${escapeHtml(known(runtime.queued))}</p>
      <p class="subtle">${words('已记录请求尝试 / 完成 / 失败 / 取消', 'Recorded request attempts / completed / failed / cancelled')}: ${metrics.available === false ? words('不可用', 'Unavailable') : [metrics.total, metrics.completed, metrics.failed, metrics.cancelled].map(value => escapeHtml(known(value))).join(' / ')}</p>
      <p class="subtle">${words('指标按端点请求尝试计数，重试会分别记录；不代表业务任务或条目的完成数量。', 'Metrics count endpoint request attempts, including each retry separately; they do not represent completed business jobs or items.')}</p>
      <label><input type="checkbox" id="llmPoolEnabled" ${config?.enabled ? 'checked' : ''}> ${words('启用端点池', 'Enable endpoint pool')}</label>
      <label for="llmPoolConcurrency">${words('全局并发上限', 'Global concurrency limit')}</label>
      <input class="form-input" style="max-width:140px" type="number" min="1" step="1" id="llmPoolConcurrency" value="${escapeAttr(config?.global_concurrency ?? 5)}">
      <div class="llm-pool-endpoints"><table class="metrics-table llm-pool-table"><thead><tr>
        <th>${words('启用', 'Enabled')}</th><th>${words('端点 / 协议 / 完整地址 / 模型', 'Endpoint / protocol / full URL / model')}</th><th>${words('并发', 'Concurrency')}</th><th>${words('任务范围', 'Tasks')}</th><th>${words('状态与探活', 'State and probe')}</th>
      </tr></thead><tbody>${(config?.endpoints || []).map((endpoint, index) => {
        const state = Array.isArray(states) ? states.find(row => row.id === endpoint.id || row.endpoint_id === endpoint.id) || {} : states[endpoint.id] || {};
        const samples = (metrics.by_endpoint || []).find(row => row.endpoint_id === endpoint.id) || {};
        return `<tr data-pool-index="${index}">
          <td class="llm-pool-toggle"><span class="llm-pool-cell-label" aria-hidden="true">${words('启用', 'Enabled')}</span><input type="checkbox" data-field="enabled" aria-label="${escapeAttr(endpoint.label || endpoint.id)} ${words('启用', 'enabled')}" ${endpoint.enabled ? 'checked' : ''}></td>
          <td class="llm-pool-endpoint"><span class="llm-pool-cell-label" aria-hidden="true">${words('端点 / 协议 / 地址 / 模型', 'Endpoint / protocol / URL / model')}</span>${endpointSummary(endpoint)}</td>
          <td class="llm-pool-concurrency"><span class="llm-pool-cell-label" aria-hidden="true">${words('并发', 'Concurrency')}</span><input class="form-input" type="number" min="1" step="1" data-field="concurrency" aria-label="${escapeAttr(endpoint.id)} concurrency" value="${escapeAttr(endpoint.concurrency ?? 1)}"></td>
          <td class="llm-pool-tasks"><span class="llm-pool-cell-label" aria-hidden="true">${words('任务范围', 'Tasks')}</span><div class="llm-pool-task-options">${TASKS.map(task => `<label><input type="checkbox" data-task="${task}" ${(endpoint.tasks || []).includes(task) ? 'checked' : ''}> ${task}</label>`).join('')}</div></td>
          <td class="llm-pool-state"><span class="llm-pool-cell-label" aria-hidden="true">${words('状态与探活', 'State and probe')}</span><div class="llm-pool-state-metrics"><p>${words('运行 / 等待', 'Running / queued')}: ${escapeHtml(known(state.active ?? state.running))} / ${escapeHtml(known(state.queued))}</p>
            <p>${words('状态', 'State')}: ${escapeHtml(state.state || words('未知', 'Unknown'))}</p>
            <p>${words('最近成功', 'Last success')}: ${escapeHtml(known(state.last_success_at))}</p>
            <p>${words('最近失败', 'Last failure')}: ${escapeHtml(known(state.last_failure_at))}</p>
            <p>${words('错误类型', 'Error code')}: ${escapeHtml(known(state.last_error_code))}</p>
            <p>${words('延迟样本', 'Latency sample')}: ${escapeHtml(known(state.last_latency_ms))} ms</p>
            <p>${words('请求尝试 / 完成 / 失败', 'Request attempts / completed / failed')}: ${[samples.total, samples.completed, samples.failed].map(value => escapeHtml(known(value))).join(' / ')}</p>
            <p>${words('样本平均延迟', 'Sample mean latency')}: ${escapeHtml(known(samples.avg_latency_ms))} ms</p>
            </div>
            <button class="action-btn" data-probe="${escapeAttr(endpoint.id)}" ${probing.has(endpoint.id) ? 'disabled' : ''}>${words('探活', 'Probe')}</button>
            <p data-probe-result role="status">${escapeHtml(probing.has(endpoint.id) ? words('探测中…', 'Probing…') : probeResults.get(endpoint.id) || words('未探测', 'Not tested'))}</p>
          </td></tr>`;
      }).join('')}</tbody></table></div>
      <button class="action-btn primary" id="llmPoolSaveConfig" ${config?.endpoints?.length ? '' : 'disabled'}>${words('保存并发与任务配置', 'Save concurrency and task settings')}</button>`;
    find('llmPoolSaveConfig').addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const globalConcurrency = Number(find('llmPoolConcurrency').value);
        if (!Number.isInteger(globalConcurrency) || globalConcurrency < 1) throw new Error(words('并发必须为正整数', 'Concurrency must be a positive integer'));
        const endpoints = config.endpoints.map((endpoint, index) => {
          const row = container.querySelector(`[data-pool-index="${index}"]`);
          const concurrency = Number(row.querySelector('[data-field="concurrency"]').value);
          if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(words('并发必须为正整数', 'Concurrency must be a positive integer'));
          const saved = { ...endpoint };
          delete saved.api_key;
          return { ...saved, enabled: row.querySelector('[data-field="enabled"]').checked, concurrency, tasks: [...row.querySelectorAll('[data-task]:checked')].map(input => input.dataset.task) };
        });
        await request('', 'PUT', { config: { ...config, enabled: find('llmPoolEnabled').checked, global_concurrency: globalConcurrency, endpoints } });
        await refresh();
        feedback(words('配置已保存并重新读取。', 'Settings saved and reloaded.'));
      } catch (err) { feedback(err.message); }
      finally { button.disabled = false; }
    });
    container.querySelectorAll('[data-probe]').forEach(button => button.addEventListener('click', async () => {
      const id = button.dataset.probe;
      if (probing.has(id)) return;
      probing.add(id);
      const output = button.parentElement.querySelector('[data-probe-result]');
      button.disabled = true;
      output.textContent = words('探测中…', 'Probing…');
      try {
        const result = await request('/test', 'POST', { endpoint_id: id });
        const status = result.ok ? words('接口探活成功（未验证业务质量）', 'Protocol probe passed (business quality unverified)') : words('探活失败', 'Probe failed');
        const code = typeof result.error_code === 'string' && /^[a-z0-9_-]{1,60}$/i.test(result.error_code) ? ` · ${result.error_code}` : '';
        probeResults.set(id, `${status}${code} · ${known(result.latency_ms ?? result.elapsed_ms)} ms`);
        probing.delete(id);
        await refresh();
      } catch (err) {
        probeResults.set(id, `${words('探活失败', 'Probe failed')} · ${err.message}`);
        probing.delete(id);
        output.textContent = probeResults.get(id);
        try { await refresh(); } catch { feedback(words('状态回读失败，请刷新。', 'State reload failed; refresh to retry.')); }
      } finally { probing.delete(id); button.disabled = false; }
    }));
  }

  find('llmPoolPaste').addEventListener('input', () => {
    previewText = '';
    find('llmPoolActivate').disabled = true;
    find('llmPoolPreview').hidden = true;
  });
  find('llmPoolParse').addEventListener('click', async event => {
    const button = event.currentTarget;
    const pasted = find('llmPoolPaste').value;
    previewText = '';
    find('llmPoolActivate').disabled = true;
    if (!pasted.trim()) { feedback(words('请先粘贴配置。', 'Paste a configuration first.')); return; }
    button.disabled = true;
    try {
      const data = await request('/parse', 'POST', { pasted });
      if (!container.isConnected || pasted !== find('llmPoolPaste').value) return;
      find('llmPoolPreview').innerHTML = `<p>${words('解析端点数量', 'Parsed endpoints')}: ${data.config.endpoints.length}</p>${data.config.endpoints.map(endpoint => `<div class="settings-preview">${endpointSummary(endpoint)}</div>`).join('')}`;
      find('llmPoolPreview').hidden = false;
      previewText = pasted;
      find('llmPoolActivate').disabled = !data.config.endpoints.length;
      feedback(words('预览不会保存配置，也不会调用端点。', 'Preview does not save configuration or call endpoints.'));
    } catch (err) { feedback(err.message); }
    finally { button.disabled = false; }
  });
  find('llmPoolActivate').addEventListener('click', async event => {
    if (!previewText || previewText !== find('llmPoolPaste').value) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await request('', 'PUT', { pasted: previewText, enabled: true });
      previewText = '';
      find('llmPoolPaste').value = '';
      find('llmPoolPreview').innerHTML = '';
      find('llmPoolPreview').hidden = true;
      await refresh();
      feedback(words('端点池已保存启用；请逐路探活。', 'Pool saved and enabled; probe each saved endpoint.'));
    } catch (err) { feedback(err.message); button.disabled = false; }
  });
  find('llmPoolClear').addEventListener('click', () => {
    previewText = '';
    find('llmPoolPaste').value = '';
    find('llmPoolPreview').innerHTML = '';
    find('llmPoolPreview').hidden = true;
    find('llmPoolActivate').disabled = true;
  });
  find('llmPoolRefresh').addEventListener('click', () => refresh().catch(err => feedback(err.message)));
  try { await refresh(); } catch (err) { feedback(err.message); }
}
