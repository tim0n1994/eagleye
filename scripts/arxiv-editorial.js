#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const sharp = require('sharp');
const { parseTweet } = require('twitter-text');
const { diagram, publishingDraft, publicationZIP } = require('../server/services/arxiv-editorial-output');
const { writeDate, getCandidates, selectionMarkdown, composeEdition, validateEdition } = require('../server/services/arxiv-editorial');

async function exists(file) {
  try { await fs.access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function atomicFile(filepath, data) {
  const temp = filepath + '.' + process.pid + '.tmp';
  await fs.writeFile(temp, data, { mode: 0o600, flag: 'wx' });
  try { await fs.rename(temp, filepath); } finally { await fs.unlink(temp).catch(() => {}); }
}

function reviewNotes(edition) {
  return [
    '# 发布前核对', '',
    '逐条核对数字、基线、任务范围和结论语气。原文由程序按段落编号附上，解读含义仍需人工核对。', '',
    ...edition.papers.flatMap(p => [
      '## ' + p.title, '',
      '版本 [' + p.version + '](' + p.url + ') · ' + ({ html: 'HTML 正文', pdf: 'PDF 前 24 页', abstract: '仅有摘要' }[p.mode]), '',
    ]),
    ...edition.evidence.flatMap(e => [
      '### ' + e.id + ' · arXiv:' + e.paper_id + ' · ' + e.locator, '', e.claim, '', '> ' + e.quote, '',
    ]),
  ].join('\n');
}

function compactEdition(edition) {
  const { title, summary } = edition.wechat;
  return { ...edition, x: edition.x.map(({ text, link_id, evidence_ids }) => ({ text, link_id, evidence_ids })), wechat: { title, summary } };
}

async function pack(dir, coverFile) {
  const file = JSON.parse(await fs.readFile(path.join(dir, '稿件.json'), 'utf8'));
  file.wechat.markdown = await fs.readFile(path.join(dir, '公众号正文.md'), 'utf8');
  const { evidence, ...edition } = validateEdition(file, file.papers, file.evidence);
  const coverPath = coverFile ? path.resolve(coverFile) : path.join(dir, '封面.png');
  const jpeg = await sharp(coverPath, { limitInputPixels: 25000000 })
    .rotate().flatten({ background: '#f5f0e7' }).resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 }).toBuffer();
  const draft = publishingDraft({ ...edition, evidence, papers: file.papers }, {
    x: { body: jpeg, ext: 'jpg' }, wechat: { body: jpeg, ext: 'jpg' }, 'card-0': { body: jpeg, ext: 'jpg' },
  }, coverFile ? '配图' : '解读示意图，实验数据见原论文。');
  await atomicFile(path.join(dir, '三平台发布包.zip'), await publicationZIP(draft));
  await atomicFile(path.join(dir, 'X-预览.txt'), edition.x.map(post => `[${parseTweet(post.ready_text).weightedLength}/280]\n${post.ready_text}`).join('\n\n'));
}

async function coveredIds(root, date) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const days = entries.filter(entry => entry.isDirectory() && /^\d{4}-\d\d-\d\d$/.test(entry.name) && entry.name < date)
    .map(entry => entry.name).sort().reverse().slice(0, 14);
  const ids = new Set();
  for (const day of days) {
    const file = path.join(root, day, '成稿', '稿件.json');
    if (await exists(file)) {
      const edition = JSON.parse(await fs.readFile(file, 'utf8'));
      for (const paper of edition.papers) ids.add(paper.id);
    }
  }
  return ids;
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    db: { type: 'string' }, out: { type: 'string' }, date: { type: 'string' }, picks: { type: 'string' },
    focus: { type: 'string' }, angle: { type: 'string' }, 'angle-file': { type: 'string' },
    cover: { type: 'string' }, dir: { type: 'string' },
  } });
  const [command] = positionals;
  if (command === 'pack') {
    if (!values.dir) throw new Error('pack 需要 --dir 指向成稿目录');
    await pack(path.resolve(values.dir), values.cover);
    console.log('已重打包', path.resolve(values.dir, '三平台发布包.zip'));
    return;
  }
  if (!['shortlist', 'compose', 'daily'].includes(command) || !values.out) {
    throw new Error('用法: arxiv-editorial.js shortlist|daily --db FILE --out DIR | compose --out DIR --picks ID[,ID] | pack --dir DIR');
  }
  const date = values.date || writeDate();
  if (!/^\d{4}-\d\d-\d\d$/.test(date) || Number.isNaN(Date.parse(date))) throw new Error('日期需要 YYYY-MM-DD');
  const root = path.resolve(values.out);
  const dir = path.join(root, date);
  const draftDir = path.join(dir, '成稿');
  await fs.mkdir(dir, { mode: 0o700, recursive: true });
  const slateFile = path.join(dir, '候选.json');
  if (command !== 'compose' && !await exists(slateFile)) {
    const dbPath = values.db || process.env.EAGLEYE_DB_PATH;
    if (!dbPath) throw new Error('需要 --db 或 EAGLEYE_DB_PATH 指向 Eagleye 数据库');
    const cutoff = new Date(Date.now() - 48 * 3600000).toISOString();
    const focus = values.focus?.split(',').map(s => s.toLowerCase().trim()).filter(Boolean);
    const papers = getCandidates(path.resolve(dbPath), { focus, collectedSince: cutoff, exclude: await coveredIds(root, date) });
    const slate = { date, collected_since: cutoff, papers };
    await atomicFile(slateFile, JSON.stringify(slate, null, 2) + '\n');
    await atomicFile(path.join(dir, '选题清单.md'), selectionMarkdown(slate));
    console.log('候选已保存', date, papers.length);
  }
  if (command === 'shortlist') return;
  if (await exists(draftDir)) {
    if (command === 'daily') {
      if (!await exists(path.join(draftDir, '三平台发布包.zip'))) await pack(draftDir);
      console.log('已保留该期现有成稿', date);
      return;
    }
    throw new Error('该期成稿已存在。请编辑后使用 pack，或用单独的输出目录重选。');
  }
  const slate = JSON.parse(await fs.readFile(slateFile, 'utf8'));
  if (!slate.papers.length) { console.log('入库窗口内没有满足条件的新论文，跳过'); return; }
  const auto = command === 'daily';
  const ids = [...new Set(values.picks?.split(',').map(id => id.trim()).filter(Boolean))];
  const papers = auto ? slate.papers.slice(0, 3) : ids.map(id => slate.papers.find(paper => paper.arxiv_id === id));
  if (!papers.length || papers.length > 3 || papers.some(p => !p)) throw new Error('请从该期候选里指定 1–3 个 arXiv ID');
  const angle = values.angle ?? (values['angle-file'] ? await fs.readFile(values['angle-file'], 'utf8') : '');
  if (angle.length > 2000) throw new Error('作者观察最多 2000 字');
  const edition = await composeEdition(papers, { angle, auto, onStatus: status => console.log('论文证据', JSON.stringify(status)) });
  if (!edition) { console.log('候选暂缺可回查的正文证据，保留选题清单供审阅'); return; }
  const temp = await fs.mkdtemp(path.join(dir, '.draft-'));
  try {
    await fs.writeFile(path.join(temp, '稿件.json'), JSON.stringify({ date, ...compactEdition(edition) }, null, 2) + '\n', { mode: 0o600 });
    await fs.writeFile(path.join(temp, '公众号正文.md'), edition.wechat.markdown + '\n', { mode: 0o600 });
    await fs.writeFile(path.join(temp, '证据与审稿.md'), reviewNotes(edition), { mode: 0o600 });
    await fs.writeFile(path.join(temp, '封面.png'), await diagram(edition.cover, date), { mode: 0o600 });
    await fs.rename(temp, draftDir);
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true });
    throw error;
  }
  await pack(draftDir);
  console.log('成稿待审', draftDir);
}

if (require.main === module) {
  main().catch(error => { console.error('arXiv 精选：' + error.message); process.exitCode = 1; });
}
