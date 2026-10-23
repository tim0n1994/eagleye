// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */
const Database = require('better-sqlite3');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

describe('durable daily scheduling', () => {
  let db;
  let scheduler;
  let runJob;
  let getJob;
  let findCompensationJob;
  let load;
  let testSwitches;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 9, 4, 1));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    testSwitches = null;
    db = new Database(':memory:');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    runJob = vi.fn(async () => 'job-1');
    getJob = vi.fn(() => ({ status: 'completed' }));
    findCompensationJob = vi.fn(() => null);
    load = () => {
      const filename = path.resolve(__dirname, '../scheduler.js');
      const subject = new Module(filename, module);
      subject.filename = filename;
      subject.require = id => {
        if (id === '../db/user-data') { return {
          getValue: key => JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || 'null'),
          setValue: (key, value) => db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, JSON.stringify(value)),
        }; }
        if (id === './jobs') return { runJob, getJob, findCompensationJob, JOB_TYPES: { FULL_PIPELINE: 'full-pipeline', RESCORE_ALL: 'rescore-all' } };
        if (id === '../services/runtime-switches') return { getSwitches: () => testSwitches || { collect: true, enrich: true, digest: true } };
        throw new Error(`Unexpected dependency: ${id}`);
      };
      subject._compile(fs.readFileSync(filename, 'utf8'), filename);
      return subject.exports;
    };
    scheduler = load();
    scheduler.saveConfig({ enabled: true, time: '04:00' });
  });
  afterEach(() => { scheduler.stop(); db.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('catches up only today once, persists identity across module restart and exposes actual job status', async () => {
    await scheduler.tick();
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(scheduler.getConfig()).toMatchObject({ lastRun: '2026-09-09 04:01', last_job_id: 'job-1', last_outcome: 'completed', last_job_status: 'completed' });
    scheduler = load();
    await scheduler.tick();
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(new Date(scheduler.getConfig().next_due).getDate()).toBe(10);
    vi.setSystemTime(new Date(2026, 8, 12, 5, 0));
    await scheduler.tick();
    expect(runJob).toHaveBeenCalledTimes(2);
    expect(scheduler.getConfig().lastRun).toBe('2026-09-12 05:00');
  });

  it('does not fire before the due time or while disabled', async () => {
    vi.setSystemTime(new Date(2026, 8, 9, 3, 59));
    await scheduler.tick();
    scheduler.saveConfig({ enabled: false });
    vi.setSystemTime(new Date(2026, 8, 9, 10, 0));
    await scheduler.tick();
    expect(runJob).not.toHaveBeenCalled();
    expect(scheduler.getConfig().next_due).toBeNull();
  });

  it('awaits enqueue and serializes overlapping ticks', async () => {
    let resolve;
    runJob.mockImplementation(() => new Promise(done => { resolve = done; }));
    const first = scheduler.tick();
    await scheduler.tick();
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(scheduler.getConfig().lastRun).toBeNull();
    expect(scheduler.getConfig().last_outcome).toBe('enqueueing');
    resolve('existing-singleton');
    await first;
    expect(scheduler.getConfig().last_job_id).toBe('existing-singleton');
  });

  it('records failed enqueue without lastRun and bounds attempts and retry interval', async () => {
    runJob.mockRejectedValue(new Error('Database unavailable'));
    await scheduler.tick();
    expect(scheduler.getConfig()).toMatchObject({ lastRun: null, last_outcome: 'enqueue_failed', attempt_count: 1, last_error: 'Database unavailable' });
    await scheduler.tick();
    expect(runJob).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 2; i++) {
      vi.setSystemTime(new Date(Date.now() + 5 * 60 * 1000));
      await scheduler.tick();
    }
    vi.setSystemTime(new Date(Date.now() + 60 * 60 * 1000));
    await scheduler.tick();
    expect(runJob).toHaveBeenCalledTimes(3);
    expect(new Date(scheduler.getConfig().next_due).getDate()).toBe(10);
  });

  it('treats missing job identity as failure and keeps old lastRun migration safe', async () => {
    runJob.mockResolvedValue(null);
    await scheduler.tick();
    expect(scheduler.getConfig().last_outcome).toBe('enqueue_failed');
    scheduler.saveConfig({ lastRun: '2026-09-09 04:00', attempt_count: 0 });
    runJob.mockClear();
    await scheduler.tick();
    expect(runJob).not.toHaveBeenCalled();
  });

  it('does not replay an enqueue whose receipt was interrupted by restart', async () => {
    scheduler.saveConfig({ last_attempt: new Date().toISOString(), attempt_count: 1, last_outcome: 'enqueueing' });
    scheduler = load();
    expect(scheduler.getConfig().last_outcome).toBe('enqueue_unknown');
    await scheduler.tick();
    expect(runJob).not.toHaveBeenCalled();
    expect(new Date(scheduler.getConfig().next_due).getDate()).toBe(10);
  });

  it('start is idempotent and stop removes the heartbeat', async () => {
    scheduler.saveConfig({ enabled: false });
    scheduler.start();
    scheduler.start();
    expect(vi.getTimerCount()).toBe(1);
    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600000);
    expect(runJob).not.toHaveBeenCalled();
  });

  it('holds the schedule while a required runtime switch is paused and resumes without consuming an attempt', async () => {
    testSwitches = { collect: true, enrich: false, digest: true };
    await scheduler.tick();
    expect(runJob).not.toHaveBeenCalled();
    expect(scheduler.getConfig()).toMatchObject({ lastRun: null, last_outcome: 'switch_paused', attempt_count: 0 });
    testSwitches = { collect: true, enrich: true, digest: true };
    await scheduler.tick();
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(scheduler.getConfig().last_outcome).toBe('completed');
  });

  it('follows a failed root through its recovery chain before reporting scheduler status', async () => {
    await scheduler.tick();
    getJob.mockImplementation(id => ({
      'job-1': {
        id: 'job-1',
        status: 'failed',
        error: 'Server restarted before this background job completed',
        result: JSON.stringify({ recovery: { compensation_job_id: 'job-1-recovery' } }),
      },
      'job-1-recovery': { id: 'job-1-recovery', status: 'completed' },
    })[id]);

    const config = scheduler.getConfig();

    expect(config).toMatchObject({
      last_job_id: 'job-1',
      effective_job_id: 'job-1-recovery',
      last_job_status: 'completed',
      last_outcome: 'completed',
      last_error: null,
    });
    expect(config.last_job_chain).toEqual([
      { id: 'job-1', status: 'failed' },
      { id: 'job-1-recovery', status: 'completed' },
    ]);
  });
});
