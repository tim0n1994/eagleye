// @vitest-environment node
/**
 * R3.1 ruling C (Q5) — the topics pending predicate must also drain the
 * lite_but_no_dynamic caliber (有 lite 无 dynamic).
 *
 * Three populations (三口径人口) measured on the 2026-10-20 production snapshot:
 *
 *   no_semantic_lite     44,891   no semantic-lite vector for the live hash model
 *   no_dynamic           60,107   no dynamic-topic assignment at all
 *   lite_but_no_dynamic  15,216   has the lite vector, has no dynamic topic
 *
 * 44,891 + 15,216 = 60,107: no_semantic_lite ⊂ no_dynamic and the two pending
 * groups are disjoint. Only the third group is never selected today.
 *
 * Why (as of b745270):
 *   server/services/kg-drainer.js:168   runTopics(null, caps.topics, 5, { order, pending: true })
 *   → `eagleye-kg topics --pending`     kg-worker/eagleye_kg/cli.py:75-80, :121-122
 *   → discover_topics(pending=True)     kg-worker/eagleye_kg/topics.py:394-409
 *   → load_items_for_topics             topics.py:156-167
 *   → TOPICS_LITE_PENDING               topics.py:152-153 — "no semantic-lite vector for
 *                                       HASH_VECTOR_MODEL" is the done marker
 * discover_topics writes that vector for EVERY selected item (topics.py:464-466)
 * but only emits dynamic assignments for groups that pass should_keep_group
 * (topics.py:468-471). An item whose keys never reach min_items leaves the run
 * with a vector and no topic, and the predicate then excludes it forever.
 * Measured: /tmp/eagleye-r3-meas/top1.out — processed 50, vectors 50,
 * dynamic_topics 0, assignments 0; topB.out — 1000 processed, 989 assignments.
 *
 * This spec drives the real stage entry (`python3 -m eagleye_kg.cli topics`, the
 * README's offline-test invocation) against a throwaway fixture DB built from
 * the schema migrations. It never opens the repository DB: eagleye_kg/config.py:8
 * defaults --db to <repo>/eagleye.db, so --db is always passed and the path is
 * asserted to live under the temp dir. Observable effect used as the "selected
 * this run" marker: the stage (re)writes the live-model lite vector of every
 * selected item, while the fixture seeds every vector with content_hash='fixture'.
 *
 * Contract:
 *   1. 第三组不再饿死 — under --pending every lite_but_no_dynamic item is selected,
 *      with or without a taxonomy assignment, in all three drain orderings, and
 *      metrics.total counts the whole no_dynamic caliber as work.
 *   2. 前两组行为不回退 — every no_semantic_lite item (no vector, or a vector only
 *      for a retired model) stays selected; no_dynamic coverage never drops below
 *      today's floor and becomes complete.
 *   3. Convergence guard — items with BOTH the lite vector and a dynamic topic are
 *      never re-selected under --pending; the default (no --pending) selection is
 *      unchanged.
 *
 * Companion unit-level spec (same fixture, in-process):
 *   kg-worker/tests/test_topics_lite_but_no_dynamic.py
 *   PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=kg-worker python3 -m unittest discover -s kg-worker/tests -v
 * Existing pins of the OLD done marker that must move with ruling C (not touched here):
 *   kg-worker/tests/test_drain_selection.py:96-101 and :110-117.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const MIGRATIONS = ['001_initial_schema.sql', '006_kg_v2.sql', '030_kg_item_topic_lookup.sql'];
const HASH_VECTOR_MODEL = 'eagleye-hash-v1'; // kg-worker/eagleye_kg/vectors.py:17
const STALE_LITE_MODEL = 'eagleye-hash-v0'; // a retired model name — not the live one
const DRAIN_ORDERS = [null, 'newest-first', 'oldest-first']; // kg-drainer.js:52-54 lanes
const STAGE_TIMEOUT_MS = 60_000;

// Group 1 — no_semantic_lite caliber: nothing in item_vectors for the live model.
const NO_LITE_IDS = ['nolite-xf-0', 'nolite-xf-1', 'nolite-hn-0'];
const STALE_LITE_IDS = ['stalelite-xf-0']; // lite vector only for STALE_LITE_MODEL
const NO_SEMANTIC_LITE_IDS = [...NO_LITE_IDS, ...STALE_LITE_IDS];
// Group 3 — lite_but_no_dynamic caliber: live-model lite vector, no dynamic topic.
// The *-1 items also carry a taxonomy assignment (deterministic extract output):
// "no dynamic" must not be confused with "no assignment of any kind".
const LITE_NO_DYNAMIC_IDS = ['litenodyn-xf-0', 'litenodyn-xf-1', 'litenodyn-hn-0', 'litenodyn-hn-1'];
const TAXONOMY_ONLY_IDS = ['litenodyn-xf-1', 'litenodyn-hn-1'];
// Group 2 — no_dynamic caliber = group 1 ⊔ group 3 (the 44,891 + 15,216 = 60,107 identity).
const NO_DYNAMIC_IDS = [...NO_SEMANTIC_LITE_IDS, ...LITE_NO_DYNAMIC_IDS];
// Control — done: live-model lite vector AND a semantic-lite dynamic assignment.
const DONE_IDS = ['done-xf-0', 'done-hn-0'];
const ALL_IDS = [...NO_DYNAMIC_IDS, ...DONE_IDS];
// Monotonicity probe (only in the test that asks for it): dynamic topic, no lite vector.
const ODD_ID = 'odd-xf-0';

// Caliber predicates — same `i` alias as fair_items() (kg-worker/eagleye_kg/selection.py:49-56).
const NO_SEMANTIC_LITE_SQL = `NOT EXISTS (SELECT 1 FROM item_vectors v WHERE v.item_id = i.id
  AND v.vector_type = 'semantic-lite' AND v.model_name = ?)`;
const NO_DYNAMIC_SQL = `NOT EXISTS (SELECT 1 FROM item_topic_assignments a WHERE a.item_id = i.id
  AND a.topic_kind = 'dynamic')`;
const LITE_BUT_NO_DYNAMIC_SQL = `NOT (${NO_SEMANTIC_LITE_SQL}) AND ${NO_DYNAMIC_SQL}`;

const sorted = values => [...values].sort();
const missing = (ids, selected) => ids.filter(id => !selected.has(id)).sort();
const sourceOf = id => (id.includes('-xf-') ? 'x-following' : 'hacker-news');

function buildFixture(dbPath, { odd = false } = {}) {
  const db = new Database(dbPath);
  try {
    for (const name of MIGRATIONS) {
      db.exec(fs.readFileSync(path.join(REPO_ROOT, 'server/migrations', name), 'utf8'));
    }
    db.exec('ALTER TABLE information_items ADD COLUMN duplicate_of TEXT'); // R3.0: 生产由新迁移提供
    db.exec('DELETE FROM sources');
    const source = db.prepare('INSERT INTO sources(id,slug,label,is_active) VALUES(?,?,?,1)');
    for (const slug of ['x-following', 'hacker-news']) source.run(slug, slug, slug);

    const item = db.prepare(`INSERT INTO information_items
      (id,source_id,title,canonical_url,digest_date,score,published_at,source_payload)
      VALUES(?,?,?,?,?,?,?,?)`);
    const ids = odd ? [...ALL_IDS, ODD_ID] : ALL_IDS;
    ids.forEach((id, index) => item.run(
      id, sourceOf(id), `Fixture ${id}`, `https://example.com/${id}`, '2026-10-20',
      100 - index, `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00Z`, '{}',
    ));

    const vector = db.prepare(`INSERT INTO item_vectors (item_id, vector_type, model_name, dimension, vector_json, content_hash)
      VALUES (?, 'semantic-lite', ?, 256, '[]', 'fixture')`);
    for (const id of STALE_LITE_IDS) vector.run(id, STALE_LITE_MODEL);
    for (const id of [...LITE_NO_DYNAMIC_IDS, ...DONE_IDS]) vector.run(id, HASH_VECTOR_MODEL);

    const assignment = db.prepare(`INSERT INTO item_topic_assignments (item_id, topic_kind, topic_id, relevance, assigned_by, reason)
      VALUES (?, ?, ?, 0.8, ?, 'fixture')`);
    for (const id of TAXONOMY_ONLY_IDS) assignment.run(id, 'taxonomy', 'kt001', 'deterministic');
    db.prepare(`INSERT INTO dynamic_topics (id, slug, name, status, discovery_method, topic_model_version, item_count)
      VALUES ('kdt_fixture', 'fixture-topic', 'Fixture topic', 'active', 'semantic-lite', 'dynamic-topic-lite-0.1', ?)`)
      .run(DONE_IDS.length + (odd ? 1 : 0));
    for (const id of DONE_IDS) assignment.run(id, 'dynamic', 'kdt_fixture', 'semantic-lite');
    if (odd) assignment.run(ODD_ID, 'dynamic', 'kdt_fixture', 'semantic-lite');
  } finally {
    db.close();
  }
}

function caliber(dbPath, predicate, params = []) {
  const db = new Database(dbPath);
  try {
    return new Set(db.prepare(`SELECT i.id FROM information_items i WHERE ${predicate}`).pluck().all(...params));
  } finally {
    db.close();
  }
}

/** Items the stage selected in the last run: their live-model lite vector was (re)written. */
function selectedThisRun(dbPath) {
  const db = new Database(dbPath);
  try {
    return new Set(db.prepare(`SELECT item_id FROM item_vectors WHERE vector_type = 'semantic-lite'
      AND model_name = ? AND content_hash <> 'fixture'`).pluck().all(HASH_VECTOR_MODEL));
  } finally {
    db.close();
  }
}

/** Runs the real stage entry against the fixture DB; returns the {"phase":"done"} metrics. */
function runTopics(dbPath, { pending = true, order = null, limit = 100, minItems = 5 } = {}) {
  // --db is mandatory: eagleye_kg/config.py:8 would otherwise open <repo>/eagleye.db.
  if (!dbPath.startsWith(os.tmpdir())) throw new Error(`refusing to run the stage outside the temp dir: ${dbPath}`);
  const args = ['-m', 'eagleye_kg.cli', '--db', dbPath, 'topics', '--limit', String(limit), '--min-items', String(minItems)];
  if (pending) args.push('--pending');
  if (order) args.push('--order', order);
  const result = spawnSync('python3', args, {
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONPATH: path.join(REPO_ROOT, 'kg-worker'), PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
    timeout: STAGE_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`eagleye-kg topics exited ${result.status}\nargs: ${args.join(' ')}\n${result.stderr}`);
  }
  const phaseLine = result.stdout.split('\n').find(line => line.startsWith('{"phase"'));
  if (!phaseLine) throw new Error(`no {"phase": ...} metrics line in stdout:\n${result.stdout}`);
  return JSON.parse(phaseLine);
}

describe('eagleye-kg topics --pending — R3.1 C: lite_but_no_dynamic must drain', () => {
  let directory;
  let dbPath;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-kg-topics-pending-'));
    dbPath = path.join(directory, 'fixture.db');
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('fixture reproduces the three R3 calibers (44,891 + 15,216 = 60,107 identity)', () => {
    buildFixture(dbPath);
    const noSemanticLite = caliber(dbPath, NO_SEMANTIC_LITE_SQL, [HASH_VECTOR_MODEL]);
    const liteButNoDynamic = caliber(dbPath, LITE_BUT_NO_DYNAMIC_SQL, [HASH_VECTOR_MODEL]);
    const noDynamic = caliber(dbPath, NO_DYNAMIC_SQL);
    expect(sorted(noSemanticLite)).toEqual(sorted(NO_SEMANTIC_LITE_IDS));
    expect(sorted(liteButNoDynamic)).toEqual(sorted(LITE_NO_DYNAMIC_IDS));
    expect(sorted(noDynamic)).toEqual(sorted(NO_DYNAMIC_IDS));
    expect(NO_SEMANTIC_LITE_IDS.filter(id => liteButNoDynamic.has(id))).toEqual([]);
    expect(DONE_IDS.filter(id => noDynamic.has(id))).toEqual([]);
  });

  describe('前两组行为不回退', () => {
    it.each(DRAIN_ORDERS)('--pending still selects every no_semantic_lite item (order=%s)', order => {
      buildFixture(dbPath);
      runTopics(dbPath, { pending: true, order });
      expect(
        missing(NO_SEMANTIC_LITE_IDS, selectedThisRun(dbPath)),
        'regression: no_semantic_lite items dropped from --pending; today\'s predicate selects every item '
          + 'without a live-model lite vector (retired-model vectors included)',
      ).toEqual([]);
    }, STAGE_TIMEOUT_MS);

    it('--pending covers the whole no_dynamic caliber: never below today\'s floor, and complete', () => {
      buildFixture(dbPath);
      const noDynamic = caliber(dbPath, NO_DYNAMIC_SQL);
      runTopics(dbPath);
      const selected = selectedThisRun(dbPath);
      const covered = [...noDynamic].filter(id => selected.has(id));
      expect(
        covered.length,
        `regression: no_dynamic coverage ${covered.length}/${noDynamic.size} fell below today's `
          + `${NO_SEMANTIC_LITE_IDS.length} (the no_semantic_lite subset)`,
      ).toBeGreaterThanOrEqual(NO_SEMANTIC_LITE_IDS.length);
      expect(
        missing([...noDynamic], selected),
        `no_dynamic coverage ${covered.length}/${noDynamic.size}: these items have no dynamic topic yet `
          + '--pending never selects them (they are the lite_but_no_dynamic caliber)',
      ).toEqual([]);
    }, STAGE_TIMEOUT_MS);
  });

  describe('第三组不再饿死', () => {
    it.each(DRAIN_ORDERS)('--pending selects lite_but_no_dynamic items instead of starving them (order=%s)', order => {
      buildFixture(dbPath);
      runTopics(dbPath, { pending: true, order });
      expect(
        missing(LITE_NO_DYNAMIC_IDS, selectedThisRun(dbPath)),
        'lite_but_no_dynamic items starved under --pending: TOPICS_LITE_PENDING (topics.py:152) uses the '
          + 'lite vector as the done marker, so an item that got its vector but no dynamic topic is never re-selected',
      ).toEqual([]);
    }, STAGE_TIMEOUT_MS);

    it('--pending selects lite_but_no_dynamic items that carry a taxonomy assignment', () => {
      buildFixture(dbPath);
      runTopics(dbPath);
      expect(
        missing(TAXONOMY_ONLY_IDS, selectedThisRun(dbPath)),
        '"no dynamic" must not be read as "no assignment at all": a deterministic taxonomy row does not make an item done',
      ).toEqual([]);
    }, STAGE_TIMEOUT_MS);

    it('`topics --pending` reports the whole no_dynamic caliber as its work (metrics.total)', () => {
      buildFixture(dbPath);
      const expected = caliber(dbPath, NO_DYNAMIC_SQL).size;
      const metrics = runTopics(dbPath);
      expect(
        metrics.total,
        `discover_topics(pending=True) selected ${metrics.total} items but the no_dynamic caliber holds ${expected}: `
          + `the ${LITE_NO_DYNAMIC_IDS.length} lite_but_no_dynamic items were excluded from the drain`,
      ).toBe(expected);
      expect(metrics.processed).toBe(expected);
      expect(metrics.vectors).toBe(expected);
    }, STAGE_TIMEOUT_MS);
  });

  describe('convergence guard', () => {
    it.each(DRAIN_ORDERS)('--pending never re-selects items that have both lite and dynamic (order=%s)', order => {
      buildFixture(dbPath);
      runTopics(dbPath, { pending: true, order });
      const selected = selectedThisRun(dbPath);
      expect(
        DONE_IDS.filter(id => selected.has(id)),
        'items with a live-model lite vector AND a dynamic topic were re-selected; the widened predicate must still converge',
      ).toEqual([]);
    }, STAGE_TIMEOUT_MS);

    it('an item with a dynamic topic but no live-model lite vector stays selected (monotone widening)', () => {
      buildFixture(dbPath, { odd: true });
      runTopics(dbPath);
      expect(
        selectedThisRun(dbPath).has(ODD_ID),
        'regression: today\'s predicate selects any item lacking the live-model lite vector, dynamic topic or not',
      ).toBe(true);
    }, STAGE_TIMEOUT_MS);

    it('without --pending the default selection is unchanged (whole window, done items included)', () => {
      buildFixture(dbPath);
      runTopics(dbPath, { pending: false });
      expect(missing(ALL_IDS, selectedThisRun(dbPath))).toEqual([]);
    }, STAGE_TIMEOUT_MS);
  });
});
