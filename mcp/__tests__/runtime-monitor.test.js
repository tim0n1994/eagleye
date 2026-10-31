// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { readRuntimeMonitor } = require('../runtime-monitor');
const directory = mkdtempSync(path.join(tmpdir(), 'eagleye-monitor-boundary-'));
const file = path.join(directory, 'state.json');
const now = Date.parse('2026-01-02T03:04:05Z');
const healthy = () => ({
  checked_at: '2026-01-02T03:04:05.123456+00:00',
  issues: [],
  metrics: { free_gib: 50, outbox_pending: 0, kg_pending: 10, enrich_pending: 5 },
});
function read(state, options = {}) {
  writeFileSync(file, JSON.stringify(state));
  return readRuntimeMonitor({ file, now, ...options });
}
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('local monitor evidence boundary', () => {
  it('is opt-in and exposes only fixed scalar fields', () => {
    expect(readRuntimeMonitor({ file: '' })).toEqual({ status: 'not_configured' });
    const state = healthy();
    state.api_key = 'private-fixture';
    state.metrics.endpoint = 'private-fixture';
    state.metrics.model = 'private-fixture';
    state.metrics.items_total = 'private-fixture';
    const result = read(state);
    expect(result.status).toBe('ok');
    expect(result.metrics.kg_pending).toBe(10);
    expect(JSON.stringify(result)).not.toContain('private-fixture');
  });
  it('makes stale or future evidence explicit instead of reporting healthy', () => {
    expect(read(healthy(), { now: now + 91 * 60000 }).status).toBe('stale');
    expect(read(healthy(), { now: now - 10 * 60000 }).reason).toBe('future_timestamp');
  });
  it('maps timer/source faults and drops arbitrary issue contents', () => {
    const state = healthy();
    state.issues = ['inactive:argus-eagleye-outbox-drain.timer',
      'source_no_success_48h:reddit', 'monitor_check_failed:private-fixture', 'private-fixture'];
    const result = read(state);
    expect(result.status).toBe('degraded');
    expect(result.issues).toContain('outbox_timer_inactive');
    expect(result.issues).toContain('reddit_source_no_success_48h');
    expect(result.issues).toContain('monitor_check_failed');
    expect(result.issues).toContain('unrecognized_monitor_issue');
    expect(JSON.stringify(result)).not.toContain('private-fixture');
  });
  it('does not report empty, invalid or malformed metrics as healthy', () => {
    for (const state of [null, [], {}, { ...healthy(), issues: 'private-fixture' }]) {
      expect(read(state).status).toBe('unavailable');
    }
    expect(read({ ...healthy(), metrics: {} }).issues).toContain('monitor_metrics_incomplete');
    const state = healthy();
    state.metrics.free_gib = '50';
    expect(read(state).status).toBe('degraded');
  });
  it('fails closed for missing, malformed and oversized files without echoing paths', () => {
    const missing = readRuntimeMonitor({ file: path.join(directory, 'private-fixture'), now });
    expect(missing.status).toBe('unavailable');
    expect(JSON.stringify(missing)).not.toContain('private-fixture');
    writeFileSync(file, '{private-fixture');
    expect(readRuntimeMonitor({ file, now }).status).toBe('unavailable');
    writeFileSync(file, 'x'.repeat(65537));
    expect(readRuntimeMonitor({ file, now }).reason).toBe('invalid_file');
  });
  it('rejects directories and symlinks without arbitrary file access', () => {
    expect(readRuntimeMonitor({ file: directory, now }).status).toBe('unavailable');
    writeFileSync(file, JSON.stringify(healthy()));
    const link = path.join(directory, 'link');
    symlinkSync(file, link);
    expect(readRuntimeMonitor({ file: link, now }).status).toBe('unavailable');
  });
});
