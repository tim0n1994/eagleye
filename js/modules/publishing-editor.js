import { escapeAttr, escapeHtml } from './utils.js';
import { getLanguage, onLanguageChange } from './i18n.js';

const words = (zh, en) => getLanguage() === 'zh' ? zh : en;
const listeners = new Set();
const knownNotes = new Set();
const loadingNotes = new Set();
const noteReadErrors = new Set();
const noteTimers = new Map();
const noteVersions = new Map();
const itemCache = new Map();
const failures = new Map();
let loadPromise;
let loaded = false;
let writes = Promise.resolve();
let pendingCount = 0;
let initialized = false;
let userId = '';
let frame = 0;

export async function publishingRequest(path, options = {}) {
  const { body, ...rest } = options;
  const response = await fetch(`/api/publishing${path}`, {
    credentials: 'same-origin',
    ...rest,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...rest.headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || data.message || words(`请求失败（${response.status}）`, `Request failed (${response.status})`));
    error.status = response.status;
    throw error;
  }
  return data;
}

const state = {
  enabled: false,
  workspace: { selected_ids: [], brief: '' },
  items: [],
  notes: {},
  limits: { max_items: 20 },
  error: '',
};

function emit() {
  for (const listener of listeners) {
    try { listener(state); } catch (error) { console.warn('Publishing view:', error.message); }
  }
  syncChrome();
}

function mergeNotes(notes = {}) {
  for (const [id, value] of Object.entries(notes)) {
    if (!noteVersions.has(id)) state.notes[id] = value;
    knownNotes.add(id);
    noteReadErrors.delete(id);
  }
}

function mergeItems(items = []) {
  for (const item of items) itemCache.set(item.id, item);
  state.items = state.workspace.selected_ids.map(id => itemCache.get(id) || { id, title: id });
}

function enqueue(key, work) {
  pendingCount += 1;
  const operation = writes.then(work).then(result => {
    failures.delete(key);
    state.error = failures.values().next().value || '';
    return result;
  }).catch(error => {
    failures.set(key, error.message);
    state.error = error.message;
    throw error;
  }).finally(() => {
    pendingCount -= 1;
    emit();
  });
  // Keep the queue usable after a failed request; flush still reports failures.
  writes = operation.catch(() => {});
  emit();
  return operation;
}

async function ready() {
  if (loaded) return state;
  if (!loadPromise) {
    loadPromise = publishingRequest('/workspace').then(data => {
      state.workspace = { selected_ids: [], brief: '', ...data.workspace };
      state.limits = { max_items: 20, ...data.limits };
      mergeNotes(data.notes);
      mergeItems(data.items);
      loaded = true;
      state.error = '';
      emit();
      return state;
    }).catch(error => {
      state.error = error.message;
      emit();
      throw error;
    }).finally(() => { loadPromise = null; });
  }
  return loadPromise;
}

async function updateWorkspace(patch) {
  await ready();
  Object.assign(state.workspace, patch);
  const snapshot = { selected_ids: [...state.workspace.selected_ids], brief: state.workspace.brief };
  mergeItems();
  emit();
  return enqueue('workspace', async () => {
    const data = await publishingRequest('/workspace', { method: 'PUT', body: snapshot });
    // Newer optimistic choices can already be queued: never replace them with
    // the response to an older change. Only enrich the selected item cache.
    mergeItems(data.items);
    mergeNotes(data.notes);
    return state;
  });
}

async function saveNote(id, value) {
  await ready();
  const note = { note: String(value.note || ''), excerpt: String(value.excerpt || '') };
  const version = (noteVersions.get(id) || 0) + 1;
  noteVersions.set(id, version);
  state.notes[id] = note;
  knownNotes.add(id);
  emit();
  return enqueue(`note:${id}`, async () => {
    const data = await publishingRequest(`/notes/${encodeURIComponent(id)}`, { method: 'PUT', body: note });
    if (noteVersions.get(id) === version) {
      state.notes[id] = data.note || note;
      noteVersions.delete(id);
    }
    return state.notes[id];
  });
}

function scheduleNote(id, value) {
  clearTimeout(noteTimers.get(id));
  state.notes[id] = value;
  // Protect a just-typed note from a slower GET response before autosave starts.
  noteVersions.set(id, (noteVersions.get(id) || 0) + 1);
  noteTimers.set(id, setTimeout(() => {
    noteTimers.delete(id);
    saveNote(id, state.notes[id]).catch(() => {});
  }, 650));
  emit();
}

async function flush() {
  const ids = [...noteTimers.keys()];
  for (const id of ids) {
    clearTimeout(noteTimers.get(id));
    noteTimers.delete(id);
  }
  await Promise.all(ids.map(id => saveNote(id, state.notes[id])));
  await writes;
  if (failures.size) throw new Error([...failures.values()].join('；'));
}

export const publishing = {
  state,
  ready,
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async setSelection(ids) {
    await ready();
    const unique = [...new Set(ids.map(String).filter(Boolean))];
    if (unique.length > state.limits.max_items) throw new Error(words(`一篇最多选择 ${state.limits.max_items} 条素材。`, `Select up to ${state.limits.max_items} items per draft.`));
    return updateWorkspace({ selected_ids: unique });
  },
  setBrief(brief) { return updateWorkspace({ brief: String(brief || '') }); },
  saveNote,
  flush,
  async retry() {
    if (failures.has('workspace')) await updateWorkspace({ ...state.workspace });
    for (const key of [...failures.keys()]) {
      if (key.startsWith('note:')) await saveNote(key.slice(5), state.notes[key.slice(5)] || {});
    }
    await flush();
  },
  async reload() {
    await flush();
    loaded = false;
    return ready();
  },
  async setEnabled(enabled) {
    if (enabled) await ready();
    else await flush();
    state.enabled = !!enabled;
    try { sessionStorage.setItem(`eagleye-editor:${userId}`, String(state.enabled)); } catch { /* Optional preference only. */ }
    emit();
    if (enabled) mountEditors();
  },
};

function statusFor(id) {
  if (failures.has(`note:${id}`)) return words('未保存，点击重试', 'Not saved — retry');
  if (noteTimers.has(id) || noteVersions.has(id)) return words('保存中…', 'Saving…');
  if (noteReadErrors.has(id)) return words('批注读取失败，请重试', 'Could not load note — retry');
  if (!knownNotes.has(id)) return words('读取批注中…', 'Loading note…');
  return state.notes[id]?.note || state.notes[id]?.excerpt ? words('批注已保存', 'Note saved') : words('仅你可见，选入稿件后参与写作', 'Private; used only when selected for a draft');
}

function syncChrome() {
  if (typeof document === 'undefined') return;
  document.body.classList.toggle('editor-mode', state.enabled);
  document.querySelectorAll('[data-editor-toggle]').forEach(button => {
    button.setAttribute('aria-checked', String(state.enabled));
    button.classList.toggle('is-active', state.enabled);
    button.textContent = state.enabled ? words('编辑模式 · 开', 'Edit mode · On') : words('编辑模式', 'Edit mode');
  });
  const dock = document.getElementById('publishingSelectionDock');
  if (dock) {
    dock.hidden = !state.enabled || document.body.classList.contains('auth-page') || window.location.pathname === '/publishing';
    dock.querySelector('[data-editor-count]').textContent = words(`已选 ${state.workspace.selected_ids.length} 条`, `${state.workspace.selected_ids.length} selected`);
    const status = dock.querySelector('[data-editor-status]');
    status.textContent = state.error || (pendingCount || noteTimers.size ? words('正在保存…', 'Saving…') : words('选择可以跨日期、跨页面组合', 'Combine selections across dates and pages'));
    status.classList.toggle('editor-error', !!state.error);
    dock.querySelector('[data-editor-compose]').textContent = words('组合成稿 →', 'Compose →');
    dock.querySelector('[data-editor-retry-all]').hidden = !failures.size;
  }
  document.querySelectorAll('[data-editor-panel]').forEach(panel => {
    const id = panel.dataset.editorPanel;
    const checkbox = panel.querySelector('[data-editor-select]');
    checkbox.checked = state.workspace.selected_ids.includes(id);
    panel.closest('[data-editor-item-id]')?.classList.toggle('editor-selected', checkbox.checked);
    for (const key of ['note', 'excerpt']) {
      const field = panel.querySelector(`[data-editor-field="${key}"]`);
      if (document.activeElement !== field) field.value = state.notes[id]?.[key] || '';
      field.disabled = !knownNotes.has(id) && !noteVersions.has(id);
    }
    const noteStatus = panel.querySelector('[data-editor-note-status]');
    noteStatus.textContent = statusFor(id);
    noteStatus.classList.toggle('editor-error', failures.has(`note:${id}`) || noteReadErrors.has(id));
    const retry = panel.querySelector('[data-editor-retry]');
    retry.hidden = !failures.has(`note:${id}`) && !noteReadErrors.has(id);
    retry.textContent = knownNotes.has(id) ? words('重试保存', 'Retry saving') : words('重新读取', 'Retry loading');
  });
}

async function loadNotes(ids) {
  const missing = [...new Set(ids)].filter(id => !knownNotes.has(id) && !loadingNotes.has(id));
  for (const id of missing) { loadingNotes.add(id); noteReadErrors.delete(id); }
  if (missing.length) emit();
  for (let offset = 0; offset < missing.length; offset += 20) {
    const batch = missing.slice(offset, offset + 20);
    try {
      const data = await publishingRequest(`/notes?ids=${encodeURIComponent(batch.join(','))}`);
      mergeNotes(data.notes);
      batch.forEach(id => { knownNotes.add(id); if (!state.notes[id]) state.notes[id] = { note: '', excerpt: '' }; });
    } catch (error) {
      batch.forEach(id => noteReadErrors.add(id));
      state.error = error.message;
    } finally {
      batch.forEach(id => loadingNotes.delete(id));
      if (!noteReadErrors.size && !failures.size) state.error = '';
      emit();
    }
  }
}

function mountEditors() {
  if (!state.enabled || !loaded) return;
  const ids = [];
  document.querySelectorAll('#pageContent [data-editor-item-id]').forEach(card => {
    const id = card.dataset.editorItemId;
    if (!id) return;
    ids.push(id);
    if (card.querySelector('[data-editor-panel]')) return;
    const panel = document.createElement('div');
    panel.className = 'editor-card-panel';
    panel.dataset.editorPanel = id;
    panel.innerHTML = `
      <label class="editor-select-label"><input type="checkbox" data-editor-select><span>${words('选入本次稿件', 'Add to this draft')}</span></label>
      <label class="editor-note-label"><span>${words('我的看法', 'My take')}</span><textarea data-editor-field="note" rows="3" maxlength="4000" placeholder="${escapeAttr(words('哪里打动了你？一句话、一个联想也可以。', 'What caught your eye? A sentence or an association is enough.'))}"></textarea></label>
      <details class="editor-excerpt"><summary>${words('只引用其中一段', 'Use a specific excerpt')}</summary><label><span class="sr-only">${words('摘录', 'Excerpt')}</span><textarea data-editor-field="excerpt" rows="3" maxlength="8000" placeholder="${escapeAttr(words('粘贴你关注的原文片段；留空则使用这条素材。', 'Paste the source passage you want to use, or leave blank for the whole item.'))}"></textarea></label></details>
      <div class="editor-note-footer"><span data-editor-note-status role="status"></span><button type="button" class="action-btn" data-editor-retry hidden>${words('重试保存', 'Retry')}</button></div>`;
    panel.addEventListener('click', event => event.stopPropagation());
    panel.addEventListener('input', event => {
      if (!event.target.matches('[data-editor-field]')) return;
      const value = {
        note: panel.querySelector('[data-editor-field="note"]').value,
        excerpt: panel.querySelector('[data-editor-field="excerpt"]').value,
      };
      scheduleNote(id, value);
    });
    panel.querySelector('[data-editor-select]').addEventListener('change', async event => {
      const selected = new Set(state.workspace.selected_ids);
      if (event.target.checked) selected.add(id); else selected.delete(id);
      try { await publishing.setSelection([...selected]); }
      catch (error) { state.error = error.message; emit(); }
    });
    panel.querySelector('[data-editor-retry]').addEventListener('click', () => {
      if (!knownNotes.has(id)) loadNotes([id]);
      else saveNote(id, state.notes[id] || {}).catch(() => {});
    });
    card.appendChild(panel);
  });
  syncChrome();
  loadNotes(ids);
}

export function initPublishingEditor(currentUser) {
  if (initialized || !currentUser?.id) return;
  initialized = true;
  userId = currentUser.id;
  const dock = document.createElement('aside');
  dock.id = 'publishingSelectionDock';
  dock.className = 'editor-selection-dock';
  dock.hidden = true;
  dock.setAttribute('aria-label', words('本次创作选材', 'Draft selection'));
  dock.innerHTML = `<div><strong data-editor-count></strong><span data-editor-status role="status"></span><button type="button" class="action-btn" data-editor-retry-all hidden>${words('重试保存', 'Retry saving')}</button></div><button type="button" class="editor-compose-button" data-editor-compose></button>`;
  document.body.appendChild(dock);
  dock.querySelector('[data-editor-retry-all]').addEventListener('click', async () => {
    try {
      if (failures.has('workspace')) await updateWorkspace({ ...state.workspace });
      for (const key of [...failures.keys()]) {
        if (key.startsWith('note:')) await saveNote(key.slice(5), state.notes[key.slice(5)] || {});
      }
    } catch { /* The queue keeps the specific error visible until saved. */ }
  });
  dock.querySelector('[data-editor-compose]').addEventListener('click', async () => {
    try {
      await flush();
      window.__router?.navigate('/publishing');
    } catch (error) { state.error = error.message; emit(); }
  });
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-editor-toggle]');
    if (!button) return;
    button.disabled = true;
    try { await publishing.setEnabled(!state.enabled); }
    catch (error) {
      state.error = error.message;
      // An off-state failure still needs to be visible near the switch.
      const notice = document.querySelector('[data-editor-home-status]');
      if (notice) notice.textContent = error.message;
      else window.alert(error.message);
      emit();
    } finally { button.disabled = false; }
  });
  const observer = new MutationObserver(records => {
    if (!records.some(record => [...record.addedNodes].some(node => node.nodeType === 1 &&
      (node.matches?.('[data-editor-item-id], [data-editor-toggle]') || node.querySelector?.('[data-editor-item-id], [data-editor-toggle]'))))) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { mountEditors(); syncChrome(); });
  });
  const container = document.getElementById('pageContent');
  if (container) observer.observe(container, { childList: true, subtree: true });
  window.addEventListener('beforeunload', event => {
    if (!pendingCount && !noteTimers.size && !failures.size) return;
    event.preventDefault();
    event.returnValue = '';
  });
  onLanguageChange(() => {
    document.querySelectorAll('[data-editor-panel]').forEach(panel => panel.remove());
    mountEditors();
    syncChrome();
  });
  let restore = false;
  try { restore = sessionStorage.getItem(`eagleye-editor:${userId}`) === 'true'; } catch { /* Optional preference only. */ }
  if (restore) publishing.setEnabled(true).catch(() => {});
  syncChrome();
}

export function publishingHomeToolbar() {
  return `<div class="editor-home-toolbar"><div><strong>${escapeHtml(words('把发现变成自己的表达', 'Make a discovery your own'))}</strong><p data-editor-home-status>${escapeHtml(words('打开编辑模式，给卡片留一句评论，再挑几条组合成稿。', 'Turn on edit mode, leave a thought on a card, and combine your selections into a draft.'))}</p></div><div class="editor-home-actions"><button type="button" role="switch" aria-checked="false" class="editor-mode-toggle" data-editor-toggle>${words('编辑模式', 'Edit mode')}</button><a href="/publishing">${words('我的草稿', 'My drafts')} →</a></div></div>`;
}

export function refreshPublishingEditor() {
  syncChrome();
  mountEditors();
}
