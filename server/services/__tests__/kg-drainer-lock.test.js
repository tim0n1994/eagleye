// @vitest-environment node
/**
 * Real-mechanism lock integration test for defaultAcquireLock
 * (EAGLEYE_R3_DRAINER) — pins the review-blocker fix (2026-10-21).
 *
 * kg-drainer.test.js injects acquireLock in all 10 cases, so the real
 * flock mechanics had ZERO coverage — which is exactly how the bug hid:
 * release() was `proc.kill('SIGTERM')` on the flock parent, while the
 * FD-inheriting sh/sleep child kept holding heavy.lock until the sleep
 * expired (default 1800s). Verified on the deployment host: after killing
 * the flock parent, a second `flock -w 1` was still busy until the sleep
 * child died — every drain would have left heavy.lock occupied for up to
 * 30 minutes, blocking the nightly pipeline and mis-skipping drains as
 * { skipped: 'lock-busy' }.
 *
 * This file runs the REAL default wiring through runKGDrain (acquireLock
 * deliberately NOT injected) on a temporary lock path and asserts:
 *   1. while the drain's stages run, an external `flock -n` on the same
 *      path FAILS — the lock is really held;
 *   2. once runKGDrain resolves (release() ran), `flock -n` on the same
 *      path SUCCEEDS IMMEDIATELY — release must drop the lock now, not
 *      when a sleep-H holder eventually expires.
 *
 * Mechanism under test: holder chain `flock -w W <path> sh -c 'echo
 * locked; timeout H cat'` with stdin piped; release() = stdin.end() →
 * cat EOF → chain exit → lock FD closes. Linux-only (flock/sh/timeout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const DRAINER_PATH = path.resolve(import.meta.dirname, '../kg-drainer.js');

function compileDrainer() {
  const subject = new Module(DRAINER_PATH, module);
  subject.filename = DRAINER_PATH;
  subject.require = id => {
    if (id.startsWith('.')) return {};
    return require(id);
  };
  subject._compile(fs.readFileSync(DRAINER_PATH, 'utf8'), DRAINER_PATH);
  return subject.exports;
}

/** 0 = lock free (flock -n succeeded), non-zero = busy. */
function flockNonblockingStatus(lockPath) {
  const result = spawnSync('flock', ['-n', lockPath, 'true'], { encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  return result.status;
}

/**
 * release() ends stdin; the holder chain (cat EOF → timeout → sh) then
 * exits within milliseconds. Poll briefly instead of probing at exactly
 * zero delay: the discriminating window is milliseconds (fixed) vs the
 * holder timeout (300s here — the old kill-parent bug kept the lock busy
 * for that entire span, so a 2s poll still separates the two cleanly).
 */
async function waitForLockFree(lockPath, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (flockNonblockingStatus(lockPath) === 0) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return flockNonblockingStatus(lockPath) === 0;
}

const onLinux = process.platform === 'linux';

describe('defaultAcquireLock real flock mechanism (EAGLEYE_R3_DRAINER)', () => {
  let directory;
  let lockPath;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-kg-lock-test-'));
    lockPath = path.join(directory, 'heavy.lock');
    process.env.EAGLEYE_R3_DRAINER = '1';
    process.env.EAGLEYE_HEAVY_LOCK = lockPath;
    process.env.EAGLEYE_DRAIN_LOCK_WAIT_SECONDS = '5';
    process.env.EAGLEYE_DRAIN_LOCK_HOLD_SECONDS = '300';
  });

  afterEach(() => {
    delete process.env.EAGLEYE_R3_DRAINER;
    delete process.env.EAGLEYE_HEAVY_LOCK;
    delete process.env.EAGLEYE_DRAIN_LOCK_WAIT_SECONDS;
    delete process.env.EAGLEYE_DRAIN_LOCK_HOLD_SECONDS;
    fs.rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  (onLinux ? describe : describe.skip)('release() drops heavy.lock immediately', () => {
    it('holds the lock during the drain and frees it the moment runKGDrain resolves', async () => {
      const drainer = compileDrainer();
      let statusWhileDraining = null;
      const deps = {
        readSalon9Count: () => 0, // deterministic: room free → steady mode
        idleWindow: false,
        runExtract: vi.fn(async () => {
          statusWhileDraining = flockNonblockingStatus(lockPath);
          return 'extract-result';
        }),
        runEmbed: vi.fn(async () => 'embed-result'),
        runTopics: vi.fn(async () => 'topics-result'),
        // acquireLock deliberately NOT injected: the REAL default wiring runs.
      };
      const result = await drainer.runKGDrain(deps);
      expect(result).toMatchObject({ mode: 'steady', extract: 'extract-result' });
      // Property 1: the lock was really held while the stages ran.
      expect(statusWhileDraining).not.toBe(0);
      // Property 2: release() freed the lock NOW — not when the holder's
      // timeout would have expired (HOLD=300s here; the old kill-parent
      // implementation kept it busy for that long).
      expect(await waitForLockFree(lockPath)).toBe(true);
    });

    it('yields { skipped: "lock-busy" } when another holder owns heavy.lock', async () => {
      process.env.EAGLEYE_DRAIN_LOCK_WAIT_SECONDS = '2';
      const drainer = compileDrainer();
      const holder = spawn('flock', [lockPath, 'sleep', '8'], { stdio: 'ignore' });
      // Give the holder a beat to actually acquire the lock.
      await new Promise(resolve => holder.on('spawn', () => setTimeout(resolve, 250)));
      const deps = {
        readSalon9Count: () => 0,
        idleWindow: false,
        runExtract: vi.fn(async () => 'extract-result'),
        runEmbed: vi.fn(async () => 'embed-result'),
        runTopics: vi.fn(async () => 'topics-result'),
        // acquireLock deliberately NOT injected: the REAL default wiring runs.
      };
      const result = await drainer.runKGDrain(deps);
      expect(result).toMatchObject({ skipped: 'lock-busy' });
      // R3.1: the skip carries the load sample so the next (fresh-process)
      // fire can rebuild the load1 ≥ 3.0 streak; this file reads the real
      // /proc/loadavg, so only the shape is pinned here.
      expect(result.load1 === null || typeof result.load1 === 'number').toBe(true);
      expect(deps.runExtract).not.toHaveBeenCalled();
      expect(deps.runEmbed).not.toHaveBeenCalled();
      expect(deps.runTopics).not.toHaveBeenCalled();
      holder.kill('SIGKILL');
      await new Promise(resolve => holder.on('close', resolve));
    });
  });
});
