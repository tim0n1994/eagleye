// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const previousPath = process.env.EAGLEYE_DB_PATH;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'education-feed-'));
process.env.EAGLEYE_DB_PATH = path.join(directory, 'education_test.sqlite');

const { getDB, closeDB } = require('../../db/connection');
const registerEducationRoutes = require('../../routes/education');

const hoursAgoIso = (hours) => new Date(Date.now() - hours * 3600000).toISOString();

let routes;
beforeAll(() => {
  const db = getDB();
  db.exec([
    'CREATE TABLE sources (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, label TEXT NOT NULL)',
    'CREATE TABLE information_items (id TEXT PRIMARY KEY, source_id TEXT REFERENCES sources(id), canonical_url TEXT NOT NULL, title TEXT NOT NULL, title_zh TEXT, original_summary TEXT, language TEXT, author TEXT, digest_date TEXT, score REAL DEFAULT 0, published_at TEXT, created_at TEXT, duplicate_of TEXT)',
    'CREATE INDEX idx_items_published_at ON information_items(published_at DESC)',
    'CREATE INDEX idx_items_created_at ON information_items(created_at)',
    'CREATE TABLE ai_summaries (item_id TEXT PRIMARY KEY, one_liner TEXT, one_liner_zh TEXT, short_summary_zh TEXT)',
    'CREATE TABLE paper_metadata (item_id TEXT PRIMARY KEY, arxiv_id TEXT, venue TEXT, pdf_url TEXT, doi TEXT, abstract TEXT)',
  ].join(';\n'));

  const insertSource = db.prepare('INSERT INTO sources (id, slug, label) VALUES (?, ?, ?)');
  insertSource.run('src-hn', 'hacker-news', 'Hacker News');
  insertSource.run('src-hf', 'hugging-face', 'Hugging Face');
  insertSource.run('src-edu', 'education-arxiv', 'Education arXiv');

  const insertItem = db.prepare('INSERT INTO information_items (id, source_id, canonical_url, title, original_summary, digest_date, score, published_at, created_at, duplicate_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertSummary = db.prepare('INSERT INTO ai_summaries (item_id, one_liner, one_liner_zh, short_summary_zh) VALUES (?, ?, ?, ?)');
  const insertPaper = db.prepare('INSERT INTO paper_metadata (item_id, arxiv_id, venue, pdf_url, doi, abstract) VALUES (?, ?, ?, ?, ?, ?)');

  const fixtures = [
    ['edu-product', 'src-hn', 'Duolingo launches an AI tutor for students', 'Language app adds AI tutor for learners', 2, null],
    ['edu-only', 'src-hn', 'New national curriculum for schools announced', 'The ministry updated the curriculum', 3, null],
    ['ai-only', 'src-hn', 'OpenAI releases GPT-5 for developers', 'New frontier model ships today', 4, null],
    ['ml-trap', 'src-hn', 'Novel neural network learning algorithm cuts training costs', 'Training efficiency improves', 5, null],
    ['research-paper', 'src-hf', 'LLM tutors in classrooms: an arXiv study', 'Large language models used by students in classrooms', 6, { arxiv_id: '2501.12345', venue: 'AIED' }],
    ['edu-arxiv-meta', 'src-edu', 'Effects of GPT-4 tutors on K-12 student outcomes', 'A randomized study of AI tutoring', 7, { arxiv_id: '2501.67890', venue: 'L@S' }],
    ['edu-arxiv-no-ai', 'src-edu', 'Classroom seating arrangements and daylight', 'Room design affects attention', 8, null],
    ['policy', 'src-hn', 'Ministry of Education issues AI guidelines for schools', 'Regulation covers classroom AI use', 9, null],
    ['teaching', 'src-hn', 'How teachers use ChatGPT for lesson plans in the classroom', 'Pedagogy notes from real classrooms', 10, null],
    ['dup-item', 'src-hn', 'Duolingo launches an AI tutor for students', 'Language app adds AI tutor for learners', 2, { duplicate_of: 'edu-product' }],
    ['old-item', 'src-hn', 'Khan Academy rolls out AI tutor for students', 'Early AI tutor pilot in classrooms', 60 * 24, null],
    ['within-window', 'src-hn', 'AI tutor app helps school students learn', 'An educational learning app', 20 * 24, null],
    ['academic-not-edu', 'src-hn', 'Oxford University researchers unveil AI model', 'A university student studies model performance', 1, null],
    ['benchmark-not-edu', 'src-hn', 'AI model achieves new exam benchmark record', 'The model performs well on exams', 1, null],
    ['distill-not-edu', 'src-hn', 'Student models learn from teachers using AI distillation', 'Model training research', 1, null],
    ['policy-plain', 'src-hn', 'New AI education policy for schools', 'A public policy update', 1, null],
  ];
  for (const [id, sourceId, title, summary, hours, extra] of fixtures) {
    insertItem.run(id, sourceId, 'https://example.com/' + id, title, summary, '2026-01-01', 5, hoursAgoIso(hours), hoursAgoIso(hours), (extra && extra.duplicate_of) || null);
    if (extra && extra.arxiv_id) {
      insertPaper.run(id, extra.arxiv_id, extra.venue, 'https://arxiv.org/pdf/' + extra.arxiv_id, '', 'Abstract about AI in education');
    }
    if (id !== 'edu-arxiv-no-ai') {
      insertSummary.run(id, summary, id === 'research-paper' ? '课堂中的大模型辅导研究' : '', '');
    }
  }
  // A busy generic feed must not push an older relevant story out of a
  // selected 30-day window before education candidates are considered.
  db.transaction(() => {
    for (let i = 0; i < 5100; i++) {
      insertItem.run(`noise-${i}`, 'src-hn', `https://example.com/noise-${i}`, 'AI infrastructure update', '', '2026-01-01', 0, hoursAgoIso(2), hoursAgoIso(2), null);
    }
  })();

  routes = {};
  registerEducationRoutes(routes);
});

afterAll(() => {
  closeDB();
  if (previousPath === undefined) delete process.env.EAGLEYE_DB_PATH;
  else process.env.EAGLEYE_DB_PATH = previousPath;
  fs.rmSync(directory, { recursive: true, force: true });
});

function call(query = {}, method = 'GET') {
  const req = { method: method, url: '/api/education', headers: {} };
  let statusCode = 0;
  let rawResponse = '';
  const res = {
    writeHead(code) { statusCode = code; },
    end(body) { rawResponse = body; },
  };
  routes['/api/education'](req, res, { query: query });
  return { status: statusCode, body: rawResponse ? JSON.parse(rawResponse) : null };
}

const catCount = (body, key) => body.categories.find((c) => c.key === key).count;

describe('education feed classification', () => {
  it('includes AI+education items and assigns precise categories', () => {
    const { body } = call({ limit: 120 });
    const byId = {};
    for (const item of body.items) byId[item.id] = item;
    expect(byId['edu-product'].category).toBe('learning_product');
    expect(byId['research-paper'].category).toBe('research');
    expect(byId['research-paper'].paper.arxiv_id).toBe('2501.12345');
    expect(byId['edu-arxiv-meta'].category).toBe('research');
    expect(byId['policy'].category).toBe('policy');
    expect(byId['policy-plain'].category).toBe('policy');
    expect(byId['teaching'].category).toBe('teaching_practice');
    expect(byId['edu-product'].matched.ai_terms).toContain('AI');
    expect(byId['edu-product'].matched.edu_terms).toContain('student');
    expect(byId['edu-arxiv-meta'].matched.category_reason).toBe('paper');
  });

  it('rejects education-only, AI-only, ML traps, dupes, and non-AI source items', () => {
    const ids = call({ limit: 120 }).body.items.map((item) => item.id);
    expect(ids).not.toContain('edu-only');
    expect(ids).not.toContain('ai-only');
    expect(ids).not.toContain('ml-trap');
    expect(ids).not.toContain('dup-item');
    expect(ids).not.toContain('edu-arxiv-no-ai');
    expect(ids).not.toContain('academic-not-edu');
    expect(ids).not.toContain('benchmark-not-edu');
    expect(ids).not.toContain('distill-not-edu');
    expect(ids).toContain('within-window');
  });

  it('honors the days window', () => {
    expect(call({ limit: 120 }).body.items.map((i) => i.id)).not.toContain('old-item');
    expect(call({ limit: 120, days: 90 }).body.items.map((i) => i.id)).toContain('old-item');
  });

  it('sorts by published_at descending', () => {
    const times = call({ limit: 120 }).body.items.map((i) => i.published_at);
    expect(times).toEqual([...times].sort().reverse());
  });
});

describe('education route contract', () => {
  it('category counts are window-wide and unaffected by the category filter', () => {
    const unfiltered = call({ limit: 120 });
    const filtered = call({ category: 'learning_product', limit: 120 });
    expect(filtered.body.categories).toEqual(unfiltered.body.categories);
    expect(catCount(filtered.body, 'research')).toBeGreaterThan(0);
    expect(filtered.body.items.every((i) => i.category === 'learning_product')).toBe(true);
    expect(filtered.body.stats.total).toBe(catCount(filtered.body, 'learning_product'));
  });

  it('stats.total ignores limit and offset; pages slice it', () => {
    const full = call({ category: 'research', limit: 120 });
    const paged = call({ category: 'research', limit: 1, offset: 1 });
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.stats.total).toBe(full.body.stats.total);
    expect(paged.body.items[0].id).toBe(full.body.items[1].id);
  });

  it('validates params and methods', () => {
    expect(call({ category: 'bogus' }).status).toBe(400);
    expect(call({ source: 'bad slug!' }).status).toBe(400);
    expect(call({}, 'POST').status).toBe(405);
  });
});
