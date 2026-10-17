// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// Swap the shared DB connection for an in-memory database before the service
// and route modules load. require.cache swap follows llm-pool-routes.test.js;
// the in-memory DB follows llm-pool.test.js.
const connectionPath = require.resolve('../../db/connection');
const previousConnection = require.cache[connectionPath];
let db;

require.cache[connectionPath] = {
  id: connectionPath,
  filename: connectionPath,
  loaded: true,
  exports: { getDB: () => db, closeDB: () => {} },
};

const { getMcpServerConfig, saveMcpServerConfig } = require('../mcp-config');
const registerMcpConfigRoutes = require('../../routes/mcp-config');

afterAll(() => {
  if (previousConnection) require.cache[connectionPath] = previousConnection;
  else delete require.cache[connectionPath];
});

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE user_data (
    key TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT '',
    value TEXT,
    PRIMARY KEY (key, user_id)
  )`);
});

const persistedRow = () => db.prepare("SELECT value FROM user_data WHERE key = 'mcp_server_config' AND user_id = ''").get();

async function request(method, { role = 'admin', body } = {}) {
  const routes = {};
  registerMcpConfigRoutes(routes);
  const payload = body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)];
  const req = Readable.from(payload);
  Object.assign(req, { method, user: role ? { id: 'user-test', role } : null });
  let status; let result;
  const res = { writeHead(code) { status = code; }, end(text) { result = JSON.parse(text); } };
  await routes['/api/settings/mcp'](req, res);
  return { status, body: result };
}

describe('mcp server config service', () => {
  it('reads unset config as enabled (default-on)', () => {
    expect(getMcpServerConfig()).toEqual({ enabled: true });
  });

  it.each([
    ['not json'],
    [JSON.stringify({ enabled: 'yes' })],
    [JSON.stringify({ enabled: 1 })],
    ['["enabled"]'],
  ])('reads corrupt or non-boolean stored value %s as disabled', stored => {
    db.prepare("INSERT INTO user_data (key, user_id, value) VALUES ('mcp_server_config', '', ?)").run(stored);
    expect(getMcpServerConfig()).toEqual({ enabled: false });
  });

  it('persists {enabled} under the global scope and reads it back', () => {
    saveMcpServerConfig({ enabled: true });
    expect(JSON.parse(persistedRow().value)).toEqual({ enabled: true });
    expect(getMcpServerConfig()).toEqual({ enabled: true });
    saveMcpServerConfig({ enabled: false });
    expect(getMcpServerConfig()).toEqual({ enabled: false });
  });

  it.each([undefined, null, 'true', 1, { enabled: true }])('rejects non-boolean enabled input (%s)', value => {
    expect(() => saveMcpServerConfig({ enabled: value })).toThrow();
    expect(persistedRow()).toBeUndefined();
  });

  it('rejects a missing argument', () => {
    expect(() => saveMcpServerConfig()).toThrow();
  });
});

describe('mcp config routes', () => {
  it.each([
    ['GET', undefined],
    ['PUT', { enabled: true }],
  ])('rejects %s from non-admin and unauthenticated callers with 403', async (method, body) => {
    expect((await request(method, { role: 'user', body })).status).toBe(403);
    expect((await request(method, { role: null, body })).status).toBe(403);
    expect(persistedRow()).toBeUndefined();
  });

  it('roundtrips a valid PUT into a matching GET', async () => {
    const put = await request('PUT', { body: { enabled: true } });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ status: 'ok', config: { enabled: true } });
    const get = await request('GET');
    expect(get.status).toBe(200);
    expect(get.body).toEqual({ status: 'ok', config: { enabled: true } });
  });

  it.each([
    ['not json'],
    ['{}'],
    [{ enabled: 'yes' }],
    [{ enabled: 1 }],
  ])('rejects invalid PUT body %j with 400 and keeps the stored config', async raw => {
    const response = await request('PUT', { body: raw });
    expect(response.status).toBe(400);
    expect(response.body.error).toBeTruthy();
    expect(persistedRow()).toBeUndefined();
  });

  it('answers 405 for unsupported methods', async () => {
    expect((await request('POST', { body: { enabled: true } })).status).toBe(405);
  });
});
