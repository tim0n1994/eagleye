// @vitest-environment node
/**
 * R3 drainer CLI argument contract — server/services/kg-worker.js.
 *
 * Contract under test (EAGLEYE_R3_DRAINER lane):
 *   The kg-worker stage runners gain an OPTIONAL trailing options object so
 *   the 2h drainer can pass drain parameters through to the Python CLI
 *   without touching the default signatures:
 *
 *     runKGExtract(sources, limit, { order })        → 'extract --order <o>'
 *     runKGEmbed(sources, limit, batchSize, { order }) → 'embed --order <o>'
 *     runKGTopics(sources, limit, minItems, { order, pending })
 *                        → 'topics --order <o>' and bare '--pending'
 *
 *   --pending is the converging topics selection predicate (items that
 *   already have a semantic-lite vector are done — the 60k dynamic-topic
 *   backlog cannot drain without it, see kg-worker/tests/
 *   test_drain_selection.py). --order newest-first/oldest-first implements
 *   积压最新优先 + 旧积压空闲补齐 (p95 入库→出向量 < 6h).
 *
 *   CHARACTERISTIC (must hold before AND after the change — switch OFF is
 *   byte-identical to today): runKGFullPipeline() still spawns exactly
 *   three commands with limits 200/500/1000 and NO --order / --pending
 *   arguments, and bare stage calls without options add no new flags.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

function workerHarness(dbPath) {
  const calls = [];
  const module = { exports: {} };
  const filename = path.resolve(import.meta.dirname, '../kg-worker.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, __dirname: path.dirname(filename),
    process: { env: process.env, platform: 'linux', kill() {} },
    require(name) {
      if (name === '../config') return { getDBPath: () => dbPath };
      if (name !== 'child_process') return require(name);
      return {
        spawn(command, args, options) {
          const child = new EventEmitter();
          child.pid = 43000 + calls.length;
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => true;
          calls.push({ command, args, options });
          queueMicrotask(() => {
            child.stdout.emit('data', '{"processed":1}\n');
            child.emit('close', 0);
          });
          return child;
        },
      };
    },
  }, { filename });
  return { worker: module.exports, calls };
}

function arg(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('kg-worker drain CLI arguments (EAGLEYE_R3_DRAINER)', () => {
  let directory;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-kg-drain-test-'));
    delete process.env.KG_EMBED_BACKEND;
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    delete process.env.KG_EMBED_BACKEND;
    vi.restoreAllMocks();
  });

  it('CHARACTERISTIC: runKGFullPipeline stays byte-identical (200/500/1000, no drain flags)', async () => {
    const harness = workerHarness(path.join(directory, 'isolated.db'));
    const result = await harness.worker.runKGFullPipeline();
    expect(Object.keys(result)).toEqual(['extract', 'embed', 'topics']);
    expect(harness.calls).toHaveLength(3);
    const limits = ['200', '500', '1000'];
    harness.calls.forEach(({ args }, index) => {
      expect(arg(args, '--limit')).toBe(limits[index]);
      expect(args).not.toContain('--order');
      expect(args).not.toContain('--pending');
    });
  });

  it('CHARACTERISTIC: bare stage calls without options add no drain flags', async () => {
    const harness = workerHarness(path.join(directory, 'isolated.db'));
    await harness.worker.runKGTopics(null, 999, 5);
    await harness.worker.runKGExtract(null, 7);
    for (const { args } of harness.calls) {
      expect(args).not.toContain('--order');
      expect(args).not.toContain('--pending');
    }
  });

  it('runKGTopics forwards order and the converging pending predicate', async () => {
    const harness = workerHarness(path.join(directory, 'isolated.db'));
    await harness.worker.runKGTopics(null, 1000, 5, { order: 'oldest-first', pending: true });
    const [args] = harness.calls.map(call => call.args);
    expect(arg(args, '--limit')).toBe('1000');
    expect(arg(args, '--min-items')).toBe('5');
    expect(arg(args, '--order')).toBe('oldest-first');
    expect(args).toContain('--pending');
  });

  it('runKGExtract forwards order (and never a pending flag)', async () => {
    const harness = workerHarness(path.join(directory, 'isolated.db'));
    await harness.worker.runKGExtract(null, 500, { order: 'newest-first' });
    const [args] = harness.calls.map(call => call.args);
    expect(arg(args, '--limit')).toBe('500');
    expect(arg(args, '--order')).toBe('newest-first');
    expect(args).not.toContain('--pending');
  });

  it('runKGEmbed forwards order and keeps the hash backend default', async () => {
    const harness = workerHarness(path.join(directory, 'isolated.db'));
    await harness.worker.runKGEmbed(null, 1000, 64, { order: 'newest-first' });
    const [args] = harness.calls.map(call => call.args);
    expect(arg(args, '--limit')).toBe('1000');
    expect(arg(args, '--batch-size')).toBe('64');
    expect(arg(args, '--backend')).toBe('hash');
    expect(arg(args, '--order')).toBe('newest-first');
    expect(args).not.toContain('--pending');
  });
});
