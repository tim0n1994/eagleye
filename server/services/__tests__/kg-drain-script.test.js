// @vitest-environment node
/**
 * R3 drainer fire script — scripts/kg-drain.js (EAGLEYE_R3_DRAINER).
 *
 * Contract under test — the repo-side half of the 3b98144 enrich-drainer
 * three-piece pattern (script + systemd user unit + 2h timer are the ops
 * half). The script is the timer's entry point and must be a thin,
 * side-effect-free-at-import module:
 *
 *   export async function main(deps = {})
 *     deps.countBacklog  () => number | Promise<number>  (read-only backlog probe)
 *     deps.fireDrainJob  (params) => Promise<{ job_id }> (goes through runJob)
 *     deps.now           () => Date                      (injectable clock)
 *
 *   Behavior:
 *     - EAGLEYE_R3_DRAINER off → { skipped: 'disabled' }; the backlog is not
 *       even probed and nothing is fired (switch off = timer runs, nothing
 *       happens — identical to today).
 *     - backlog below the fire threshold (200, the enrich drainer's floor)
 *       → { skipped: 'backlog-below-threshold', backlog }; nothing fired.
 *     - backlog at/above the threshold → fireDrainJob({ idleWindow }) exactly
 *       once; idleWindow is true inside the idle catch-up window (default
 *       00:30–05:30 local, 旧积压空闲时段补齐) and false otherwise; resolves
 *       { fired: true, job_id }.
 *     - every skip path resolves (the CLI wrapper exits 0; a skipped drain
 *       cycle is not an error).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const SCRIPT_PATH = path.resolve(import.meta.dirname, '../../../scripts/kg-drain.js');

function compileScript() {
  const subject = new Module(SCRIPT_PATH, module);
  subject.filename = SCRIPT_PATH;
  subject.require = id => {
    // The script must lazy-require its real dependencies (jobs, config)
    // inside main()/the CLI path so importing it stays side-effect free.
    if (id.startsWith('.')) return {};
    return require(id);
  };
  subject._compile(fs.readFileSync(SCRIPT_PATH, 'utf8'), SCRIPT_PATH);
  return subject.exports;
}

function scriptHarness({ backlog = 12712, now = '2026-10-21T10:00:00' } = {}) {
  const deps = {
    countBacklog: vi.fn(async () => backlog),
    fireDrainJob: vi.fn(async () => ({ job_id: 'job-1' })),
    now: vi.fn(() => new Date(now)),
  };
  return deps;
}

describe('kg-drain fire script presence (R3 lane)', () => {
  it('scripts/kg-drain.js exists behind EAGLEYE_R3_DRAINER', () => {
    expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
  });
});

const implemented = fs.existsSync(SCRIPT_PATH);
(implemented ? describe : describe.skip)('scripts/kg-drain.js fire decision', () => {
  let script;

  beforeEach(() => {
    delete process.env.EAGLEYE_R3_DRAINER;
    script = compileScript();
  });
  afterEach(() => {
    delete process.env.EAGLEYE_R3_DRAINER;
    vi.restoreAllMocks();
  });

  it('switch off is a full no-op: no backlog probe, nothing fired', async () => {
    const deps = scriptHarness();
    const result = await script.main(deps);
    expect(result).toEqual({ skipped: 'disabled' });
    expect(deps.countBacklog).not.toHaveBeenCalled();
    expect(deps.fireDrainJob).not.toHaveBeenCalled();
  });

  it('skips without firing when the backlog is below the 200-item floor', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';
    const deps = scriptHarness({ backlog: 88 });
    const result = await script.main(deps);
    expect(result).toEqual({ skipped: 'backlog-below-threshold', backlog: 88 });
    expect(deps.fireDrainJob).not.toHaveBeenCalled();
  });

  it('fires the drain job once outside the idle window (daytime: idleWindow false)', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';
    const deps = scriptHarness({ backlog: 12712, now: '2026-10-21T10:00:00' });
    const result = await script.main(deps);
    expect(deps.fireDrainJob).toHaveBeenCalledTimes(1);
    expect(deps.fireDrainJob).toHaveBeenCalledWith({ idleWindow: false });
    expect(result).toEqual({ fired: true, job_id: 'job-1' });
  });

  it('flags the idle catch-up window in the small hours (idleWindow true)', async () => {
    process.env.EAGLEYE_R3_DRAINER = '1';
    const deps = scriptHarness({ backlog: 12712, now: '2026-10-21T02:00:00' });
    await script.main(deps);
    expect(deps.fireDrainJob).toHaveBeenCalledWith({ idleWindow: true });
  });
});
