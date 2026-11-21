/** Bounded retrieval of the exact version linked by Eagleye, with PDF fallback. */
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, writeFile, unlink, rmdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { load } = require('cheerio');

const run = promisify(execFile);
const MAX_PDF_BYTES = 24 * 1024 * 1024;
const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v[1-9]\d*)?$/;
const normalize = text => String(text || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();

function paperVersion(id, link) {
  if (typeof id !== 'string' || !ARXIV_ID.test(id)) return '';
  try {
    const url = new URL(link);
    const version = url.pathname.replace(/^\/(?:abs|pdf|html)\//, '').replace(/\.pdf$/, '');
    if (['arxiv.org', 'export.arxiv.org'].includes(url.hostname) && ARXIV_ID.test(version)
        && version.replace(/v\d+$/, '') === id.replace(/v\d+$/, '')) return version;
  } catch { /* Use the validated metadata ID. */ }
  return id;
}

async function fetchArxiv(path, maxBytes) {
  const response = await fetch('https://arxiv.org/' + path, {
    redirect: 'manual', signal: AbortSignal.timeout(22000),
    headers: { Accept: path.startsWith('html/') ? 'text/html' : 'application/pdf' },
  });
  if (!response.ok || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('arXiv response unavailable: HTTP ' + response.status);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('arXiv response exceeds size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function evidenceKind(heading, text) {
  if (/limit|discussion|failure|threat|conclusion/i.test(heading)) return 'boundary';
  if (/result|eval|experiment|ablation|performance|benchmark/i.test(heading)) return 'result';
  if (/method|approach|architecture|pipeline|algorithm|design|framework/i.test(heading)) return 'method';
  if (/baseline|ablation|benchmark|outperform|accuracy|compared with|latency|throughput/i.test(text)) return 'result';
  return 'context';
}

function passagesFromHtml($) {
  const passages = [];
  $('script,style,nav,footer,annotation,annotation-xml,.ltx_bibliography,.ltx_acknowledgements,.ltx_appendix,.ltx_abstract').remove();
  $('section p, section figcaption').each((_i, element) => {
    const paragraph = $(element);
    const section = paragraph.closest('section');
    const heading = normalize(section.children('h2,h3,h4,h5').first().text()) || '正文';
    const text = normalize(paragraph.text());
    if (text.length >= 160) passages.push({ locator: heading, kind: evidenceKind(heading, text), text });
  });
  return passages;
}

async function passagesFromPdf(buffer) {
  if (buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('arXiv response is not a PDF');
  const dir = await mkdtemp(join(tmpdir(), 'eagleye-arxiv-'));
  const file = join(dir, 'paper.pdf');
  try {
    await writeFile(file, buffer, { mode: 0o600 });
    const { stdout } = await run('pdftotext', ['-f', '1', '-l', '24', '-layout', file, '-'], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
    });
    const passages = [];
    let section = '';
    for (const [index, page] of stdout.split('\f').entries()) {
      for (const block of page.split(/\n\s*\n/)) {
        if (/^\s*(?:\d+(?:\.\d+)*\.?\s+)?(?:References|Bibliography|Appendix)\s*(?:\n|$)/im.test(block)) return passages;
        const heading = block.match(/^\s*\d+(?:\.\d+)*\.?\s+([^\n]{4,90})\s*$/);
        if (heading) { section = normalize(heading[1]); continue; }
        const text = normalize(block.replace(/(?<=[a-z])-\s*\n\s*(?=[a-z])/g, ''));
        if (text.length < 160) continue;
        passages.push({ locator: 'PDF p.' + (index + 1) + (section ? ' · ' + section : ''), kind: evidenceKind(section, text), text });
      }
    }
    return passages;
  } finally {
    await unlink(file).catch(() => {});
    await rmdir(dir);
  }
}

function selectPassages(passages) {
  const chosen = [];
  for (const kind of ['method', 'result', 'boundary', 'context']) {
    const group = passages.filter(p => p.kind === kind);
    const distinct = new Map();
    // Prefer section diversity and evidence-bearing language over repeated introductions.
    group.sort((a, b) => (/[0-9]/.test(b.text) - /[0-9]/.test(a.text)) * (kind === 'result' ? 1 : 0));
    for (const passage of group) {
      if (!distinct.has(passage.locator)) distinct.set(passage.locator, passage);
    }
    const unique = [...distinct.values()];
    chosen.push(...unique.concat(group.filter(passage => !unique.includes(passage))).slice(0, 3));
  }
  return chosen.map(passage => ({ ...passage, text: passage.text.slice(0, 1600) }));
}

async function readPaperEvidence(paper) {
  const version = paperVersion(paper.arxiv_id, paper.landing_url);
  if (!version) throw new Error('Invalid arXiv ID');
  const abstract = { locator: '摘要', kind: 'abstract', text: normalize(paper.abstract).slice(0, 2400) };
  let mode = 'abstract';
  let passages = [];
  const failures = [];
  try {
    const html = await fetchArxiv('html/' + version, 5 * 1024 * 1024);
    passages = selectPassages(passagesFromHtml(load(html)));
    if (!passages.length) throw new Error('No extractable HTML sections');
    mode = 'html';
  } catch (error) {
    failures.push('HTML: ' + error.message);
    try {
      const pdf = await fetchArxiv('pdf/' + version, MAX_PDF_BYTES);
      passages = selectPassages(await passagesFromPdf(pdf));
      if (!passages.length) throw new Error('No extractable PDF passages', { cause: error });
      mode = 'pdf';
    } catch (pdfError) { failures.push('PDF: ' + pdfError.message); }
  }
  return {
    id: paper.arxiv_id, version, title: paper.title, url: 'https://arxiv.org/abs/' + version,
    mode, failures, passages: [abstract, ...passages].filter(p => p.text),
  };
}

module.exports = { readPaperEvidence, paperVersion, normalize };
