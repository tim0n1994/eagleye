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

      // Password verification yields to other requests. Check the current
      // hash under the same write lock as session creation to fence resets.
      getDB().transaction(() => {
        const current = auth.getUserByEmail(email);
        if (!current || current.password_hash !== user.password_hash || current.status !== 'active' || !current.email_verified) {
          throw Object.assign(new Error('Credentials changed. Please sign in again.'),{status:401});
        }
        auth.createSession(res,current.id);
      }).immediate();
      resetAuthAttempts(req);
      sendJSON(res, 200, {
        status: 'ok',
        user: { id: user.id, email: user.email, role: user.role, display_name: user.display_name },
      });
    } catch (err) {
      sendError(res, err.status || 500, err.status ? err.message : 'Login could not be completed. Please retry.');
    }
  };

  // Password recovery does not disclose account existence or activate pending users.
  routes['/api/auth/forgot-password'] = async (req,res) => {
    if (req.method !== 'POST') return sendError(res,405,'Method not allowed');
    if (authThrottled(req,res)) return;
    if (!process.env.RESEND_API_KEY?.trim() || !process.env.RESEND_FROM?.trim()) return sendError(res,503,'Email recovery is temporarily unavailable.');
    try {
      const body = await readBody(req);
      const email = auth.normalizeEmail(body?.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>254) return sendError(res,400,'Valid email required');
      const user = auth.getUserByEmail(email);
      if (user?.status === 'active' && user.email_verified) {
        try { await auth.requestVerificationEmail(email,'reset'); }
        catch (error) {
          // The mail helper records provider failures. Cooldown and delivery
          // outcomes must not change the public account-existence response.
          if (error.status !== 429) console.warn('[password-recovery] delivery unavailable');
        }
      }
      return sendJSON(res,200,{status:'ok',message:'If this email belongs to an active verified account, a reset code will be sent. Please check your inbox.',retry_after:60});
    } catch { return sendError(res,400,'Invalid recovery request'); }
  };

  routes['/api/auth/reset-password'] = async (req,res) => {
    if (req.method !== 'POST') return sendError(res,405,'Method not allowed');
    if (authThrottled(req,res)) return;
    try {
      const body = await readBody(req);
      const email = auth.normalizeEmail(body?.email);
      const code = typeof body?.code === 'string' ? body.code.trim() : '';
      const password = body?.password;
      if (!email || !/^\d{6}$/.test(code)) return sendError(res,400,'Email and a 6-digit reset code are required');
      if (typeof password !== 'string' || password.length<6 || Buffer.byteLength(password,'utf8')>72) return sendError(res,400,'Password must be at least 6 characters and at most 72 UTF-8 bytes');
      const hash = await auth.hashPassword(password);
      getDB().transaction(() => {
        const user = auth.getUserByEmail(email);
        if (!user || user.status !== 'active' || !user.email_verified || !auth.verifyCode(email,code,'reset')) {
          throw Object.assign(new Error('Invalid or expired reset code'),{status:400});
        }
        getDB().prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,user.id);
        getDB().prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
        getDB().prepare('UPDATE verification_codes SET used=1 WHERE email=? AND used=0').run(email);
        // A reset must also fence mail requests already in flight; their late
        // response must not publish another usable pre-reset code.
        getDB().prepare("UPDATE verification_delivery SET request_id=?,status='invalidated',attempted_at=? WHERE email=?")
          .run(require('node:crypto').randomUUID(),Date.now(),email);
      }).immediate();
      auth.clearSession(res);
      resetAuthAttempts(req);
      sendJSON(res,200,{status:'ok',message:'Password reset. Please sign in again.'});
    } catch (error) {
      sendError(res,error.status || 500,error.status ? error.message : 'Password reset could not be completed. Please retry.');
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
