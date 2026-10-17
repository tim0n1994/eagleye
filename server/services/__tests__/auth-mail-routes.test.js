import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const paths = {
  auth: require.resolve('../auth'),
  connection: require.resolve('../../db/connection'),
  rateLimit: require.resolve('../rate-limit'),
  shared: require.resolve('../../routes/_shared'),
  route: require.resolve('../../routes/auth'),
};
const previous = new Map(Object.values(paths).map(path => [path, require.cache[path]]));
const auth = {
  getUserByEmail: vi.fn(),
  hashPassword: vi.fn(async () => 'fixture-password-hash'),
  createUser: vi.fn(() => ({ id: 'fixture-user', isFirstUser: false })),
  storeVerificationCode: vi.fn(() => '123456'),
  sendVerificationEmail: vi.fn(async () => undefined),
};
const getDB = vi.fn(() => { throw new Error('Database access is forbidden in auth-mail route tests'); });
const rateLimit = { checkAuthAttempt: vi.fn(() => ({ limited: false })), resetAuthAttempts: vi.fn() };
for (const [path, exports] of [[paths.auth, auth], [paths.connection, { getDB }], [paths.rateLimit, rateLimit]]) {
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}
delete require.cache[paths.shared];
delete require.cache[paths.route];
const register = require('../../routes/auth');

afterAll(() => {
  for (const [path, cached] of previous) {
    if (cached) require.cache[path] = cached;
    else delete require.cache[path];
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.getUserByEmail.mockReset();
  auth.sendVerificationEmail.mockReset().mockResolvedValue(undefined);
  rateLimit.checkAuthAttempt.mockReset().mockReturnValue({ limited: false });
  vi.stubEnv('RESEND_API_KEY', 'fixture-only-mail-key');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network access is forbidden in auth-mail route tests'); }));
});

afterEach(() => {
  expect(getDB).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function request(path, { method = 'POST', body = { email: 'reader@example.com', password: 'fixture-password' } } = {}) {
  const routes = {};
  register(routes);
  const req = Readable.from([JSON.stringify(body)]);
  Object.assign(req, { method, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
  let status;
  let result;
  const headers = {};
  const end = vi.fn(text => { result = JSON.parse(text); });
  const res = { writeHead(code) { status = code; }, setHeader(key, value) { headers[key] = value; }, end };
  await routes[path](req, res, { query: {} });
  expect(end).toHaveBeenCalledTimes(1);
  return { status, body: result, headers };
}

describe('email registration and recovery route boundary', () => {
  it.each(['/api/auth/register', '/api/auth/resend'])('rejects %s before account/code changes when email delivery is unconfigured', async path => {
    vi.stubEnv('RESEND_API_KEY', '');
    const result = await request(path);
    expect(result.status).toBe(503);
    expect(result.body.error).toContain('Contact the administrator');
    expect(result.body).not.toHaveProperty('status', 'ok');
    for (const method of Object.values(auth)) expect(method).not.toHaveBeenCalled();
  });

  it.each(['/api/auth/register', '/api/auth/resend'])('GET %s cannot create an account or send an email', async path => {
    const result = await request(path, { method: 'GET' });
    expect(result.status).toBe(405);
    for (const method of Object.values(auth)) expect(method).not.toHaveBeenCalled();
    expect(rateLimit.checkAuthAttempt).not.toHaveBeenCalled();
  });

  it('reports registration delivery failure as 503 while leaving the created account recoverable through resend', async () => {
    auth.sendVerificationEmail.mockRejectedValue(new Error('private upstream failure fixture'));
    const result = await request('/api/auth/register');
    expect(result.status).toBe(503);
    expect(result.body.error).toContain('Use resend');
    expect(result.body).not.toHaveProperty('status', 'ok');
    expect(JSON.stringify(result.body)).not.toContain('private upstream');
    expect(auth.hashPassword).toHaveBeenCalledWith('fixture-password');
    expect(auth.createUser).toHaveBeenCalledWith('reader@example.com', 'fixture-password-hash');
    expect(auth.storeVerificationCode).toHaveBeenCalledWith('reader@example.com', 'register');
    expect(auth.sendVerificationEmail).toHaveBeenCalledWith('reader@example.com', '123456');
  });

  it('only acknowledges registration delivery after the sender succeeds', async () => {
    let finish;
    auth.sendVerificationEmail.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    let settled = false;
    const pending = request('/api/auth/register').then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(auth.sendVerificationEmail).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    finish();
    const result = await pending;
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('ok');
    expect(result.body.message).toBe('Verification code sent');
    expect(result.body).not.toHaveProperty('code');
  });

  it('resends only for an active unverified account', async () => {
    auth.getUserByEmail.mockReturnValue({ id: 'fixture-user', email_verified: 0, status: 'active' });
    const result = await request('/api/auth/resend');
    expect(result.status).toBe(200);
    expect(result.body.message).toBe('If registration is pending, a verification email has been sent.');
    expect(auth.storeVerificationCode).toHaveBeenCalledWith('reader@example.com', 'register');
    expect(auth.sendVerificationEmail).toHaveBeenCalledWith('reader@example.com', '123456');
    expect(auth.createUser).not.toHaveBeenCalled();
  });

  it('returns the same generic success for verified, unknown, disabled and pending accounts', async () => {
    const results = [];
    for (const user of [
      { email_verified: 1, status: 'active' },
      undefined,
      { email_verified: 0, status: 'disabled' },
    ]) {
      auth.getUserByEmail.mockReturnValue(user);
      results.push(await request('/api/auth/resend'));
    }
    expect(auth.storeVerificationCode).not.toHaveBeenCalled();
    expect(auth.sendVerificationEmail).not.toHaveBeenCalled();
    auth.getUserByEmail.mockReturnValue({ email_verified: 0, status: 'active' });
    const pending = await request('/api/auth/resend');
    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.body).toEqual(pending.body);
      expect(result.body).not.toHaveProperty('email');
      expect(result.body).not.toHaveProperty('code');
    }
    expect(auth.createUser).not.toHaveBeenCalled();
  });

  it('reports resend delivery failure without claiming success or exposing upstream errors', async () => {
    auth.getUserByEmail.mockReturnValue({ email_verified: 0, status: 'active' });
    auth.sendVerificationEmail.mockRejectedValue(new Error('private upstream failure fixture'));
    const result = await request('/api/auth/resend');
    expect(result.status).toBe(503);
    expect(result.body.error).toContain('could not be sent');
    expect(result.body).not.toHaveProperty('status', 'ok');
    expect(JSON.stringify(result.body)).not.toContain('private upstream');
    expect(auth.createUser).not.toHaveBeenCalled();
  });

  it.each(['/api/auth/register', '/api/auth/resend'])('preserves throttling before %s can mutate state', async path => {
    rateLimit.checkAuthAttempt.mockReturnValue({ limited: true, retryAfterSec: 30 });
    const result = await request(path);
    expect(result.status).toBe(429);
    expect(result.headers['Retry-After']).toBe('30');
    for (const method of Object.values(auth)) expect(method).not.toHaveBeenCalled();
  });
});
