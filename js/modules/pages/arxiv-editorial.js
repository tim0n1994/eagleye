import { escapeHtml as h, escapeAttr as a } from '../utils.js';
import { getLanguage } from '../i18n.js';
import { router } from '../router.js';
import { publishingRequest as request } from '../publishing-editor.js';
import { publishingTabs } from './publishing-tabs.js';

const words = (zh, en) => getLanguage() === 'zh' ? zh : en;
const platforms = { x: 'X', wechat: '公众号', red: '小红书' };
const defaultImage = slot => ['x', 'wechat', 'card-0'].includes(slot) ? 'default' : 'none';
const fileTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function query(path, params = {}) {
  return '/arxiv' + path + '?' + new URLSearchParams(params);
}

function arxivLink(id) {
  return 'https://arxiv.org/abs/' + String(id || '').split('/').map(encodeURIComponent).join('/');
}

function field(label, key, value, max, rows = 0) {
  const input = rows ? `<textarea rows="${rows}" data-edit="${a(key)}" maxlength="${max}">${h(value || '')}</textarea>`
    : `<input data-edit="${a(key)}" maxlength="${max}" value="${a(value || '')}">`;
  return `<label class="pub-field"><span>${h(label)}</span>${input}</label>`;
}

function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取选择的图片。'));
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
    reader.readAsDataURL(file);
  });
}

export async function renderArxivEditorial() {
  const main = document.getElementById('pageContent');
  main.innerHTML = `<section class="publishing-page pub-arxiv">
    ${publishingTabs(true)}
    <header class="pub-page-heading">
      <div><h2>${words('每日 arXiv 精选', 'Daily arXiv')}</h2><p>每天从 Eagleye 入库论文里选题。核对原文，加上你的判断，再编辑三平台图文。</p></div>
      <div class="pub-actions arv-header-actions" data-arv-tools></div>
    </header>
    <p class="pub-notice" data-arv-status aria-live="polite">正在读取期次…</p>
    <div class="pub-layout"><aside class="pub-sidebar" data-arv-candidates></aside><article class="pub-main pub-panel" data-arv-draft hidden></article></div>
    <dialog class="arv-dialog" data-arv-dialog><div class="arv-dialog-content"></div><form method="dialog"><button>关闭</button></form></dialog>
  </section>`;
  const root = main.firstElementChild;
  const $ = selector => root.querySelector(selector);
  const dialog = $('[data-arv-dialog]');
  const controller = new AbortController();
  const { signal } = controller;
  let state;
  let platform = 'x';
  let showAll = false;
  const opened = new Set();
  let busy = false;
  let timer;
  let polling;
  let dialogUrl;
  let saving = Promise.resolve();
  let workspaceChanges = 0;
  let draftChanges = 0;
  let uploadedAt = 0;

  function status(message = '', error = false) {
    const line = $('[data-arv-status]');
    line.textContent = message;
    line.classList.toggle('pub-error', error);
  }

  function setHeaderButtons() {
    if (!state) return;
    const active = state.date;
    $('[data-arv-tools]').innerHTML = `<label class="arv-date"><span>期次 · 美西时间</span>
      <select data-arv-date>${[...new Set([active, ...state.dates])].sort().reverse().map(date =>
        `<option ${date === active ? 'selected' : ''} value="${a(date)}">${h(date)}${date === state.today ? ' · 今天' : ''}</option>`).join('')}</select></label>
      <button type="button" data-arv-action="save" ${busy ? 'disabled' : ''}>保存</button>
      <button type="button" class="pub-primary" data-arv-action="download" ${!state.draft || busy ? 'disabled' : ''}>下载三平台稿件</button>`;
  }

  function renderCandidates() {
    const papers = showAll ? state.candidates : state.candidates.slice(0, 4);
    $('[data-arv-candidates]').innerHTML = `<section class="pub-panel">
      <div class="pub-section-title"><h3>本期候选</h3><span>${state.selection.length} / 3 已选</span></div>
      ${papers.length ? papers.map(paper => {
        const id = paper.arxiv_id;
        const picked = state.selection.includes(id);
        const lead = state.selection[0] === id;
        return `<article class="pub-source arv-paper">
          <label class="arv-paper-pick"><input type="checkbox" data-pick="${a(id)}" ${picked ? 'checked' : ''}
            ${!picked && state.selection.length >= 3 ? 'disabled' : ''}><span>
            <strong>${h(paper.title)}</strong><small>${h((paper.categories || []).slice(0, 2).join(' · '))}${lead ? ' · 主稿' : ''}</small>
          </span></label>
          ${picked && !lead ? `<button type="button" data-arv-action="lead" data-id="${a(id)}">设为主稿</button>` : ''}
          <details data-paper="${a(id)}" ${opened.has(id) ? 'open' : ''}><summary>摘要与批注${state.notes[id] ? ' · 已填写' : ''}</summary>
            <p lang="en" class="arv-abstract">${h(paper.abstract)}</p>
            <a href="${a(arxivLink(id))}" target="_blank" rel="noopener noreferrer">打开论文 ↗</a>
            ${field('我的批注', 'note:' + id, state.notes[id], 1000, 3)}
          </details></article>`;
      }).join('') : '<p class="pub-empty">本期候选尚未生成。</p>'}
      ${state.candidates.length > 4 ? `<button type="button" class="arv-more" data-arv-action="more">${showAll ? '收起候选' : '查看全部 ' + state.candidates.length + ' 篇'}</button>` : ''}
      ${field('这期我想怎么讲', 'angle', state.angle, 2000, 3)}
      <div class="pub-generate">
        <button type="button" class="pub-primary" data-arv-action="generate" ${busy || state.busy || !state.selection.length ? 'disabled' : ''}>
          ${h(state.job || (state.busy ? '另一期正在生成' : (state.draft ? '按选材另生成一版' : '生成三平台稿件')))}
        </button>
      </div>
    </section>`;
  }

  function evidenceChips(ids) {
    return `<span class="arv-chips">${ids.map(id => `<button type="button" data-arv-action="evidence" data-id="${a(id)}"
      ${state.draft.reviewed.includes(id) ? 'class="arv-reviewed" aria-label="' + a(id + ' 已核对') + '"' : ''}>${h(id)}${state.draft.reviewed.includes(id) ? ' ✓' : ''}</button>`).join('')}</span>`;
  }

  function asset(slot) {
    const mode = state.draft.images[slot] || defaultImage(slot);
    const params = { date: state.date, draft: state.draft.id, slot, mode, v: uploadedAt };
    return `<div class="arv-asset">
      ${mode !== 'none' ? `<img src="/api/publishing${a(query('/image', params))}" alt="当前配图" loading="lazy">` : '<span class="arv-no-image">暂无配图</span>'}
      <div><div class="pub-muted">${mode === 'upload' ? '已上传图片' : mode === 'default' ? '本期解读示意图' : '可以上传论文中要引用的原图'}</div>
        <div class="arv-asset-actions">
          <button type="button" data-arv-action="choose-image" data-slot="${slot}">${mode === 'none' ? '上传配图' : '更换图片'}</button>
          <input hidden type="file" data-upload="${slot}" accept="image/png,image/jpeg,image/webp,image/gif">
          ${mode !== 'default' ? `<button type="button" data-arv-action="image-mode" data-slot="${slot}" data-mode="default">使用示意图</button>` : ''}
          ${mode !== 'none' ? `<button type="button" data-arv-action="image-mode" data-slot="${slot}" data-mode="none">移除配图</button>` : ''}
        </div>
      </div></div>`;
  }

  function renderPlatform(draft) {
    if (platform === 'x') {
      return `<h3>X 串帖</h3>${asset('x')}${draft.x.map((post, i) => {
        const paper = draft.papers.find(item => item.id === post.link_id);
        return `<section class="pub-card-editor"><div class="pub-card-heading"><strong>${i + 1} / ${draft.x.length}</strong>${evidenceChips(post.evidence_ids)}</div>
          ${field('帖子正文', 'x:' + i, post.text, 400, 3)}
          ${paper ? `<a href="${a(arxivLink(paper.version))}" target="_blank" rel="noopener noreferrer">${h(paper.version)} · 论文链接 ↗</a>` : ''}
        </section>`;
      }).join('')}`;
    }
    if (platform === 'wechat') {
      return `<div class="pub-section-title"><h3>公众号文章</h3><button type="button" data-arv-action="preview" data-format="wechat">预览排版</button></div>
        ${field('标题', 'wechat:title', draft.wechat.title, 100)}
        ${field('分享摘要', 'wechat:summary', draft.wechat.summary, 250)}
        ${asset('wechat')}${field('配图说明', 'caption', draft.caption, 250)}
        ${field('正文 · Markdown，保留原文编号 [E1]', 'wechat:markdown', draft.wechat.markdown, 4000, 19)}`;
    }
    const red = draft.xiaohongshu;
    return `<h3>小红书图文</h3>
      ${field('标题', 'red:title', red.title, 20)}
      ${field('笔记正文', 'red:caption', red.caption, 900, 6)}
      ${field('话题 · 逗号分隔', 'red:tags', red.tags.join('，'), 240)}
      ${red.cards.map((card, i) => `<section class="pub-card-editor">
        <div class="pub-card-heading"><strong>图卡 ${i + 1} / ${red.cards.length}</strong>
          <button type="button" data-arv-action="preview" data-format="card" data-index="${i}">预览当前图卡</button></div>
        ${field('图卡标题', 'card:' + i + ':title', card.title, 34)}
        ${field('图卡文字', 'card:' + i + ':body', card.body, 155, 3)}
        ${evidenceChips(card.evidence_ids)}${asset('card-' + i)}
      </section>`).join('')}`;
  }

  function renderVersions() {
    const control = $('[data-arv-version]');
    if (!control) return;
    control.innerHTML = state.versions.map((version, i) => `<option value="${a(version.id)}"
      ${version.id === state.draft?.id ? 'selected' : ''}>${version.id === 'background' ? '后台原稿' : '重写 · ' + (version.time?.slice(0, 16).replace('T', ' ') || i + 1)}
      · ${h(version.title)}</option>`).join('');
  }

  function renderDraft() {
    const block = $('[data-arv-draft]');
    block.hidden = false;
    const draft = state.draft;
    if (!draft) {
      block.innerHTML = '<div class="pub-empty"><h3>本期还没有后台草稿</h3><p>可以先核对候选与摘要，选好论文后生成一版。</p></div>';
      return;
    }
    block.innerHTML = `<header class="pub-draft-heading"><div><span class="pub-kicker">待审稿 · 工程师读论文</span>
      <h2>${h(draft.wechat.title || '未命名稿件')}</h2></div></header>
      <label class="pub-field"><span>稿件版本</span><select data-arv-version></select></label>
      <div class="arv-evidence-strip"><strong>原文证据</strong>${evidenceChips(draft.evidence.map(e => e.id))}</div>
      <nav class="arv-platforms" aria-label="发布平台">${Object.entries(platforms).map(([name, label]) =>
        `<button type="button" data-arv-action="platform" data-id="${name}" aria-pressed="${name === platform}">${label}</button>`).join('')}</nav>
      <div class="arv-editor" data-arv-editor>${renderPlatform(draft)}</div>`;
    renderVersions();
  }

  function openEvidence(id) {
    const draft = state.draft;
    const evidence = draft.evidence.find(item => item.id === id);
    if (!evidence) return;
    const paper = draft.papers.find(item => item.id === evidence.paper_id);
    const isReviewed = draft.reviewed.includes(id);
    showDialog(`<h3>${h(id)} · 原文证据</h3>
      <p class="pub-muted">${h(paper?.version || evidence.paper_id)} · ${h(evidence.locator)}</p>
      <h4>稿件里的判断</h4><p>${h(evidence.claim)}</p>
      <h4>论文原文</h4><blockquote lang="en">${h(evidence.quote)}</blockquote>
      <p><a href="${a(arxivLink(paper?.version || evidence.paper_id))}" target="_blank" rel="noopener noreferrer">查看论文版本 ↗</a></p>
      <button type="button" data-arv-action="review" data-id="${a(id)}">${isReviewed ? '取消已核对' : '标记已核对'}</button>`);
  }

  function showDialog(html) {
    dialog.querySelector('.arv-dialog-content').innerHTML = html;
    if (!dialog.open) dialog.showModal();
  }

  function clearDialogUrl() {
    if (dialogUrl) URL.revokeObjectURL(dialogUrl);
    dialogUrl = undefined;
  }

  function updateEditor(key, value) {
    const [group, index, prop] = key.split(':');
    if (group === 'angle' || group === 'note') {
      if (group === 'angle') {
        state.angle = value;
      } else {
        state.notes[index] = value;
      }
      workspaceChanges++;
      return;
    }
    const draft = state.draft;
    if (!draft) return;
    if (group === 'caption') draft.caption = value;
    if (group === 'x') draft.x[Number(index)].text = value;
    if (group === 'wechat') draft.wechat[index] = value;
    if (group === 'red') {draft.xiaohongshu[index] = index === 'tags'
      ? [...new Set(value.split(/[,，\n#]+/).map(tag => tag.trim()).filter(Boolean))] : value;}
    if (group === 'card') draft.xiaohongshu.cards[Number(index)][prop] = value;
    draftChanges++;
  }

  function save() {
    clearTimeout(timer);
    if (!state) return Promise.resolve();
    saving = saving.catch(() => {}).then(async () => {
      const current = state;
      const draft = current.draft;
      if (workspaceChanges) {
        const stamp = workspaceChanges;
        const { date, selection, notes, angle, active, revision } = current;
        const data = await request(query('/workspace', { date }), { method: 'PUT', body: { selection, notes, angle, active, revision } });
        current.revision = data.revision;
        if (workspaceChanges === stamp) workspaceChanges = 0;
      }
      if (draft && draftChanges) {
        const stamp = draftChanges;
        const data = await request(query('/draft', { date: current.date, draft: draft.id }), { method: 'PUT',
          body: {
            x: draft.x.map(post => post.text), wechat: draft.wechat, xiaohongshu: draft.xiaohongshu,
            caption: draft.caption, images: draft.images, reviewed: draft.reviewed, revision: draft.revision,
          } });
        draft.revision = data.draft.revision;
        if (draftChanges === stamp) draftChanges = 0;
      }
    });
    return saving;
  }

  function scheduleSave() {
    clearTimeout(timer);
    timer = setTimeout(() => save().then(() => {
      if (!state?.job && !state?.error && !signal.aborted) {
        status('修改已保存。');
      }
    }).catch(error => { if (!signal.aborted) status(error.message, true); }), 700);
  }

  async function load(date = '') {
    const data = await request(query('', date ? { date } : {}), { signal });
    if (signal.aborted) return;
    state = data;
    setHeaderButtons();
    renderCandidates();
    renderDraft();
    showStatus();
  }

  function showStatus() {
    if (state.error) {
      status(state.error, true);
    } else if (state.job) {
      status(state.job + '，可以继续核对和编辑已有稿件。');
    } else {
      status(state.date === state.today ? '' : '显示最近可用或所选期次 · ' + state.date);
    }
  }

  async function poll() {
    if (!state || busy || !state.busy) return;
    const date = state.date;
    const data = await request(query('', { date }), { signal });
    if (signal.aborted || state.date !== date || busy) return;
    const completed = state.job && !data.busy && !data.error;
    state.job = data.job;
    state.busy = data.busy;
    state.error = data.error;
    state.versions = data.versions;
    if (!state.draft && data.draft) {
      state.draft = data.draft;
      state.active = data.active;
      setHeaderButtons();
      renderDraft();
    } else renderVersions();
    // Progress must not replace the controls under a user's cursor.
    const generate = $('[data-arv-action="generate"]');
    if (generate) {
      generate.disabled = state.busy || !state.selection.length;
      generate.textContent = state.job || (state.busy ? '另一期开启了生成' : (state.draft ? '按选材另生成一版' : '生成三平台稿件'));
    }
    showStatus();
    if (completed) status('新稿件已生成，可从「稿件版本」切换。');
  }

  async function rendered(format, index) {
    await save();
    const params = { date: state.date, draft: state.draft.id, format };
    if (index !== undefined) params.index = index;
    const response = await fetch('/api/publishing' + query('/render', params), { signal, credentials: 'same-origin' });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '无法读取排版或发布包。');
    return response.blob();
  }

  async function run(operation) {
    if (busy) return;
    busy = true;
    root.setAttribute('aria-busy', 'true');
    try { await operation(); }
    catch (error) { if (!signal.aborted) status(error.message, true); }
    finally {
      busy = false;
      root.removeAttribute('aria-busy');
      setHeaderButtons();
      const generate = $('[data-arv-action="generate"]');
      if (generate) generate.disabled = state.busy || !state.selection.length;
    }
  }

  root.addEventListener('input', event => {
    if (event.target.dataset.edit) {
      updateEditor(event.target.dataset.edit, event.target.value);
      scheduleSave();
    }
  }, { signal });
  root.addEventListener('toggle', event => {
    const id = event.target.dataset.paper;
    if (!id) return;
    if (event.target.open) opened.add(id);
    else opened.delete(id);
  }, { signal, capture: true });
  root.addEventListener('change', event => {
    const input = event.target;
    if (input.dataset.pick) {
      state.selection = input.checked ? [...state.selection, input.dataset.pick] : state.selection.filter(id => id !== input.dataset.pick);
      workspaceChanges++;
      renderCandidates();
      scheduleSave();
    }
    if (input.matches('[data-arv-date], [data-arv-version]')) {
      const isDate = input.matches('[data-arv-date]');
      const value = input.value;
      const date = isDate ? value : state.date;
      if (busy) { setHeaderButtons(); renderVersions(); return; }
      const workspace = root.querySelector('.pub-layout');
      workspace.inert = true;
      void run(async () => {
        await save();
        if (!isDate) {
          state.active = value;
          workspaceChanges++;
          try { await save(); }
          catch (error) { state.active = state.draft?.id || 'background'; throw error; }
        }
        await load(date);
        if (isDate && !signal.aborted) {
          showAll = false;
          opened.clear();
          renderCandidates();
          const url = new URL(location.href);
          url.searchParams.set('date', state.date);
          history.replaceState(history.state, '', url);
        }
      }).finally(() => {
        workspace.inert = false;
        renderVersions();
      });
    }
    if (input.dataset.upload && input.files[0]) {
      const file = input.files[0];
      const slot = input.dataset.upload;
      input.value = '';
      void run(async () => {
        if (!fileTypes.has(file.type) || file.size > 8 * 1024 * 1024) throw new Error('请选择不超过 8 MB 的 PNG、JPG、WebP 或 GIF 图片。');
        await save();
        const data64 = await fileBase64(file);
        await request(query('/image', { date: state.date, draft: state.draft.id, slot }),
          { method: 'POST', body: { data_base64: data64, revision: state.draft.revision } });
        state.draft.images[slot] = 'upload';
        uploadedAt = Date.now();
        draftChanges++;
        await save();
        if (!signal.aborted) {
          $('[data-arv-editor]').innerHTML = renderPlatform(state.draft);
          status('配图已保存。');
        }
      });
    }
  }, { signal });

  root.addEventListener('click', event => {
    const button = event.target.closest('[data-arv-action]');
    if (!button || !state) return;
    const { arvAction: action, id, slot, mode, format, index } = button.dataset;
    if (action === 'evidence') { openEvidence(id); return; }
    if (action === 'platform') {
      platform = id;
      root.querySelectorAll('.arv-platforms button').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
      $('[data-arv-editor]').innerHTML = renderPlatform(state.draft);
      return;
    }
    if (busy) return;
    if (action === 'choose-image') { root.querySelector('[data-upload="' + slot + '"]').click(); return; }
    if (action === 'more') { showAll = !showAll; renderCandidates(); return; }
    if (action === 'lead') {
      state.selection = [id, ...state.selection.filter(item => item !== id)];
      workspaceChanges++;
      renderCandidates();
      scheduleSave();
      return;
    }
    if (action === 'image-mode' || action === 'review') {
      if (action === 'review') {
        const list = state.draft.reviewed;
        state.draft.reviewed = list.includes(id) ? list.filter(item => item !== id) : [...list, id];
        dialog.close();
        renderDraft();
      } else {
        state.draft.images[slot] = mode;
        $('[data-arv-editor]').innerHTML = renderPlatform(state.draft);
      }
      draftChanges++;
      scheduleSave();
      return;
    }
    void run(async () => {
      if (action === 'save') { await save(); status('修改已保存。'); }
      if (action === 'generate') {
        await save();
        const data = await request(query('/generate', { date: state.date }), { method: 'POST' });
        state.busy = true;
        state.error = '';
        state.job = data.job;
        renderCandidates();
        showStatus();
      }
      if (action === 'download') {
        status('正在打包三个平台的文稿和配图…');
        const blob = await rendered('zip');
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = 'Eagleye-arXiv-' + state.date + '.zip';
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 20000);
        status('发布包已生成。');
      }
      if (action === 'preview') {
        status('正在排版预览…');
        const blob = await rendered(format, index);
        clearDialogUrl();
        dialogUrl = URL.createObjectURL(blob);
        showDialog(format === 'wechat'
          ? `<h3>公众号排版预览</h3><iframe sandbox title="公众号排版预览" src="${a(dialogUrl)}"></iframe>`
          : `<h3>小红书图卡 ${Number(index) + 1}</h3><img class="arv-card-preview" src="${a(dialogUrl)}" alt="当前图卡排版预览">`);
        showStatus();
      }
    });
  }, { signal });

  dialog.addEventListener('close', clearDialogUrl, { signal });
  window.addEventListener('beforeunload', event => {
    if (workspaceChanges || draftChanges) { event.preventDefault(); event.returnValue = ''; }
  }, { signal });
  router.onCleanup(() => {
    void save().catch(() => {});
    controller.abort();
    clearInterval(polling);
    clearDialogUrl();
  });

  try {
    await load(new URLSearchParams(location.search).get('date') || '');
    if (!signal.aborted) {polling = setInterval(() => poll().catch(error => {
      if (!signal.aborted) status(error.message, true);
    }), 4000);}
  } catch (error) {
    if (!signal.aborted) status(error.message, true);
  }
}
