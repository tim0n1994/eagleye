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
  routes['/api/auth/register'] = async (req, res, parsed) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    if (authThrottled(req, res)) return;
    try {
      const { email, password } = await readBody(req);
      if (!email || !password) return sendError(res, 400, 'Email and password required');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendError(res, 400, 'Invalid email');
      if (password.length < 6) return sendError(res, 400, 'Password must be at least 6 characters');

      const existing = auth.getUserByEmail(email);
      if (existing) return sendError(res, 409, 'Email already registered');

      const hash = await auth.hashPassword(password);
      const user = auth.createUser(email, hash);
      const code = auth.storeVerificationCode(email, 'register');

      try {
        await auth.sendVerificationEmail(email, code);
      } catch (e) {
        console.warn('  ⚠  Failed to send verification email:', e.message);
        // Continue — user can still see the code in server logs (dev mode)
      }

      sendJSON(res, 200, { status: 'ok', message: 'Verification code sent', email, isFirstUser: user.isFirstUser });
    } catch (err) {
      sendError(res, 500, err.message);
    }
  };

  // POST /api/auth/verify — verify email code + activate account + create session
  routes['/api/auth/verify'] = async (req, res, parsed) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    // A 6-digit code is only 10^6 wide; without a brake it is brute-forceable.
    if (authThrottled(req, res)) return;
    try {
      const { email, code } = await readBody(req);
      if (!email || !code) return sendError(res, 400, 'Email and code required');

      const valid = auth.verifyCode(email, String(code).trim(), 'register');
      if (!valid) return sendError(res, 400, 'Invalid or expired verification code');

      const user = auth.getUserByEmail(email);
      if (!user) return sendError(res, 404, 'User not found');
      if (user.status !== 'active') return sendError(res, 403, 'Account disabled');

      // Mark email as verified
      getDB().prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);

      auth.createSession(res, user.id);
      sendJSON(res, 200, {
        status: 'ok',
        user: { id: user.id, email: user.email, role: user.role, display_name: user.display_name },
      });
    } catch (err) {
      sendError(res, 500, err.message);
    }
  };

  // POST /api/auth/login — verify password + create session
  routes['/api/auth/login'] = async (req, res, parsed) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    if (authThrottled(req, res)) return;
    try {
      const { email, password } = await readBody(req);
      if (!email || !password) return sendError(res, 400, 'Email and password required');

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
  routes['/api/auth/logout'] = async (req, res, parsed) => {
    const cookieHeader = req.headers?.cookie || '';
    const match = cookieHeader.match(/(?:^|;\s*)session=([a-f0-9]+)/);
    auth.clearSession(res, match?.[1]);
    sendJSON(res, 200, { status: 'ok' });
  };

  // GET /api/auth/me — current user info
  routes['/api/auth/me'] = (req, res, parsed) => {
    const user = auth.getSessionUser(req);
    if (!user) return sendJSON(res, 200, { user: null });
    sendJSON(res, 200, { user });
  };

  // ─── Admin Routes ─────────────────────────────────────────────────────

  // GET /api/admin/users — list all users (admin only; enforced by auth gate)
  routes['/api/admin/users'] = (req, res, parsed) => {
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
  routes['/api/auth/keys'] = async (req, res, parsed) => {
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
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    // Revoking is destructive, so it must be your own key (or you an admin).
    // Without this any account could disable a key belonging to anyone else.
    const owned = auth.listApiKeys(req.user.id).some(k => k.key === params.key);
    if (!owned && req.user.role !== 'admin') return sendError(res, 404, 'Key not found');
    auth.revokeApiKey(params.key);
    sendJSON(res, 200, { status: 'ok' });
  };
}

module.exports = register;
