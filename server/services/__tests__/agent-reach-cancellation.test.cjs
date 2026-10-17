const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

for (const [wrapper, input, args] of [
  ['redditSubreddit', 'r/test', ['reddit', 'subreddit', 'test', '--sort', 'hot', '--limit', '20', '-f', 'json']],
  ['xiaohongshuSearch', 'test', ['xiaohongshu', 'search', 'test', '--limit', '20', '-f', 'json']],
]) {
  test(`${wrapper}: preabort spawns nothing; midflight abort kills the child`, { timeout: 5000 }, async t => {
    let child;
    const calls = [];
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../agent-reach.js'), 'utf8'), {
      module,
      require: name => name === 'child_process' ? {
        spawn(bin, commandArgs, opts) {
          calls.push({ bin, args: Array.from(commandArgs), opts });
          child = spawn(bin, ['-e', 'setInterval(() => {}, 1000)'], opts);
          return child;
        },
      } : require(name),
      process: { env: { AGENT_REACH_OPENCLI_BIN: process.execPath } },
    }, { filename: 'agent-reach.js' });
    t.after(() => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });

    const pre = new AbortController();
    const preReason = new Error('cancel before spawn');
    pre.abort(preReason);
    await assert.rejects(module.exports[wrapper](input, { signal: pre.signal }), err => err === preReason);
    assert.equal(calls.length, 0);

    const controller = new AbortController();
    const reason = new Error('cancel active child');
    const pending = module.exports[wrapper](input, { signal: controller.signal });
    const rejected = assert.rejects(pending, err => err === reason);
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    await once(child, 'spawn');
    controller.abort(reason);
    await rejected;
    assert.equal((await exited).signal, 'SIGKILL');
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, process.execPath);
    assert.deepEqual(calls[0].args, args);
    assert.equal(calls[0].opts.signal, controller.signal);
    assert.equal(calls[0].opts.killSignal, 'SIGKILL');
  });
}
