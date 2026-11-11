/**
 * Eagleye — Settings event wiring
 *
 * wireSettingsHandlers binds every control on the settings page. Split from the
 * page shell purely for size; behaviour is unchanged.
 */

import { escapeAttr, escapeHtml } from '../utils.js';
import { getLanguage, t } from '../i18n.js';
import { st } from '../i18n/settings-extra.js';
import { SAMPLE_PASTE, refreshLLMStatus } from './settings-panels.js';
import { router } from '../router.js';

let _lastParsedConfig = null;

export function wireSettingsHandlers() {
  if (window.__currentUser?.()?.role !== 'admin') return;
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
      const emptyPaste = `<div class="settings-warn">${st('settingsExtra.paste_first')}</div>`;
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
        pv.innerHTML = `<div class="settings-warn">${t('settings.parse_failed', { msg: escapeHtml(data.error || st('settingsExtra.parse_failed')) })}</div>`;
        return;
      }
      _lastParsedConfig = data;
      saveBtn.disabled = false;
      pv.hidden = false;
      const parsedLabel = st('settingsExtra.parsed_review', { action: escapeHtml(t('settings.save_activate')) });
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
      pv.innerHTML = `<div class="settings-warn">${escapeHtml(err.message)}</div>`;
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
      if (!res.ok || data.error) throw new Error(data.error || st('settingsExtra.save_failed'));
      const savedMsg = st('settingsExtra.single_saved');
      out.textContent = savedMsg;
      $('llmPaste').value = '';
      _lastParsedConfig = null;
      $('llmSaveBtn').disabled = true;
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
      if (!res.ok || data.error) throw new Error(data.error || st('settingsExtra.save_failed'));
      const savedMsg = st('settingsExtra.single_saved');
      out.textContent = savedMsg;
      $('llmApiKey').value = '';
      await refreshLLMStatus();
    } catch (err) {
      out.textContent = '⚠ ' + err.message;
    }
  });

  $('llmTestBtn')?.addEventListener('click', async () => {
    const out = $('llmTestResult');
    out.textContent = st('settingsExtra.testing');
    try {
      const res = await fetch('/api/settings/llm/test', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.ok) {
        out.textContent = `✓ ${st('settingsExtra.endpoint_responded')} · ${data.latent_ms || data.latency_ms} ms`;
      } else {
        out.textContent = '⚠ ' + (data.message || st('settingsExtra.test_failed'));
      }
    } catch (err) {
      out.textContent = '⚠ ' + err.message;
    }
  });

  $('llmResetBtn')?.addEventListener('click', async () => {
    const confirmMsg = st('settingsExtra.reset_confirm');
    if (!confirm(confirmMsg)) return;
    const out = $('llmTestResult');
    out.textContent = st('settingsExtra.resetting');
    try {
      const res = await fetch('/api/settings/llm', { method: 'DELETE' });
      if (!res.ok) throw new Error(st('settingsExtra.reset_failed'));
      const okMsg = st('settingsExtra.reset_done');
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
      const suffix = r.error ? st('settingsExtra.error_line', { msg: escapeHtml(r.error) }) : st('settingsExtra.items_count', { count: r.items || 0 });
      return st('settingsExtra.source_result', { source: escapeHtml(r.source || st('settingsExtra.unknown_source')), count: suffix });
    }).join('<br>');
  }

  function summarizeStagePayload(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const parts = [];
    if (payload.phase === 'fetching') {
      parts.push(st('settingsExtra.source_progress', { completed: payload.completed_sources ?? payload.current_index ?? 0, total: payload.total_sources || '?' }));
      if (payload.current_source) parts.push(escapeHtml(payload.current_source));
      const items = (payload.results || []).reduce((sum, r) => sum + (Number(r.items) || 0), 0);
      parts.push(st('settingsExtra.items_count', { count: items }));
      if (payload.heartbeat !== undefined) parts.push(st('settingsExtra.tick', { count: payload.heartbeat }));
    } else if (payload.phase === 'enriching' || payload.phase === 'scoring') {
      parts.push(st('settingsExtra.processed_progress', { completed: payload.processed || 0, total: payload.total || 0 }));
      parts.push(st('settingsExtra.enriched_count', { count: payload.enriched || 0 }));
      parts.push(st('settingsExtra.failed_count', { count: payload.failed || 0 }));
      if (payload.entities !== undefined) parts.push(st('settingsExtra.entities_count', { count: payload.entities }));
      if (payload.topics !== undefined) parts.push(st('settingsExtra.topics_count', { count: payload.topics }));
    } else if (payload.phase === 'translating') {
      parts.push(st('settingsExtra.processed_progress', { completed: payload.processed || 0, total: payload.total || 0 }));
      parts.push(st('settingsExtra.translated_count', { count: payload.translated || 0 }));
      parts.push(st('settingsExtra.failed_count', { count: payload.failed || 0 }));
      parts.push(st('settingsExtra.remaining_count', { count: payload.remaining ?? '—' }));
    } else if (Array.isArray(payload.fetch)) {
      const items = payload.fetch.reduce((sum, r) => sum + (Number(r.items) || 0), 0);
      parts.push(st('settingsExtra.sources_count', { count: payload.fetch.length }));
      parts.push(st('settingsExtra.items_count', { count: items }));
    } else {
      if (payload.message) parts.push(escapeHtml(payload.message));
      if (payload.error) parts.push(st('settingsExtra.error_line', { msg: escapeHtml(payload.error) }));
      if (payload.date) parts.push(st('settingsExtra.date_line', { value: escapeHtml(payload.date) }));
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
      return `<span class="job-mini-result-list">${sorted.map(r => `<span class="source-line ${(r.items||0)>0?'has-items':''}">${st('settingsExtra.source_result', { source: escapeHtml(r.source || st('settingsExtra.unknown_source')), count: r.error ? st('settingsExtra.error_line', { msg: escapeHtml(r.error) }) : st('settingsExtra.items_count', { count: r.items || 0 }) })}</span>`).join('<br>')}</span>`;
    }
    if (result.enriched !== undefined) return st('settingsExtra.enriched_result', { count: result.enriched, total: result.total || 0, failed: result.failed || 0 });
    if (result.translated !== undefined) return st('settingsExtra.translated_result', { count: result.translated, total: result.total || 0, failed: result.failed || 0, remaining: result.remaining ?? '—' });
    if (result.nodes !== undefined || result.edges !== undefined) return st('settingsExtra.nodes_edges', { nodes: result.nodes || 0, edges: result.edges || 0 });
    if (result.domains !== undefined) return st('settingsExtra.graph_summary', { domains: result.domains, topics: result.topics || 0, tags: result.uniqueTags || result.tags || 0 });
    if (result.extract || result.embed || result.topics) {
      return st('settingsExtra.extraction_summary', { extract: result.extract?.total || 0, embed: result.embed?.vectors || 0, topics: result.topics?.dynamic_topics || 0 });
    }
    if (result.generated !== undefined) return result.generated ? st('settingsExtra.generated') : st('settingsExtra.no_summary');
    if (result.edges_updated !== undefined) return st('settingsExtra.edges_scores', { edges: result.edges_updated, scores: result.scores_updated });
    if (result.sources !== undefined) return `${result.sources}`;
    return escapeHtml(JSON.stringify(result).slice(0, 120));
  }

  function formatPipelineProgress(parsed) {
    const stages = Array.isArray(parsed.stages) ? parsed.stages : [];
    if (stages.length === 0) return escapeHtml(JSON.stringify(parsed).slice(0, 500));
    const current = parsed.current_stage || '';
    const rows = stages.map(stage => {
      const status = stage.status || 'pending';
      const detail = [summarizeStagePayload(stage.detail), summarizeStageResult(stage.result)].filter(Boolean).join('<br>');
      const label = getLanguage() === 'zh' ? (stage.label_zh || stage.label || stage.key) : (stage.label || stage.key);
      const elapsed = stage.started_at && status === 'running'
        ? `${Math.max(0, Math.round((Date.now() - new Date(stage.started_at).getTime()) / 1000))}s`
        : '';
      const statusLabels = {
        pending: st('settingsExtra.status_pending'),
        running: st('settingsExtra.status_running'),
        completed: st('settingsExtra.status_completed'),
        failed: st('settingsExtra.status_failed'),
        cancelled: st('settingsExtra.status_cancelled'),
        queued: st('settingsExtra.status_queued'),
      };
      const statusText = elapsed ? `${statusLabels[status] || status} · ${elapsed}` : (statusLabels[status] || status);
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
        st('settingsExtra.translating_progress', { completed: parsed.processed || 0, total: parsed.total || 0 }),
        st('settingsExtra.translated_failed', { translated: parsed.translated || 0, failed: parsed.failed || 0 }),
        st('settingsExtra.remaining_line', { remaining: parsed.remaining ?? '—' }),
      ];
      if (parsed.batch_items || parsed.workers) {
        lines.push(st('settingsExtra.batch_workers', { batch: parsed.batch_items || '—', workers: parsed.workers || '—' }));
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
        parts.push(st('settingsExtra.fetching_source', { source: escapeHtml(parsed.current_source || ''), completed: parsed.current_index || doneSources, total: totalSources || '?' }));
      } else if (parsed.phase === 'enriching') {
        parts.push(st('settingsExtra.fetch_complete_enriching', { sources: doneSources, total_sources: totalSources || doneSources, items: totalItems }));
      } else {
        parts.push(st('settingsExtra.sources_items', { sources: doneSources, total_sources: totalSources || doneSources, items: totalItems }));
      }
      const details = formatSourceResults(fetchResults);
      if (details) parts.push(`<span class="job-mini-result-list">${details}</span>`);
      if (parsed.enrich) {
        parts.push(st('settingsExtra.enriched_line', { count: parsed.enrich.enriched || 0, total: parsed.enrich.total || 0 }));
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
          showStream(op, `${t('ops.stream_failed', { elapsed })}<br><span class="job-mini-error">${escapeHtml(job.error || '—')}</span><br><span class="job-mini-result">${result}</span>`, true);
          setOpRunning(op, false);
          opJobMap[op] = null;
          refreshOpJobs();
          return true;
        }
        // still queued
        showStream(op, `⏳ ${st('settingsExtra.queued', { job_id: shortJobId(jobId) })}`);
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
        const batch = Number($('enrichBatch')?.value);
        if (!Number.isInteger(batch) || batch < 1 || batch > 100) throw new Error(st('settingsExtra.batch_validation'));
        const query = new URLSearchParams({ batch: String(batch), background: 'true' });
        if ($('enrichRetryExhausted')?.checked) query.set('reset_attempts', 'true');
        res = await fetch(`/api/enrich?${query}`, { method: 'POST' });
      } else if (op === 'digest') {
        res = await fetch('/api/digest/build?background=true', { method: 'POST' });
      } else if (op === 'pipeline') {
        res = await fetch('/api/pipeline', { method: 'POST' });
      } else {
        throw new Error(st('settingsExtra.unknown_op'));
      }
      if (!res) throw new Error(st('settingsExtra.no_response'));
      const data = await readJSONOnce(res);
      if (!res.ok) throw new Error(data.message || data.error || st('settingsExtra.op_launch_failed', { op }));
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
        opJobsBody.innerHTML = `<p class="empty-state">${st('settingsExtra.no_jobs')}</p>`;
        return;
      }
      opJobsBody.innerHTML = jobs.map(j => {
        const jobType = (j.job_type || '').replace(/-/g, ' ').toUpperCase();
        const status = (j.status || '').toLowerCase();
        const statusLabels = {
          pending: st('settingsExtra.status_pending'),
          running: st('settingsExtra.status_running'),
          completed: st('settingsExtra.status_completed'),
          failed: st('settingsExtra.status_failed'),
          cancelled: st('settingsExtra.status_cancelled'),
          queued: st('settingsExtra.status_queued'),
        };
        const statusClass = status === 'completed' ? 'job-done' : status === 'failed' ? 'job-failed' : status === 'cancelled' ? 'job-cancelled' : status === 'running' ? 'job-running' : 'job-queued';
        const startedAt = j.started_at || j.created_at || '';
        const result = j.result ? formatJobResult(j) : '';
        const error = j.error || '';
        return `<div class="job-row">
          <span class="job-type">${escapeHtml(jobType)}</span>
          <span class="job-status ${statusClass}">${escapeHtml(statusLabels[status] || j.status || '')}</span>
          <span class="job-time">${escapeHtml(startedAt)}</span>
          ${result ? `<span class="job-result">${result}</span>` : ''}
          ${error ? `<span class="job-error">${escapeHtml(error.slice(0, 80))}</span>` : ''}
        </div>`;
      }).join('');
    } catch (err) {
      opJobsBody.innerHTML = `<p class="empty-state">${err.message}</p>`;
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
      if (!res.ok) throw new Error(data.message || st('settingsExtra.save_failed'));
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
      if (!res.ok) throw new Error(data.message || st('settingsExtra.save_failed'));
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
      if (!res.ok) throw new Error(data.message || st('settingsExtra.cleanup_failed'));
      if (xBlocklistResult) xBlocklistResult.textContent = t('xconfig.cleanup_done', { n: data.purged ?? 0 });
    } catch (err) {
      if (xBlocklistResult) xBlocklistResult.textContent = '✗ ' + err.message;
    }
  });
  loadXConfig();

  refreshOpJobs();
  // Poll jobs panel every 5s. Registered for teardown: wireSettingsHandlers runs
  // on every render of the settings page, so without this each visit left
  // another live poller behind.
  const opJobsTimer = setInterval(refreshOpJobs, 5000);
  router.onCleanup(() => clearInterval(opJobsTimer));
}
