const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { getValue, setValue } = require('../db/user-data');
const { composeEdition, validateEdition, writeDate, ARTICLE_CITATION_ERROR } = require('./arxiv-editorial');
const { diagram, publishingDraft, publicationZIP } = require('./arxiv-editorial-output');
const { prepareImageUpload } = require('./publishing-media');
const { renderCard, renderWechat } = require('./publishing-render');

const DATE = /^\d{4}-\d\d-\d\d$/;
const SLOT = /^(?:x|wechat|card-[0-5])$/;
const ORIGINAL = 'background';
const jobs = new Map();

function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}

function root() {
  return process.env.EAGLEYE_ARXIV_EDITORIAL_DIR || path.join(os.homedir(), '.local/share/eagleye/arxiv-editorial');
}

function dateValue(value) {
  if (typeof value !== 'string' || !DATE.test(value) || new Date(value).toJSON()?.slice(0, 10) !== value) {
    fail(400, '请选择有效的期次日期。');
  }
  return value;
}

async function optional(read) {
  try { return await read(); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function dates() {
  return ((await optional(() => fs.readdir(root(), { withFileTypes: true }))) || [])
    .filter(entry => entry.isDirectory() && DATE.test(entry.name))
    .map(entry => entry.name).sort().reverse();
}

async function inputs(date) {
  const dir = path.join(root(), date);
  const candidates = await optional(() => fs.readFile(path.join(dir, '候选.json'), 'utf8'));
  if (!candidates) return { candidates: [], background: null };
  // The timer publishes the draft directory with a single rename after all
  // source files are present. The workspace never writes into that directory.
  const draftDir = path.join(dir, '成稿');
  const manifest = await optional(() => fs.readFile(path.join(draftDir, '稿件.json'), 'utf8'));
  let background = null;
  if (manifest) {
    background = JSON.parse(manifest);
    background.wechat.markdown = await fs.readFile(path.join(draftDir, '公众号正文.md'), 'utf8');
  }
  return { candidates: JSON.parse(candidates).papers, background };
}

function workspace(user, date) {
  return getValue('arxiv_editorial:' + date, user) || {
    selection: null, notes: {}, angle: '', active: ORIGINAL, revision: 0, edits: {}, drafts: {}, error: '',
  };
}

function store(user, date, state) {
  setValue('arxiv_editorial:' + date, state, user);
}

function baseFor(state, background, id) {
  return id === ORIGINAL ? background : state.drafts[id];
}

function workspaceDir(user, date, id) {
  const owner = createHash('sha256').update(user).digest('hex');
  return path.join(root(), '.workspaces', owner, date, id);
}

function text(value, max) {
  if (typeof value !== 'string' || value.length > max) fail(400, '编辑内容的格式或长度超出范围。');
  return value;
}

function displayDraft(state, base, id) {
  if (!base) return null;
  const edits = state.edits[id];
  return {
    ...base, id,
    x: base.x.map((post, i) => ({ ...post, text: edits?.x[i] ?? post.text })),
    wechat: { ...base.wechat, ...edits?.wechat },
    xiaohongshu: { ...base.xiaohongshu, ...edits?.xiaohongshu,
      cards: base.xiaohongshu.cards.map((card, i) => ({ ...card, ...edits?.xiaohongshu.cards[i] })) },
    reviewed: edits?.reviewed || [],
    images: edits?.images || {},
    caption: edits?.caption ?? '解读示意图，实验数据见原论文。',
    revision: edits?.revision || 0,
  };
}

async function readEdition(user, requested) {
  const available = await dates();
  const date = requested ? dateValue(requested) : available[0] || writeDate();
  const { candidates, background } = await inputs(date);
  const state = workspace(user, date);
  const versions = Object.entries(state.drafts).reverse().map(([id, draft]) => ({ id, title: draft.wechat.title, time: draft.created_at }));
  if (background) versions.push({ id: ORIGINAL, title: background.wechat.title });
  const active = baseFor(state, background, state.active) ? state.active : versions[0]?.id || ORIGINAL;
  const job = jobs.get(user);
  return {
    date, today: writeDate(), dates: available, candidates, versions,
    selection: state.selection ?? background?.papers.map(p => p.id) ?? [],
    notes: state.notes, angle: state.angle, revision: state.revision, active,
    draft: displayDraft(state, baseFor(state, background, active), active),
    job: job?.date === date ? job.phase : '', busy: Boolean(job),
    error: (state.generating && job?.date !== date) ? '上次生成已中断，现有选材和各版草稿已保留。' : state.error,
  };
}

async function saveWorkspace(user, date, body) {
  const { candidates, background } = await inputs(date);
  const state = workspace(user, date);
  if (body.revision !== state.revision) fail(409, '工作区已在另一窗口更新，请刷新后再保存。');
  const ids = new Set(candidates.map(candidate => candidate.arxiv_id));
  if (!Array.isArray(body.selection) || body.selection.length > 3 ||
      body.selection.some(id => !ids.has(id)) || new Set(body.selection).size !== body.selection.length ||
      !body.notes || typeof body.notes !== 'object' || Array.isArray(body.notes)) {
    fail(400, '请从当期候选里选择最多三篇论文。');
  }
  const notes = {};
  for (const id of ids) {
    if (Object.hasOwn(body.notes, id)) notes[id] = text(body.notes[id], 1000);
  }
  const active = body.active === ORIGINAL || Object.hasOwn(state.drafts, body.active) ? body.active : state.active;
  if (active !== ORIGINAL && !baseFor(state, background, active)) fail(404, '草稿不存在。');
  store(user, date, { ...state, selection: body.selection, notes, angle: text(body.angle, 2000), active, revision: state.revision + 1 });
  return { revision: state.revision + 1 };
}

async function target(user, date, id) {
  if (id !== ORIGINAL && (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) fail(404, '草稿不存在。');
  const { background } = await inputs(date);
  const state = workspace(user, date);
  const base = baseFor(state, background, id);
  if (!base) fail(404, '草稿不存在。');
  return { state, base, draft: displayDraft(state, base, id) };
}

function imageSlot(base, slot) {
  if (typeof slot !== 'string' || !SLOT.test(slot) ||
      (slot.startsWith('card-') && Number(slot.slice(5)) >= base.xiaohongshu.cards.length)) fail(404, '没有这个配图位置。');
}

function uploadPath(user, date, id, slot) {
  return path.join(workspaceDir(user, date, id), slot + '.jpg');
}

async function saveDraft(user, date, id, body) {
  const { base, draft } = await target(user, date, id);
  if (body.revision !== draft.revision) fail(409, '这份草稿已在另一窗口更新，请刷新后再保存。');
  if (!Array.isArray(body.x) || body.x.length !== base.x.length ||
      !Array.isArray(body.xiaohongshu?.cards) || body.xiaohongshu.cards.length !== base.xiaohongshu.cards.length) {
    fail(400, '稿件条数与原稿不符。');
  }
  const images = {};
  for (const [slot, mode] of Object.entries(body.images || {})) {
    imageSlot(base, slot);
    if (!['default', 'none', 'upload'].includes(mode)) fail(400, '配图选项无效。');
    if (mode === 'upload' && !await optional(() => fs.access(uploadPath(user, date, id, slot)).then(() => true))) {
      fail(400, '请先上传该位置的配图。');
    }
    images[slot] = mode;
  }
  const xiaohongshu = body.xiaohongshu;
  const edit = {
    x: body.x.map(post => text(post, 400)),
    wechat: { title: text(body.wechat?.title, 100), summary: text(body.wechat?.summary, 250),
      markdown: text(body.wechat?.markdown, 4000) },
    xiaohongshu: { title: text(xiaohongshu.title, 20), caption: text(xiaohongshu.caption, 900),
      tags: Array.isArray(xiaohongshu.tags) ? xiaohongshu.tags.slice(0, 8).map(tag => text(tag, 24)) : [],
      cards: xiaohongshu.cards.map(card => ({ title: text(card?.title, 34), body: text(card?.body, 155) })) },
    caption: text(body.caption, 250),
    reviewed: Array.isArray(body.reviewed) ? base.evidence.map(e => e.id).filter(e => body.reviewed.includes(e)) : [],
    images, revision: draft.revision + 1,
  };
  // Re-read after asynchronous file checks to avoid clobbering notes or a
  // revision saved by a different tab while those checks were in progress.
  const current = workspace(user, date);
  if ((current.edits[id]?.revision || 0) !== draft.revision) fail(409, '草稿刚被更新，请刷新后重试。');
  store(user, date, { ...current, edits: { ...current.edits, [id]: edit } });
  return { draft: displayDraft({ ...current, edits: { ...current.edits, [id]: edit } }, base, id) };
}

async function atomic(filepath, data) {
  const temp = filepath + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temp, data, { mode: 0o600, flag: 'wx' });
  try { await fs.rename(temp, filepath); }
  finally { await fs.unlink(temp).catch(() => {}); }
}

async function upload(user, date, id, slot, body) {
  const { base, draft } = await target(user, date, id);
  imageSlot(base, slot);
  if (body.revision !== draft.revision) fail(409, '草稿已被更新，请刷新后重试。');
  const processed = await prepareImageUpload(body.data_base64);
  await fs.mkdir(workspaceDir(user, date, id), { mode: 0o700, recursive: true });
  const state = workspace(user, date);
  if ((state.edits[id]?.revision || 0) !== draft.revision) fail(409, '草稿已被更新，请刷新后重试。');
  await atomic(uploadPath(user, date, id, slot), processed.data);
  return { ok: true };
}

async function generate(user, date) {
  const { candidates, background } = await inputs(date);
  if (jobs.has(user)) fail(409, '已有一期在生成，请等待完成。');
  const state = workspace(user, date);
  const selection = state.selection ?? background?.papers.map(p => p.id) ?? [];
  const chosen = selection.map(id => candidates.find(candidate => candidate.arxiv_id === id));
  if (!chosen.length || chosen.some(candidate => !candidate)) fail(400, '请先为本期选择一至三篇论文。');
  const job = { date, phase: '正在读取论文原文' };
  store(user, date, { ...state, error: '', generating: true });
  jobs.set(user, job);
  const id = randomUUID();
  void (async () => {
    try {
      const draft = await composeEdition(chosen, { angle: state.angle, notes: state.notes, onStatus: rows => {
        const { stage, issue } = rows[0] || {};
        if (issue) console.info('arXiv editorial repair:', date, stage, issue);
        job.phase = ({
          article_repair: '正在核对公众号原文引用',
          repair: '正在校对三平台稿件',
        })[stage] || '正在撰写三平台稿件';
      } });
      job.phase = '正在生成配图';
      await fs.mkdir(workspaceDir(user, date, id), { mode: 0o700, recursive: true });
      await atomic(path.join(workspaceDir(user, date, id), 'cover.png'), await diagram(draft.cover, date));
      const current = workspace(user, date);
      store(user, date, { ...current, drafts: { ...current.drafts, [id]: { ...draft, created_at: new Date().toISOString() } },
        error: '', generating: false });
    } catch (error) {
      console.warn('arXiv editorial generation:', date, job.phase, error.code || '', error.message);
      const current = workspace(user, date);
      const reason = error.code === ARTICLE_CITATION_ERROR ? '公众号正文的原文引用未通过校验' : '生成失败';
      store(user, date, { ...current, generating: false, error: reason + '，选材、批注和各版草稿已保留，可以重试。' });
    } finally { jobs.delete(user); }
  })().catch(error => console.error('arXiv editorial workspace:', error.message));
  return { job: job.phase };
}

async function readImage(user, date, id, slot, mode) {
  if (mode === 'none') return null;
  if (mode === 'upload') {
    const body = await optional(() => fs.readFile(uploadPath(user, date, id, slot)));
    return body ? { body, ext: 'jpg' } : null;
  }
  if (mode !== 'default' && slot !== 'x' && slot !== 'wechat' && slot !== 'card-0') return null;
  const cover = id === ORIGINAL ? path.join(root(), date, '成稿', '封面.png') : path.join(workspaceDir(user, date, id), 'cover.png');
  const body = await optional(() => fs.readFile(cover));
  return body ? { body, ext: 'png' } : null;
}

async function image(user, date, id, slot, mode) {
  const { base, draft } = await target(user, date, id);
  imageSlot(base, slot);
  const asset = await readImage(user, date, id, slot, mode || draft.images[slot]);
  if (!asset) fail(404, '该位置没有配图。');
  return asset;
}

async function render(user, date, id, format, index) {
  const { draft } = await target(user, date, id);
  const slots = format === 'card' ? ['card-' + index] : format === 'wechat' ? ['wechat']
    : ['x', 'wechat', ...draft.xiaohongshu.cards.map((_, i) => 'card-' + i)];
  for (const slot of slots) imageSlot(draft, slot);
  const assets = Object.fromEntries(await Promise.all(slots.map(async slot => [slot, await readImage(user, date, id, slot, draft.images[slot])])));
  if (format === 'wechat') return { body: await renderWechat(publishingDraft(draft, assets, draft.caption)), type: 'text/html; charset=utf-8' };
  if (format === 'card') return { body: await renderCard(publishingDraft(draft, assets, draft.caption), Number(index)), type: 'image/png' };
  if (!assets.x || !assets.wechat || !slots.some(slot => slot.startsWith('card-') && assets[slot])) {
    fail(409, '请给 X、公众号及至少一张小红书图卡选一张配图，再下载三平台发布包。');
  }
  let edition;
  try { edition = validateEdition(draft, draft.papers, draft.evidence); }
  catch (error) { fail(422, error.message); }
  return { body: await publicationZIP(publishingDraft({ ...edition, papers: draft.papers }, assets, draft.caption)),
    type: 'application/zip', filename: 'Eagleye-arXiv-' + date + '.zip' };
}

module.exports = { readEdition, saveWorkspace, saveDraft, generate, dateValue, image, upload, render };
