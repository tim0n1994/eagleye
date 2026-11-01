// @vitest-environment node

/**
 * /api/sources cadence contract.
 *
 * The response must name the real executing schedule and explicitly retire
 * refresh_cron as metadata. Source rows still expose their evaluator cadence,
 * so clients can distinguish scheduler-driven, explicit-source, and fallback
 * grading without interpreting the unused cron field.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

function compileRoute({ schedulerConfig, schedulerHours }) {
  const moduleFilename = path.resolve(dirname, '../sources.js');
  const sources = [
    {
      id: 1,
      slug: 'scheduled-source',
      label: 'Scheduled source',
      refresh_cron: '0 */2 * * *',
      expected_interval_hours: null,
    },
    {
      id: 2,
      slug: 'explicit-source',
      label: 'Explicit source',
      refresh_cron: '0 */6 * * *',
      expected_interval_hours: 6,
    },
  ];
  const db = {
    prepare(sql) {
      if (sql.includes('FROM sources s')) return { all: () => sources };
      if (sql.includes('FROM information_items i JOIN sources s')) return { all: () => [] };
      throw new Error('unexpected query: ' + sql);
    },
  };
  const resolveModule = (id) => {
    if (id === '../db/connection') return { getDB: () => db };
    if (id === './_shared') {
      return {
        sendJSON(res, status, body) {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.body = body;
        },
        sendError(res, status, error) { res.body = { error, status }; },
      };
    }
    if (id === '../services/scheduler') {
      return { getConfig: () => schedulerConfig, expectedIntervalHours: () => schedulerHours };
    }
    return require(path.resolve(path.dirname(moduleFilename), id));
  };
  const subject = { filename: moduleFilename, exports: {} };
  const register = vm.runInNewContext(fs.readFileSync(moduleFilename, 'utf8') + '\nmodule.exports', {
    module: subject,
    require: resolveModule,
    console,
  }, { filename: moduleFilename });
  const routes = {};
  register(routes);
  return routes['/api/sources'];
}

async function readResponse(handler) {
  const res = { body: null, writeHead() {} };
  handler({}, res, { query: {} });
  return res.body;
}

describe('/api/sources cadence semantics', () => {
  it('reports the enabled daily pipeline and per-source evaluator cadence', async () => {
    const handler = compileRoute({
      schedulerConfig: { enabled: true, task: 'pipeline', time: '01:00' },
      schedulerHours: 24,
    });
    const body = await readResponse(handler);

    expect(body.expected_cadence).toEqual({
      hours: 24,
      basis: 'scheduler_config',
      schedule: 'daily 01:00',
    });
    expect(body.semantics.refresh_cron).toMatch(/metadata only/);
    expect(body.semantics.refresh_cron).toMatch(/no current scheduler executes it/);
    expect(body.sources[0]).toMatchObject({
      refresh_cron: '0 */2 * * *',
      expected_interval_hours: 24,
      expected_interval_basis: 'scheduler_config',
    });
    expect(body.sources[1]).toMatchObject({
      expected_interval_hours: 6,
      expected_interval_basis: 'source_expected_interval',
    });
  });

  it('does not present an executing cadence when the scheduler is off', async () => {
    const handler = compileRoute({
      schedulerConfig: { enabled: false, task: 'pipeline', time: '01:00' },
      schedulerHours: null,
    });
    const body = await readResponse(handler);

    expect(body.expected_cadence).toEqual({
      hours: null,
      basis: 'no_active_scheduler',
      schedule: null,
    });
    expect(body.sources[0]).toMatchObject({
      expected_interval_hours: 48,
      expected_interval_basis: 'fallback_no_active_scheduler',
    });
  });
});
