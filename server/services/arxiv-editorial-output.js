const { renderAsync } = require('@resvg/resvg-js');
const JSZip = require('jszip');
const { exportDraft } = require('./publishing-render');

function escapeSvg(text) {
  return String(text).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
}

async function diagram(cover, date) {
  const rows = [
    ['问题', cover.problem],
    ['机制', cover.mechanism],
    ['边界', cover.boundary],
  ];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="680" viewBox="0 0 1080 680">
  <rect width="1080" height="680" fill="#182920"/>
  <text x="70" y="90" fill="#a8cdb2" font-family="sans-serif" font-size="29">arXiv 论文笔记 / ${escapeSvg(date)}</text>
  <path d="M104 209V542" stroke="#6daa7c" stroke-width="4"/>
  ${rows.map(([label, value], i) => {
    const y = 150 + i * 154;
    const chars = Array.from(value);
    const words = chars.length > 40 ? [...chars.slice(0, 39), '…'] : chars;
    const lines = words.length > 20 ? [words.slice(0, 20).join(''), words.slice(20).join('')] : [words.join('')];
    return `<rect x="72" y="${y}" width="936" height="120" rx="12" fill="#243c30" stroke="#4d745b" stroke-width="2"/>
      <circle cx="105" cy="${y + 60}" r="7" fill="#c6edb8"/>
      <text x="134" y="${y + 72}" font-family="sans-serif" font-size="36" fill="#c6edb8">${label}</text>
      <text font-family="sans-serif" font-size="34" fill="#fbfff4">${lines.map((line, j) => `<tspan x="252" y="${y + (lines.length === 1 ? 73 : 50 + j * 43)}">${escapeSvg(line)}</tspan>`).join('')}</text>`;
  }).join('')}
  <text x="72" y="643" fill="#a8cdb2" font-family="sans-serif" font-size="23">解读示意 · 数据与实验见原论文</text>
  </svg>`;
  const font = process.env.EAGLEYE_PUBLISHING_FONT?.trim();
  return (await renderAsync(svg, { font: {
    loadSystemFonts: true, ...(font ? { fontFiles: [font] } : {}),
    defaultFontFamily: 'Noto Sans CJK SC', sansSerifFamily: 'Noto Sans CJK SC',
  } })).asPng();
}

function publishingDraft(edition, assets, caption) {
  const sources = edition.papers.map(paper => ({
    id: paper.id, title: paper.title, url: paper.url, source_label: 'arXiv · 预印本',
    evidence_level: paper.mode === 'abstract' ? 'source_summary' : 'raw_content',
  }));
  const links = new Map(edition.evidence.map(entry => [entry.id, entry.url]));
  const images = Object.entries(assets).filter(([, asset]) => asset).map(([id, asset]) => {
    const mime = asset.ext === 'png' ? 'image/png' : 'image/jpeg';
    return { id, filename: id + '.' + asset.ext, mime_type: mime, origin: 'upload',
      data_uri: 'data:' + mime + ';base64,' + asset.body.toString('base64') };
  });
  return {
    title: edition.wechat.title, theme: 'mint', sources, images, assets, x: edition.x,
    wechat: { ...edition.wechat,
      markdown: edition.wechat.markdown.replace(/\[(E\d+)\]/g, (tag, id) => links.has(id) ? `[〔${id}〕](${links.get(id)})` : tag),
      images: assets.wechat ? [{ image_id: 'wechat', after_paragraph: 0, caption }] : [] },
    xiaohongshu: { ...edition.xiaohongshu, cards: edition.xiaohongshu.cards.map((card, i) => {
      const id = 'card-' + i;
      const evidenceIds = card.evidence_ids || [];
      return { ...card, image_id: assets[id] ? id : '', source_ids: [...new Set(edition.evidence
        .filter(entry => evidenceIds.includes(entry.id)).map(entry => entry.paper_id))] };
    }) },
  };
}

async function publicationZIP(draft) {
  const combined = await exportDraft(draft, 'publishing-zip');
  const zip = await JSZip.loadAsync(combined.body);
  if (draft.assets.x) zip.file('X/cover.' + draft.assets.x.ext, draft.assets.x.body);
  zip.file('公众号/summary.txt', draft.wechat.summary + '\n');
  zip.file('X/thread.txt', draft.x.map(post => post.ready_text).join('\n\n--------\n\n') + '\n');
  return zip.generateAsync({ type: 'nodebuffer' });
}

module.exports = { diagram, publishingDraft, publicationZIP };
