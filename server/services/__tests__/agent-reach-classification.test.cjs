const assert = require('node:assert/strict');
const test = require('node:test');

const { classifyError } = require('../agent-reach');

test('classifies rdt access-forbidden responses as authentication failures', () => {
  assert.deepEqual(
    classifyError('', 'Access forbidden: Resource', 1, null),
    { code: 'AUTH_REQUIRED', message: 'login required or session expired' },
  );
});

test('keeps ordinary collector failures distinct from authentication failures', () => {
  assert.equal(classifyError('', 'upstream unavailable', 1, null).code, 'EXIT_1');
});
