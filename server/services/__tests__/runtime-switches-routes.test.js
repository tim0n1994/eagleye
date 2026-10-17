// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);

const previousPath = process.env.EAGLEYE_DB_PATH;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r0ops-switches-'));
process.env.EAGLEYE_DB_PATH = path.join(directory, 'switches.sqlite');

const { getDB, closeDB } = require('../../db/connection');
const register = require('../../routes/system');
const { CONFIG_KEY, SWITCH_KEYS } = require('../../services/runtime-switches');

let routes;
beforeAll(() => {
  getDB().exec([
    'CREATE TABLE user_data (',
    '  key TEXT NOT NULL,',
    "  user_id TEXT NOT NULL DEFAULT '',",
    '  value TEXT,',
    '  PRIMARY KEY (key, user_id)',
    ')',
  ].join('\n'));
  routes = {};
  register(routes);
});

afterAll(() => {
  closeDB();
  if (previousPath === undefined) delete process.env.EAGLEYE_DB_PATH;
  else process.env.EAGLEYE_DB_PATH = previousPath;
  fs.rmSync(directory, { recursive: true, force: true });
});

async function call(method, role = 'user', raw) {
  const req = Readable.from(raw === undefined ? [] : [raw]);
  Object.assign(req, { method, url: '/api/system/switches', user: { id: 'user-test', role } });
  let statusCode = 0;
  let rawResponse = '';
  const res = { writeHead(code) { statusCode = code; }, end(body) { rawResponse = body; } };
  await routes['/api/system/switches'](req, res);
  await new Promise(resolve => setImmediate(resolve));
  return { status: statusCode, body: JSON.parse(rawResponse) };
}

const storedSwitches = () => {
  const row = getDB().prepare("SELECT value FROM user_data WHERE key = ? AND user_id = ''").get(CONFIG_KEY);
  return row ? JSON.parse(JSON.parse(row.value)) : null;
};

describe('runtime switches admin API', () => {
  beforeEach(() => {
    getDB().prepare('DELETE FROM user_data').run();
  });

  it('exposes all seven switches defaulting to true to any authenticated caller', async () => {
    const response = await call('GET', 'user');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      switches: Object.fromEntries(SWITCH_KEYS.map(key => [key, true])),
    });
    expect(Object.keys(response.body.switches)).toHaveLength(7);
  });

  it('rejects a non-admin POST before touching the stored switches', async () => {
    const response = await call('POST', 'user', JSON.stringify({ collect: false }));
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Admin access required');
    expect(storedSwitches()).toBeNull();
  });

  it('answers wrong methods with 405', async () => {
    expect((await call('PUT', 'admin', '{}')).status).toBe(405);
    expect((await call('DELETE', 'user')).status).toBe(405);
    expect(storedSwitches()).toBeNull();
  });

  it('rejects invalid patches with 400 and persists nothing', async () => {
    for (const patch of [{ bogus: true }, { collect: 'no' }, { collect: 1 }]) {
      const response = await call('POST', 'admin', JSON.stringify(patch));
      expect(response.status).toBe(400);
      expect(typeof response.body.error).toBe('string');
    }
    expect(storedSwitches()).toBeNull();
    const read = await call('GET', 'admin');
    expect(Object.values(read.body.switches).every(Boolean)).toBe(true);
  });

  it('persists an admin patch so the next read observes it', async () => {
    const response = await call('POST', 'admin', JSON.stringify({ collect: false }));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', switches: { collect: false } });
    expect(storedSwitches().collect).toBe(false);
    const read = await call('GET', 'user');
    expect(read.status).toBe(200);
    expect(read.body.switches.collect).toBe(false);
    for (const key of SWITCH_KEYS.filter(key => key !== 'collect')) expect(read.body.switches[key]).toBe(true);
  });

  it('rejects a malformed JSON body with 400', async () => {
    const response = await call('POST', 'admin', '{"collect":');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid JSON');
    expect(storedSwitches()).toBeNull();
  });
});
