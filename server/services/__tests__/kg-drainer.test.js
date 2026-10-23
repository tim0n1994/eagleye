// @vitest-environment node
/**
 * R3 convergence drainer — EAGLEYE_R3_DRAINER core module contract.
 *
 * Contract under test — NEW module server/services/kg-drainer.js (Round 3
 * stage 2, CTO-approved direction): the KG convergence stages move from the
 * nightly one-shot pipeline (extract 200 / embed 500 / topics 1000, one run
 * per pipeline) to a 2h continuous drainer, copying the 3b98144 enrich
 * drainer operating model. All logic behind the EAGLEYE_R3_DRAINER env
 * switch; switch OFF must leave today's behavior byte-identical (pinned by
 * kg-worker-drain-args.test.js and enrich-partial-failure.test.js).
 *
 * Exported surface:
 *   isDrainerEnabled() -> boolean
 *       EAGLEYE_R3_DRAINER read at CALL time (same truthy spellings as
 *       isJobIntakePaused, jobs.js: '1'/'true'/'yes'/'on', trimmed,
 *       case-insensitive). Unset/empty/anything else -> false.
 *   salon9Occupied(count) -> boolean
 *       CTO rule: Salon9 room occupied (asr-agent log count > 0) → slow
 *       down; log UNREADABLE → treat as occupied (safe default).
 *   drainCaps(mode) -> { extract, embed, topics, order }
 *       'steady'    extract 500  / embed 1000 / topics 1000 / newest-first
 *       'catchup'   extract 1000 / embed 1000 / topics 1000 / oldest-first
 *       'slow'      extract 200  / embed 500  / topics 1000 / newest-first
 *       Rationale (stage-1 measurements): catching up 12,712 + 2×4,400
 *       intake in 48h over 24 runs needs ≥897 extract/run → 1000 catchup;
 *       steady 500 keeps ahead of ~370 items/2h intake with headroom;
 *       topics stays 1000 because its write phase is one BEGIN IMMEDIATE
 *       transaction that contends with the live service; slow = today's
 *       pipeline caps while Salon9 is occupied.
 *   runKGDrain(options) -> Promise<result>   (used by the KG_DRAIN job)
 *       options (all injectable for tests; real defaults lazy-wired):
 *         readSalon9Count      () => number | null | throws  (default: unreadable)
 *         readBacklogFeatures  () => number  (read-only backlog_features count)
 *         readBacklogTopics    () => number  (read-only topic-consumable backlog)
 *         loadavgPath          string  (/proc/loadavg-shaped file; load1 = 1st field)
 *         readPreviousLoad1    () => number | null  (previous fire's persisted load1;
 *                              each 2h fire is a fresh oneshot process, so the
 *                              load1 ≥ 3.0 streak is rebuilt from it)
 *         idleWindow           boolean  — still accepted, IGNORED since R3.1
 *                              (ruling A: the backlog trigger replaced the clock;
 *                              boundaries live in kg-drainer-backlog-trigger.test.js)
 *         acquireLock          () => Promise<release|null>   (heavy.lock; null = busy/timeout)
 *         runExtract / runEmbed / runTopics                  (kg-worker stage runners)
 *       Behavior:
 *         - switch off → { skipped: 'disabled' }; nothing else touched.
 *         - occupancy = salon9Occupied(readSalon9Count()); mode =
 *           occupied ? 'slow'
 *           : (backlog_features > 500 && load1 < 2.5) ? 'catchup' : 'steady'
 *           (plus the R3.1 load guard: two consecutive samples with load1 ≥ 3.0
 *           → 'slow' + a load-downgrade event).
 *         - acquire heavy.lock FIRST; null release → { skipped: 'lock-busy', load1 }
 *           (超时让出; the sample is kept for the next fire) and NO stage runs.
 *         - stages run once each in order extract → embed → topics with
 *           the mode caps; topics is the only stage needing the converging
 *           pending predicate (--pending) so the 60k old dynamic-topic
 *           backlog actually drains; every stage gets --order (newest-first
 *           keeps 入库→出向量 p95 < 6h, oldest-first chews old backlog in
 *           catch-up runs).
 *         - release() exactly once in a finally path, even when a stage
 *           throws (the error still propagates; remaining stages are not
 *           started).
 *         - resolves { mode, caps, load1, backlogFeatures, backlogTopics, events, extract,
 *           embed, topics } (sampled inputs + stage results).
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
    // Stage runners and lock/salon9 readers must be lazy-required inside
    // runKGDrain defaults so this pure-decision module stays side-effect
    // free; tests always inject them anyway.
    if (id.startsWith('.')) return {};
    return require(id);
  };
  subject._compile(fs.readFileSync(DRAINER_PATH, 'utf8'), DRAINER_PATH);
  return subject.exports;
}

// Injected /proc/loadavg stand-in (R3.1): a quiet machine, load1 0.50, so no
// case here depends on the real host load. Nothing in this file reads the
// real /proc/loadavg or the production DB.
let tmpDir;
let quietLoadavg;

function drainHarness(overrides = {}) {
  const calls = [];
  const release = vi.fn(() => { calls.push('release'); });
  const deps = {
    readSalon9Count: vi.fn(() => 0),
    readBacklogFeatures: vi.fn(() => 0), // no backlog → never catch-up unless a case says so
    readBacklogTopics: vi.fn(() => 0),
    loadavgPath: quietLoadavg,
    idleWindow: false,
    acquireLock: vi.fn(async () => { calls.push('lock'); return release; }),
    runExtract: vi.fn(async () => { calls.push('extract'); return 'extract-result'; }),
    runEmbed: vi.fn(async () => { calls.push('embed'); return 'embed-result'; }),
    runTopics: vi.fn(async () => { calls.push('topics'); return 'topics-result'; }),
    ...overrides,
  };
  return { deps, calls, release };
}

describe('kg-drainer module presence (R3 lane)', () => {
  it('server/services/kg-drainer.js exists behind EAGLEYE_R3_DRAINER', () => {
    expect(fs.existsSync(DRAINER_PATH)).toBe(true);
  });
});

// Until the module lands, only the presence test fails (assertion FAIL, not
// a module-resolution error) and the contract suite is skipped.
const implemented = fs.existsSync(DRAINER_PATH);
(implemented ? describe : describe.skip)('EAGLEYE_R3_DRAINER kg-drainer contract', () => {
  let drainer;

  beforeEach(() => {
    delete process.env.EAGLEYE_R3_DRAINER;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-drainer-contract-'));
    quietLoadavg = path.join(tmpDir, 'loadavg');
    fs.writeFileSync(quietLoadavg, '0.50 0.58 1.12 1/936 2952339\n');
    drainer = compileDrainer();
  });
  afterEach(() => {
    delete process.env.EAGLEYE_R3_DRAINER;
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enables only for the documented truthy spellings, read at call time', () => {
    for (const value of ['1', 'true', 'yes', 'on', 'ON', ' true ']) {
      process.env.EAGLEYE_R3_DRAINER = value;
      expect(drainer.isDrainerEnabled(), `EAGLEYE_R3_DRAINER=${value} must enable`).toBe(true);
    }
    for (const value of [undefined, '', '0', 'off', 'no', 'bogus']) {
      if (value === undefined) delete process.env.EAGLEYE_R3_DRAINER;
      else process.env.EAGLEYE_R3_DRAINER = value;
      expect(drainer.isDrainerEnabled(), `EAGLEYE_R3_DRAINER=${value} must disable`).toBe(false);
    }
  });

  it('salon9 occupancy: count 0 is free; >0 or unreadable counts as occupied', () => {
    expect(drainer.salon9Occupied(0)).toBe(false);
    expect(drainer.salon9Occupied(3)).toBe(true);
    expect(drainer.salon9Occupied(null)).toBe(true);
  });

  it('drain caps match the stage-1 measured per-run bounds', () => {
    expect(drainer.drainCaps('steady')).toEqual(CAPS.steady);
    expect(drainer.drainCaps('catchup')).toEqual(CAPS.catchup);
    expect(drainer.drainCaps('slow')).toEqual(CAPS.slow);
  });

  it('switch off is a no-op: no lock, no salon9 probe, no stages', async () => {
    const { deps, release } = drainHarness();
    const result = await drainer.runKGDrain(deps);
    expect(result).toEqual({ skipped: 'disabled' });
    expect(deps.acquireLock).not.toHaveBeenCalled();
    expect(deps.readSalon9Count).not.toHaveBeenCalled();
    expect(deps.runExtract).not.toHaveBeenCalled();
    expect(deps.runEmbed).not.toHaveBeenCalled();
    expect(deps.runTopics).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('heavy.lock timeout yields the run: no stage executes (the skip still carries the load sample for the next fire)', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';
    const { deps, release } = drainHarness({ acquireLock: vi.fn(async () => null) });
    const result = await drainer.runKGDrain(deps);
    expect(result).toEqual({ skipped: 'lock-busy', load1: 0.5 });
    expect(deps.runExtract).not.toHaveBeenCalled();
    expect(deps.runEmbed).not.toHaveBeenCalled();
    expect(deps.runTopics).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('steady run: locks once, runs each stage once with caps + order + topics pending, releases once', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';
    const { deps, calls, release } = drainHarness();
    const result = await drainer.runKGDrain(deps);
    expect(result).toEqual({
      mode: 'steady',
      caps: CAPS.steady,
      load1: 0.5, // the sampled inputs ride along so the stored job result explains its mode
      backlogFeatures: 0,
      backlogTopics: 0,
      events: [],
      extract: 'extract-result',
      embed: 'embed-result',
      topics: 'topics-result',
    });
    expect(calls).toEqual(['lock', 'extract', 'embed', 'topics', 'release']);
    expect(deps.runExtract).toHaveBeenCalledTimes(1);
    expect(deps.runExtract).toHaveBeenCalledWith(null, CAPS.steady.extract, { order: CAPS.steady.order });
    expect(deps.runEmbed).toHaveBeenCalledTimes(1);
    expect(deps.runEmbed).toHaveBeenCalledWith(null, CAPS.steady.embed, { order: CAPS.steady.order });
    expect(deps.runTopics).toHaveBeenCalledTimes(1);
    expect(deps.runTopics).toHaveBeenCalledWith(null, CAPS.steady.topics, 5, { order: CAPS.steady.order, pending: true });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('occupied salon9 (count > 0, unreadable, or throwing reader) drains in slow mode', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';
    for (const readSalon9Count of [vi.fn(() => 5), vi.fn(() => null), vi.fn(() => { throw new Error('journalctl unavailable'); })]) {
      const { deps } = drainHarness({ readSalon9Count });
      const result = await drainer.runKGDrain(deps);
      expect(result.mode).toBe('slow');
      expect(result.caps).toEqual(CAPS.slow);
      expect(deps.runExtract).toHaveBeenCalledWith(null, CAPS.slow.extract, { order: CAPS.slow.order });
      expect(deps.runTopics).toHaveBeenCalledWith(null, CAPS.slow.topics, 5, { order: CAPS.slow.order, pending: true });
    }
  });

  it('backlog trigger (R3.1): backlog_features > 500 on a free, quiet machine switches to catch-up (oldest-first); idleWindow no longer decides', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';
    // idleWindow:false is the daytime value scripts/kg-drain.js still sends —
    // the backlog alone must drive catch-up (boundaries 499/500/501 and
    // 2.49/2.5 are pinned in kg-drainer-backlog-trigger.test.js).
    const { deps } = drainHarness({ idleWindow: false, readBacklogFeatures: vi.fn(() => 2000) });
    const result = await drainer.runKGDrain(deps);
    expect(result.mode).toBe('catchup');
    expect(result.caps).toEqual(CAPS.catchup);
    expect(result.backlogFeatures).toBe(2000);
    expect(deps.readBacklogFeatures).toHaveBeenCalledTimes(1);
    expect(deps.runExtract).toHaveBeenCalledWith(null, CAPS.catchup.extract, { order: 'oldest-first' });
    expect(deps.runEmbed).toHaveBeenCalledWith(null, CAPS.catchup.embed, { order: 'oldest-first' });
    expect(deps.runTopics).toHaveBeenCalledWith(null, CAPS.catchup.topics, 5, { order: 'oldest-first', pending: true });
  });

  it('a failing stage still releases the lock exactly once and stops the chain', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';
    const { deps, release } = drainHarness({
      runEmbed: vi.fn(async () => { throw new Error('KG worker exit 1'); }),
    });
    await expect(drainer.runKGDrain(deps)).rejects.toThrow('KG worker exit 1');
    expect(release).toHaveBeenCalledTimes(1);
    expect(deps.runTopics).not.toHaveBeenCalled();
  });
});
