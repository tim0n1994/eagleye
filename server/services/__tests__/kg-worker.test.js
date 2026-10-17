// @vitest-environment node
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { describe, beforeEach, afterEach, it, expect } = globalThis;

function workerHarness(dbPath, { autoClose = true, platform = 'darwin', killError = null } = {}) {
  const calls = [];
  const groupSignals = [];
  const processSignals = [];
  let currentDBPath = dbPath;
  const module = { exports: {} };
  const filename = path.resolve(__dirname, '../kg-worker.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, __dirname: path.dirname(filename),
    process: {
      env: process.env,
      platform,
      kill(pid, signal) {
        groupSignals.push({ pid, signal });
        if (killError) throw killError;
      },
    },
    require(name) {
      if (name === '../config') return { getDBPath: () => currentDBPath };
      if (name !== 'child_process') return require(name);
      return {
        spawn(command, args, options) {
          const child = new EventEmitter();
          child.pid = 42000 + calls.length;
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = signal => { processSignals.push({ pid: child.pid, signal }); return true; };
          calls.push({ command, args, options, child });
          if (autoClose) {
            queueMicrotask(() => {
              child.stdout.emit('data', 'worker progress\n{"processed":1}\n');
              child.emit('close', 0);
            });
          }
          return child;
        },
      };
    },
  }, { filename });
  return { worker: module.exports, calls, groupSignals, processSignals, setDBPath(value) { currentDBPath = value; } };
}

describe('KG worker subprocess contract', () => {
  let directory;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-kg-test-')); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  it('runs bounded stages using the configured DB path and active-source default', async () => {
    const dbPath = path.join(directory, 'isolated.db');
    const harness = workerHarness(dbPath);
    const result = await harness.worker.runKGFullPipeline();
    expect(Object.keys(result)).toEqual(['extract', 'embed', 'topics']);
    expect(harness.calls).toHaveLength(3);
    const limits = ['200', '500', '1000'];
    harness.calls.forEach(({ command, args, options }, index) => {
      expect(command).toBe('uv');
      expect(args[args.indexOf('--db') + 1]).toBe(dbPath);
      expect(args[args.indexOf('--limit') + 1]).toBe(limits[index]);
      expect(args).not.toContain('--sources');
      expect(options.shell).toBeUndefined();
    });
  });

  it('resolves DB path for each invocation and preserves explicit source scope', async () => {
    const harness = workerHarness(path.join(directory, 'first.db'));
    await harness.worker.runKGExtract(['reddit', 'hacker-news'], 7);
    const second = path.join(directory, 'path with spaces.db');
    harness.setDBPath(second);
    await harness.worker.runKGExtract(null, 2);
    const firstArgs = harness.calls[0].args;
    expect(firstArgs[firstArgs.indexOf('--sources') + 1]).toBe('reddit,hacker-news');
    const secondArgs = harness.calls[1].args;
    expect(secondArgs[secondArgs.indexOf('--db') + 1]).toBe(second);
  });

  it('terminates only owned POSIX process groups and removes completed workers', async () => {
    const harness = workerHarness(path.join(directory, 'isolated.db'), { autoClose: false });
    const otherHarness = workerHarness(path.join(directory, 'other.db'), { autoClose: false });
    const completed = harness.worker.runKGExtract();
    harness.calls[0].child.emit('close', 0);
    await completed;
    const running = harness.worker.runKGEmbed();
    const rejected = expect(running).rejects.toThrow('KG worker exit null');
    const otherRunning = otherHarness.worker.runKGExtract();
    expect(harness.calls[1].options.detached).toBe(true);
    expect(harness.calls[1].command).toBe('uv');
    expect(harness.calls[1].args).toContain('eagleye-kg');
    expect(harness.worker.stopKGWorkers()).toEqual({ stopped: 1, errors: [] });
    expect(harness.groupSignals).toEqual([{ pid: -42001, signal: 'SIGTERM' }]);
    expect(harness.processSignals).toEqual([]);
    expect(otherHarness.groupSignals).toEqual([]);
    expect(otherHarness.processSignals).toEqual([]);
    harness.calls[1].child.emit('close', null);
    await rejected;
    expect(harness.worker.stopKGWorkers()).toEqual({ stopped: 0, errors: [] });
    otherHarness.calls[0].child.emit('close', 0);
    await otherRunning;
  });

  it('uses the owned child kill fallback on Windows', async () => {
    const harness = workerHarness(path.join(directory, 'isolated.db'), { autoClose: false, platform: 'win32' });
    const running = harness.worker.runKGExtract();
    const rejected = expect(running).rejects.toThrow('KG worker exit null');
    expect(harness.calls[0].options.detached).toBe(false);
    expect(harness.worker.stopKGWorkers()).toEqual({ stopped: 1, errors: [] });
    expect(harness.groupSignals).toEqual([]);
    expect(harness.processSignals).toEqual([{ pid: 42000, signal: 'SIGTERM' }]);
    harness.calls[0].child.emit('close', null);
    await rejected;
  });

  it('prevents the next pipeline stage from spawning during shutdown', async () => {
    const harness = workerHarness(path.join(directory, 'isolated.db'), { autoClose: false });
    const running = harness.worker.runKGFullPipeline();
    const rejected = expect(running).rejects.toThrow('KG workers are shutting down');
    harness.worker.stopKGWorkers();
    harness.calls[0].child.emit('close', 0);
    await rejected;
    expect(harness.calls).toHaveLength(1);
  });

  it('keeps shutting down other workers when a group signal fails', async () => {
    const error = Object.assign(new Error('not permitted'), { code: 'EPERM' });
    const harness = workerHarness(path.join(directory, 'isolated.db'), { autoClose: false, killError: error });
    const pending = [harness.worker.runKGExtract(), harness.worker.runKGEmbed()];
    expect(harness.worker.stopKGWorkers()).toEqual({ stopped: 0, errors: [error, error] });
    expect(harness.groupSignals.map(signal => signal.pid)).toEqual([-42000, -42001]);
    harness.calls.forEach(({ child }) => child.emit('close', 0));
    await Promise.all(pending);
  });

  it('ignores exited groups and never signals missing spawn PIDs', async () => {
    const error = Object.assign(new Error('not found'), { code: 'ESRCH' });
    const harness = workerHarness(path.join(directory, 'isolated.db'), { autoClose: false, killError: error });
    const exited = harness.worker.runKGExtract();
    const failed = harness.worker.runKGEmbed();
    const rejected = expect(failed).rejects.toThrow('spawn failed');
    harness.calls[1].child.pid = undefined;
    harness.calls[1].child.emit('error', new Error('spawn failed'));
    await rejected;
    expect(harness.worker.stopKGWorkers()).toEqual({ stopped: 0, errors: [] });
    expect(harness.groupSignals).toEqual([{ pid: -42000, signal: 'SIGTERM' }]);
    harness.calls[0].child.emit('close', 0);
    await exited;
  });
});
