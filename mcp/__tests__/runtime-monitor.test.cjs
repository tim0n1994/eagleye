const { after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readRuntimeMonitor } = require('../runtime-monitor');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-runtime-monitor-'));
let sequence = 0;

const writeState = (state) => {
  const file = path.join(directory, 'state-' + (++sequence) + '.json');
  fs.writeFileSync(file, JSON.stringify(state));
  return file;
};

const baseState = () => ({
  checked_at: '2026-11-07T00:30:00Z',
  issues: [],
  metrics: {
    enrich_pending: 0,
    free_gib: 10,
    kg_pending: 0,
    outbox_pending: 0,
  },
});

describe('runtime monitor warning boundary', () => {
  it('maps known pipeline degradations to fixed codes and reports degraded', () => {
    const result = readRuntimeMonitor({
      file: writeState({
        ...baseState(),
        warnings: [
          'pipeline_degraded:fetch: 1 source(s) failed; continuing downstream with 14 available source(s)',
          'pipeline_degraded:translate: 32 translation item(s) failed; 68 succeeded',
        ],
      }),
      now: Date.parse('2026-11-07T00:31:00Z'),
    });
    assert.equal(result.status, 'degraded');
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.warnings, ['pipeline_degraded_fetch', 'pipeline_degraded_translate']);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('source(s) failed'));
    assert.ok(!serialized.includes('14 available'));
    assert.ok(!serialized.includes('32 translation item(s) failed'));
  });

  it('generalizes unknown warnings without exposing their text', () => {
    const secretMarker = 'SECRET-VALUE-/home/example/private';
    const result = readRuntimeMonitor({
      file: writeState({
        ...baseState(),
        warnings: [
          'pipeline_degraded:custom-stage: ' + secretMarker,
          'unrelated-warning ' + secretMarker,
        ],
      }),
      now: Date.parse('2026-11-07T00:31:00Z'),
    });
    assert.equal(result.status, 'degraded');
    assert.deepEqual(result.warnings, ['unrecognized_monitor_warning']);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('custom-stage'));
    assert.ok(!serialized.includes(secretMarker));
  });

  it('keeps issue degraded behavior and stale precedence unchanged', () => {
    const now = Date.parse('2026-11-07T02:31:00Z');
    const issueResult = readRuntimeMonitor({
      file: writeState({ ...baseState(), issues: ['disk_free_below_10gib'] }),
      now,
    });
    assert.equal(issueResult.status, 'stale');
    assert.deepEqual(issueResult.issues, ['disk_free_below_10gib']);
    assert.deepEqual(issueResult.warnings, []);
  });

  it('rejects malformed warning arrays and symlinked state files', () => {
    const malformed = readRuntimeMonitor({
      file: writeState({ ...baseState(), warnings: 'SECRET-VALUE' }),
      now: Date.parse('2026-11-07T00:31:00Z'),
    });
    assert.deepEqual(malformed, { status: 'unavailable', reason: 'invalid_state' });

    const target = writeState(baseState());
    const link = path.join(directory, 'state-link.json');
    fs.symlinkSync(target, link);
    assert.deepEqual(readRuntimeMonitor({ file: link }), {
      status: 'unavailable',
      reason: 'unreadable_state',
    });
  });
});

after(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});
