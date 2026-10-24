const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

test('dedicated X sync records connector failures before rethrowing', async () => {
  const originalRequire = Module.prototype.require;
  const recordFailedAttempt = (...args) => { recordFailedAttempt.calls.push(args); };
  recordFailedAttempt.calls = [];
  class FailingConnector {
    async fetch() {
      const error = new Error('X Following feed returned an empty first page');
      error.code = 'EMPTY_FEED';
      throw error;
    }
  }

  Module.prototype.require = function patchedRequire(name, ...rest) {
    if (name === '../connectors/x-following') return { XFollowingConnector: FailingConnector };
    if (name === '../connectors/index') return { recordFailedAttempt };
    if (name === './jobs') return { isJobCancelled: () => false };
    return originalRequire.call(this, name, ...rest);
  };

  const subjectPath = require.resolve('../x-following');
  delete require.cache[subjectPath];
  try {
    const { syncXFollowing } = require('../x-following');
    await assert.rejects(syncXFollowing(), /empty first page/);
    assert.equal(recordFailedAttempt.calls.length, 1);
    assert.equal(recordFailedAttempt.calls[0][0], 'x-following');
    assert.equal(recordFailedAttempt.calls[0][1].code, 'EMPTY_FEED');
    assert.equal(typeof recordFailedAttempt.calls[0][2], 'number');
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[subjectPath];
  }
});
