// @vitest-environment node
/**
 * R3.1 — backlog-triggered catch-up replaces the idle time window
 * (CTO ruling A on Q1/Q2; worktree round3-convergence @ b745270).
 *
 * Contract under test — server/services/kg-drainer.js, the drainer
 * implementation file (the ruling names it "kg-drain.js（或 drainer 实现文件）").
 *
 * Why: today catch-up is a clock predicate — scripts/kg-drain.js
 * inIdleWindow() (00:30–05:30) → idleWindow job param → kg-drainer.js:159
 * `occupied ? 'slow' : (idleWindow ? 'catchup' : 'steady')`. That gives at
 * most ~3 catch-up runs a night, so the :42-43 arithmetic ("12,712 + 2×4,400
 * over 24 runs in 48h needs ≥897/run") never held: only ~6 of the 24
 * two-hour runs could be catch-up runs. The trigger moves to the backlog
 * itself, gated by a deterministic load criterion read from /proc/loadavg.
 *
 * runKGDrain(options) — NEW injectable inputs (real defaults lazy-wired so
 * requiring the module stays side-effect free, like readSalon9Count):
 *   readBacklogFeatures  () => number | Promise<number>
 *       items still missing KG features (backlog_features). The real default
 *       is a READ-ONLY count — the drainer never writes the DB from here.
 *   loadavgPath          string, default '/proc/loadavg'
 *       load1 = first whitespace-separated field. Tests inject a temp file
 *       (可注入路径 mock); nothing in this suite touches the real file.
 *   readPreviousLoad1    () => number | null | Promise<number | null>
 *       load1 persisted by the previous fire's kg-drain job result (null =
 *       no previous sample). The real default is a READ-ONLY
 *       background_jobs query (same source as slo-baseline's
 *       latest_drain_gear); the harness default here is null.
 *   idleWindow           still accepted, now IGNORED (time window replaced).
 *
 * Mode decision — everything else (switch, Salon9 probe, lock-first,
 * extract → embed → topics once each, release-once) is unchanged
 * (其余保持现有门控):
 *   occupied                                         → 'slow'
 *   !occupied && backlog_features > 500 && load1 < 2.5 → 'catchup'
 *   otherwise                                         → 'steady'
 *   Boundaries: 500 is NOT > 500 (steady), 501 is (catch-up); 2.49 < 2.5
 *   (catch-up), 2.5 is not (steady). The ruling lists the pair "499/500"
 *   next to the operator ">500"; this suite follows the operator, which the
 *   ruling states twice, and covers 499, 500 and 501.
 *
 * Load guard — load1 ≥ 3.0 连续 2 个采样点 → 降 slow 档并记录事件:
 *   采样点 = one drain cycle = one runKGDrain call (one 2h fire). In
 *   production EVERY fire is a fresh oneshot process
 *   (scripts/systemd/argus-eagleye-kg-drain.service Type=oneshot →
 *   scripts/kg-drain.js → jobs.js runJob executes the job in the caller's
 *   own process; no queued-job poller exists), so a module-level counter
 *   alone never reaches 2. Continuity comes from the previous fire's
 *   persisted kg-drain job result: every sampled cycle — including a
 *   lock-busy skip — carries load1, and a fire whose own sample is high
 *   reads the previous sample back through readPreviousLoad1 (only
 *   consulted when the current sample is high). The in-process counter
 *   still accumulates for repeat calls inside one process, which the
 *   same-instance cases below model; the two-instance cases (one fresh
 *   compileDrainer() per fire) pin the cross-process rebuild. A sample with
 *   load1 ≥ 3.0 is HIGH. The FIRST high sample (no high previous sample)
 *   never downgrades (it runs whatever the table above gives — steady when
 *   the room is free, since ≥ 3.0 is also ≥ 2.5). The SECOND consecutive
 *   high sample runs 'slow' with the slow caps and records
 *   { type: 'load-downgrade', load1 } in result.events. Any sample < 3.0
 *   resets the streak (high / low / high never downgrades). Exactly 3.0 is
 *   high; 2.99 is not.
 *
 * Result of a non-skipped run additionally carries:
 *   load1   number | null   the sampled value (null = loadavg unreadable)
 *   events  array           may be empty or absent when nothing was recorded
 * A lock-busy skip resolves { skipped: 'lock-busy', load1 } so its sample
 * is persisted for the next fire. Unreadable / unparseable loadavg → load1
 * null → never catch-up, never throws (same safe-default spirit as the
 * unreadable Salon9 probe).
 *
 * readLoad1(loadavgPath) → number | null   exported pure reader (sync or
 * async — the tests await it).
 *
 * Erratum (:42-43): the DRAIN_CAPS rationale block must state the backlog
 * trigger (backlog_features > 500, load1 < 2.5) and the 48h SLO as "features
 * AND embed both drained to zero", and must no longer attribute catch-up to
 * idle windows (空闲时段).
 *
 * Nothing here reads the production DB, the real /proc/loadavg, journalctl
 * or heavy.lock: every input is injected (时间与外部全 mock).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const DRAINER_PATH = path.resolve(import.meta.dirname, '../kg-drainer.js');

const CAPS = {
  steady: { extract: 500, embed: 1000, topics: 1000, order: 'newest-first' },
  catchup: { extract: 1000, embed: 1000, topics: 1000, order: 'oldest-first' },
  slow: { extract: 200, embed: 500, topics: 1000, order: 'newest-first' },
};

function compileDrainer() {
  const subject = new Module(DRAINER_PATH, module);
  subject.filename = DRAINER_PATH;
  subject.require = id => {
    // Stage runners / DB / lock / salon9 readers are lazy-required inside
    // runKGDrain defaults; the tests inject every one of them, so relative
    // requires resolve to an empty stub and nothing external is touched.
    if (id.startsWith('.')) return {};
    return require(id);
  };
  subject._compile(fs.readFileSync(DRAINER_PATH, 'utf8'), DRAINER_PATH);
  return subject.exports;
}

// ── injected /proc/loadavg ──────────────────────────────────────────────
let tmpDir;
let fileSeq = 0;

/** Mirrors the real line shape: "0.38 0.58 1.12 1/936 2952339". */
function setLoad1(file, load1) {
  fs.writeFileSync(file, `${load1} 0.58 1.12 1/936 2952339\n`);
}

function loadavgFile(load1) {
  const file = path.join(tmpDir, `loadavg-${fileSeq++}`);
  setLoad1(file, load1);
  return file;
}

function drainHarness(overrides = {}) {
  const calls = [];
  const release = vi.fn(() => { calls.push('release'); });
  const deps = {
    readSalon9Count: vi.fn(() => 0), // room free
    readBacklogFeatures: vi.fn(() => 2000), // well above the 500 trigger
    loadavgPath: loadavgFile('0.50'), // quiet machine
    readPreviousLoad1: vi.fn(() => null), // no persisted sample from an earlier fire
    acquireLock: vi.fn(async () => { calls.push('lock'); return release; }),
    runExtract: vi.fn(async () => { calls.push('extract'); return 'extract-result'; }),
    runEmbed: vi.fn(async () => { calls.push('embed'); return 'embed-result'; }),
    runTopics: vi.fn(async () => { calls.push('topics'); return 'topics-result'; }),
    ...overrides,
  };
  return { deps, calls, release };
}

const loadDowngradeEvents = result =>
  (result.events ?? []).filter(event => event && event.type === 'load-downgrade');

describe('R3.1 backlog-triggered catch-up (server/services/kg-drainer.js)', () => {
  let drainer;

  beforeEach(() => {
    delete process.env.EAGLEYE_R3_DRAINER;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-drainer-loadavg-'));
    drainer = compileDrainer();
  });
  afterEach(() => {
    delete process.env.EAGLEYE_R3_DRAINER;
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exports readLoad1 and parses load1 from an injected loadavg path (unreadable → null)', async () => {
    expect(typeof drainer.readLoad1, 'kg-drainer.js must export readLoad1(loadavgPath)').toBe('function');
    expect(await drainer.readLoad1(loadavgFile('2.49'))).toBe(2.49);
    expect(await drainer.readLoad1(loadavgFile('3.00'))).toBe(3);
    expect(await drainer.readLoad1(path.join(tmpDir, 'missing-loadavg'))).toBeNull();
    const garbage = path.join(tmpDir, 'garbage-loadavg');
    fs.writeFileSync(garbage, 'not a loadavg line\n');
    expect(await drainer.readLoad1(garbage)).toBeNull();
  });

  it('catch-up needs backlog_features > 500: 499 and 500 stay steady, 501 goes catch-up (room free, load1 2.49)', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';
    for (const [backlog, mode] of [[499, 'steady'], [500, 'steady'], [501, 'catchup']]) {
      const { deps } = drainHarness({
        readBacklogFeatures: vi.fn(() => backlog),
        loadavgPath: loadavgFile('2.49'),
      });
      const result = await drainer.runKGDrain(deps);
      expect(result.mode, `backlog_features=${backlog}`).toBe(mode);
      expect(result.caps, `backlog_features=${backlog}`).toEqual(CAPS[mode]);
      expect(deps.readBacklogFeatures).toHaveBeenCalled();
      expect(deps.runExtract).toHaveBeenCalledWith(null, CAPS[mode].extract, { order: CAPS[mode].order });
    }
  });

  it('catch-up needs load1 < 2.5: 2.49 goes catch-up, 2.50 stays steady (room free, backlog 2000)', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';
    for (const [load, mode] of [['2.49', 'catchup'], ['2.50', 'steady']]) {
      const { deps } = drainHarness({ loadavgPath: loadavgFile(load) });
      const result = await drainer.runKGDrain(deps);
      expect(result.mode, `load1=${load}`).toBe(mode);
      expect(result.load1, `load1=${load} must be reported in the result`).toBe(Number(load));
      expect(result.caps, `load1=${load}`).toEqual(CAPS[mode]);
      expect(deps.runExtract).toHaveBeenCalledWith(null, CAPS[mode].extract, { order: CAPS[mode].order });
      expect(deps.runEmbed).toHaveBeenCalledWith(null, CAPS[mode].embed, { order: CAPS[mode].order });
      expect(deps.runTopics).toHaveBeenCalledWith(null, CAPS[mode].topics, 5, { order: CAPS[mode].order, pending: true });
    }
  });

  it('the idle time window no longer decides: idleWindow=true with a small backlog runs steady, idleWindow=false with a big one catches up', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';
    const small = drainHarness({ idleWindow: true, readBacklogFeatures: vi.fn(() => 100) });
    const smallResult = await drainer.runKGDrain(small.deps);
    expect(smallResult.mode, 'idleWindow must not force catch-up any more').toBe('steady');
    expect(small.deps.runExtract).toHaveBeenCalledWith(null, CAPS.steady.extract, { order: 'newest-first' });

    const big = drainHarness({ idleWindow: false }); // backlog 2000, load1 0.50, room free
    const bigResult = await drainer.runKGDrain(big.deps);
    expect(bigResult.mode, 'daytime is irrelevant: backlog + quiet machine = catch-up').toBe('catchup');
    expect(big.deps.runExtract).toHaveBeenCalledWith(null, CAPS.catchup.extract, { order: 'oldest-first' });
  });

  it('an occupied room stays slow even with a big backlog and a quiet machine (existing gating kept)', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';
    for (const readSalon9Count of [vi.fn(() => 5), vi.fn(() => null), vi.fn(() => { throw new Error('journalctl unavailable'); })]) {
      const { deps } = drainHarness({ readSalon9Count }); // backlog 2000, load1 0.50
      const result = await drainer.runKGDrain(deps);
      expect(result.mode).toBe('slow');
      expect(result.caps).toEqual(CAPS.slow);
      expect(deps.runExtract).toHaveBeenCalledWith(null, CAPS.slow.extract, { order: CAPS.slow.order });
    }
  });

  it('switch off still probes nothing: no backlog read, no salon9 probe, no lock, no stages', async () => {
    const { deps, release } = drainHarness();
    const result = await drainer.runKGDrain(deps);
    expect(result).toEqual({ skipped: 'disabled' });
    expect(deps.readBacklogFeatures).not.toHaveBeenCalled();
    expect(deps.readPreviousLoad1).not.toHaveBeenCalled();
    expect(deps.readSalon9Count).not.toHaveBeenCalled();
    expect(deps.acquireLock).not.toHaveBeenCalled();
    expect(deps.runExtract).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('load1 ≥ 3.0 downgrades to slow only on the SECOND consecutive sample and records a load-downgrade event', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';
    const loadavgPath = loadavgFile('3.20');

    const first = drainHarness({ loadavgPath });
    const r1 = await drainer.runKGDrain(first.deps);
    expect(r1.mode, 'first high sample must not downgrade (3.2 ≥ 2.5 → not catch-up → steady)').toBe('steady');
    expect(r1.caps).toEqual(CAPS.steady);
    expect(r1.load1).toBe(3.2);
    expect(loadDowngradeEvents(r1)).toEqual([]);
    expect(first.deps.runExtract).toHaveBeenCalledWith(null, CAPS.steady.extract, { order: 'newest-first' });

    setLoad1(loadavgPath, '3.10'); // next 2h fire, still hot
    const second = drainHarness({ loadavgPath });
    const r2 = await drainer.runKGDrain(second.deps);
    expect(r2.mode, 'second consecutive high sample downgrades').toBe('slow');
    expect(r2.caps).toEqual(CAPS.slow);
    expect(r2.load1).toBe(3.1);
    expect(loadDowngradeEvents(r2)).toEqual([expect.objectContaining({ type: 'load-downgrade', load1: 3.1 })]);
    expect(second.deps.runExtract).toHaveBeenCalledWith(null, CAPS.slow.extract, { order: 'newest-first' });
    expect(second.deps.runEmbed).toHaveBeenCalledWith(null, CAPS.slow.embed, { order: 'newest-first' });
    expect(second.deps.runTopics).toHaveBeenCalledWith(null, CAPS.slow.topics, 5, { order: 'newest-first', pending: true });
    expect(second.calls).toEqual(['lock', 'extract', 'embed', 'topics', 'release']);
    expect(second.release).toHaveBeenCalledTimes(1);
  });

  it('a sample below 3.0 resets the streak: high / low / high never downgrades', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';
    const loadavgPath = loadavgFile('3.50');

    const r1 = await drainer.runKGDrain(drainHarness({ loadavgPath }).deps);
    expect(r1.mode).toBe('steady');
    expect(loadDowngradeEvents(r1)).toEqual([]);

    setLoad1(loadavgPath, '2.00');
    const r2 = await drainer.runKGDrain(drainHarness({ loadavgPath }).deps);
    expect(r2.mode, 'quiet sample: backlog 2000 > 500, room free, 2.0 < 2.5').toBe('catchup');
    expect(loadDowngradeEvents(r2)).toEqual([]);

    setLoad1(loadavgPath, '3.50');
    const r3 = await drainer.runKGDrain(drainHarness({ loadavgPath }).deps);
    expect(r3.mode, 'non-consecutive high samples must not downgrade').toBe('steady');
    expect(loadDowngradeEvents(r3)).toEqual([]);
  });

  it('exactly 3.0 is a high sample (two of them downgrade); 2.99 is not (two of them stay steady)', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';

    const hot = loadavgFile('3.00');
    const a1 = await drainer.runKGDrain(drainHarness({ loadavgPath: hot }).deps);
    expect(a1.mode).toBe('steady');
    expect(loadDowngradeEvents(a1)).toEqual([]);
    const a2 = await drainer.runKGDrain(drainHarness({ loadavgPath: hot }).deps);
    expect(a2.mode, 'two consecutive samples at exactly 3.0 downgrade').toBe('slow');
    expect(loadDowngradeEvents(a2)).toHaveLength(1);

    const fresh = compileDrainer(); // independent streak
    const warm = loadavgFile('2.99');
    const b1 = await fresh.runKGDrain(drainHarness({ loadavgPath: warm }).deps);
    const b2 = await fresh.runKGDrain(drainHarness({ loadavgPath: warm }).deps);
    expect(b1.mode, '2.99 ≥ 2.5 → not catch-up, < 3.0 → not high').toBe('steady');
    expect(b2.mode, 'two samples at 2.99 never downgrade').toBe('steady');
    expect(b2.load1).toBe(2.99);
    expect(loadDowngradeEvents(b2)).toEqual([]);
  });

  it('unreadable loadavg: load1 null, never catch-up, no downgrade event, no throw', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';
    const { deps, release } = drainHarness({ loadavgPath: path.join(tmpDir, 'no-such-loadavg') }); // backlog 2000, room free
    const result = await drainer.runKGDrain(deps);
    expect(result.load1).toBeNull();
    expect(result.mode).not.toBe('catchup');
    expect(loadDowngradeEvents(result)).toEqual([]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  // ── cross-process streak: one fresh module per oneshot fire ─────────────
  // Production never calls runKGDrain twice in one process (Type=oneshot →
  // scripts/kg-drain.js → runJob executes in the caller's process), so the
  // only link between two fires is the previous fire's persisted result.

  it('cross-process: two independent module instances (one per fire) — the second consecutive high sample still downgrades, rebuilt from the previous fire\'s persisted load1', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';
    const loadavgPath = loadavgFile('3.20');

    // Fire 1 = process 1: nothing persisted yet.
    const fire1 = compileDrainer();
    const first = drainHarness({ loadavgPath, readPreviousLoad1: vi.fn(() => null) });
    const r1 = await fire1.runKGDrain(first.deps);
    expect(r1.mode, 'first high sample with no previous sample must not downgrade').toBe('steady');
    expect(r1.load1).toBe(3.2);
    expect(loadDowngradeEvents(r1)).toEqual([]);
    expect(first.deps.readPreviousLoad1, 'a high sample consults the persisted history exactly once').toHaveBeenCalledTimes(1);

    // Fire 2 = process 2, 2h later: a NEW module (fresh in-process counter);
    // the only thing it shares with fire 1 is fire 1's stored result.load1.
    setLoad1(loadavgPath, '3.10');
    const fire2 = compileDrainer();
    expect(fire2).not.toBe(fire1);
    const second = drainHarness({ loadavgPath, readPreviousLoad1: vi.fn(() => r1.load1) });
    const r2 = await fire2.runKGDrain(second.deps);
    expect(r2.mode, 'second consecutive high sample across processes downgrades').toBe('slow');
    expect(r2.caps).toEqual(CAPS.slow);
    expect(r2.load1).toBe(3.1);
    expect(loadDowngradeEvents(r2)).toEqual([expect.objectContaining({ type: 'load-downgrade', load1: 3.1 })]);
    expect(second.deps.runExtract).toHaveBeenCalledWith(null, CAPS.slow.extract, { order: 'newest-first' });
    expect(second.deps.runEmbed).toHaveBeenCalledWith(null, CAPS.slow.embed, { order: 'newest-first' });
    expect(second.deps.runTopics).toHaveBeenCalledWith(null, CAPS.slow.topics, 5, { order: 'newest-first', pending: true });
    expect(second.calls).toEqual(['lock', 'extract', 'embed', 'topics', 'release']);

    // Fire 3 = process 3, load still hot: sustained high keeps the slow lane.
    const fire3 = compileDrainer();
    const r3 = await fire3.runKGDrain(drainHarness({ loadavgPath, readPreviousLoad1: vi.fn(() => r2.load1) }).deps);
    expect(r3.mode, 'sustained high load stays slow on every later fire').toBe('slow');
    expect(loadDowngradeEvents(r3)).toHaveLength(1);
  });

  it('cross-process: a previous sample below 3.0, no previous sample, or an unreadable history never downgrades a fresh process; a non-high current sample never consults the history', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';
    const cases = [
      { previous: () => 2.0, current: '3.40', label: 'previous low → streak restarts at 1' },
      { previous: () => null, current: '3.40', label: 'no previous sample' },
      { previous: () => { throw new Error('database is locked'); }, current: '3.40', label: 'unreadable history → treated as no previous sample' },
      { previous: () => 3.5, current: '2.99', label: 'current not high: a high previous sample is irrelevant', notConsulted: true },
    ];
    for (const { previous, current, label, notConsulted } of cases) {
      const fresh = compileDrainer(); // every row is its own process
      const { deps, release } = drainHarness({ loadavgPath: loadavgFile(current), readPreviousLoad1: vi.fn(previous) });
      const result = await fresh.runKGDrain(deps);
      expect(result.mode, label).toBe('steady');
      expect(loadDowngradeEvents(result), label).toEqual([]);
      expect(release, label).toHaveBeenCalledTimes(1);
      if (notConsulted) expect(deps.readPreviousLoad1, label).not.toHaveBeenCalled();
    }
  });

  it('a lock-busy cycle still persists its sample — { skipped: "lock-busy", load1 } — so the next fire can count it', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';
    const busy = compileDrainer();
    const { deps, release } = drainHarness({ loadavgPath: loadavgFile('3.30'), acquireLock: vi.fn(async () => null) });
    const result = await busy.runKGDrain(deps);
    expect(result).toEqual({ skipped: 'lock-busy', load1: 3.3 });
    expect(deps.runExtract).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    // Next fire (fresh process) reads that persisted 3.3 back and, being
    // high itself, is the second consecutive high sample → slow.
    const next = compileDrainer();
    const nextRun = drainHarness({ loadavgPath: loadavgFile('3.10'), readPreviousLoad1: vi.fn(() => result.load1) });
    const r = await next.runKGDrain(nextRun.deps);
    expect(r.mode, 'the lock-busy sample counts toward the streak').toBe('slow');
    expect(loadDowngradeEvents(r)).toEqual([expect.objectContaining({ type: 'load-downgrade', load1: 3.1 })]);
  });

  it('DRAIN_CAPS rationale (:42-43 erratum) documents the backlog trigger and the two-backlog 48h SLO, not idle windows', () => {
    const source = fs.readFileSync(DRAINER_PATH, 'utf8');
    const capsIndex = source.indexOf('const DRAIN_CAPS');
    expect(capsIndex, 'the DRAIN_CAPS table must still exist').toBeGreaterThan(-1);
    const before = source.slice(0, capsIndex);
    const block = before.slice(before.lastIndexOf('/**'));

    // Trigger premise: catch-up is a backlog + load criterion, not a clock.
    expect(block, 'must state the backlog_features > 500 trigger').toMatch(/[>＞]\s*500/);
    expect(block, 'must name the load1 gate').toMatch(/load1/);
    expect(block, 'must state the load1 < 2.5 bound').toMatch(/2\.5/);
    expect(block, 'must not attribute catch-up to idle windows any more').not.toMatch(/idle window|空闲时段|idleWindow/i);

    // SLO premise: 48h counts only when features AND embed are both at zero.
    expect(block).toMatch(/48\s?h/);
    expect(block, 'the 48h SLO covers the embed backlog as well as features').toMatch(/embed/);
    expect(block).toMatch(/features|extract/);
  });
});
