import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wireSettingsHandlers } from '../pages/settings-handlers.js';

vi.mock('../router.js', () => ({ router: { onCleanup: vi.fn() } }));
vi.mock('../i18n.js', () => ({ getLanguage: () => 'en', t: key => key }));
vi.mock('../pages/settings-panels.js', () => ({ SAMPLE_PASTE: '', refreshLLMStatus: vi.fn() }));

describe('settings pipeline results', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.__currentUser = () => ({ role: 'admin' });
    document.body.innerHTML = '<div id="opJobsBody"></div>';
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete window.__currentUser;
    document.body.innerHTML = '';
  });

  async function renderStage({ status = 'completed', detail = {} } = {}) {
    const job = {
      job_type: 'full-pipeline', status,
      result: JSON.stringify({
        pipeline: true, current_stage: 'kg_worker', stages: [{
          key: 'kg_worker', label: 'KG worker', status, detail,
          result: { extract: { total: 200 }, embed: { vectors: 500 }, topics: { dynamic_topics: 30 } },
        }],
      }),
    };
    vi.stubGlobal('fetch', vi.fn(async url => {
      if (url === '/api/jobs?limit=8') return { json: async () => ({ jobs: [job] }) };
      if (url === '/api/settings/x-following') return { json: async () => ({}) };
      throw new Error(`Unexpected request: ${url}`);
    }));
    wireSettingsHandlers();
    await vi.advanceTimersByTimeAsync(0);
    return document.getElementById('opJobsBody');
  }

  it('renders real KG output field names through the wired jobs panel', async () => {
    const panel = await renderStage();
    expect(panel.textContent).toContain('extract 200 · embed 500 · topics 30');
  });

  it('shows the fallback reason alongside retained output counts', async () => {
    const panel = await renderStage({ status: 'failed', detail: { error: 'Requested backend degraded: FastEmbed unavailable' } });
    expect(panel.querySelector('.job-status').textContent).toBe('failed');
    expect(panel.textContent).toContain('Requested backend degraded: FastEmbed unavailable');
    expect(panel.textContent).toContain('extract 200 · embed 500 · topics 30');
  });
});
