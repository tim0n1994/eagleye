/**
 * Eagleye — Settings event wiring
 *
 * wireSettingsHandlers binds every control on the settings page. Split from the
 * page shell purely for size; behaviour is unchanged.
 */

import { $, escapeAttr, escapeHtml } from '../utils.js';
import { getLanguage, t } from '../i18n.js';
import { SAMPLE_PASTE, refreshLLMStatus } from './settings-panels.js';

let _lastParsedConfig = null;

export function wireSettingsHandlers() {
  const $ = (id) => document.getElementById(id);

  $('llmLoadSampleBtn')?.addEventListener('click', () => {
    const ta = $('llmPaste');
    if (ta) { ta.value = SAMPLE_PASTE; ta.focus(); }
  });

  $('llmClearBtn')?.addEventListener('click', () => {
    const ta = $('llmPaste'); if (ta) ta.value = '';
    const pv = $('llmPreview'); if (pv) { pv.hidden = true; pv.innerHTML = ''; }
    _lastParsedConfig = null;
    const btn = $('llmSaveBtn'); if (btn) btn.disabled = true;
  });

  $('llmParseBtn')?.addEventListener('click', async () => {
    const text = $('llmPaste')?.value || '';
    const pv = $('llmPreview');
    const saveBtn = $('llmSaveBtn');
    if (!text.trim()) {
      pv.hidden = false;
      const emptyPaste = getLanguage() === 'zh' ? '<div class="settings-warn">请先粘贴接口配置。</div>' : '<div class="settings-warn">Paste your endpoint config first.</div>';
      pv.innerHTML = emptyPaste;
      return;
    }
    try {
      const res = await fetch('/api/settings/llm/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pasted: text }),
      });
      const data = await res.json();
      if (data.status === 'parse_error' || data.error) {
        _lastParsedConfig = null;
        saveBtn.disabled = true;
        pv.hidden = false;
        pv.innerHTML = `<div class="settings-warn">${t('settings.parse_failed', { msg: escapeHtml(data.error || (getLanguage() === 'zh' ? '解析失败' : 'Parse failed')) })}</div>`;
        return;
      }
      _lastParsedConfig = data;
      saveBtn.disabled = false;
      pv.hidden = false;
      const parsedLabel = getLanguage() === 'zh' ? `✓ 已解析 — 确认后点击 <strong>${escapeHtml(t('settings.save_activate'))}</strong>` : `✓ Parsed — review and click <strong>${escapeHtml(t('settings.save_activate'))}</strong>`;
      pv.innerHTML = `
        <div class="settings-ok">${parsedLabel}</div>
        <div class="kv-grid">
          <div class="kv"><label>${t('settings.fields_provider')}</label><span>${escapeHtml(data.provider)}</span></div>
          <div class="kv"><label>${t('settings.fields_model')}</label><span>${escapeHtml(data.model)}</span></div>
          <div class="kv"><label>${t('settings.fields_base_url')}</label><span class="mono">${escapeHtml(data.base_url)}</span></div>
          <div class="kv"><label>${t('settings.fields_api_key')}</label><span class="mono">${escapeHtml(data.masked?.api_key || '••••')}</span></div>
        </div>
      `;
    } catch (err) {
      pv.hidden = false;
      pv.innerHTML = `<div class="settings-warn">⚠ ${escapeHtml(err.message)}</div>`;
    }
  });

  $('llmSaveBtn')?.addEventListener('click', async () => {
    if (!_lastParsedConfig) return;
    const out = $('llmSaveResult');
    out.textContent = t('settings.saving');
    try {
      const res = await fetch('/api/settings/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pasted: $('llmPaste').value }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || (getLanguage() === 'zh' ? '保存失败' : 'Save failed'));
      const savedMsg = getLanguage() === 'zh' ? '✓ 已保存并启用。' : '✓ Saved & activated.';
      out.textContent = savedMsg;
      await refreshLLMStatus();
    } catch (err) {
      out.textContent = '⚠ ' + err.message;
    }
  });

  $('llmSaveFieldsBtn')?.addEventListener('click', async () => {
    const cfg = {
      provider: $('llmProvider')?.value || '',
      base_url: $('llmBaseUrl')?.value || '',
      api_key: $('llmApiKey')?.value || '',
      model: $('llmModel')?.value || '',
    };
    const out = $('llmFieldsResult');
    out.textContent = t('settings.saving');
    try {
      const res = await fetch('/api/settings/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: cfg }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || (getLanguage() === 'zh' ? '保存失败' : 'Save failed'));
      const savedMsg = getLanguage() === 'zh' ? '✓ 已保存并启用。' : '✓ Saved & activated.';
      out.textContent = savedMsg;
      await refreshLLMStatus();
    } catch (err) {
      out.textContent = '⚠ ' + err.message;
    }
  });

  $('llmTestBtn')?.addEventListener('click', async () => {
    const out = $('llmTestResult');
    out.textContent = getLanguage() === 'zh' ? '测试中…' : 'Testing…';
    try {
      const res = await fetch('/api/settings/llm/test', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        out.textContent = `✓ ${data.latent_ms || data.latency_ms}ms — "${(data.sample || '').slice(0, 40)}"`;
      } else {
        out.textContent = '⚠ ' + (data.message || (getLanguage() === 'zh' ? '测试失败' : 'Test failed'));
      }
    } catch (err) {
      out.textContent = '⚠ ' + err.message;
    }
  });

  $('llmResetBtn')?.addEventListener('click', async () => {
    const confirmMsg = getLanguage() === 'zh' ? '确定重置为 .env 默认值吗？粘贴的配置将被清除。' : 'Reset to .env defaults? Your pasted config will be cleared.';
    if (!confirm(confirmMsg)) return;
    const out = $('llmTestResult');
    out.textContent = getLanguage() === 'zh' ? '重置中…' : 'Resetting…';
    try {
      const res = await fetch('/api/settings/llm', { method: 'DELETE' });
      if (!res.ok) throw new Error(getLanguage() === 'zh' ? '重置失败' : 'Reset failed');
      const okMsg = getLanguage() === 'zh' ? '✓ 已重置为 .env 默认值。' : '✓ Reset to .env defaults.';
      out.textContent = okMsg;
      await refreshLLMStatus();
    } catch (err) {
      out.textContent = '⚠ ' + err.message;
    }
  });

  // ── Operations card wiring ──
  const opJobsBody = $('opJobsBody');
  const OP_LABELS = {
    sync: getLanguage() === 'zh' ? '抓取信息源' : 'Sync sources',
    enrich: getLanguage() === 'zh' ? 'AI 摘要' : 'Enrich items',
    digest: getLanguage() === 'zh' ? '生成简报' : 'Build digest',
    pipeline: getLanguage() === 'zh' ? '完整流水线' : 'Full pipeline',
    xsync: getLanguage() === 'zh' ? 'X 同步' : 'X sync',
  };
  // Map each op to its running job_id so we can poll/cancel
  const opJobMap = {};

  function showStream(op, html, isError = false) {
    const el = document.querySelector(`[data-op-stream="${op}"]`);
    if (!el) return;
    el.hidden = false;
    el.className = 'op-stream ' + (isError ? 'op-stream-error' : 'op-stream-ok');
    el.innerHTML = html;
  }

  function hideStream(op) {
    const el = document.querySelector(`[data-op-stream="${op}"]`);
    if (el) { el.hidden = true; el.innerHTML = ''; }
  }

  function setOpRunning(op, running) {
    const row = document.querySelector(`[data-op-row="${op}"]`);
    if (!row) return;
    const startBtn = row.querySelector('[data-op]');
    const stopBtn = row.querySelector('[data-op-stop]');
    if (startBtn) startBtn.disabled = !!running;
    if (stopBtn) stopBtn.hidden = !running;
  }

  function shortJobId(id) {
    return id ? id.slice(0, 8) : '—';
  }

  function parseJobResult(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return String(raw);
    }
  }

  async function readJSONOnce(res) {
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  }

  function formatSourceResults(results) {
    if (!Array.isArray(results) || results.length === 0) return '';
    return results.slice(-6).map(r => {
      const suffix = r.error ? `error: ${escapeHtml(r.error)}` : `${r.items || 0} items`;
      return `${escapeHtml(r.source || 'unknown')}: ${suffix}`;
    }).join('<br>');
  }

  function summarizeStagePayload(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const parts = [];
    if (payload.phase === 'fetching') {
      parts.push(`source ${payload.completed_sources ?? payload.current_index ?? 0}/${payload.total_sources || '?'}`);
      if (payload.current_source) parts.push(escapeHtml(payload.current_source));
      const items = (payload.results || []).reduce((sum, r) => sum + (Number(r.items) || 0), 0);
      parts.push(`${items} items`);
      if (payload.heartbeat !== undefined) parts.push(`tick ${payload.heartbeat}`);
    } else if (payload.phase === 'enriching' || payload.phase === 'scoring') {
      parts.push(`processed ${payload.processed || 0}/${payload.total || 0}`);
      parts.push(`enriched ${payload.enriched || 0}`);
      parts.push(`failed ${payload.failed || 0}`);
      if (payload.entities !== undefined) parts.push(`entities ${payload.entities}`);
      if (payload.topics !== undefined) parts.push(`topics ${payload.topics}`);
    } else if (payload.phase === 'translating') {
      parts.push(`processed ${payload.processed || 0}/${payload.total || 0}`);
      parts.push(`translated ${payload.translated || 0}`);
      parts.push(`failed ${payload.failed || 0}`);
      parts.push(`remaining ${payload.remaining ?? '—'}`);
    } else if (Array.isArray(payload.fetch)) {
      const items = payload.fetch.reduce((sum, r) => sum + (Number(r.items) || 0), 0);
      parts.push(`${payload.fetch.length} sources`);
      parts.push(`${items} items`);
    } else {
      if (payload.message) parts.push(escapeHtml(payload.message));
      if (payload.error) parts.push(`error: ${escapeHtml(payload.error)}`);
      if (payload.date) parts.push(`date ${escapeHtml(payload.date)}`);
      if (payload.sources) parts.push(escapeHtml(payload.sources));
    }
    return parts.filter(Boolean).join(' · ');
  }

  function summarizeStageResult(result) {
    if (!result || typeof result !== 'object') return '';
    if (Array.isArray(result.fetch)) {
      // Show all sources with item counts, paper sources first
      const paperSources = new Set(['hugging-face', 'arxiv-ai', 'physical-ai-arxiv', 'physical-ai-cn-photonics']);
      const sorted = [...result.fetch].sort((a, b) => {
        const aPaper = paperSources.has(a.source) ? -1 : 0;
        const bPaper = paperSources.has(b.source) ? -1 : 0;
        return aPaper - bPaper || (b.items || 0) - (a.items || 0);
      });
      return `<span class="job-mini-result-list">${sorted.map(r => `<span class="source-line ${(r.items||0)>0?'has-items':''}">${escapeHtml(r.source || 'unknown')}: ${r.items || 0}</span>`).join('<br>')}</span>`;
    }
    if (result.enriched !== undefined) return `enriched ${result.enriched}/${result.total || 0} · failed ${result.failed || 0}`;
    if (result.translated !== undefined) return `translated ${result.translated}/${result.total || 0} · remaining ${result.remaining ?? '—'}`;
    if (result.nodes !== undefined || result.edges !== undefined) return `nodes ${result.nodes || 0} · edges ${result.edges || 0}`;
    if (result.domains !== undefined) return `${result.domains} 领域 · ${result.topics || 0} 方向 · ${result.uniqueTags || result.tags || 0} 标签`;
    if (result.extract || result.embed || result.topics) {
      return `extract ${result.extract?.total || 0} · embed ${result.embed?.embedded || 0} · topics ${result.topics?.topics_discovered || 0}`;
    }
    if (result.generated !== undefined) return result.generated ? '已生成' : '无摘要';
    if (result.edges_updated !== undefined) return `edges ${result.edges_updated} · scores ${result.scores_updated}`;
    if (result.sources !== undefined) return `${result.sources}`;
    return escapeHtml(JSON.stringify(result).slice(0, 120));
  }

  function formatPipelineProgress(parsed) {
    const stages = Array.isArray(parsed.stages) ? parsed.stages : [];
    if (stages.length === 0) return escapeHtml(JSON.stringify(parsed).slice(0, 500));
    const current = parsed.current_stage || '';
    const rows = stages.map(stage => {
      const status = stage.status || 'pending';
      const detail = summarizeStagePayload(stage.detail) || summarizeStageResult(stage.result);
      const label = getLanguage() === 'zh' ? (stage.label_zh || stage.label || stage.key) : (stage.label || stage.key);
      const elapsed = stage.started_at && status === 'running'
        ? `${Math.max(0, Math.round((Date.now() - new Date(stage.started_at).getTime()) / 1000))}s`
        : '';
      const statusText = elapsed ? `${status} · ${elapsed}` : status;
      return `
        <div class="pipeline-stage pipeline-stage-${escapeAttr(status)} ${stage.key === current ? 'active' : ''}">
          <span class="pipeline-stage-label">${escapeHtml(label)}</span>
          <span class="pipeline-stage-status">${escapeHtml(statusText)}</span>
          ${detail ? `<span class="pipeline-stage-detail">${detail}</span>` : ''}
        </div>
      `;
    }).join('');
    return `<div class="pipeline-progress">${rows}</div>`;
  }

  function formatJobResult(job) {
    const parsed = parseJobResult(job?.result);
    if (!parsed) return '—';
    if (typeof parsed === 'string') return escapeHtml(parsed.slice(0, 500));

    if (parsed.pipeline === true) {
      return formatPipelineProgress(parsed);
    }

    if (parsed.phase === 'translating') {
      const lines = [
        `Translating ${parsed.processed || 0}/${parsed.total || 0}`,
        `Translated: ${parsed.translated || 0}, failed: ${parsed.failed || 0}`,
        `Remaining: ${parsed.remaining ?? '—'}`,
      ];
      if (parsed.batch_items || parsed.workers) {
        lines.push(`Batch: ${parsed.batch_items || '—'}, workers: ${parsed.workers || '—'}`);
      }
      return lines.join('<br>');
    }

    const fetchResults = parsed.fetch || parsed.results;
    if (Array.isArray(fetchResults)) {
      const totalSources = parsed.total_sources || fetchResults.length;
      const doneSources = fetchResults.length;
      const totalItems = fetchResults.reduce((sum, r) => sum + (r.items || 0), 0);
      const parts = [];
      if (parsed.phase === 'fetching') {
        parts.push(`Fetching ${escapeHtml(parsed.current_source || '')} (${parsed.current_index || doneSources}/${totalSources || '?'})`);
      } else if (parsed.phase === 'enriching') {
        parts.push(`Fetch complete: ${doneSources}/${totalSources || doneSources} sources, ${totalItems} items. Enriching…`);
      } else {
        parts.push(`Sources: ${doneSources}/${totalSources || doneSources}, items: ${totalItems}`);
      }
      const details = formatSourceResults(fetchResults);
      if (details) parts.push(`<span class="job-mini-result-list">${details}</span>`);
      if (parsed.enrich) {
        parts.push(`Enriched: ${parsed.enrich.enriched || 0}/${parsed.enrich.total || 0}`);
      }
      return parts.join('<br>');
    }

    return escapeHtml(JSON.stringify(parsed).slice(0, 500));
  }

  async function pollJob(op, jobId, startMs) {
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        const data = await readJSONOnce(res);
        const job = data?.job;
        if (!job) return true; // done
        const elapsed = Math.round((Date.now() - startMs) / 1000);
        const status = (job.status || '').toLowerCase();
        const result = formatJobResult(job);
        if (status === 'running') {
          showStream(op, `${t('ops.stream_running', { elapsed })}<br><span class="job-mini-result">${result}</span>`);
          return false;
        }
        if (status === 'completed') {
          showStream(op, `${t('ops.stream_done', { elapsed })}<br><span class="job-mini-result">${result}</span>`);
          setOpRunning(op, false);
          opJobMap[op] = null;
          refreshOpJobs();
          return true;
        }
        if (status === 'cancelled') {
          showStream(op, `${t('ops.stream_cancelled', { elapsed })}<br><span class="job-mini-result">${result}</span>`);
          setOpRunning(op, false);
          opJobMap[op] = null;
          refreshOpJobs();
          return true;
        }
        if (status === 'failed') {
          showStream(op, `${t('ops.stream_failed', { elapsed })}<br><span class="job-mini-error">${escapeHtml(job.error || '—')}</span>`, true);
          setOpRunning(op, false);
          opJobMap[op] = null;
          refreshOpJobs();
          return true;
        }
        // still queued
        showStream(op, `⏳ Queued ${shortJobId(jobId)}…`);
        return false;
      } catch (err) {
        showStream(op, `⚠ ${err.message}`, true);
        return true;
      }
    };
    // poll every 1.5s until done
    while (!(await tick())) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  async function runOp(op) {
    setOpRunning(op, true);
    const startMs = Date.now();
    showStream(op, `${OP_LABELS[op]}: ${t('ops.running')}`);
    try {
      let res;
      if (op === 'sync') {
        res = await fetch('/api/sync', { method: 'POST' });
      } else if (op === 'enrich') {
        res = await fetch('/api/enrich?background=true', { method: 'POST' });
      } else if (op === 'digest') {
        res = await fetch('/api/digest/build?background=true', { method: 'POST' });
      } else if (op === 'pipeline') {
        res = await fetch('/api/pipeline', { method: 'POST' });
      } else {
        throw new Error('unknown op');
      }
      if (!res) throw new Error('no response');
      const data = await readJSONOnce(res);
      if (!res.ok) throw new Error(data.message || data.error || `${op} failed`);
      const jobId = data.job_id;
      if (jobId) {
        opJobMap[op] = jobId;
        showStream(op, `⏳ ${shortJobId(jobId)}: ${t('ops.running')}`);
        await pollJob(op, jobId, startMs);
      } else {
        showStream(op, t('ops.done', { msg: data.message || 'ok' }));
        setOpRunning(op, false);
        setTimeout(refreshOpJobs, 800);
      }
    } catch (err) {
      showStream(op, t('ops.failed', { msg: err.message }), true);
      setOpRunning(op, false);
    }
  }

  async function stopOp(op) {
    const jobId = opJobMap[op];
    if (!jobId) return;
    const stopBtn = document.querySelector(`[data-op-stop="${op}"]`);
    if (stopBtn) {
      stopBtn.disabled = true;
      stopBtn.textContent = t('ops.cancelling');
    }
    try {
      await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    } catch (err) {
      console.warn('cancel failed:', err.message);
    }
    // pollJob will pick up the cancelled status and update UI
  }

  async function refreshOpJobs() {
    if (!opJobsBody) return;
    try {
      const res = await fetch('/api/jobs?limit=8');
      const data = await res.json();
      const jobs = data.jobs || [];
      if (jobs.length === 0) {
        opJobsBody.innerHTML = `<p class="empty-state">${getLanguage() === 'zh' ? '暂无任务' : 'No jobs yet'}</p>`;
        return;
      }
      opJobsBody.innerHTML = jobs.map(j => {
        const jobType = (j.job_type || '').replace(/-/g, ' ').toUpperCase();
        const status = (j.status || '').toLowerCase();
        const statusClass = status === 'completed' ? 'job-done' : status === 'failed' ? 'job-failed' : status === 'cancelled' ? 'job-cancelled' : status === 'running' ? 'job-running' : 'job-queued';
        const startedAt = j.started_at || j.created_at || '';
        const result = j.result ? formatJobResult(j) : '';
        const error = j.error || '';
        return `<div class="job-row">
          <span class="job-type">${escapeHtml(jobType)}</span>
          <span class="job-status ${statusClass}">${escapeHtml(j.status || '')}</span>
          <span class="job-time">${escapeHtml(startedAt)}</span>
          ${result ? `<span class="job-result">${result}</span>` : ''}
          ${error ? `<span class="job-error">${escapeHtml(error.slice(0, 80))}</span>` : ''}
        </div>`;
      }).join('');
    } catch (err) {
      opJobsBody.innerHTML = `<p class="empty-state">⚠ ${err.message}</p>`;
    }
  }

  document.querySelectorAll('[data-op]').forEach(btn => {
    btn.addEventListener('click', () => runOp(btn.dataset.op));
  });
  document.querySelectorAll('[data-op-stop]').forEach(btn => {
    btn.addEventListener('click', () => stopOp(btn.dataset.opStop));
  });

  // ── X Following config wiring ──
  const xConfigTextarea = $('xConfigTextarea');
  const xConfigResult = $('xConfigResult');
  const xBlocklistTextarea = $('xBlocklistTextarea');
  const xBlocklistResult = $('xBlocklistResult');
  async function loadXConfig() {
    try {
      const res = await fetch('/api/settings/x-following');
      const data = await res.json();
      const users = data?.config?.users?.length ? data.config.users : (data?.env_users || []);
      if (xConfigTextarea) xConfigTextarea.value = users.join('\n');
      if (xBlocklistTextarea && Array.isArray(data?.blocklist)) xBlocklistTextarea.value = data.blocklist.join('\n');
    } catch (err) {
      if (xConfigResult) xConfigResult.textContent = t('xconfig.load_error', { msg: err.message });
    }
  }
  $('xConfigSaveBtn')?.addEventListener('click', async () => {
    if (!xConfigTextarea) return;
    const users = xConfigTextarea.value.split(/[\n,]/).map(s => s.trim().replace(/^@/, '')).filter(Boolean);
    try {
      const res = await fetch('/api/settings/x-following', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ users }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'save failed');
      if (xConfigResult) xConfigResult.textContent = t('xconfig.saved', { n: data.saved });
    } catch (err) {
      if (xConfigResult) xConfigResult.textContent = '✗ ' + err.message;
    }
  });
  // ── X Following blocklist wiring ──
  $('xBlocklistSaveBtn')?.addEventListener('click', async () => {
    if (!xBlocklistTextarea) return;
    const blocked = xBlocklistTextarea.value.split(/[\n,]/).map(s => s.trim().replace(/^@/, '')).filter(Boolean);
    try {
      const res = await fetch('/api/settings/x-following', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocked_users: blocked }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'save failed');
      if (xBlocklistResult) xBlocklistResult.textContent = t('xconfig.blocklist_saved', { n: data.blocked_saved ?? 0 });
    } catch (err) {
      if (xBlocklistResult) xBlocklistResult.textContent = '✗ ' + err.message;
    }
  });
  $('xCleanupBtn')?.addEventListener('click', async () => {
    if (xBlocklistResult) xBlocklistResult.textContent = '⏳ ' + t('xconfig.cleanup_running');
    try {
      const res = await fetch('/api/settings/x-following/cleanup', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'cleanup failed');
      if (xBlocklistResult) xBlocklistResult.textContent = t('xconfig.cleanup_done', { n: data.purged ?? 0 });
    } catch (err) {
      if (xBlocklistResult) xBlocklistResult.textContent = '✗ ' + err.message;
    }
  });
  loadXConfig();

  refreshOpJobs();
  // Poll jobs panel every 5s
  setInterval(refreshOpJobs, 5000);
}

