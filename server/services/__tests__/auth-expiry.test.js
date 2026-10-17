// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */
const Database = require('better-sqlite3');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

describe('authentication expiry contracts', () => {
  let db;
  let auth;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T12:00:00Z'));
    db = new Database(':memory:');
    for (const file of ['026_users.sql', '027_api_keys.sql']) db.exec(fs.readFileSync(path.join(__dirname, '../../migrations', file), 'utf8'));
    db.exec("INSERT INTO users (id,email,password_hash,email_verified) VALUES ('u','user@example.test','unused',1)");
    const filename = path.resolve(__dirname, '../auth.js');
    const subject = new Module(filename, module);
    subject.filename = filename;
    subject.require = id => id === '../db/connection' ? { getDB: () => db } : require(id);
    subject._compile(fs.readFileSync(filename, 'utf8'), filename);
    auth = subject.exports;
  });
  afterEach(() => { db.close(); vi.useRealTimers(); });

  it('round trips generated ISO sessions and expires them at the exact boundary', () => {
    const token = auth.createSession({ setHeader: vi.fn() }, 'u');
    const req = { headers: { cookie: `session=${token}` } };
    expect(auth.getSessionUser(req)?.id).toBe('u');
    const expires = db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token).expires_at;
    expect(expires).toBe('2026-09-16T12:00:00.000Z');
    vi.setSystemTime(new Date(expires));
    expect(auth.getSessionUser(req)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(0);
  });

  it.each(['2000-01-01T00:00:00.000Z', '2026-09-09 11:59:59', 'invalid', '2099-02-30T12:00:00Z', '2099-09-09T24:00:00Z'])('rejects expired or invalid session timestamp %s', expires => {
    db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run('abcd', 'u', expires);
    expect(auth.getSessionUser({ headers: { cookie: 'session=abcd' } })).toBeNull();
  });

  it.each(['2026-09-09 12:00:01', '2026-09-09T20:00:01+08:00'])('supports future legacy and offset timestamp %s', expires => {
    db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run('abcd', 'u', expires);
    expect(auth.getSessionUser({ headers: { cookie: 'session=abcd' } })?.id).toBe('u');
  });

  it('denies expired, malformed, revoked and disabled-owner API keys while preserving NULL no-expiry keys', () => {
    const key = auth.createApiKey('test', 'u');
    expect(auth.getApiKeyOwner(key)?.id).toBe('u');
    for (const expiry of ['2000-01-01T00:00:00Z', 'bad', '', '2026-09-09T12:00:00Z']) {
      db.prepare('UPDATE api_keys SET expires_at=? WHERE key=?').run(expiry, key);
      expect(auth.getApiKeyOwner(key)).toBeNull();
    }
    db.prepare('UPDATE api_keys SET expires_at=NULL WHERE key=?').run(key);
    auth.revokeApiKey(key);
    expect(auth.getApiKeyOwner(key)).toBeNull();
    const other = auth.createApiKey('other', 'u');
    db.exec("UPDATE users SET status='disabled' WHERE id='u'");
    expect(auth.getApiKeyOwner(other)).toBeNull();
  });

  it('rejects expired or malformed verification codes without consuming them', () => {
    db.exec("INSERT INTO verification_codes(id,email,code,expires_at) VALUES ('v','user@example.test','123456','bad')");
    expect(auth.verifyCode('user@example.test', '123456')).toBe(false);
    db.exec("UPDATE verification_codes SET expires_at='2000-01-01T00:00:00Z'");
    expect(auth.verifyCode('user@example.test', '123456')).toBe(false);
    db.exec("UPDATE verification_codes SET expires_at='2026-09-09 12:01:00'");
    expect(auth.verifyCode('user@example.test', '123456')).toBe(true);
    expect(auth.verifyCode('user@example.test', '123456')).toBe(false);
  });
});
