/**
 * Eagleye — Auth, admin and API-key routes
 *
 * The only endpoints reachable without a session (register/verify/login/logout/
 * me are whitelisted in server.js), so they carry the rate limiter. Kept in one
 * module so this surface can be reviewed on its own.
 */

const auth = require('../services/auth');
const { getDB } = require('../db/connection');
const { resetAuthAttempts } = require('../services/rate-limit');
const { sendJSON, sendError, readBody, authThrottled } = require('./_shared');

function register(routes) {
  // ─── Auth Routes ──────────────────────────────────────────────────────

  // POST /api/auth/register — create unverified user + send verification code
  routes['/api/auth/register'] = async (req, res, _parsed) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    if (authThrottled(req, res)) return;
    if (!process.env.RESEND_API_KEY?.trim() || !process.env.RESEND_FROM?.trim()) return sendError(res, 503, 'Email registration is unavailable. Contact the administrator for access.');
    try {
      const body = await readBody(req);
      const email = auth.normalizeEmail(body?.email);
      const password = body?.password;
      if (!email || typeof password !== 'string' || !password) return sendError(res, 400, 'Email and password required');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendError(res, 400, 'Invalid email');
      if (password.length < 6 || Buffer.byteLength(password,'utf8') > 72) return sendError(res, 400, 'Password must be at least 6 characters and at most 72 UTF-8 bytes');

      const existing = auth.getUserByEmail(email);
      if (existing) return sendJSON(res, 409, {error: existing.email_verified ? 'Email already registered. Please sign in.' : 'Registration is pending. Please resend the verification code.', pending_verification: !existing.email_verified && existing.status === 'active', email});

      const hash = await auth.hashPassword(password);
      const user = auth.createUser(email, hash);
      try {
        const delivery = await auth.requestVerificationEmail(email);
        sendJSON(res, 200, { status:'ok', message:'Verification email accepted for sending', email, isFirstUser:user.isFirstUser, ...delivery });
      } catch (error) {
        res.setHeader('Retry-After',String(error.retryAfter || 60));
        return sendJSON(res,error.status || 503,{error:error.message,pending_verification:true,email,retry_after:error.retryAfter || 60});
      }
    } catch (err) {
      sendError(res, 500, err.message);
    }
  };

  routes['/api/auth/resend'] = async (req, res) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    if (authThrottled(req, res)) return;
    if (!process.env.RESEND_API_KEY?.trim() || !process.env.RESEND_FROM?.trim()) return sendError(res, 503, 'Email registration is unavailable. Contact the administrator for access.');
    try {
      const body = await readBody(req);
      const email = auth.normalizeEmail(body?.email);
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendError(res, 400, 'Valid email required');
      const user = auth.getUserByEmail(email);
      if (user && !user.email_verified && user.status === 'active') {
        await auth.requestVerificationEmail(email);
      }
      return sendJSON(res, 200, { status: 'ok', message: 'If registration is pending, a verification email has been accepted for sending.', retry_after:60 });
    } catch (error) {
      res.setHeader('Retry-After',String(error.retryAfter || 60));
      return sendJSON(res,error.status || 503,{error:error.message,retry_after:error.retryAfter || 60});
    }
  };

  // POST /api/auth/verify — verify email code + activate account + create session
  routes['/api/auth/verify'] = async (req, res, _parsed) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    // A 6-digit code is only 10^6 wide; without a brake it is brute-forceable.
    if (authThrottled(req, res)) return;
    try {
      const body = await readBody(req);
      const email = auth.normalizeEmail(body?.email);
      const code = typeof body?.code === 'string' ? body.code.trim() : '';
      if (!email || !/^\d{6}$/.test(code)) return sendError(res,400,'Email and a 6-digit code are required');
      // Email ownership authorizes the password chosen by this verifier. Never
      // activate a pending account with a password a prior registrant chose.
      const password = body?.password;
      if (typeof password !== 'string' || password.length < 6 || Buffer.byteLength(password,'utf8') > 72) return sendError(res,400,'Choose a password of at least 6 characters and at most 72 UTF-8 bytes');
      const passwordHash = await auth.hashPassword(password);
      const user = getDB().transaction(() => {
        const account = auth.getUserByEmail(email);
        if (!account || account.status !== 'active' || account.email_verified || !auth.verifyCode(email,code,'register')) {
          throw Object.assign(new Error('Invalid or expired verification code'), {status:400});
        }
        getDB().prepare('UPDATE users SET email_verified=1,password_hash=? WHERE id=?').run(passwordHash,account.id);
        auth.createSession(res,account.id);
        return account;
      }).immediate();
      resetAuthAttempts(req);
      sendJSON(res, 200, {
        status: 'ok',
        user: { id: user.id, email: user.email, role: user.role, display_name: user.display_name },
      });
    } catch (err) {
      sendError(res, err.status || 500, err.status ? err.message : 'Verification could not be completed. Please retry.');
    }
  };

  // POST /api/auth/login — verify password + create session
  routes['/api/auth/login'] = async (req, res, _parsed) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    if (authThrottled(req, res)) return;
    try {
      const body = await readBody(req);
      const email = auth.normalizeEmail(body?.email);
      const password = body?.password;
      if (!email || typeof password !== 'string' || !password) return sendError(res, 400, 'Email and password required');

      const user = auth.getUserByEmail(email);
      if (!user) return sendError(res, 401, 'Invalid email or password');

      const valid = await auth.verifyPassword(password, user.password_hash);
      if (!valid) return sendError(res, 401, 'Invalid email or password');
      if (user.status !== 'active') return sendError(res, 403, 'Account disabled');
      if (!user.email_verified) return sendError(res, 403, 'Email not verified');

      resetAuthAttempts(req);
      auth.createSession(res, user.id);
      sendJSON(res, 200, {
        status: 'ok',
        user: { id: user.id, email: user.email, role: user.role, display_name: user.display_name },
      });
    } catch (err) {
      sendError(res, 500, err.message);
    }
  };

  // POST /api/auth/logout — clear session
  routes['/api/auth/logout'] = async (req, res, _parsed) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    const cookieHeader = req.headers?.cookie || '';
    const match = cookieHeader.match(/(?:^|;\s*)session=([a-f0-9]+)/);
    auth.clearSession(res, match?.[1]);
    sendJSON(res, 200, { status: 'ok' });
  };

  // GET /api/auth/me — current user info
  routes['/api/auth/me'] = (req, res, _parsed) => {
    const user = auth.getSessionUser(req);
    if (!user) return sendJSON(res, 200, { user: null });
    sendJSON(res, 200, { user });
  };

  // ─── Admin Routes ─────────────────────────────────────────────────────

  // GET /api/admin/users — list all users (admin only; enforced by auth gate)
  routes['/api/admin/users'] = (req, res, _parsed) => {
    const users = auth.getAllUsers();
    sendJSON(res, 200, { status: 'ok', users });
  };

  // Param routes for user actions — matched by the router's param patterns
  // POST /api/admin/users/:id/role
  routes['/api/admin/users/:id/role'] = async (req, res, parsed, params) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    try {
      const { role } = await readBody(req);
      if (!['admin', 'user'].includes(role)) return sendError(res, 400, 'Invalid role');
      auth.updateUserRole(params.id, role);
      sendJSON(res, 200, { status: 'ok' });
    } catch (err) { sendError(res, 500, err.message); }
  };

  // POST /api/admin/users/:id/disable
  routes['/api/admin/users/:id/disable'] = async (req, res, parsed, params) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    // Prevent self-disable
    if (req.user?.id === params.id) return sendError(res, 400, 'Cannot disable yourself');
    auth.updateUserStatus(params.id, 'disabled');
    sendJSON(res, 200, { status: 'ok' });
  };

  // POST /api/admin/users/:id/enable
  routes['/api/admin/users/:id/enable'] = async (req, res, parsed, params) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    auth.updateUserStatus(params.id, 'active');
    sendJSON(res, 200, { status: 'ok' });
  };

  // ─── API Key Management (for the current user) ────────────────────────

  // GET /api/auth/keys — list current user's API keys
  // POST /api/auth/keys — create a new API key { name }
  routes['/api/auth/keys'] = async (req, res, _parsed) => {
    if (!req.user) return sendError(res, 401, 'Authentication required');
    if (req.method === 'POST') {
      try {
        const { name } = await readBody(req);
        const key = auth.createApiKey(name || 'default', req.user.id);
        sendJSON(res, 200, { status: 'ok', key });
      } catch (err) { sendError(res, 500, err.message); }
    } else {
      const keys = auth.listApiKeys(req.user.id);
      sendJSON(res, 200, { status: 'ok', keys });
    }
  };

  // DELETE /api/auth/keys/:key — revoke an API key
  routes['/api/auth/keys/:key'] = async (req, res, parsed, params) => {
    if (!['POST', 'DELETE'].includes(req.method)) return sendError(res, 405, 'Method not allowed');
    // Revoking is destructive, so it must be your own key (or you an admin).
    // Without this any account could disable a key belonging to anyone else.
    const owned = auth.listApiKeys(req.user.id).some(k => k.key === params.key);
    if (!owned && req.user.role !== 'admin') return sendError(res, 404, 'Key not found');
    auth.revokeApiKey(params.key);
    sendJSON(res, 200, { status: 'ok' });
  };
}

module.exports = register;
