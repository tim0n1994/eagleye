// @vitest-environment node
/**
 * R3.1 ruling D (Q9) — kg cost baseline script: scripts/kg-cost-baseline.{py,js,mjs,cjs}
 *
 * Black-box CLI contract for the repeatable KG cost baseline that replaces the
 * "logs already deleted, cannot re-run" measurement. TDD RED gate: must fail with
 * assertion FAILs (not env errors) against the empty-output placeholder stub, and
 * go green once implemented. Never touches the production DB, network or LLMs —
 * the fixture is a tempfile sqlite built here from the real DDL
 * (server/migrations/001_initial_schema.sql:26 information_items;
 *  server/migrations/006_kg_v2.sql:31 item_features / :164 item_topic_assignments /
 *  :180 item_vectors), REFERENCES clauses dropped.
 *
 * Contract (marker style follows scripts/slo-baseline.py KEY=VALUE lines and its
 * 0 / 1 / 2 exit-code semantics):
 *   1) exactly one of scripts/kg-cost-baseline.{py,js,mjs,cjs} exists
 *      (.py → python3; .js/.mjs/.cjs → the running node). 换语言实现时须删掉 .py 桩。
 *   2) --help → rc 0, stdout contains 'usage' (case-insensitive) and lists --db, --dry-run
 *   3) --db <sqlite> --dry-run → rc 0; some stdout line starts with
 *         COST_BASELINE_OK items=<int> cpu_s=<float>
 *      (extra key=value fields may follow on the line). items = pending
 *      information_items. The fixture rows have no semantic-hash vector, no
 *      item_features and no item_topic_assignments (全积压), so items equals the
 *      fixture row count under both the "all rows" and "backlog rows" readings —
 *      three fixture sizes (7 / 5 / 3) pin items to the DB, not a constant.
 *   4) read-only: fixture sha256 unchanged after dry-run; no -wal/-shm/-journal left
 *   5) repeatable: two dry-runs both OK with identical items (cpu_s may differ)
 *   6) unreadable db path → rc 2 and stderr contains 'ERROR' (measurement error,
 *      distinct from RED=1 and never disguised as COST_BASELINE_OK)
 *   Not in contract (implementer's call): empty fixture (0 rows), non-dry-run mode,
 *   additional output fields.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const SCRIPTS_DIR = path.resolve(import.meta.dirname, '../../../scripts');
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const CANDIDATES = ['kg-cost-baseline.py', 'kg-cost-baseline.js',
  'kg-cost-baseline.mjs', 'kg-cost-baseline.cjs'];
const PYTHON = fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
const RUN_TIMEOUT_MS = 120_000;
const FIXED_TS = '2026-10-20 00:00:00'; // deterministic UTC stamp (DB caliber, as slo-baseline)

// line-anchored marker; trailing key=value fields allowed (e.g. wall_s= / per_item_ms=)
const MARKER_RE = /^COST_BASELINE_OK items=(\d+) cpu_s=(\d+(?:\.\d+)?)(?=\s|$)/m;

// Real DDL subset (REFERENCES dropped; names/types/NOT NULL/DEFAULT/PK kept)
const SCHEMA = `
CREATE TABLE information_items (
  id TEXT PRIMARY KEY,
  source_id TEXT,
  canonical_url TEXT NOT NULL,
  external_id TEXT,
  title TEXT NOT NULL,
  original_summary TEXT,
  content_text TEXT,
  language TEXT DEFAULT 'en',
  author TEXT,
  published_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  digest_date TEXT NOT NULL,
  source_payload TEXT NOT NULL DEFAULT '{}',
  normalized_payload TEXT NOT NULL DEFAULT '{}',
  score REAL DEFAULT 0,
  popularity TEXT DEFAULT '{}',
  content_hash TEXT,
  duplicate_group_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_id, canonical_url, digest_date)
);
CREATE TABLE item_features (
  item_id TEXT PRIMARY KEY,
  source_slug TEXT NOT NULL,
  domain TEXT,
  author_norm TEXT,
  language_detected TEXT,
  content_hash TEXT,
  title_tokens TEXT NOT NULL DEFAULT '[]',
  keyword_candidates TEXT NOT NULL DEFAULT '[]',
  source_features TEXT NOT NULL DEFAULT '{}',
  quality_score REAL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE item_topic_assignments (
  item_id TEXT NOT NULL,
  topic_kind TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  relevance REAL NOT NULL DEFAULT 0,
  assigned_by TEXT NOT NULL,
  reason TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, topic_kind, topic_id, assigned_by)
);
CREATE TABLE item_vectors (
  item_id TEXT NOT NULL,
  vector_type TEXT NOT NULL,
  model_name TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, vector_type, model_name)
);
`;

function locateScripts() {
  return CANDIDATES.map(c => path.join(SCRIPTS_DIR, c))
    .filter(p => fs.existsSync(p) && fs.statSync(p).isFile());
}

function interpreterFor(scriptPath) {
  return scriptPath.endsWith('.py') ? PYTHON : process.execPath;
}

function runCli(scriptPath, ...args) {
  const r = spawnSync(interpreterFor(scriptPath), [scriptPath, ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: RUN_TIMEOUT_MS,
  });
  if (r.error) throw r.error; // interpreter missing / timeout → surfaced as an error, not a FAIL
  return { rc: r.status, stdout: r.stdout, stderr: r.stderr };
}

function buildFixture(dir, nItems) {
  const dbPath = path.join(dir, 'fixture.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  const ins = db.prepare(
    'INSERT INTO information_items (id, source_id, canonical_url, external_id, title, ' +
    'content_text, digest_date, fetched_at, created_at, updated_at, content_hash) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < nItems; i++) {
    const iid = `fx-${String(i).padStart(4, '0')}`;
    const n3 = String(i).padStart(3, '0');
    ins.run(iid, 'fixture-src', `https://fixture.invalid/items/${iid}`, iid,
      `Fixture item ${n3}`, `deterministic fixture body ${n3}. `.repeat(12),
      '2026-10-20', FIXED_TS, FIXED_TS, FIXED_TS, `fxhash-${n3}`);
  }
  db.close();
  return dbPath;
}

function sha256Of(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function expectMarker(stdout, label) {
  const m = MARKER_RE.exec(stdout);
  expect(m, `${label}: stdout lacks line-anchored 'COST_BASELINE_OK items=<n> cpu_s=<x>'; stdout=${JSON.stringify(stdout)}`)
    .not.toBeNull();
  const items = Number(m[1]);
  const cpuS = Number(m[2]);
  expect(cpuS, `${label}: cpu_s must be >= 0`).toBeGreaterThanOrEqual(0);
  return { items, cpuS };
}

describe('kg-cost-baseline presence (R3.1 D / Q9)', () => {
  it('exactly one scripts/kg-cost-baseline.{py,js,mjs,cjs} exists', () => {
    const found = locateScripts();
    expect(found, `contract 1: found=${JSON.stringify(found)}`).toHaveLength(1);
  });
});

const located = locateScripts();
const SCRIPT = located.length === 1 ? located[0] : null;

(SCRIPT ? describe : describe.skip)('scripts/kg-cost-baseline CLI contract', () => {
  const tmpDirs = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function fixture(nItems) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-cost-fixture-'));
    tmpDirs.push(d);
    return buildFixture(d, nItems);
  }

  // ---- contract 2 ----
  it('--help exits 0, prints usage and documents --db / --dry-run', () => {
    const p = runCli(SCRIPT, '--help');
    expect(p.rc, `--help rc=${p.rc} stderr=${JSON.stringify(p.stderr)}`).toBe(0);
    expect(p.stdout.toLowerCase(), `--help must print usage; stdout=${JSON.stringify(p.stdout)}`)
      .toContain('usage');
    expect(p.stdout, '--help must list --db').toContain('--db');
    expect(p.stdout, '--help must list --dry-run').toContain('--dry-run');
  });

  // ---- contract 3 ----
  it('--db <fixture> --dry-run exits 0 and emits COST_BASELINE_OK with items = fixture rows (7)', () => {
    const db = fixture(7);
    const p = runCli(SCRIPT, '--db', db, '--dry-run');
    expect(p.rc, `dry-run rc=${p.rc} stdout=${JSON.stringify(p.stdout)} stderr=${JSON.stringify(p.stderr)}`).toBe(0);
    const { items } = expectMarker(p.stdout, 'dry-run(7)');
    expect(items, 'items must equal fixture row count 7 (all pending → both calibers agree)').toBe(7);
  });

  // ---- contract 4 ----
  it('dry-run is read-only on the fixture (sha256 unchanged, no -wal/-shm/-journal)', () => {
    const db = fixture(5);
    const before = sha256Of(db);
    const p = runCli(SCRIPT, '--db', db, '--dry-run');
    expect(p.rc, `dry-run rc=${p.rc} stdout=${JSON.stringify(p.stdout)} stderr=${JSON.stringify(p.stderr)}`).toBe(0);
    expectMarker(p.stdout, 'dry-run(5)'); // only a run that actually measured counts as read-only
    expect(sha256Of(db), 'dry-run modified the fixture db (must be read-only)').toBe(before);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      expect(fs.existsSync(db + suffix), `dry-run left ${suffix} behind (open mode=ro)`).toBe(false);
    }
  });

  // ---- contract 5 ----
  it('dry-run is repeatable: two runs both OK with identical items (3)', () => {
    const db = fixture(3);
    const p1 = runCli(SCRIPT, '--db', db, '--dry-run');
    const p2 = runCli(SCRIPT, '--db', db, '--dry-run');
    expect([p1.rc, p2.rc], `rc=(${p1.rc},${p2.rc}) stderr=(${JSON.stringify(p1.stderr)},${JSON.stringify(p2.stderr)})`)
      .toEqual([0, 0]);
    const a = expectMarker(p1.stdout, 'run#1');
    const b = expectMarker(p2.stdout, 'run#2');
    expect(a.items).toBe(3);
    expect(a.items, 'repeatable: items must match across runs (cpu_s may differ)').toBe(b.items);
  });

  // ---- contract 6 ----
  it('unreadable db is a measurement error: rc 2, stderr ERROR, no OK marker', () => {
    const p = runCli(SCRIPT, '--db', '/nonexistent/kg-cost-fixture/eagleye.db', '--dry-run');
    expect(p.rc, `unreadable db must exit 2 (measurement error; not RED=1, not OK=0); rc=${p.rc} stdout=${JSON.stringify(p.stdout)} stderr=${JSON.stringify(p.stderr)}`)
      .toBe(2);
    expect(p.stderr, `unreadable db must print ERROR on stderr; stderr=${JSON.stringify(p.stderr)}`).toContain('ERROR');
    expect(p.stdout, 'unreadable db must not be disguised as COST_BASELINE_OK').not.toContain('COST_BASELINE_OK');
  });
});
