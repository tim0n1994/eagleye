/**
 * Eagleye — research page module
 *
 * Deep-research report pages and the report index.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml, timeAgo } from '../utils.js';
import { getLanguage, t } from '../i18n.js';
import { API } from '../api.js';
import { API_BASE, fetchJSON, getItemDisplayTitle, getResearchChatState, pickZh, renderMarkdownLite, showError, showLoader } from './shared.js';


export async function renderResearchPage(params) {
  const container = $('#pageContent');
  const rawId = params?.id || window.location.pathname.replace('/research/', '').split('?')[0];
  const urlParams = new URLSearchParams(window.location.search);
  const isTopicReport = urlParams.has('topic');
  showLoader(container, getLanguage() === 'zh' ? '正在载入研究页...' : 'LOADING RESEARCH...');

  if (!rawId) {
    showError(container, getLanguage() === 'zh' ? '缺少 id' : 'Missing id');
    return;
  }

  // Topic-level research reports have item_id=NULL and the URL carries ?topic=.
  // Render the report Markdown directly instead of trying to load an item.
  if (isTopicReport) {
    try {
      const repData = await fetchJSON(`${API_BASE}/research/${encodeURIComponent(rawId)}`);
      const report = repData.report;
      if (!report) { showError(container, t('common.not_found')); return; }
      const topicName = urlParams.get('topic') || '';
      container.innerHTML =
        `<section class="page-section research-page">` +
        `<div class="page-header"><a href="/topics/${escapeAttr(topicName)}" class="anchor-link">← ${t('nav.topics')}</a>` +
        `<h2 class="page-title">🔬 ${escapeHtml(topicName)} — ${t('topics.research_this')}</h2>` +
        `<p class="page-description">${report.status === 'completed' ? '' : '⏳ '+report.status}</p></div>` +
        (report.report_markdown ? renderMarkdownLite(report.report_markdown) :
         report.error ? `<p class="subtle">${escapeHtml(report.error)}</p>` :
         `<p class="subtle">${t('common.loading')}</p>`) +
        `</section>`;
      return;
    } catch (err) { showError(container, err.message); return; }
  }

  const itemId = rawId;
  try {
    const data = await API.fetchItem(itemId);
    const item = data.item || {};
    const summary = item.ai_summary || {};
    const summaryProvenance = summary.model_provider === 'deterministic'
      ? (getLanguage() === 'zh' ? '来源标题卡片 · 正文缺失' : 'Source title card · Body unavailable')
      : (getLanguage() === 'zh'
        ? `AI 摘要 · ${summary.model_name || '模型来源未记录'} · 未经独立核验`
        : `AI summary · ${summary.model_name || 'Model not recorded'} · Not independently verified`);
    const deploy = data.deploy || {};
    const title = getItemDisplayTitle(item);
    const oneLiner = pickZh(summary.one_liner, summary.one_liner_zh);
    const shortSummary = pickZh(summary.short_summary, summary.short_summary_zh);
    const whyItMatters = pickZh(summary.why_it_matters, summary.why_it_matters_zh);

    let keyPoints = [];
    try {
      const en = typeof summary.key_points === 'string' ? JSON.parse(summary.key_points) : summary.key_points;
      const zh = typeof summary.key_points_zh === 'string' ? JSON.parse(summary.key_points_zh) : summary.key_points_zh;
      keyPoints = pickZh(en, zh);
      if (!Array.isArray(keyPoints)) keyPoints = [];
    } catch {
      keyPoints = [];
    }

    const topicLinks = (item.topics || []).map((topic) =>
      `<a href="/topics/${escapeAttr(topic.slug)}" class="research-topic-chip">${escapeHtml(pickZh(topic.name, topic.name_zh) || topic.slug)}</a>`
    ).join('');
    const tagLinks = (item.tags || []).map((tag) =>
      `<span class="research-tag-chip">${escapeHtml(tag.name || tag.slug || '')}</span>`
    ).join('');
    const deployBadge = deploy?.eligibility
      ? `<span class="research-deploy-badge research-deploy-${escapeAttr(deploy.eligibility)}">${escapeHtml(deploy.eligibility)}</span>`
      : '';

    container.innerHTML = `
      <section class="page-section research-page">
        <div class="page-header research-page-header">
          <div class="research-page-meta">
            <a href="/news" class="research-back-link">← ${escapeHtml(t('nav.news'))}</a>
            <span class="research-source-pill">${escapeHtml(item.source_label || '')}</span>
            ${deployBadge}
          </div>
          <h2 class="page-title">${escapeHtml(title)}</h2>
          <p class="page-description">${escapeHtml(getLanguage() === 'zh' ? '围绕单条信号的研究、追问与上下文整理。' : 'Signal-specific research, follow-up chat, and context synthesis.')}</p>
        </div>

        <div class="research-page-grid">
          <div class="research-main-col">
            <section class="research-summary-card">
              <div class="research-summary-top">
                <div class="research-summary-source">${escapeHtml(item.source_label || '')}</div>
                <div class="research-summary-time">${escapeHtml(item.published_at ? timeAgo(item.published_at) : timeAgo(item.created_at))}</div>
              </div>
              <p class="subtle">${escapeHtml(summaryProvenance)}</p>
              ${oneLiner ? `<p class="research-one-liner">${escapeHtml(oneLiner)}</p>` : ''}
              ${shortSummary ? `<p class="research-short-summary">${escapeHtml(shortSummary)}</p>` : ''}
              ${keyPoints.length ? `<ul class="research-key-points">${keyPoints.map((point) => `<li>${escapeHtml(point)}</li>`).join('')}</ul>` : ''}
              ${whyItMatters ? `<p class="research-why">${escapeHtml(whyItMatters)}</p>` : ''}
              <div class="research-summary-links">
                <a href="${escapeAttr(item.canonical_url || '#')}" target="_blank" rel="noopener" class="action-link">${escapeHtml(getLanguage() === 'zh' ? '打开原文' : 'Open Original')} ↗</a>
              </div>
            </section>

            <section class="research-report-card">
              <div class="research-card-head">
                <h3>${escapeHtml(t('research.title'))}</h3>
                <button class="action-btn" id="researchRefreshBtn">${escapeHtml(getLanguage() === 'zh' ? '重新研究' : 'Refresh')}</button>
              </div>
              <div id="researchReportBody" class="research-report-body">
                <div class="page-loading"><div class="spinner"></div><span>${escapeHtml(getLanguage() === 'zh' ? '正在生成研究报告...' : 'Generating research report...')}</span></div>
              </div>
            </section>
          </div>

          <aside class="research-side-col">
            <section class="research-context-card">
              <div class="research-card-head">
                <h3>${escapeHtml(getLanguage() === 'zh' ? '上下文' : 'Context')}</h3>
              </div>
              ${topicLinks ? `<div class="research-chip-row">${topicLinks}</div>` : ''}
              ${tagLinks ? `<div class="research-chip-row">${tagLinks}</div>` : ''}
              <div class="research-context-meta">
                <div><label>ID</label><span class="mono">${escapeHtml(item.id || '')}</span></div>
                <div><label>Source</label><span>${escapeHtml(item.source_slug || '')}</span></div>
                <div><label>URL</label><span class="mono">${escapeHtml((item.canonical_url || '').slice(0, 80) || '—')}</span></div>
              </div>
            </section>

            <section class="research-chat-card">
              <div class="research-card-head">
                <h3>${escapeHtml(getLanguage() === 'zh' ? '研究对话' : 'Research Chat')}</h3>
              </div>
              <div id="researchChatMessages" class="research-chat-messages"></div>
              <form id="researchChatForm" class="research-chat-form">
                <textarea id="researchChatInput" class="research-chat-input" rows="4" placeholder="${escapeAttr(getLanguage() === 'zh' ? '继续追问这条信息的背景、风险、机会、后续跟踪点…' : 'Ask follow-up questions about context, risks, opportunities, and what to track next...')}"></textarea>
                <div class="research-chat-actions">
                  <span id="researchChatStatus" class="research-chat-status">${escapeHtml(getLanguage() === 'zh' ? '就绪' : 'Ready')}</span>
                  <button type="submit" class="action-btn primary" id="researchChatSendBtn">${escapeHtml(getLanguage() === 'zh' ? '发送' : 'Send')}</button>
                </div>
              </form>
            </section>
          </aside>
        </div>
      </section>
    `;

    const reportBody = $('#researchReportBody');
    const refreshBtn = $('#researchRefreshBtn');
    const chatMessages = $('#researchChatMessages');
    const chatForm = $('#researchChatForm');
    const chatInput = /** @type {HTMLTextAreaElement | null} */ ($('#researchChatInput'));
    const chatStatus = $('#researchChatStatus');
    const chatSendBtn = $('#researchChatSendBtn');
    const history = getResearchChatState(itemId);

    function renderChatMessages() {
      if (!chatMessages) return;
      if (!history.length) {
        chatMessages.innerHTML = `<div class="research-chat-empty">${escapeHtml(getLanguage() === 'zh' ? '研究报告生成后，可以继续追问这条信号。' : 'Once the report is ready, you can continue the discussion here.')}</div>`;
        return;
      }
      chatMessages.innerHTML = history.map((turn) => `
        <div class="research-chat-msg research-chat-${escapeAttr(turn.role || 'assistant')}">
          <div class="research-chat-role">${escapeHtml(turn.role === 'user' ? (getLanguage() === 'zh' ? '你' : 'You') : 'LLM')}</div>
          <div class="research-chat-bubble">${turn.role === 'assistant' ? renderMarkdownLite(turn.content) : `<p>${escapeHtml(turn.content)}</p>`}</div>
        </div>
      `).join('');
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    async function loadResearch(force = false) {
      if (!reportBody) return;
      reportBody.innerHTML = `<div class="page-loading"><div class="spinner"></div><span>${escapeHtml(force ? (getLanguage() === 'zh' ? '正在重新生成研究报告...' : 'Refreshing research report...') : (getLanguage() === 'zh' ? '正在生成研究报告...' : 'Generating research report...'))}</span></div>`;
      if (refreshBtn) refreshBtn.setAttribute('disabled', 'disabled');
      try {
        const result = await API.triggerItemResearch(itemId, force);
        const report = result.report?.report_markdown || result.report?.content || '';
        reportBody.innerHTML = renderMarkdownLite(report || (getLanguage() === 'zh' ? '研究报告为空。' : 'Research report is empty.'));
      } catch (err) {
        reportBody.innerHTML = `<div class="page-error">⚠ ${escapeHtml(err.message)}</div>`;
      } finally {
        if (refreshBtn) refreshBtn.removeAttribute('disabled');
      }
    }

    renderChatMessages();
    loadResearch(false);

    refreshBtn?.addEventListener('click', async () => {
      await loadResearch(true);
    });

    chatForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const question = String(chatInput?.value || '').trim();
      if (!question) return;

      history.push({ role: 'user', content: question });
      renderChatMessages();
      if (chatInput) chatInput.value = '';
      if (chatStatus) chatStatus.textContent = getLanguage() === 'zh' ? '思考中…' : 'Thinking...';
      if (chatSendBtn) chatSendBtn.setAttribute('disabled', 'disabled');

      try {
        const result = await API.chatItemResearch(
          itemId,
          question,
          history.slice(-8).map((turn) => ({ role: turn.role, content: turn.content })),
        );
        history.push({ role: 'assistant', content: result.answer || (getLanguage() === 'zh' ? '没有返回内容。' : 'No answer returned.') });
        if (chatStatus) chatStatus.textContent = getLanguage() === 'zh' ? '就绪' : 'Ready';
      } catch (err) {
        history.push({
          role: 'assistant',
          content: getLanguage() === 'zh'
            ? `现有上下文不足或研究对话失败：${err.message}`
            : `Research chat failed: ${err.message}`,
        });
        if (chatStatus) chatStatus.textContent = getLanguage() === 'zh' ? '失败' : 'Failed';
      } finally {
        renderChatMessages();
        if (chatSendBtn) chatSendBtn.removeAttribute('disabled');
      }
    });
  } catch (err) {
    showError(container, err.message);
  }
}

// ─── Research Reports List ──────────────────────────────

export async function renderReports(_params) {
  const container = $('#pageContent');
  showLoader(container, getLanguage() === 'zh' ? '加载报告…' : 'LOADING REPORTS...');

  try {
    const data = await fetchJSON(`${API_BASE}/reports?limit=50`);
    const reports = data.reports || [];
    const zh = getLanguage() === 'zh';

    container.innerHTML =
      `<section class="page-section">` +
      `<div class="page-header"><h2 class="page-title">${zh ? '研究报告' : 'Research Reports'}</h2>` +
      `<p class="page-description">${zh ? '所有深度研究报告和专题研究' : 'All deep research and topic study reports'}</p></div>` +
      (reports.length === 0
        ? `<p class="empty-state">${zh ? '暂无报告。在任意信号卡上点击"深度研究"生成。' : 'No reports yet. Click "Deep Research" on any signal card.'}</p>`
        : `<ul class="story-members">` +
          reports.map(r => {
            const isTopic = !r.item_id;
            const statusIcon = r.status === 'completed' ? '✅' : r.status === 'failed' ? '❌' : r.status === 'running' ? '⏳' : '📋';
            const link = isTopic
              ? `/research/${r.id}?topic=research`
              : `/research/${r.id}`;
            const excerpt = r.excerpt ? escapeHtml(r.excerpt.slice(0, 100)) : (r.error ? `<span style="color:#f87171">${escapeHtml(r.error.slice(0, 80))}</span>` : '(empty)');
            return `<li class="story-member">` +
              `<span class="story-member-src">${statusIcon} ${isTopic ? (zh ? '专题' : 'Topic') : (zh ? '条目' : 'Item')}</span>` +
              `<a href="${escapeAttr(link)}">${excerpt}</a>` +
              `<span class="subtle" style="font-size:10px;margin-left:auto">${escapeHtml(r.created_at || '')}</span>` +
              `</li>`;
          }).join('') + `</ul>`) +
      `</section>`;
  } catch (err) {
    showError(container, err.message);
  }
}
