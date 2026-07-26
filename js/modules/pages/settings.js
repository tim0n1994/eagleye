/**
 * Eagleye — settings page module
 *
 * Settings page: LLM provider, scheduler, user management and system health.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml } from '../utils.js';
import { getLanguage, t } from '../i18n.js';
import { API } from '../api.js';
import { API_BASE, fetchJSON } from './shared.js';


// ─── Settings (LLM endpoint + runtime config) ───────────────────────

import { SAMPLE_PASTE, refreshApiKeys, refreshLLMStatus, refreshSchedulerPanel, refreshSystemHealth, refreshUserManagement } from './settings-panels.js';
import { wireSettingsHandlers } from './settings-handlers.js';

export async function renderSettings(_params) {
  const container = $('#pageContent');
  const sampleText = SAMPLE_PASTE;
  const directSubtitle = getLanguage() === 'zh' ? '适用于 OpenAI 兼容接口' : 'For OpenAI-compatible endpoints';
  const pasteSubtitle = getLanguage() === 'zh' ? '自动识别 key/value、JSON、curl 三种格式' : 'Auto-detects key/value, JSON, and curl';
  const providerSelect = getLanguage() === 'zh'
    ? '<option value="openai">openai (OpenAI Chat Completions 兼容)</option><option value="gemini">gemini</option><option value="claude">claude</option>'
    : '<option value="openai">openai (OpenAI Chat Completions compatible)</option><option value="gemini">gemini</option><option value="claude">claude</option>';
  const step1 = getLanguage() === 'zh' ? '点击上方的' : 'Hit';
  const step1b = getLanguage() === 'zh' ? '以确认接口正常。' : ' above to confirm the API answers.';
  const step2 = getLanguage() === 'zh' ? '打开首页 — 当日信号将自动 enrichment。' : "Open the homepage — today's signals will start to enrich.";
  const step3 = getLanguage() === 'zh' ? '或手动批量运行：' : 'Or run a batch manually:';
  const step4 = getLanguage() === 'zh' ? '然后触发每日简报：' : 'Then trigger a daily digest:';

  container.innerHTML = `
    <section class="page-section">
      <div class="page-header">
        <h2 class="page-title">${t('settings.title')}</h2>
        <p class="page-description">${t('settings.subtitle')}</p>
      </div>

      <div class="settings-grid">
        <div class="settings-card">
          <div class="settings-card-header">
            <span class="settings-card-title">${t('settings.current')}</span>
            <span class="settings-card-badge" id="llmStatusBadge">…</span>
          </div>
          <div class="settings-card-body" id="llmCurrent">
            <div class="empty-state">${getLanguage() === 'zh' ? '加载中…' : 'Loading…'}</div>
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
            <button class="action-btn" id="llmClearBtn">${getLanguage() === 'zh' ? '清空' : 'CLEAR'}</button>
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
              <input id="llmApiKey" class="form-input" type="password" placeholder="Bearer token or sk-…">
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
              <li>${step3}
                <pre class="settings-code">curl -X POST 'http://127.0.0.1:3001/api/enrich?batch=1600&amp;background=true'</pre>
              </li>
              <li>${step4}
                <pre class="settings-code">curl -X POST 'http://127.0.0.1:3001/api/digest/build?background=true'</pre>
              </li>
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
                  <button class="action-btn primary" data-op="sync">▶ ${t('ops.sync')}</button>
                  <button class="action-btn danger op-stop" data-op-stop="sync" hidden>${t('ops.stop')}</button>
                </div>
              </div>
              <div class="op-row" data-op-row="enrich">
                <div class="op-info">
                  <div class="op-name"><span class="op-name-zh">AI 摘要批量</span><span class="op-name-sep">·</span><span class="op-name-en">ENRICH ITEMS</span></div>
                  <div class="op-desc">${t('ops.enrich_desc')}</div>
                  <div class="op-stream" data-op-stream="enrich" hidden></div>
                </div>
                <div class="op-actions">
                  <button class="action-btn primary" data-op="enrich">▶ ${t('ops.enrich')}</button>
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
                  <button class="action-btn primary" data-op="digest">▶ ${t('ops.digest')}</button>
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
                  <button class="action-btn primary" data-op="pipeline">▶ ${t('ops.pipeline')}</button>
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
                <p class="empty-state">${getLanguage() === 'zh' ? '加载中…' : 'Loading…'}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <h3 class="settings-card-title">⏰ ${getLanguage() === 'zh' ? '定时调度' : 'Scheduler'}</h3>
        <p class="settings-card-desc">${getLanguage() === 'zh' ? '每天定时自动运行 FULL_PIPELINE 或 RESCORE_ALL。默认关闭。' : 'Run FULL_PIPELINE or RESCORE_ALL automatically each day. Disabled by default.'}</p>
        <div id="schedulerPanel" class="scheduler-panel">
          <p class="subtle">${getLanguage() === 'zh' ? '加载中…' : 'Loading...'}</p>
        </div>
      </div>

      <div class="settings-card">
        <h3 class="settings-card-title">📊 ${getLanguage() === 'zh' ? '系统健康' : 'System Health'}</h3>
        <div id="systemHealthPanel"><p class="subtle">${getLanguage() === 'zh' ? '加载中…' : 'Loading...'}</p></div>
      </div>

      <div class="settings-card">
        <h3 class="settings-card-title">🔗 ${getLanguage() === 'zh' ? '快捷链接' : 'Quick Links'}</h3>
        <div style="display:flex;flex-wrap:wrap;gap:8px;padding:8px 0">
          <a href="/email/digest" target="_blank" rel="noopener" class="action-link" style="font-size:11px">📧 ${getLanguage() === 'zh' ? '邮件简报' : 'Email digest'}</a>
          <a href="/opml.xml" download class="action-link" style="font-size:11px">📋 OPML</a>
          <a href="/sitemap.xml" target="_blank" rel="noopener" class="action-link" style="font-size:11px">🗺 Sitemap</a>
          <a href="/feed.xml" target="_blank" rel="noopener" class="action-link" style="font-size:11px">📡 RSS</a>
          <a href="/watchlist/feed.xml" target="_blank" rel="noopener" class="action-link" style="font-size:11px">🔔 ${getLanguage() === 'zh' ? '关注 RSS' : 'Watchlist RSS'}</a>
          <a href="/help" class="action-link" style="font-size:11px">❓ ${getLanguage() === 'zh' ? '帮助' : 'Help'}</a>
        </div>
      </div>
    </section>
    <section class="metrics-block" id="userMgmtPanel" style="margin-top:16px"></section>
    <section class="metrics-block" id="apiKeysPanel" style="margin-top:16px"></section>
  `;

  await refreshLLMStatus();
  wireSettingsHandlers();
  refreshSchedulerPanel();
  refreshSystemHealth();
  refreshUserManagement();
  refreshApiKeys();
}
