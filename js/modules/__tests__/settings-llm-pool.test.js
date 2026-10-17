import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderLLMPoolPanel } from '../pages/settings-llm-pool.js';
import { renderSettings } from '../pages/settings.js';
import { refreshSchedulerPanel } from '../pages/settings-panels.js';
import { wireSettingsHandlers } from '../pages/settings-handlers.js';
import { router } from '../router.js';
import { setLanguage } from '../i18n.js';

const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
const configuration = () => ({
  schema_version: 1, enabled: true, global_concurrency: 5, queue_limit: 40, request_timeout_ms: 45000, queue_timeout_ms: 5000, max_attempts: 2,
  endpoints: Array.from({ length: 5 }, (_, i) => ({ id: `lane-${i + 1}`, label: `Lane ${i + 1}`, protocol: 'anthropic', endpoint_url: `http://127.0.0.1:1234/v1/messages-${i + 1}`, model: i === 1 ? 'gemini-fixture' : `model-${i + 1}`, api_key: '••••', enabled: true, concurrency: 1, tasks: ['enrich', 'research'] })),
});
let config;
let handle;
let root;

beforeEach(() => {
  setLanguage('en');
  window.__currentUser = () => ({ role: 'admin' });
  document.body.innerHTML = '<main id="pageContent"><div id="pool"></div></main>';
  root = document.querySelector('#pool');
  config = configuration();
  handle = async (url, options = {}) => {
    if (url === '/api/settings/llm/pool/parse') return response({ status: 'ok', config });
    if (url === '/api/settings/llm/pool/test') return response({ ok: true, endpoint_id: JSON.parse(options.body).endpoint_id, latency_ms: 42 });
    if (url === '/api/settings/llm/pool') {
      if (options.method === 'PUT') config = JSON.parse(options.body).config || config;
      return response({ status: 'ok', config, runtime: { scope: 'process', active: 1, queued: 2, endpoints: [{ id: 'lane-1', active: 1, queued: 0, state: 'ready', last_success_at: '2026-09-09T00:00:00Z', last_latency_ms: 42 }] }, metrics: { scope: 'persisted', available: true, total: 4, completed: 3, failed: 1, cancelled: 0, by_endpoint: [{ endpoint_id: 'lane-1', total: 4, completed: 3, failed: 1, avg_latency_ms: 45 }] } });
    }
    if (url === '/api/settings/llm') return response({ config: { provider: 'openai', model: 'legacy', api_key: 'masked' } });
    if (url === '/api/scheduler') return response({ config: { timezone: 'Asia/Shanghai', time: '04:00', next_due: '2026-09-10T20:00:00Z', last_job_id: 'job-1', last_outcome: 'queued', last_job_status: 'completed' } });
    if (url === '/api/system/stats') return response({ stats: {} });
    if (url.startsWith('/api/jobs')) return response({ jobs: [] });
    return response({ users: [], keys: [] });
  };
  vi.stubGlobal('fetch', vi.fn((...args) => handle(...args)));
});

afterEach(() => {
  router._runCleanups();
  delete window.__currentUser;
  delete window.__logout;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function preview(text = 'Endpoint fixture block with local-only-test-key') {
  document.querySelector('#llmPoolPaste').value = text;
  document.querySelector('#llmPoolParse').click();
  await vi.waitFor(() => expect(document.querySelector('#llmPoolActivate').disabled).toBe(false));
}

describe('LLM pool settings DOM', () => {
  it('previews five full paths and independent protocols/models without showing key material', async () => {
    config.endpoints[0].api_key = 'a-fixture-secret-that-must-not-render';
    await renderLLMPoolPanel(root);
    await preview();
    const output = document.querySelector('#llmPoolPreview');
    expect(output.textContent).toContain('Parsed endpoints: 5');
    for (let n = 1; n <= 5; n++) expect(output.textContent).toContain(`/v1/messages-${n}`);
    expect(output.textContent).toContain('gemini-fixture');
    expect(output.textContent).toContain('anthropic');
    expect(document.body.textContent).not.toContain('a-fixture-secret-that-must-not-render');
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/test'))).toHaveLength(0);
  });

  it('saves the original parsed block, clears input, then refreshes masked settings', async () => {
    await renderLLMPoolPanel(root);
    const pasted = 'Fixture complete endpoint block';
    await preview(pasted);
    document.querySelector('#llmPoolActivate').click();
    await vi.waitFor(() => expect(document.querySelector('#llmPoolFeedback').textContent).toContain('Pool saved and enabled'));
    const call = fetch.mock.calls.find(([url, options]) => url === '/api/settings/llm/pool' && options.method === 'PUT');
    expect(JSON.parse(call[1].body)).toEqual({ pasted, enabled: true });
    expect(document.querySelector('#llmPoolPaste').value).toBe('');
    expect(document.querySelector('#llmPoolPreview').hidden).toBe(true);
    expect(fetch.mock.calls.filter(([url, options]) => url === '/api/settings/llm/pool' && options.method === 'GET')).toHaveLength(2);
  });

  it('invalidates preview when pasted content changes', async () => {
    await renderLLMPoolPanel(root);
    await preview();
    document.querySelector('#llmPoolPaste').value = 'different block';
    document.querySelector('#llmPoolPaste').dispatchEvent(new Event('input'));
    expect(document.querySelector('#llmPoolActivate').disabled).toBe(true);
    expect(document.querySelector('#llmPoolPreview').hidden).toBe(true);
  });

  it('edits enablement, concurrency and tasks while preserving endpoint IDs and omitting masked credentials', async () => {
    await renderLLMPoolPanel(root);
    document.querySelector('#llmPoolConcurrency').value = '3';
    const row = document.querySelector('[data-pool-index="0"]');
    row.querySelector('[data-field="enabled"]').checked = false;
    row.querySelector('[data-field="concurrency"]').value = '2';
    row.querySelector('[data-task="graph"]').checked = true;
    document.querySelector('#llmPoolSaveConfig').click();
    await vi.waitFor(() => expect(document.querySelector('#llmPoolFeedback').textContent).toContain('Settings saved and reloaded'));
    const sent = JSON.parse(fetch.mock.calls.find(([, options]) => options.method === 'PUT')[1].body).config;
    expect(sent.global_concurrency).toBe(3);
    expect(sent.queue_limit).toBe(40);
    expect(sent.endpoints[0]).toMatchObject({ id: 'lane-1', enabled: false, concurrency: 2, tasks: ['enrich', 'research', 'graph'] });
    expect(sent.endpoints[0]).not.toHaveProperty('api_key');
    expect(sent.endpoints[1].endpoint_url).toBe('http://127.0.0.1:1234/v1/messages-2');
  });

  it('provides per-endpoint stacked field labels and all controls for the narrow-screen layout', async () => {
    await renderLLMPoolPanel(root);
    expect(root.classList.contains('llm-pool')).toBe(true);
    expect(root.querySelector('.llm-pool-table')).not.toBeNull();
    const rows = [...root.querySelectorAll('[data-pool-index]')];
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect([...row.querySelectorAll('.llm-pool-cell-label')].map(label => label.textContent)).toEqual(['Enabled', 'Endpoint / protocol / URL / model', 'Concurrency', 'Tasks', 'State and probe']);
      expect(row.querySelector('.llm-pool-toggle [data-field="enabled"]')).not.toBeNull();
      expect(row.querySelector('.llm-pool-concurrency [data-field="concurrency"]')).not.toBeNull();
      expect(row.querySelectorAll('.llm-pool-task-options [data-task]')).toHaveLength(7);
      expect(row.querySelector('.llm-pool-state [data-probe]')).not.toBeNull();
      expect(row.querySelector('.llm-pool-state-metrics')).not.toBeNull();
    }
  });

  it('probes only saved endpoint IDs and distinguishes protocol success and failure', async () => {
    await renderLLMPoolPanel(root);
    document.querySelector('[data-probe="lane-2"]').click();
    await vi.waitFor(() => expect(root.textContent).toContain('Protocol probe passed (business quality unverified)'));
    const probe = fetch.mock.calls.find(([url]) => url.endsWith('/test'));
    expect(JSON.parse(probe[1].body)).toEqual({ endpoint_id: 'lane-2' });
    const prior = handle;
    handle = (url, options) => url.endsWith('/test') ? response({ ok: false, error_code: 'TIMEOUT', message: 'secret-should-not-echo', latency_ms: 5000 }) : prior(url, options);
    document.querySelector('[data-probe="lane-1"]').click();
    await vi.waitFor(() => expect(root.textContent).toContain('Probe failed · TIMEOUT'));
    expect(root.textContent).not.toContain('secret-should-not-echo');
    expect(root.textContent).toContain('Sample mean latency');
    expect(root.textContent).toContain('Recorded request attempts');
    expect(root.textContent).toContain('including each retry separately');
    expect(root.textContent).toContain('2026-09-09T00:00:00Z');
  });

  it('keeps failed saves visibly failed without leaking server payload', async () => {
    await renderLLMPoolPanel(root);
    await preview();
    const prior = handle;
    handle = (url, options) => options.method === 'PUT' ? response({ error: 'secret-should-not-echo' }, 400) : prior(url, options);
    document.querySelector('#llmPoolActivate').click();
    await vi.waitFor(() => expect(document.querySelector('#llmPoolFeedback').textContent).toContain('HTTP 400 · Configuration was not saved.'));
    expect(document.querySelector('#llmPoolFeedback').textContent).toContain('concurrency and queue limits');
    expect(document.querySelector('#llmPoolActivate').disabled).toBe(false);
    expect(root.textContent).not.toContain('secret-should-not-echo');
  });

  it.each(['en', 'zh'])('gives safe local guidance for parse failures and administrator access in %s', async language => {
    setLanguage(language);
    await renderLLMPoolPanel(root);
    const prior = handle;
    let status = 400;
    handle = (url, options) => url.endsWith('/parse') ? response({ error: 'private-fixture-key-in-server-error', error_code: 'private-fixture-code' }, status) : prior(url, options);
    document.querySelector('#llmPoolPaste').value = 'invalid block';
    document.querySelector('#llmPoolParse').click();
    await vi.waitFor(() => expect(document.querySelector('#llmPoolFeedback').textContent).toContain('HTTP 400'));
    expect(document.querySelector('#llmPoolFeedback').textContent).toContain(language === 'zh' ? '完整 Messages/Chat URL、模型及密钥' : 'complete Messages/Chat URL, model and API key');
    expect(document.querySelector('#llmPoolActivate').disabled).toBe(true);
    expect(root.textContent).not.toContain('private-fixture');
    status = 403;
    document.querySelector('#llmPoolParse').click();
    await vi.waitFor(() => expect(document.querySelector('#llmPoolFeedback').textContent).toContain('HTTP 403'));
    expect(document.querySelector('#llmPoolFeedback').textContent).toContain(language === 'zh' ? '仅限管理员' : 'requires an administrator');
    expect(root.textContent).not.toContain('private-fixture');
  });

  it('hides administrator controls and makes no settings requests for normal users', async () => {
    window.__currentUser = () => ({ role: 'user' });
    await renderSettings({});
    expect(document.querySelector('#llmPoolPanel')).toBeNull();
    expect(document.querySelector('#llmPaste')).toBeNull();
    expect(document.querySelector('[data-op]')).toBeNull();
    expect(document.querySelector('#schedulerPanel')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(document.querySelector('#settingsSignOut').textContent).toBe('Sign out');
    expect(document.querySelector('.page-description').textContent).toContain('Account settings and system access');
  });

  it('disables sign out while pending, calls the existing logout action and safely recovers from failure', async () => {
    window.__currentUser = () => ({ role: 'user' });
    let fail;
    window.__logout = vi.fn(() => new Promise((_, reject) => { fail = reject; }));
    await renderSettings({});
    const button = document.querySelector('#settingsSignOut');
    button.click();
    expect(button.disabled).toBe(true);
    button.click();
    expect(window.__logout).toHaveBeenCalledTimes(1);
    fail(new Error('private-server-error'));
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(document.querySelector('#settingsSignOutError').textContent).toBe('Sign out could not be completed. Please try again.');
    expect(document.body.textContent).not.toContain('private-server-error');
    window.__logout.mockResolvedValueOnce(undefined);
    button.click();
    await vi.waitFor(() => expect(window.__logout).toHaveBeenCalledTimes(2));
    expect(button.disabled).toBe(true);
    expect(document.querySelector('#settingsSignOutError').textContent).toBe('');
  });

  it('renders administrator controls without stale automatic-enrichment instructions', async () => {
    await renderSettings({});
    expect(document.querySelector('#llmPoolPanel')).not.toBeNull();
    expect(document.querySelector('#enrichBatch').value).toBe('20');
    expect(document.body.textContent).not.toContain('3001');
    expect(document.body.textContent).not.toContain('start to enrich');
    expect(document.querySelector('[data-op-row="enrich"] .op-desc').textContent).toContain('within the batch limit below');
    expect(document.body.textContent).not.toContain('1600');
    expect(document.body.textContent).not.toContain('10 parallel workers');
    expect(document.querySelector('#llmStatusBadge').classList.contains('ok')).toBe(false);
    expect(document.querySelector('#llmStatusBadge').textContent).toContain('health unverified');
    router._runCleanups();
    setLanguage('zh');
    await renderSettings({});
    expect(document.querySelector('[data-op-row="enrich"] .op-desc').textContent).toContain('端点池全局上限');
    expect(document.body.textContent).not.toContain('1600');
    expect(document.body.textContent).not.toContain('10 个并发 worker');
  });
});

describe('scheduler and bounded enrichment controls', () => {
  it('shows server timezone and job outcomes, and never claims a failed HTTP save succeeded', async () => {
    document.body.innerHTML = '<div id="schedulerPanel"></div>';
    await refreshSchedulerPanel();
    expect(document.querySelector('#schedulerPanel').textContent).toContain('Asia/Shanghai');
    expect(document.querySelector('#schedulerPanel').textContent).toContain('job-1');
    expect(document.querySelector('#schedulerPanel').textContent).toContain('completed');
    const prior = handle;
    handle = (url, options) => options.method === 'PUT' ? response({ error: 'denied' }, 403) : prior(url, options);
    document.querySelector('#schedSave').click();
    await vi.waitFor(() => expect(document.querySelector('#schedResult').textContent).toBe('Save failed: HTTP 403'));
    expect(document.querySelector('#schedSave').textContent).not.toContain('✓');
    const body = JSON.parse(fetch.mock.calls.find(([, options]) => options?.method === 'PUT')[1].body);
    expect(body).not.toHaveProperty('timezone');
  });

  it('submits the bounded batch with explicit exhausted-item retry via the safe enrich route', async () => {
    document.body.innerHTML = '<input id="enrichBatch" value="7"><input id="enrichRetryExhausted" type="checkbox" checked><button data-op="enrich">Enrich</button><div data-op-stream="enrich"></div>';
    wireSettingsHandlers();
    document.querySelector('[data-op="enrich"]').click();
    await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/enrich?batch=7&background=true&reset_attempts=true')).toBe(true));
    expect(fetch.mock.calls.some(([url]) => url.includes('reenrich'))).toBe(false);
  });
});
