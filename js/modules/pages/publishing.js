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
const IMAGE_TIMEOUT_MS = 180000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES_PER_DRAFT = 12;

async function publishingImageRequest(path, options = {}) {
  const { body, timeout = IMAGE_TIMEOUT_MS, signal, ...rest } = options;
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(`/api/publishing${path}`, {
      credentials: 'same-origin',
      ...rest,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...rest.headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || data.message || words(`请求失败（${response.status}）`, `Request failed (${response.status})`));
    }
    return data;
  } catch (error) {
    if (timedOut && error.name === 'AbortError') throw new Error(words('请求超时，请稍后重试。', 'The request timed out. Please try again.'), { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function ensureImageState(draft) {
  if (!draft || draft.status !== 'ready') return;
  if (!Array.isArray(draft.images)) draft.images = [];
  if (draft.wechat && !Array.isArray(draft.wechat.images)) draft.wechat.images = [];
  for (const card of Array.isArray(draft.xiaohongshu?.cards) ? draft.xiaohongshu.cards : []) {
    if (typeof card.image_id !== 'string') card.image_id = '';
    if (!['contain', 'cover'].includes(card.image_fit)) card.image_fit = 'contain';
  }
}

function assetUrl(draft, image) {
  return `/api/publishing/drafts/${encodeURIComponent(draft.id)}/images/${encodeURIComponent(image.id)}`;
}

function imageOrigin(origin) {
  return origin === 'upload' ? words('上传', 'Upload') : origin === 'source' ? words('来源', 'Source') : words('AI', 'AI');
}

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
  let stylePresets = [];
  let entry = null;
  let viewVersion = 0;
  let imageCandidates = [];
  let imageCandidateWarnings = [];
  let imageCandidateDraftId = '';
  let imageConfig = { loaded: false, available: false };
  let imageConfigError = '';
  let artDirection = '';
  let imageBusy = false;
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

  function showStyleDetails() {
    const preset = stylePresets.find(item => item.id === $('[data-style-preset]').value);
    const description = preset?.description;
    $('#pub-style-description').textContent = words(description?.zh, description?.en) || '';
    const link = $('[data-style-reference]');
    const url = sourceUrl(preset?.reference_url);
    if (url) link.href = url;
    else link.removeAttribute('href');
    link.hidden = !url;
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
      if (target.revision === revision) { target.draft = data.draft; target.dirty = false; ensureImageState(target.draft); }
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
    for (const button of container.querySelectorAll('[data-image-operation]')) {
      if (button.dataset.imageImported) { button.disabled = true; continue; }
      button.disabled = imageBusy || (button.dataset.action === 'generate-image' && !imageConfig.available);
    }
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

  function renderImageStudio(draft) {
    const assets = draft.images;
    const refs = draft.wechat.images || [];
    const candidatesForDraft = imageCandidateDraftId === draft.id;
    const assetRows = assets.map(image => {
      const reference = refs.find(item => item.image_id === image.id);
      const sourceLink = sourceUrl(image.source_url);
      return `<article class="pub-image-asset" data-image-asset="${a(image.id)}">
        <div class="pub-image-thumb"><img src="${a(assetUrl(draft, image))}" alt="${a(image.filename || words('配图', 'Image'))}" loading="lazy"></div>
        <div class="pub-image-details">
          <strong>${h(image.filename || words('未命名配图', 'Untitled image'))}</strong>
          <small>${h(imageOrigin(image.origin))}${image.width && image.height ? ` · ${h(image.width)}×${h(image.height)}` : ''}${sourceLink ? ` <a href="${a(sourceLink)}" target="_blank" rel="noopener noreferrer">${words('原文', 'Source')}</a>` : ''}</small>
          <label class="pub-image-check"><input type="checkbox" data-image-include="${a(image.id)}" ${reference ? 'checked' : ''}> ${words('用于文章', 'Use in article')}</label>
          ${reference ? `<label class="pub-image-control"><span>${words('文章位置 · 0=封面，N=第N段后', 'Article placement · 0=cover, N=after paragraph N')}</span><input type="number" min="0" max="1000" step="1" value="${a(reference.after_paragraph || 0)}" data-image-placement="${a(image.id)}"></label>` : ''}
          ${reference ? `<label class="pub-image-control"><span>${words('配图说明', 'Caption')}</span><input value="${a(reference.caption || '')}" maxlength="300" data-image-caption="${a(image.id)}"></label>` : ''}
          ${reference ? `<button type="button" data-action="remove-article-image" data-image-id="${a(image.id)}">${words('从文章移除', 'Remove from article')}</button>` : ''}
        </div>
      </article>`;
    }).join('');
    const candidateRows = (candidatesForDraft ? imageCandidates : []).map((candidate, index) => {
      const preview = sourceUrl(candidate.url);
      const imported = candidate.imported === true;
      const pageUrl = sourceUrl(candidate.source_url);
      return `<article class="pub-image-candidate">
        ${preview ? `<img src="${a(preview)}" alt="${a(candidate.caption || words('候选配图', 'Image candidate'))}" referrerpolicy="no-referrer" loading="lazy">` : `<div class="pub-image-empty">${words('无法预览', 'Preview unavailable')}</div>`}
        <p>${h(candidate.caption || words('未提供说明', 'No caption'))}</p>
        ${pageUrl ? `<a href="${a(pageUrl)}" target="_blank" rel="noopener noreferrer">${words('打开来源', 'Open source')}</a>` : ''}
        <button type="button" data-action="import-image" data-candidate-index="${index}" data-image-operation ${imported ? 'disabled data-image-imported="1"' : ''}>${imported ? words('已导入', 'Imported') : words('导入', 'Import')}</button>
      </article>`;
    }).join('');
    return `<section class="pub-image-studio">
      <h3>${words('配图区', 'Images')}</h3>
      <p class="pub-image-note">${words('复制到公众号时，平台可能去掉图片；图文包包含真实图片，可直接上传。', 'Copying may strip images. The WeChat ZIP bundle includes the real images for upload.')}</p>
      <div class="pub-image-sections">
        <section class="pub-image-panel">
          <h4>${words('上传或从来源导入', 'Upload or import sources')}</h4>
          <div class="pub-image-actions">
            <button type="button" data-action="choose-images" data-image-operation>${words('上传配图', 'Upload images')}</button>
            <button type="button" data-action="discover-images" data-image-operation>${words('查找来源图片', 'Find source images')}</button>
          </div>
          <input class="pub-image-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple data-image-file>
          <p class="pub-muted">${words('PNG / JPEG / WebP / GIF，每张 8MB 内，一篇最多 12 张。', 'PNG / JPEG / WebP / GIF, up to 8MB each, 12 per draft.')}</p>
          <p class="pub-muted">${words(`已用 ${assets.length} / 12。`, `${assets.length} / 12 used.`)}</p>
          ${candidatesForDraft && imageCandidateWarnings.length ? `<ul class="pub-image-warnings">${imageCandidateWarnings.map(value => `<li>${h(value)}</li>`).join('')}</ul>` : ''}
          ${candidateRows ? `<div class="pub-image-candidates">${candidateRows}</div>` : ''}
        </section>
        <section class="pub-image-panel">
          <h4>${words('AI 生成配图', 'Generate an image')}</h4>
          <label class="pub-image-control"><span>${words('配图想法 · 留空由文章内容决定', 'Visual direction · blank uses article context')}</span><textarea rows="3" maxlength="1200" data-image-prompt>${h(artDirection)}</textarea></label>
          <div class="pub-image-actions">
            <button type="button" data-action="clear-image-prompt">${words('清除方向', 'Clear direction')}</button>
            <button type="button" class="pub-primary" data-action="generate-image" data-image-operation ${imageConfig.available ? '' : 'disabled'}>${words('生成配图', 'Generate image')}</button>
          </div>
          <p class="pub-muted">${imageConfig.available ? words('生成后可继续选择用在文章或图卡。', 'After generation, choose where to use it.') : imageConfig.loaded ? words('AI 配图当前不可用。', 'AI image generation is unavailable.') : words('正在检查 AI 配图…', 'Checking AI image availability…')}</p>
          ${imageConfigError ? `<p class="pub-error">${h(imageConfigError)}</p>` : ''}
        </section>
      </div>
      <div class="pub-image-library">
        <h4>${words('本稿配图', 'Draft images')}</h4>
        ${assetRows ? `<div class="pub-image-list">${assetRows}</div>` : `<p class="pub-muted">${words('还没有配图。', 'No images yet.')}</p>`}
      </div>
    </section>`;
  }

  function renderCardImageControls(draft) {
    const rows = draft.xiaohongshu.cards.map((card, index) => {
      const cardImage = draft.images.find(image => image.id === card.image_id);
      return `<article class="pub-card-image" data-card-index="${index}">
        <div class="pub-card-thumb">${cardImage ? `<img src="${a(assetUrl(draft, cardImage))}" alt="${a(cardImage.filename || words('图卡配图', 'Card image'))}">` : `<span>${words('无', 'None')}</span>`}</div>
        <div class="pub-card-image-controls">
          <strong>${words('图卡', 'Card')} ${index + 1} · ${h(card.title)}</strong>
          <label><span>${words('图卡图片', 'Card image')}</span><select data-card-image="${index}"><option value="" ${!card.image_id ? 'selected' : ''}>${words('无', 'None')}</option>${draft.images.map(image => `<option value="${a(image.id)}" ${card.image_id === image.id ? 'selected' : ''}>${h(image.filename || words('未命名配图', 'Untitled image'))}</option>`).join('')}</select></label>
          <label><span>${words('填充方式', 'Fit')}</span><select data-card-fit="${index}"><option value="contain" ${card.image_fit === 'contain' ? 'selected' : ''}>${words('完整显示', 'Contain')}</option><option value="cover" ${card.image_fit === 'cover' ? 'selected' : ''}>${words('填满裁切', 'Cover')}</option></select></label>
          ${cardImage ? `<button type="button" data-action="clear-card-image" data-card-index="${index}">${words('清除', 'Clear')}</button>` : ''}
        </div>
      </article>`;
    }).join('');
    return `<section class="pub-card-images"><h4>${words('图卡配图', 'Card images')}</h4>${rows || `<p class="pub-muted">${words('还没有可选配图。', 'No images are available yet.')}</p>`}</section>`;
  }

  function renderCurrent() {
    if (!active) return;
    cleanupPreview();
    const target = $('[data-pub-current]');
    if (!entry) { target.innerHTML = `<div class="pub-empty pub-start"><span class="pub-kicker">${words('从你的眼光开始', 'Start with your perspective')}</span><h2>${words('你选什么，为什么选，才是这篇的起点。', 'Your choices and your reasons shape the story.')}</h2><p>${words('选好素材，留几句判断，再让 AI 帮你组织成两种平台的表达。每一篇都可以继续修改。', 'Choose the material, add a thought, and let AI help shape it for two platforms. Everything stays editable.')}</p></div>`; return; }
    const draft = entry.draft;
    ensureImageState(draft);
    if (draft.status !== 'ready') {
      target.innerHTML = `<div class="pub-empty"><h2>${draft.status === 'generating' ? words('正在生成', 'Generating') : words('这次没有生成完成', 'Generation did not complete')}</h2><p>${h(draft.status_message || words('选材快照已保留。生成完成后会出现在草稿列表。', 'The source snapshot is saved. Completed writing will appear in your drafts.'))}</p><button type="button" data-action="restore-sources">${words('将这份选材带回工作区', 'Restore these selections')}</button></div>`;
      return;
    }
    target.innerHTML = `<div class="pub-draft-heading"><div><span class="pub-kicker">${words('你的草稿', 'Your draft')}</span><h2>${h(draft.wechat.title)}</h2></div><span data-pub-save-state role="status"></span></div>
      ${draft.warnings?.length ? `<details class="pub-warnings"><summary>${words('有几处需要你对照来源确认', 'A few source details need your review')} (${draft.warnings.length})</summary><ul>${draft.warnings.map(value => `<li>${h(value)}</li>`).join('')}</ul></details>` : ''}
      <div class="pub-actions"><button type="button" class="pub-primary" data-action="save-draft">${words('保存修改', 'Save changes')}</button><button type="button" data-action="preview">${words('保存并预览', 'Save & preview')}</button><label class="pub-theme">${words('图卡配色', 'Card palette')} <select data-draft-theme>${[['paper', '纸色', 'Paper'], ['ink', '墨色', 'Ink'], ['mint', '薄荷', 'Mint']].map(([value, zh, en]) => `<option value="${value}" ${draft.theme === value ? 'selected' : ''}>${words(zh, en)}</option>`).join('')}</select></label></div>
      ${renderImageStudio(draft)}
      <div class="pub-platforms"><section class="pub-platform"><h3>${words('公众号文章', 'WeChat article')}</h3>
        ${field(words('标题', 'Title'), 'wechat.title', draft.wechat.title, 100)}${field(words('分享摘要', 'Share summary'), 'wechat.summary', draft.wechat.summary, 300, 3)}${field(words('正文 · Markdown', 'Article · Markdown'), 'wechat.markdown', draft.wechat.markdown, 30000, 18)}
        <div class="pub-actions"><button type="button" class="pub-primary" data-export="wechat-zip">${words('下载图文包', 'Download article bundle')}</button><button type="button" data-action="copy-wechat">${words('复制公众号排版', 'Copy formatted article')}</button><button type="button" data-export="wechat-html">HTML</button><button type="button" data-export="markdown">Markdown</button></div></section>
      <section class="pub-platform"><h3>${words('小红书图文', 'Xiaohongshu post')}</h3>${field(words('标题', 'Title'), 'xiaohongshu.title', draft.xiaohongshu.title, 60)}${field(words('配套文案', 'Caption'), 'xiaohongshu.caption', draft.xiaohongshu.caption, 3000, 7)}${field(words('标签 · 逗号分隔', 'Tags · comma separated'), 'xiaohongshu.tags', draft.xiaohongshu.tags.join(', '), 500)}
        <div class="pub-cards">${draft.xiaohongshu.cards.map((card, index) => `<article class="pub-card-editor" data-card-index="${index}"><div class="pub-card-heading"><strong>${words('图卡', 'Card')} ${index + 1}</strong><div><button type="button" data-action="card-up" ${index ? '' : 'disabled'} aria-label="${words('上移图卡', 'Move card up')}">↑</button><button type="button" data-action="card-remove" ${draft.xiaohongshu.cards.length === 1 ? 'disabled' : ''}>${words('移除', 'Remove')}</button></div></div>${field(words('图卡标题', 'Card heading'), `card.${index}.title`, card.title, 40)}${field(words('图卡正文 · 最多200字', 'Card text · up to 200 characters'), `card.${index}.body`, card.body, 200, 5)}<details class="pub-card-sources"><summary>${words('这张卡引用的来源', 'Sources for this card')}</summary>${sourceChecks(card)}</details></article>`).join('')}</div>
        ${renderCardImageControls(draft)}
        <div class="pub-actions"><button type="button" data-action="card-add" ${draft.xiaohongshu.cards.length >= 6 ? 'disabled' : ''}>${words('+ 加一张图卡', '+ Add a card')}</button><button type="button" data-action="copy-xhs">${words('复制文案', 'Copy caption')}</button><button type="button" data-export="xiaohongshu-zip">${words('下载图片包', 'Download PNG bundle')}</button></div></section></div>
      <details class="pub-source-snapshot"><summary>${words('生成时的素材与批注快照', 'Sources and notes used for this draft')}</summary>${draft.sources.map((source, index) => `<article><strong>[${index + 1}] ${h(source.title)}</strong>${sourceUrl(source.url) ? `<a href="${a(sourceUrl(source.url))}" target="_blank" rel="noopener noreferrer">${words('查看原文', 'Open source')}</a>` : ''}${source.note ? `<p>${h(source.note)}</p>` : ''}${source.excerpt ? `<blockquote>${h(source.excerpt)}</blockquote>` : ''}</article>`).join('')}</details>
      <div class="pub-approve"><p>${words('这篇已经像你了吗？确认并修改之后，再将它留作后续的文风参考。', 'Does this sound like you? Add it as a voice reference after reviewing and editing it.')}</p><button type="button" data-action="approve-sample">${words('把这篇收录为我的风格样本', 'Add this as an approved voice sample')}</button></div>
      <section class="pub-preview" data-pub-preview hidden><h3>${words('发布预览', 'Export preview')}</h3><p class="pub-muted">${words('预览对应最近保存的版本。继续编辑后，请重新保存并预览。', 'This shows the saved version. Save and refresh after further edits.')}</p><div class="pub-preview-layout"><iframe title="${words('公众号排版预览', 'WeChat layout preview')}" sandbox="" data-wechat-preview></iframe><div class="pub-image-previews" data-xhs-preview></div></div></section>`;
    updateStatus();
  }

  function normalizeImage(data) {
    const image = data?.image || data;
    if (!image?.id) throw new Error(words('配图返回缺少标识。', 'The image response is missing an identifier.'));
    return image;
  }

  function attachNewImage(target, data, revision) {
    const image = normalizeImage(data);
    ensureImageState(target.draft);
    if (!target.draft.images.some(item => item.id === image.id)) target.draft.images.push(image);
    if (!active || entry !== target) return;
    if (target.revision !== revision) {
      renderCurrent();
      message(words('配图已保存，但它是在你继续编辑时返回的，请检查后手动选择。', 'The image saved while you kept editing. Review it and choose where to use it.'));
      return;
    }
    let attached = false;
    const articleImages = target.draft.wechat.images;
    if (!articleImages.length) {
      articleImages.push({ image_id: image.id, caption: image.caption || '', after_paragraph: 0 });
      attached = true;
    }
    const firstCard = target.draft.xiaohongshu.cards?.[0];
    if (firstCard && !firstCard.image_id) {
      firstCard.image_id = image.id;
      firstCard.image_fit = firstCard.image_fit === 'cover' ? 'cover' : 'contain';
      attached = true;
    }
    if (attached) changed();
    renderCurrent();
  }

  async function uploadImages(fileList) {
    if (imageBusy) return;
    const target = entry;
    const files = [...fileList].filter(file => file.size > 0);
    if (!files.length) return;
    if (target.draft.images.length + files.length > MAX_IMAGES_PER_DRAFT) {
      throw new Error(words(`一篇最多 ${MAX_IMAGES_PER_DRAFT} 张配图。`, `A draft can have at most ${MAX_IMAGES_PER_DRAFT} images.`));
    }
    for (const file of files) {
      if (!IMAGE_TYPES.has(file.type)) throw new Error(words(`${file.name} 不是支持的图片格式。`, `${file.name} is not a supported image type.`));
      if (file.size > MAX_IMAGE_BYTES) throw new Error(words(`${file.name} 超过 8MB。`, `${file.name} is larger than 8MB.`));
    }
    let uploaded = 0;
    imageBusy = true; updateStatus();
    try {
      for (const file of files) {
        if (!active || controller.signal.aborted) break;
        const dataBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
          reader.onerror = () => reject(new Error(words(`${file.name} 读取失败。`, `Could not read ${file.name}.`)));
          reader.readAsDataURL(file);
        });
        if (!dataBase64) throw new Error(words(`${file.name} 读取失败。`, `Could not read ${file.name}.`));
        await saveDraft(target);
        const revision = target.revision;
        message(words(`正在上传 ${uploaded + 1} / ${files.length}…`, `Uploading ${uploaded + 1} / ${files.length}…`));
        const data = await publishingImageRequest(`/drafts/${encodeURIComponent(target.draft.id)}/images`, {
          method: 'POST',
          body: { data_base64: dataBase64, filename: file.name },
          signal: controller.signal,
        });
        attachNewImage(target, data, revision);
        uploaded += 1;
        if (active) message(words(`已上传 ${uploaded} / ${files.length}。`, `Uploaded ${uploaded} / ${files.length}.`));
      }
    } finally {
      imageBusy = false;
      if (active) updateStatus();
    }
  }

  async function discoverImages() {
    const target = entry;
    await saveDraft(target);
    const revision = target.revision;
    imageBusy = true; updateStatus();
    message(words('正在查找来源图片…', 'Finding source images…'));
    try {
      const data = await publishingImageRequest(`/drafts/${encodeURIComponent(target.draft.id)}/image-candidates`, {
        method: 'POST',
        body: {},
        signal: controller.signal,
      });
      imageCandidates = (Array.isArray(data.candidates) ? data.candidates : []).filter(candidate => sourceUrl(candidate.url));
      imageCandidateWarnings = Array.isArray(data.warnings) ? data.warnings : [];
      imageCandidateDraftId = target.draft.id;
      if (active && entry === target && target.revision === revision) {
        renderCurrent();
        message(imageCandidates.length ? words(`找到 ${imageCandidates.length} 张候选图。`, `Found ${imageCandidates.length} candidates.`) : words('没有找到可用来源图片。', 'No usable source images were found.'));
      } else if (active) {
        message(words('来源图片已找到，返回这篇草稿后可选择导入。', 'Source images are ready. Return to this draft to import them.'));
      }
    } finally {
      imageBusy = false;
      if (active) updateStatus();
    }
  }

  async function importCandidate(index) {
    const candidate = imageCandidates[index];
    const target = entry;
    if (!candidate || imageCandidateDraftId !== target.draft.id) throw new Error(words('候选配图不存在。', 'This image candidate no longer exists.'));
    await saveDraft(target);
    const revision = target.revision;
    imageBusy = true; updateStatus();
    message(words('正在导入来源图片…', 'Importing source image…'));
    try {
      const data = await publishingImageRequest(`/drafts/${encodeURIComponent(target.draft.id)}/images`, {
        method: 'POST',
        body: { url: candidate.url, source_id: candidate.source_id },
        signal: controller.signal,
      });
      candidate.imported = true;
      attachNewImage(target, data, revision);
      if (active) message(words('来源图片已导入。', 'Source image imported.'));
    } finally {
      imageBusy = false;
      if (active) updateStatus();
    }
  }

  async function generateImage() {
    const target = entry;
    await saveDraft(target);
    const revision = target.revision;
    imageBusy = true; updateStatus();
    message(words('正在生成配图…', 'Generating image…'));
    try {
      const data = await publishingImageRequest(`/drafts/${encodeURIComponent(target.draft.id)}/generate-image`, {
        method: 'POST',
        body: { prompt: artDirection.trim() },
        signal: controller.signal,
      });
      attachNewImage(target, data, revision);
      if (active) message(words('配图已生成。', 'Image generated.'));
    } finally {
      imageBusy = false;
      if (active) updateStatus();
    }
  }

  async function loadImageConfig() {
    try {
      const data = await publishingImageRequest('/image-config', { timeout: 20000, signal: controller.signal });
      imageConfig = { loaded: true, available: data.available === true };
      imageConfigError = '';
    } catch (error) {
      if (error.name === 'AbortError') return;
      imageConfig = { loaded: true, available: false };
      imageConfigError = error.message;
    }
    if (active) renderCurrent();
  }

  async function openDraft(id) {
    const version = ++viewVersion;
    let cached = session.drafts.get(id);
    if (!cached || (!cached.dirty && !cached.saving)) {
      const data = await request(`/drafts/${encodeURIComponent(id)}`, { signal: controller.signal });
      cached = { draft: data.draft, dirty: false, revision: 0, saving: null };
      ensureImageState(cached.draft);
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
    link.download = remoteName ? decodeURIComponent(remoteName) : `Eagleye.${format.endsWith('-zip') ? 'zip' : format === 'markdown' ? 'md' : 'html'}`;
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
      ensureImageState(data.draft);
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
    if (action === 'choose-images') { $('[data-image-file]')?.click(); return; }
    if (action === 'discover-images') return discoverImages();
    if (action === 'import-image') return importCandidate(Number(button.dataset.candidateIndex));
    if (action === 'generate-image') return generateImage();
    if (action === 'clear-image-prompt') { artDirection = ''; renderCurrent(); return; }
    if (action === 'remove-article-image' && entry) {
      ensureImageState(entry.draft);
      entry.draft.wechat.images = entry.draft.wechat.images.filter(item => item.image_id !== button.dataset.imageId);
      changed(); renderCurrent(); return;
    }
    if (action === 'clear-card-image' && entry) {
      const index = Number(button.dataset.cardIndex);
      entry.draft.xiaohongshu.cards[index].image_id = '';
      changed(); renderCurrent(); return;
    }
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
      if (action === 'card-add' && cards.length < 6) cards.push({ title: '', body: '', source_ids: entry.draft.sources.map(source => source.id), image_id: '', image_fit: 'contain' });
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

  container.innerHTML = `<section class="publishing-page"><header class="pub-page-heading"><div><span class="pub-kicker">${words('个人创作', 'Personal publishing')}</span><h2>${words('把发现，写成你的表达。', 'Make discoveries your own.')}</h2><p>${words('留下你的眼光和几句判断，再组织成公众号文章与小红书图文。', 'Add your perspective, then shape it into WeChat articles and Xiaohongshu cards.')}</p></div><a href="/">${words('← 继续选材', '← Keep exploring')}</a></header><button type="button" class="pub-reload" data-action="reload">${words('重新读取工作区', 'Reload workspace')}</button><p class="pub-notice" data-pub-message role="status">${words('正在读取你的工作区…', 'Loading your workspace…')}</p><div class="pub-layout"><aside class="pub-sidebar"><fieldset data-pub-compose disabled><section class="pub-panel"><div class="pub-section-title"><h3>${words('本次选材', 'Selections')}</h3><span data-pub-count></span></div><div data-pub-sources></div><label class="pub-field"><span>${words('这篇我想说', 'What I want to say')}</span><textarea data-pub-brief rows="4" maxlength="4000" placeholder="${words('这些东西为什么值得放在一起？不用写成完整文章。', 'What connects these discoveries? A rough thought is enough.')}"></textarea></label><button type="button" data-action="save-sources">${words('保存批注与想法', 'Save notes & direction')}</button><div class="pub-generate"><label class="pub-field"><span>${words('图卡配色', 'Card palette')}</span><select data-generation-theme><option value="paper">${words('纸色', 'Paper')}</option><option value="ink">${words('墨色', 'Ink')}</option><option value="mint">${words('薄荷', 'Mint')}</option></select></label><button type="button" class="pub-primary" data-action="generate" disabled>${words('生成一篇新稿', 'Generate a new draft')}</button></div></section><details class="pub-panel"><summary>${words('我的写作偏好', 'My writing voice')}</summary>
      <label class="pub-field"><span>${words('行文风格', 'Narrative style')}</span><select data-style-preset aria-describedby="pub-style-description"></select></label>
      <div class="pub-muted"><span id="pub-style-description"></span> <a data-style-reference hidden target="_blank" rel="noopener noreferrer">${words('查看风格参考', 'View style reference')}</a></div>
      <p class="pub-muted">${words('样本可以是你写过的短评或文章。只借鉴表达习惯，不搬用其中的经历。', 'Use your own comments or articles. Samples guide expression, not new facts.')}</p><label class="pub-field"><span>${words('希望怎么写，避免怎么写', 'Preferences and things to avoid')}</span><textarea data-voice="guidance" rows="5" maxlength="12000"></textarea></label><label class="pub-field"><span>${words('我认可的文字样本', 'Writing I recognize as mine')}</span><textarea data-voice="samples" rows="9" maxlength="12000"></textarea></label><span class="pub-muted" data-pub-voice-state></span><button type="button" data-action="save-voice">${words('保存写作偏好', 'Save writing preferences')}</button></details><section class="pub-panel"><div class="pub-section-title"><h3>${words('我的草稿', 'My drafts')}</h3><button type="button" data-action="refresh-list">${words('刷新', 'Refresh')}</button></div><button type="button" data-action="new">${words('+ 新的组合', '+ New composition')}</button><div data-pub-drafts></div></section></fieldset></aside><div class="pub-main" data-pub-current></div></div></section>`;

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
    } else if (target.matches('[data-image-prompt]')) {
      artDirection = target.value;
    } else if (target.matches('[data-image-caption]') && entry) {
      const reference = entry.draft.wechat.images.find(item => item.image_id === target.dataset.imageCaption);
      if (reference) { reference.caption = target.value; changed(); }
    } else if (target.matches('[data-draft-field]') && entry) {
      const keys = target.dataset.draftField.split('.');
      if (keys[0] === 'card') entry.draft.xiaohongshu.cards[Number(keys[1])][keys[2]] = target.value;
      else entry.draft[keys[0]][keys[1]] = keys[1] === 'tags' ? [...new Set(target.value.split(/[,，\n#]+/).map(tag => tag.trim()).filter(Boolean))] : target.value;
      changed();
    }
  }, { signal: controller.signal });
  container.addEventListener('change', event => {
    const target = event.target;
    if (target.matches('[data-style-preset]')) {
      session.voice.style_preset = target.value;
      session.voiceDirty = true;
      showStyleDetails();
      updateStatus();
      return;
    }
    if (!entry) return;
    if (target.matches('[data-image-file]')) {
      const files = [...target.files];
      target.value = '';
      if (!imageBusy) uploadImages(files).catch(error => { if (error.name !== 'AbortError') message(error.message, true); });
      return;
    }
    if (target.matches('[data-draft-theme]')) { entry.draft.theme = target.value; changed(); }
    if (target.matches('[data-image-include]')) {
      ensureImageState(entry.draft);
      const imageId = target.dataset.imageInclude;
      if (target.checked) {
        if (!entry.draft.wechat.images.some(item => item.image_id === imageId)) entry.draft.wechat.images.push({ image_id: imageId, caption: '', after_paragraph: 0 });
      } else entry.draft.wechat.images = entry.draft.wechat.images.filter(item => item.image_id !== imageId);
      changed(); renderCurrent(); return;
    }
    if (target.matches('[data-image-placement]')) {
      ensureImageState(entry.draft);
      const reference = entry.draft.wechat.images.find(item => item.image_id === target.dataset.imagePlacement);
      if (reference) {
        const value = Math.round(Number(target.value));
        reference.after_paragraph = Number.isFinite(value) ? Math.min(1000, Math.max(0, value)) : 0;
        changed();
      }
      return;
    }
    if (target.matches('[data-card-image]')) {
      ensureImageState(entry.draft);
      const card = entry.draft.xiaohongshu.cards[Number(target.dataset.cardImage)];
      if (card) {
        card.image_id = target.value;
        if (!['contain', 'cover'].includes(card.image_fit)) card.image_fit = 'contain';
        changed(); renderCurrent();
      }
      return;
    }
    if (target.matches('[data-card-fit]')) {
      const card = entry.draft.xiaohongshu.cards[Number(target.dataset.cardFit)];
      if (card && ['contain', 'cover'].includes(target.value)) {
        card.image_fit = target.value;
        changed();
      }
      return;
    }
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
    loadImageConfig();
    const [voiceData, draftsData] = await Promise.all([request('/voice', { signal: controller.signal }), request('/drafts', { signal: controller.signal })]);
    if (!active) return;
    if (!session.voiceDirty) session.voice = { guidance: '', samples: '', ...voiceData.voice };
    stylePresets = Array.isArray(voiceData.style_presets) ? voiceData.style_presets : [];
    if (!stylePresets.length) {
      stylePresets = [{ id: 'personal', label: { zh: '个人风格', en: 'Personal' },
        description: { zh: '使用你的写作偏好和认可的文字样本。', en: 'Use your preferences and approved writing samples.' } }];
    }
    const select = $('[data-style-preset]');
    for (const preset of stylePresets) {
      select.add(new Option(words(preset.label.zh, preset.label.en), preset.id));
    }
    select.value = session.voice.style_preset || 'personal';
    if (select.selectedIndex < 0) select.selectedIndex = 0;
    select.disabled = stylePresets.length === 1;
    showStyleDetails();
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
