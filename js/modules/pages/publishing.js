import { escapeHtml as h, escapeAttr as a } from '../utils.js';
import { getLanguage } from '../i18n.js';
import { router } from '../router.js';
import { publishing, publishingRequest as request } from '../publishing-editor.js';

const words = (zh, en) => getLanguage() === 'zh' ? zh : en;
// Unsubmitted edits survive SPA navigation in memory, never in localStorage.
const sessions = new Map();
let unloadInstalled = false;
const clone = value => JSON.parse(JSON.stringify(value));
const sourceUrl = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };

function getSession() {
  const user = window.__currentUser?.();
  if (!user?.id) throw new Error(words('请先登录。', 'Please sign in.'));
  if (!sessions.has(user.id)) sessions.set(user.id, { drafts: new Map(), activeId: null, voice: null, voiceDirty: false, brief: null, notes: new Map(), generating: false });
  if (!unloadInstalled) {
    unloadInstalled = true;
    window.addEventListener('beforeunload', event => {
      const dirty = [...sessions.values()].some(s => s.voiceDirty || s.brief !== null || s.notes.size || [...s.drafts.values()].some(entry => entry.dirty));
      if (dirty) { event.preventDefault(); event.returnValue = ''; }
    });
  }
  return sessions.get(user.id);
}

function field(label, key, value, max, rows = 0) {
  const control = rows
    ? `<textarea data-draft-field="${a(key)}" maxlength="${max}" rows="${rows}">${h(value || '')}</textarea>`
    : `<input data-draft-field="${a(key)}" maxlength="${max}" value="${a(value || '')}">`;
  return `<label class="pub-field"><span>${h(label)}</span>${control}</label>`;
}

function sourcesText(draft) {
  return (draft.sources || []).map((source, index) => `[${index + 1}] ${source.title}\n${sourceUrl(source.url)}`).join('\n\n');
}

export async function renderPublishing() {
  const container = document.getElementById('pageContent');
  const session = getSession();
  const controller = new AbortController();
  let active = true;
  let loaded = false;
  let noteTimer, briefTimer, pollTimer, previewController;
  let urls = [];
  let list = [];
  let entry = null;
  let viewVersion = 0;
  const $ = selector => container.querySelector(selector);

  function message(value, error = false) {
    if (!active) return;
    const target = $('[data-pub-message]');
    if (target) { target.textContent = value; target.classList.toggle('pub-error', error); }
  }

  function cleanupPreview() {
    previewController?.abort();
    urls.forEach(url => URL.revokeObjectURL(url));
    urls = [];
  }

  async function saveNotes() {
    clearTimeout(noteTimer);
    for (const [id, value] of [...session.notes]) {
      await publishing.saveNote(id, value);
      if (session.notes.get(id) === value) session.notes.delete(id);
    }
    await publishing.retry();
  }

  async function saveBrief() {
    clearTimeout(briefTimer);
    if (session.brief === null) return;
    const value = session.brief;
    await publishing.setBrief(value);
    if (session.brief === value) session.brief = null;
  }

  async function saveVoice() {
    if (!session.voiceDirty) return;
    const value = clone(session.voice);
    await request('/voice', { method: 'PUT', body: { voice: value } });
    if (JSON.stringify(session.voice) === JSON.stringify(value)) session.voiceDirty = false;
    updateStatus();
  }

  async function saveDraft(target = entry) {
    if (!target || target.draft.status !== 'ready') throw new Error(words('请先生成一篇可编辑草稿。', 'Generate an editable draft first.'));
    if (target.saving) await target.saving;
    if (!target.dirty) return target.draft;
    const revision = target.revision;
    const payload = clone({ title: target.draft.wechat.title, wechat: target.draft.wechat, xiaohongshu: target.draft.xiaohongshu, theme: target.draft.theme });
    target.saving = request(`/drafts/${encodeURIComponent(target.draft.id)}`, { method: 'PUT', body: payload }).then(data => {
      if (target.revision === revision) { target.draft = data.draft; target.dirty = false; }
      return data.draft;
    }).finally(() => { target.saving = null; updateStatus(); });
    const saved = await target.saving;
    if (target.dirty) throw new Error(words('保存期间又有新修改，请再次保存后预览或导出。', 'There are newer edits. Save again before previewing or exporting.'));
    return saved;
  }

  function updateStatus() {
    if (!active) return;
    const compose = $('[data-pub-compose]');
    if (compose) compose.disabled = !loaded || session.generating;
    const saved = $('[data-pub-save-state]');
    if (saved) saved.textContent = entry?.saving ? words('保存中…', 'Saving…') : entry?.dirty ? words('有未保存修改', 'Unsaved changes') : words('草稿已保存', 'Draft saved');
    const voice = $('[data-pub-voice-state]');
    if (voice) voice.textContent = session.voiceDirty ? words('写作偏好尚未保存', 'Writing preferences not saved') : words('仅本人确认的样本用于校准', 'Only your approved samples guide the voice');
    const count = $('[data-pub-count]');
    if (count) count.textContent = `${publishing.state.workspace.selected_ids.length} / ${publishing.state.limits.max_items}`;
    const generate = $('[data-action="generate"]');
    if (generate) {
      generate.disabled = session.generating || !publishing.state.workspace.selected_ids.length;
      generate.textContent = session.generating ? words('正在理解你的选材…', 'Working with your selections…') : words('生成一篇新稿', 'Generate a new draft');
    }
  }

  function renderSources() {
    const target = $('[data-pub-sources]');
    if (!target) return;
    const state = publishing.state;
    const byId = new Map(state.items.map(item => [item.id, item]));
    target.innerHTML = state.workspace.selected_ids.length ? state.workspace.selected_ids.map((id, index) => {
      const item = byId.get(id) || { id, title: id };
      const note = session.notes.get(id) || state.notes[id] || {};
      const url = sourceUrl(item.canonical_url);
      return `<article class="pub-source" data-source-id="${a(id)}"><div class="pub-source-head"><span class="pub-source-number">${index + 1}</span><div><small>${h(item.source_label || '')}</small><h3>${url ? `<a href="${a(url)}" target="_blank" rel="noopener noreferrer">${h(item.title_zh || item.title)}</a>` : h(item.title_zh || item.title)}</h3></div></div>
        <div class="pub-source-actions"><button type="button" data-action="source-up" ${index === 0 ? 'disabled' : ''}>${words('上移', 'Move up')}</button><button type="button" data-action="source-down" ${index === state.workspace.selected_ids.length - 1 ? 'disabled' : ''}>${words('下移', 'Move down')}</button><button type="button" data-action="source-remove">${words('移出本稿', 'Remove')}</button></div>
        <label class="pub-field"><span>${words('我的看法', 'My take')}</span><textarea data-source-field="note" rows="3" maxlength="4000" placeholder="${words('为什么挑它？好玩在哪里？你认同或怀疑什么？', 'Why this one? What interests you, or gives you pause?')}">${h(note.note || '')}</textarea></label>
        <details><summary>${words('只引用其中一段', 'Use a specific excerpt')}</summary><label class="pub-field"><span>${words('原文摘录', 'Source excerpt')}</span><textarea data-source-field="excerpt" rows="3" maxlength="8000">${h(note.excerpt || '')}</textarea></label></details></article>`;
    }).join('') : `<div class="pub-empty"><p>${words('先从每天的信息里挑一两条，让它带上你的眼光。', 'Pick a discovery or two and add your perspective.')}</p><a href="/">${words('回首页选材 →', 'Choose material on the home page →')}</a></div>`;
    updateStatus();
  }

  function renderList() {
    if (!active) return;
    const combined = new Map(list.map(draft => [draft.id, draft]));
    for (const [id, draftEntry] of session.drafts) combined.set(id, draftEntry.draft);
    const rows = [...combined.values()].sort((left, right) => (right.updated_at || '').localeCompare(left.updated_at || ''));
    $('[data-pub-drafts]').innerHTML = rows.length ? rows.map(draft => {
      const status = draft.status === 'ready' ? words('草稿', 'Draft') : draft.status === 'generating' ? words('生成中', 'Generating') : words('生成失败', 'Failed');
      return `<button type="button" class="pub-draft-link ${entry?.draft.id === draft.id ? 'is-current' : ''}" data-open-draft="${a(draft.id)}"><span>${h(draft.title || words('未命名草稿', 'Untitled draft'))}${session.drafts.get(draft.id)?.dirty ? ' *' : ''}</span><small>${h(status)} · ${h(new Date(draft.updated_at).toLocaleDateString(getLanguage() === 'zh' ? 'zh-CN' : 'en-US'))}</small></button>`;
    }).join('') : `<p class="pub-muted">${words('还没有草稿。', 'No drafts yet.')}</p>`;
  }

  async function refreshList() {
    const data = await request('/drafts', { signal: controller.signal });
    if (!active) return;
    list = data.drafts || [];
    for (const draft of list) {
      if (session.drafts.get(draft.id)?.draft.status === 'generating' && draft.status !== 'generating') session.drafts.delete(draft.id);
    }
    renderList();
  }

  function sourceChecks(card) {
    return (entry.draft.sources || []).map((source, index) => `<label><input type="checkbox" data-card-source="${a(source.id)}" ${(card.source_ids || []).includes(source.id) ? 'checked' : ''}> [${index + 1}] ${h(source.title)}</label>`).join('');
  }

  function renderCurrent() {
    if (!active) return;
    cleanupPreview();
    const target = $('[data-pub-current]');
    if (!entry) { target.innerHTML = `<div class="pub-empty pub-start"><span class="pub-kicker">${words('从你的眼光开始', 'Start with your perspective')}</span><h2>${words('你选什么，为什么选，才是这篇的起点。', 'Your choices and your reasons shape the story.')}</h2><p>${words('选好素材，留几句判断，再让 AI 帮你组织成两种平台的表达。每一篇都可以继续修改。', 'Choose the material, add a thought, and let AI help shape it for two platforms. Everything stays editable.')}</p></div>`; return; }
    const draft = entry.draft;
    if (draft.status !== 'ready') {
      target.innerHTML = `<div class="pub-empty"><h2>${draft.status === 'generating' ? words('正在生成', 'Generating') : words('这次没有生成完成', 'Generation did not complete')}</h2><p>${h(draft.status_message || words('选材快照已保留。生成完成后会出现在草稿列表。', 'The source snapshot is saved. Completed writing will appear in your drafts.'))}</p><button type="button" data-action="restore-sources">${words('将这份选材带回工作区', 'Restore these selections')}</button></div>`;
      return;
    }
    target.innerHTML = `<div class="pub-draft-heading"><div><span class="pub-kicker">${words('你的草稿', 'Your draft')}</span><h2>${h(draft.wechat.title)}</h2></div><span data-pub-save-state role="status"></span></div>
      ${draft.warnings?.length ? `<details class="pub-warnings"><summary>${words('有几处需要你对照来源确认', 'A few source details need your review')} (${draft.warnings.length})</summary><ul>${draft.warnings.map(value => `<li>${h(value)}</li>`).join('')}</ul></details>` : ''}
      <div class="pub-actions"><button type="button" class="pub-primary" data-action="save-draft">${words('保存修改', 'Save changes')}</button><button type="button" data-action="preview">${words('保存并预览', 'Save & preview')}</button><label class="pub-theme">${words('图卡配色', 'Card palette')} <select data-draft-theme>${[['paper', '纸色', 'Paper'], ['ink', '墨色', 'Ink'], ['mint', '薄荷', 'Mint']].map(([value, zh, en]) => `<option value="${value}" ${draft.theme === value ? 'selected' : ''}>${words(zh, en)}</option>`).join('')}</select></label></div>
      <div class="pub-platforms"><section class="pub-platform"><h3>${words('公众号文章', 'WeChat article')}</h3>
        ${field(words('标题', 'Title'), 'wechat.title', draft.wechat.title, 100)}${field(words('分享摘要', 'Share summary'), 'wechat.summary', draft.wechat.summary, 300, 3)}${field(words('正文 · Markdown', 'Article · Markdown'), 'wechat.markdown', draft.wechat.markdown, 30000, 18)}
        <div class="pub-actions"><button type="button" data-action="copy-wechat">${words('复制公众号排版', 'Copy formatted article')}</button><button type="button" data-export="wechat-html">HTML</button><button type="button" data-export="markdown">Markdown</button></div></section>
      <section class="pub-platform"><h3>${words('小红书图文', 'Xiaohongshu post')}</h3>${field(words('标题', 'Title'), 'xiaohongshu.title', draft.xiaohongshu.title, 60)}${field(words('配套文案', 'Caption'), 'xiaohongshu.caption', draft.xiaohongshu.caption, 3000, 7)}${field(words('标签 · 逗号分隔', 'Tags · comma separated'), 'xiaohongshu.tags', draft.xiaohongshu.tags.join(', '), 500)}
        <div class="pub-cards">${draft.xiaohongshu.cards.map((card, index) => `<article class="pub-card-editor" data-card-index="${index}"><div class="pub-card-heading"><strong>${words('图卡', 'Card')} ${index + 1}</strong><div><button type="button" data-action="card-up" ${index ? '' : 'disabled'} aria-label="${words('上移图卡', 'Move card up')}">↑</button><button type="button" data-action="card-remove" ${draft.xiaohongshu.cards.length === 1 ? 'disabled' : ''}>${words('移除', 'Remove')}</button></div></div>${field(words('图卡标题', 'Card heading'), `card.${index}.title`, card.title, 40)}${field(words('图卡正文 · 最多200字', 'Card text · up to 200 characters'), `card.${index}.body`, card.body, 200, 5)}<details class="pub-card-sources"><summary>${words('这张卡引用的来源', 'Sources for this card')}</summary>${sourceChecks(card)}</details></article>`).join('')}</div>
        <div class="pub-actions"><button type="button" data-action="card-add" ${draft.xiaohongshu.cards.length >= 6 ? 'disabled' : ''}>${words('+ 加一张图卡', '+ Add a card')}</button><button type="button" data-action="copy-xhs">${words('复制文案', 'Copy caption')}</button><button type="button" data-export="xiaohongshu-zip">${words('下载图片包', 'Download PNG bundle')}</button></div></section></div>
      <details class="pub-source-snapshot"><summary>${words('生成时的素材与批注快照', 'Sources and notes used for this draft')}</summary>${draft.sources.map((source, index) => `<article><strong>[${index + 1}] ${h(source.title)}</strong>${sourceUrl(source.url) ? `<a href="${a(sourceUrl(source.url))}" target="_blank" rel="noopener noreferrer">${words('查看原文', 'Open source')}</a>` : ''}${source.note ? `<p>${h(source.note)}</p>` : ''}${source.excerpt ? `<blockquote>${h(source.excerpt)}</blockquote>` : ''}</article>`).join('')}</details>
      <div class="pub-approve"><p>${words('这篇已经像你了吗？确认并修改之后，再将它留作后续的文风参考。', 'Does this sound like you? Add it as a voice reference after reviewing and editing it.')}</p><button type="button" data-action="approve-sample">${words('把这篇收录为我的风格样本', 'Add this as an approved voice sample')}</button></div>
      <section class="pub-preview" data-pub-preview hidden><h3>${words('发布预览', 'Export preview')}</h3><p class="pub-muted">${words('预览对应最近保存的版本。继续编辑后，请重新保存并预览。', 'This shows the saved version. Save and refresh after further edits.')}</p><div class="pub-preview-layout"><iframe title="${words('公众号排版预览', 'WeChat layout preview')}" sandbox="" data-wechat-preview></iframe><div class="pub-image-previews" data-xhs-preview></div></div></section>`;
    updateStatus();
  }

  async function openDraft(id) {
    const version = ++viewVersion;
    let cached = session.drafts.get(id);
    if (!cached || (!cached.dirty && !cached.saving)) {
      const data = await request(`/drafts/${encodeURIComponent(id)}`, { signal: controller.signal });
      cached = { draft: data.draft, dirty: false, revision: 0, saving: null };
      session.drafts.set(id, cached);
    }
    if (!active || version !== viewVersion) return;
    entry = cached;
    session.activeId = id;
    window.history.replaceState(null, '', `/publishing?id=${encodeURIComponent(id)}`);
    renderCurrent(); renderList();
    if (window.matchMedia('(max-width: 900px)').matches) $('[data-pub-current]').scrollIntoView({ block: 'start' });
  }

  function changed() {
    if (!entry) return;
    entry.dirty = true;
    entry.revision += 1;
    cleanupPreview();
    const preview = $('[data-pub-preview]');
    if (preview) preview.hidden = true;
    updateStatus();
  }

  async function exportResponse(draft, format, signal) {
    const response = await fetch(`/api/publishing/drafts/${encodeURIComponent(draft.id)}/export?format=${encodeURIComponent(format)}`, { credentials: 'same-origin', signal });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `${response.status}`); }
    return response;
  }

  async function preview() {
    const target = entry;
    const saved = await saveDraft(target);
    if (!active || entry !== target) return;
    cleanupPreview();
    previewController = new AbortController();
    const signal = previewController.signal;
    const previewRevision = target.revision;
    const html = await (await exportResponse(saved, 'wechat-html', signal)).text();
    if (!active || signal.aborted || entry !== target || previewRevision !== target.revision) return;
    $('[data-pub-preview]').hidden = false;
    $('[data-wechat-preview]').srcdoc = html;
    const gallery = $('[data-xhs-preview]');
    gallery.innerHTML = saved.xiaohongshu.cards.map((_, index) => `<figure><div data-image-slot="${index}">${words('图卡生成中…', 'Rendering card…')}</div><figcaption>${words('图卡', 'Card')} ${index + 1}</figcaption></figure>`).join('');
    await Promise.allSettled(saved.xiaohongshu.cards.map(async (_, index) => {
      try {
        const response = await fetch(`/api/publishing/drafts/${encodeURIComponent(saved.id)}/cards/${index}.png`, { credentials: 'same-origin', signal });
        if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `${response.status}`); }
        const blob = await response.blob();
        if (!active || signal.aborted || entry !== target || previewRevision !== target.revision) return;
        const url = URL.createObjectURL(blob); urls.push(url);
        const image = document.createElement('img'); image.src = url; image.alt = `${words('图卡', 'Card')} ${index + 1}: ${saved.xiaohongshu.cards[index].title}`;
        gallery.querySelector(`[data-image-slot="${index}"]`).replaceChildren(image);
      } catch (error) {
        if (!active || signal.aborted || entry !== target) return;
        const slot = gallery.querySelector(`[data-image-slot="${index}"]`); slot.textContent = error.message; slot.classList.add('pub-error');
      }
    }));
  }

  async function download(format) {
    const saved = await saveDraft();
    const response = await exportResponse(saved, format, controller.signal);
    const blob = await response.blob();
    if (!active) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const remoteName = response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''(.+)$/i)?.[1];
    link.download = remoteName ? decodeURIComponent(remoteName) : `Eagleye.${format === 'xiaohongshu-zip' ? 'zip' : format === 'markdown' ? 'md' : 'html'}`;
    link.href = url; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function generate() {
    if (session.generating) return;
    const body = { item_ids: [...publishing.state.workspace.selected_ids], brief: session.brief ?? publishing.state.workspace.brief, theme: $('[data-generation-theme]').value };
    session.generationError = '';
    session.generating = true; updateStatus();
    const version = ++viewVersion;
    try {
      await saveNotes(); await saveBrief(); await saveVoice();
      const data = await request('/drafts', { method: 'POST', body });
      session.drafts.set(data.draft.id, { draft: data.draft, dirty: false, revision: 0, saving: null });
      if (active && version === viewVersion) await openDraft(data.draft.id);
      if (active) { await refreshList(); message(words('两种平台的初稿已保存。现在可以改成你真正想说的样子。', 'Both drafts are saved. Make them your own before exporting.')); }
    } catch (error) {
      session.generationError = error.message;
      throw error;
    } finally { session.generating = false; updateStatus(); }
  }

  async function approveSample() {
    const saved = await saveDraft();
    const sample = `${saved.wechat.title}\n\n${saved.wechat.markdown}`;
    if (session.voice.samples.includes(sample)) { message(words('这篇已在风格样本中。', 'This draft is already a voice sample.')); return; }
    const combined = [session.voice.samples.trim(), sample].filter(Boolean).join('\n\n---\n\n');
    if (combined.length > 12000) throw new Error(words('样本已接近容量上限，请先在写作偏好中精简旧样本。', 'Please shorten older voice samples before adding this one.'));
    session.voice.samples = combined; session.voiceDirty = true;
    $('[data-voice="samples"]').value = combined;
    await saveVoice();
    message(words('已收录为你确认的风格样本。后续只借鉴表达，不搬用这篇的经历与事实。', 'Added as an approved voice sample. Future drafts use its voice, not its experiences or facts.'));
  }

  async function perform(button) {
    const action = button.dataset.action;
    const cardNode = button.closest('[data-card-index]');
    const sourceNode = button.closest('[data-source-id]');
    if (button.dataset.openDraft) return openDraft(button.dataset.openDraft);
    if (button.dataset.export) return download(button.dataset.export);
    if (action?.startsWith('source-')) {
      const selected = [...publishing.state.workspace.selected_ids];
      const index = selected.indexOf(sourceNode.dataset.sourceId);
      if (index < 0) return;
      if (action === 'source-remove') selected.splice(index, 1);
      else { const next = index + (action === 'source-up' ? -1 : 1); [selected[index], selected[next]] = [selected[next], selected[index]]; }
      await saveNotes(); await publishing.setSelection(selected); if (active) renderSources(); return;
    }
    if (action?.startsWith('card-') && entry) {
      const cards = entry.draft.xiaohongshu.cards;
      const index = Number(cardNode?.dataset.cardIndex);
      if (action === 'card-add' && cards.length < 6) cards.push({ title: '', body: '', source_ids: entry.draft.sources.map(source => source.id) });
      if (action === 'card-remove' && cards.length > 1) cards.splice(index, 1);
      if (action === 'card-up' && index > 0) [cards[index - 1], cards[index]] = [cards[index], cards[index - 1]];
      changed(); renderCurrent(); return;
    }
    if (action === 'generate') return generate();
    if (action === 'save-draft') { await saveDraft(); await refreshList(); message(words('草稿已保存。', 'Draft saved.')); }
    if (action === 'save-voice') { await saveVoice(); message(words('写作偏好已保存。', 'Writing preferences saved.')); }
    if (action === 'save-sources') { await saveNotes(); await saveBrief(); message(words('选材与批注已保存。', 'Selections and notes saved.')); }
    if (action === 'preview') return preview();
    if (action === 'approve-sample') return approveSample();
    if (action === 'refresh-list') return refreshList();
    if (action === 'reload') { await saveNotes(); await saveBrief(); await publishing.reload(); return router.rerenderCurrentRoute(); }
    if (action === 'new') { ++viewVersion; entry = null; session.activeId = null; window.history.replaceState(null, '', '/publishing'); renderCurrent(); renderList(); }
    if (action === 'restore-sources') {
      await saveNotes();
      await publishing.setSelection(entry.draft.sources.map(source => source.id));
      await publishing.setBrief(entry.draft.brief || ''); session.brief = null;
      if (active) { $('[data-pub-brief]').value = publishing.state.workspace.brief; renderSources(); message(words('已恢复选材和写作方向，卡片使用你当前保存的批注。', 'Selections and direction restored, using your current saved notes.')); }
    }
    if (action === 'copy-xhs') {
      const saved = await saveDraft();
      if (!navigator.clipboard?.writeText) throw new Error(words('浏览器不支持剪贴板，请下载文案包。', 'Clipboard unavailable. Download the bundle instead.'));
      await navigator.clipboard.writeText(`${saved.xiaohongshu.title}\n\n${saved.xiaohongshu.caption}\n\n${saved.xiaohongshu.tags.map(tag => `#${tag.replace(/^#+/, '')}`).join(' ')}\n\n${sourcesText(saved)}`);
      message(words('小红书文案已复制。', 'Caption copied.'));
    }
    if (action === 'copy-wechat') {
      const saved = await saveDraft();
      const html = await (await exportResponse(saved, 'wechat-html', controller.signal)).text();
      if (navigator.clipboard?.write && window.ClipboardItem) {
        const plain = new DOMParser().parseFromString(html, 'text/html').body.textContent;
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) })]);
        message(words('排版已复制，可粘贴到公众号编辑器。', 'Formatted article copied. Paste it into the WeChat editor.'));
      } else throw new Error(words('此浏览器不支持富文本复制，请下载 HTML 后复制正文。', 'Rich-text copying is unavailable. Download the HTML and copy its article.'));
    }
  }

  const unsubscribe = publishing.subscribe(() => { if (active) { updateStatus(); if (publishing.state.error) message(publishing.state.error, true); } });
  router.onCleanup(() => {
    active = false; controller.abort(); unsubscribe(); clearInterval(pollTimer); cleanupPreview();
    saveNotes().catch(() => {}); saveBrief().catch(() => {});
  });

  container.innerHTML = `<section class="publishing-page"><header class="pub-page-heading"><div><span class="pub-kicker">${words('个人创作', 'Personal publishing')}</span><h2>${words('把发现，写成你的表达。', 'Make discoveries your own.')}</h2><p>${words('留下你的眼光和几句判断，再组织成公众号文章与小红书图文。', 'Add your perspective, then shape it into WeChat articles and Xiaohongshu cards.')}</p></div><a href="/">${words('← 继续选材', '← Keep exploring')}</a></header><button type="button" class="pub-reload" data-action="reload">${words('重新读取工作区', 'Reload workspace')}</button><p class="pub-notice" data-pub-message role="status">${words('正在读取你的工作区…', 'Loading your workspace…')}</p><div class="pub-layout"><aside class="pub-sidebar"><fieldset data-pub-compose disabled><section class="pub-panel"><div class="pub-section-title"><h3>${words('本次选材', 'Selections')}</h3><span data-pub-count></span></div><div data-pub-sources></div><label class="pub-field"><span>${words('这篇我想说', 'What I want to say')}</span><textarea data-pub-brief rows="4" maxlength="4000" placeholder="${words('这些东西为什么值得放在一起？不用写成完整文章。', 'What connects these discoveries? A rough thought is enough.')}"></textarea></label><button type="button" data-action="save-sources">${words('保存批注与想法', 'Save notes & direction')}</button><div class="pub-generate"><label class="pub-field"><span>${words('图卡配色', 'Card palette')}</span><select data-generation-theme><option value="paper">${words('纸色', 'Paper')}</option><option value="ink">${words('墨色', 'Ink')}</option><option value="mint">${words('薄荷', 'Mint')}</option></select></label><button type="button" class="pub-primary" data-action="generate" disabled>${words('生成一篇新稿', 'Generate a new draft')}</button></div></section><details class="pub-panel"><summary>${words('我的写作偏好', 'My writing voice')}</summary><p class="pub-muted">${words('样本可以是你写过的短评或文章。只借鉴表达习惯，不搬用其中的经历。', 'Use your own comments or articles. Samples guide expression, not new facts.')}</p><label class="pub-field"><span>${words('希望怎么写，避免怎么写', 'Preferences and things to avoid')}</span><textarea data-voice="guidance" rows="5" maxlength="12000"></textarea></label><label class="pub-field"><span>${words('我认可的文字样本', 'Writing I recognize as mine')}</span><textarea data-voice="samples" rows="9" maxlength="12000"></textarea></label><span class="pub-muted" data-pub-voice-state></span><button type="button" data-action="save-voice">${words('保存写作偏好', 'Save writing preferences')}</button></details><section class="pub-panel"><div class="pub-section-title"><h3>${words('我的草稿', 'My drafts')}</h3><button type="button" data-action="refresh-list">${words('刷新', 'Refresh')}</button></div><button type="button" data-action="new">${words('+ 新的组合', '+ New composition')}</button><div data-pub-drafts></div></section></fieldset></aside><div class="pub-main" data-pub-current></div></div></section>`;

  container.addEventListener('input', event => {
    const target = event.target;
    if (target.matches('[data-source-field]')) {
      const source = target.closest('[data-source-id]');
      session.notes.set(source.dataset.sourceId, { note: source.querySelector('[data-source-field="note"]').value, excerpt: source.querySelector('[data-source-field="excerpt"]').value });
      clearTimeout(noteTimer); noteTimer = setTimeout(() => saveNotes().then(() => message(words('批注已保存。', 'Notes saved.'))).catch(error => message(error.message, true)), 750);
    } else if (target.matches('[data-pub-brief]')) {
      session.brief = target.value; clearTimeout(briefTimer); briefTimer = setTimeout(() => saveBrief().catch(error => message(error.message, true)), 750);
    } else if (target.matches('[data-voice]')) {
      session.voice[target.dataset.voice] = target.value; session.voiceDirty = true; updateStatus();
    } else if (target.matches('[data-draft-field]') && entry) {
      const keys = target.dataset.draftField.split('.');
      if (keys[0] === 'card') entry.draft.xiaohongshu.cards[Number(keys[1])][keys[2]] = target.value;
      else entry.draft[keys[0]][keys[1]] = keys[1] === 'tags' ? [...new Set(target.value.split(/[,，\n#]+/).map(tag => tag.trim()).filter(Boolean))] : target.value;
      changed();
    }
  }, { signal: controller.signal });
  container.addEventListener('change', event => {
    const target = event.target;
    if (!entry) return;
    if (target.matches('[data-draft-theme]')) { entry.draft.theme = target.value; changed(); }
    if (target.matches('[data-card-source]')) {
      const card = target.closest('[data-card-index]');
      entry.draft.xiaohongshu.cards[Number(card.dataset.cardIndex)].source_ids = [...card.querySelectorAll('[data-card-source]:checked')].map(input => input.dataset.cardSource);
      changed();
    }
  }, { signal: controller.signal });
  container.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action], button[data-open-draft], button[data-export]');
    if (!button || button.disabled) return;
    button.disabled = true;
    try { await perform(button); }
    catch (error) { if (error.name !== 'AbortError') message(error.message || words('操作未完成，请重试。', 'Action failed. Please retry.'), true); }
    finally { if (active) { button.disabled = false; updateStatus(); } }
  }, { signal: controller.signal });

  try {
    await publishing.ready();
    const [voiceData, draftsData] = await Promise.all([request('/voice', { signal: controller.signal }), request('/drafts', { signal: controller.signal })]);
    if (!active) return;
    if (!session.voiceDirty) session.voice = voiceData.voice;
    loaded = true;
    list = draftsData.drafts || [];
    $('[data-voice="guidance"]').value = session.voice.guidance || '';
    $('[data-voice="samples"]').value = session.voice.samples || '';
    $('[data-pub-brief]').value = session.brief ?? publishing.state.workspace.brief;
    renderSources(); renderList(); renderCurrent();
    const id = new URLSearchParams(window.location.search).get('id') || session.activeId;
    if (id) await openDraft(id);
    message(session.generationError || words('批注会自动保存。成稿修改后请保存，再预览或导出。', 'Notes save automatically. Save draft edits before previewing or exporting.'), !!session.generationError);
    pollTimer = setInterval(async () => {
      updateStatus();
      if (!active || !list.some(draft => draft.status === 'generating')) return;
      try { await refreshList(); if (entry?.draft.status === 'generating') await openDraft(entry.draft.id); } catch { /* An explicit refresh remains available. */ }
    }, 5000);
  } catch (error) { if (error.name !== 'AbortError') message(error.message, true); }
}
