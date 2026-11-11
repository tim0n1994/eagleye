/**
 * Eagleye — settings page module
 *
 * Settings page: LLM provider, scheduler, user management and system health.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr } from '../utils.js';
import { t } from '../i18n.js';
import { st } from '../i18n/settings-extra.js';


// ─── Settings (LLM endpoint + runtime config) ───────────────────────

import { SAMPLE_PASTE, refreshApiKeys, refreshLLMStatus, refreshMcpServerPanel, refreshSchedulerPanel, refreshSystemHealth, refreshUserManagement } from './settings-panels.js';
import { wireSettingsHandlers } from './settings-handlers.js';
import { renderLLMPoolPanel } from './settings-llm-pool.js';

export async function renderSettings(_params) {
  const container = $('#pageContent');
  const currentUser = window.__currentUser?.();
  const isAdmin = currentUser?.role === 'admin';
  const sampleText = SAMPLE_PASTE;
  const directSubtitle = st('settingsExtra.direct_subtitle');
  const pasteSubtitle = st('settingsExtra.paste_subtitle');
  const providerSelect = `<option value="openai">${st('settingsExtra.provider_openai')}</option><option value="gemini">gemini</option><option value="claude">claude</option>`;
  const step1 = st('settingsExtra.step_test_before');
  const step1b = st('settingsExtra.step_test_after');
  const step2 = st('settingsExtra.step_batch');
  const step3 = st('settingsExtra.step_check_jobs');
  const step4 = st('settingsExtra.step_schedule');

  container.innerHTML = `
    <section class="page-section">
      <div class="page-header">
        <h2 class="page-title">${t('settings.title')}</h2>
        <p class="page-description">${isAdmin ? t('settings.subtitle') : st('settingsExtra.subtitle_non_admin')}</p>
        ${currentUser ? `<button class="action-btn" id="settingsSignOut" type="button">${st('settingsExtra.sign_out')}</button><p id="settingsSignOutError" class="subtle" role="status" aria-live="polite"></p>` : ''}
      </div>

      ${isAdmin ? `<div class="settings-card settings-card-wide" id="llmPoolPanel"></div>
      <div class="settings-grid">
        <div class="settings-card">
        <div class="settings-card" id="mcpServerPanel"></div>
          <div class="settings-card-header">
            <span class="settings-card-title">${st('settingsExtra.single_endpoint_title')}</span>
            <span class="settings-card-badge" id="llmStatusBadge">…</span>
          </div>
          <div class="settings-card-body" id="llmCurrent">
            <div class="empty-state">${st('settingsExtra.loading')}</div>
          </div>
          <div class="settings-card-actions">
            <button class="action-btn" id="llmTestBtn">${t('settings.test')}</button>
            <button class="action-btn" id="llmResetBtn">${t('settings.reset')}</button>
            <span class="action-link" id="llmTestResult"></span>
          </div>
        </div>

        <div class="settings-card">
          <div class="settings-card-header">
            <span class="settings-card-title">${t('settings.paste')}</span>
            <span class="settings-card-sub">${pasteSubtitle}</span>
          </div>
          <div class="settings-card-body">
            <textarea id="llmPaste" class="settings-paste" rows="14" spellcheck="false" placeholder="${escapeAttr(sampleText)}"></textarea>
            <div class="settings-preview" id="llmPreview" hidden></div>
          </div>
          <div class="settings-card-actions">
            <button class="action-btn primary" id="llmParseBtn">${t('settings.parse')}</button>
            <button class="action-btn primary" id="llmSaveBtn" disabled>${t('settings.save_activate')}</button>
            <button class="action-btn" id="llmLoadSampleBtn">${t('settings.load_sample')}</button>
            <button class="action-btn" id="llmClearBtn">${st('settingsExtra.clear')}</button>
            <span class="action-link" id="llmSaveResult"></span>
          </div>
        </div>

        <div class="settings-card">
          <div class="settings-card-header">
            <span class="settings-card-title">${t('settings.direct')}</span>
            <span class="settings-card-sub">${directSubtitle}</span>
          </div>
          <div class="settings-card-body">
            <div class="form-row">
              <label for="llmProvider">${t('settings.fields_provider')}</label>
              <select id="llmProvider" class="form-input">
                ${providerSelect}
              </select>
            </div>
            <div class="form-row">
              <label for="llmBaseUrl">${t('settings.fields_base_url')}</label>
              <input id="llmBaseUrl" class="form-input" type="text" placeholder="http://127.0.0.1:3458/v1">
            </div>
            <div class="form-row">
              <label for="llmApiKey">${t('settings.fields_api_key')}</label>
              <input id="llmApiKey" class="form-input" type="password" placeholder="${escapeAttr(st('settingsExtra.api_key_placeholder'))}">
            </div>
            <div class="form-row">
              <label for="llmModel">${t('settings.fields_model')}</label>
              <input id="llmModel" class="form-input" type="text" placeholder="qwq-plus">
            </div>
          </div>
          <div class="settings-card-actions">
            <button class="action-btn primary" id="llmSaveFieldsBtn">${t('settings.save_fields')}</button>
            <span class="action-link" id="llmFieldsResult"></span>
          </div>
        </div>

        <div class="settings-card">
          <div class="settings-card-header">
            <span class="settings-card-title">${t('settings.after')}</span>
          </div>
          <div class="settings-card-body">
            <ol class="settings-steps">
              <li>${step1} <code>${t('settings.test')}</code> ${step1b}</li>
              <li>${step2}</li>
              <li>${step3}</li>
              <li>${step4}</li>
            </ol>
          </div>
        </div>

        <div class="settings-card settings-card-wide">
          <div class="settings-card-header">
            <span class="settings-card-title">${t('ops.title')}</span>
            <span class="settings-card-sub">${t('ops.subtitle')}</span>
          </div>
          <div class="settings-card-body">
            <div class="ops-grid">
              <div class="op-row" data-op-row="sync">
                <div class="op-info">
                  <div class="op-name"><span class="op-name-zh">抓取所有信息源</span><span class="op-name-sep">·</span><span class="op-name-en">SYNC ALL SOURCES</span></div>
                  <div class="op-desc">${t('ops.sync_desc')}</div>
                  <div class="op-stream" data-op-stream="sync" hidden></div>
                </div>
                <div class="op-actions">
                  <button class="action-btn primary" data-op="sync">${t('ops.sync')}</button>
                  <button class="action-btn danger op-stop" data-op-stop="sync" hidden>${t('ops.stop')}</button>
                </div>
              </div>
              <div class="op-row" data-op-row="enrich">
                <div class="op-info">
                  <div class="op-name"><span class="op-name-zh">AI 摘要批量</span><span class="op-name-sep">·</span><span class="op-name-en">ENRICH ITEMS</span></div>
                  <div class="op-desc">${st('settingsExtra.enrich_description')}</div>
                  <div class="op-stream" data-op-stream="enrich" hidden></div>
                </div>
                <div class="op-actions">
                  <label for="enrichBatch">${st('settingsExtra.batch_limit')}</label>
                  <input class="form-input" id="enrichBatch" type="number" min="1" max="100" step="1" value="20" style="width:85px">
                  <label><input type="checkbox" id="enrichRetryExhausted">${st('settingsExtra.retry_exhausted')}</label>
                  <button class="action-btn primary" data-op="enrich">${t('ops.enrich')}</button>
                  <button class="action-btn danger op-stop" data-op-stop="enrich" hidden>${t('ops.stop')}</button>
                </div>
              </div>
              <div class="op-row" data-op-row="digest">
                <div class="op-info">
                  <div class="op-name"><span class="op-name-zh">生成每日简报</span><span class="op-name-sep">·</span><span class="op-name-en">BUILD DIGEST</span></div>
                  <div class="op-desc">${t('ops.digest_desc')}</div>
                  <div class="op-stream" data-op-stream="digest" hidden></div>
                </div>
                <div class="op-actions">
                  <button class="action-btn primary" data-op="digest">${t('ops.digest')}</button>
                  <button class="action-btn danger op-stop" data-op-stop="digest" hidden>${t('ops.stop')}</button>
                </div>
              </div>
              <div class="op-row" data-op-row="pipeline">
                <div class="op-info">
                  <div class="op-name"><span class="op-name-zh">完整流水线</span><span class="op-name-sep">·</span><span class="op-name-en">FULL PIPELINE</span></div>
                  <div class="op-desc">${t('ops.pipeline_desc')}</div>
                  <div class="op-stream" data-op-stream="pipeline" hidden></div>
                </div>
                <div class="op-actions">
                  <button class="action-btn primary" data-op="pipeline">${t('ops.pipeline')}</button>
                  <button class="action-btn danger op-stop" data-op-stop="pipeline" hidden>${t('ops.stop')}</button>
                </div>
              </div>
            </div>
            <div class="xconfig-card">
              <div class="xconfig-header">
                <div class="xconfig-title">${t('xconfig.title')}</div>
                <div class="xconfig-sub">${t('xconfig.subtitle')}</div>
              </div>
              <textarea class="form-input xconfig-textarea" id="xConfigTextarea" rows="6" placeholder="elonmusk&#10;sama&#10;paulg&#10;karpathy"></textarea>
              <div class="xconfig-actions">
                <button class="action-btn primary" id="xConfigSaveBtn">${t('xconfig.save')}</button>
                <span class="action-link" id="xConfigResult"></span>
              </div>
            </div>
            <div class="xconfig-card">
              <div class="xconfig-header">
                <div class="xconfig-title">${t('xconfig.blocklist_title')}</div>
                <div class="xconfig-sub">${t('xconfig.blocklist_subtitle')}</div>
              </div>
              <textarea class="form-input xconfig-textarea" id="xBlocklistTextarea" rows="4" placeholder="${t('xconfig.blocklist_ph')}"></textarea>
              <div class="xconfig-actions">
                <button class="action-btn primary" id="xBlocklistSaveBtn">${t('xconfig.save_blocklist')}</button>
                <button class="action-btn" id="xCleanupBtn">${t('xconfig.cleanup')}</button>
                <span class="action-link" id="xBlocklistResult"></span>
              </div>
            </div>
            <div class="ops-jobs">
              <h4 class="ops-jobs-title">${t('ops.jobs')}</h4>
              <div class="op-jobs-body" id="opJobsBody">
                <p class="empty-state">${st('settingsExtra.loading')}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <h3 class="settings-card-title">${st('settingsExtra.scheduler_title')}</h3>
        <p class="settings-card-desc">${st('settingsExtra.scheduler_description')}</p>
        <div id="schedulerPanel" class="scheduler-panel">
          <p class="subtle">${st('settingsExtra.loading')}</p>
        </div>
      </div>

      <div class="settings-card">
        <h3 class="settings-card-title">${st('settingsExtra.health_title')}</h3>
        <div id="systemHealthPanel"><p class="subtle">${st('settingsExtra.loading')}</p></div>
      </div>` : `<p class="subtle">${st('settingsExtra.admin_managed')}</p>`}

      <div class="settings-card">
        <h3 class="settings-card-title">${st('settingsExtra.quick_links')}</h3>
        <div style="display:flex;flex-wrap:wrap;gap:8px;padding:8px 0">
          <a href="/email/digest" target="_blank" rel="noopener" class="action-link" style="font-size:11px">${st('settingsExtra.email_digest')}</a>
          <a href="/opml.xml" download class="action-link" style="font-size:11px">OPML</a>
          <a href="/sitemap.xml" target="_blank" rel="noopener" class="action-link" style="font-size:11px">${t('footer.sitemap')}</a>
          <a href="/feed.xml" target="_blank" rel="noopener" class="action-link" style="font-size:11px">RSS</a>
          <a href="/watchlist/feed.xml" target="_blank" rel="noopener" class="action-link" style="font-size:11px">${st('settingsExtra.watchlist_rss')}</a>
          <a href="/help" class="action-link" style="font-size:11px">${st('settingsExtra.help')}</a>
        </div>
      </div>
    </section>
    ${isAdmin ? `<section class="metrics-block" id="userMgmtPanel" style="margin-top:16px"></section>
    <section class="metrics-block" id="apiKeysPanel" style="margin-top:16px"></section>` : ''}
  `;

  const signOut = container.querySelector('#settingsSignOut');
  const signOutError = container.querySelector('#settingsSignOutError');
  signOut?.addEventListener('click', async () => {
    if (signOut.disabled) return;
    signOut.disabled = true;
    signOutError.textContent = '';
    try {
      if (typeof window.__logout !== 'function') throw new Error('Logout unavailable');
      await window.__logout();
    } catch {
      signOutError.textContent = st('settingsExtra.sign_out_error');
      signOut.disabled = false;
    }
  });

  if (isAdmin) {
    wireSettingsHandlers();
    await Promise.allSettled([
      renderLLMPoolPanel(container.querySelector('#llmPoolPanel')),
      refreshMcpServerPanel(),
      refreshLLMStatus(), refreshSchedulerPanel(), refreshSystemHealth(), refreshUserManagement(), refreshApiKeys(),
    ]);
  }
}
