/**
 * Eagleye — Authentication Service
 *
 * Email+password registration with Resend email verification.
 * Server-side session tokens stored in HttpOnly cookies.
 * First registered user becomes admin automatically.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDB } = require('../db/connection');

const BCRYPT_ROUNDS = 10;
const SESSION_MAX_AGE_DAYS = 7;

function parseSqliteUTC(s) {
  if (typeof s !== 'string' || !s.trim()) return new Date(NaN);
  const text = s.trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(text)) return new Date(NaN);
  const day = new Date(`${text.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== text.slice(0, 10)
    || Number(text.slice(11, 13)) > 23 || Number(text.slice(14, 16)) > 59 || Number(text.slice(17, 19)) > 59) return new Date(NaN);
  return new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? text : `${text}Z`);
}

function hasExpired(value) {
  const expires = parseSqliteUTC(value).getTime();
  return !Number.isFinite(expires) || expires <= Date.now();
}

// ─── Password ────────────────────────────────────────────────────────────

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// ─── Session ─────────────────────────────────────────────────────────────

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function _sessionExpiry() {
  const d = new Date();
  d.setDate(d.getDate() + SESSION_MAX_AGE_DAYS);
  return d.toISOString();
}

/**
 * Create a session for a user and set the session cookie on the response.
 * Returns the session token.
 */
function createSession(res, userId) {
  const db = getDB();
  const token = generateSessionToken();
  const expiresAt = _sessionExpiry();

  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  db.prepare('UPDATE users SET last_login_at = datetime(\'now\') WHERE id = ?').run(userId);

  // HttpOnly: JS can't read it (XSS protection)
  // SameSite=Strict: cookie not sent on cross-site requests (CSRF protection)
  // Production explicitly enables Secure; local HTTP development may omit it.
  const cookie = `session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE_DAYS * 86400}; SameSite=Strict${process.env.AUTH_COOKIE_SECURE === '1' ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', cookie);
  return token;
}

/**
 * Clear the session cookie and delete the session row.
 */
function clearSession(res, token) {
  const db = getDB();
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  res.setHeader('Set-Cookie', `session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict${process.env.AUTH_COOKIE_SECURE === '1' ? '; Secure' : ''}`);
}

/**
 * Extract and validate the session from a request's Cookie header.
 * Returns the user object { id, email, role, status, display_name } or null.
 */
function getSessionUser(req) {
  const db = getDB();
  if (!db) return null;

  const cookieHeader = req.headers?.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)session=([a-f0-9]+)/);
  if (!match) return null;
  const token = match[1];

  const row = db.prepare(`
    SELECT u.id, u.email, u.display_name, u.role, u.status, u.email_verified,
           s.expires_at
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ?
  `).get(token);

  if (!row) return null;

  // Check expiry
  if (hasExpired(row.expires_at)) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  if (row.status !== 'active') return null;

  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    email_verified: !!row.email_verified,
  };
}

// ─── Verification Codes ──────────────────────────────────────────────────

function generateVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * Store a verification code for an email and return it.
 * Old unused codes for this email/purpose are marked used.
 */
function normalizeEmail(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }

function storeVerificationCode(email, purpose = 'register', acceptedCode) {
  email = normalizeEmail(email);
  const db = getDB();
  const code = acceptedCode || generateVerificationCode();
  const id = crypto.randomUUID();

  // Invalidate previous unused codes for this email+purpose
  db.prepare('UPDATE verification_codes SET used = 1 WHERE email = ? AND purpose = ? AND used = 0').run(email, purpose);

  db.prepare(`
    INSERT INTO verification_codes (id, email, code, purpose)
    VALUES (?, ?, ?, ?)
  `).run(id, email, code, purpose);

  return code;
}

/**
 * Verify a code for an email. Returns true if valid, false otherwise.
 * Marks the code as used on success.
 */
function verifyCode(email, code, purpose = 'register') {
  email = normalizeEmail(email);
  if (!/^\d{6}$/.test(code)) return false;
  const db = getDB();
  const row = db.prepare(`
    SELECT id, expires_at, used FROM verification_codes
    WHERE email = ? AND code = ? AND purpose = ? AND used = 0
    ORDER BY created_at DESC LIMIT 1
  `).get(email, code, purpose);

  if (!row) return false;
  if (hasExpired(row.expires_at)) return false;

  return db.prepare('UPDATE verification_codes SET used = 1 WHERE id = ? AND used = 0').run(row.id).changes === 1;
}

// ─── Email (Resend) ──────────────────────────────────────────────────────

let _resendClient = null;
function _getResend() {
  if (_resendClient !== null) return _resendClient;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { _resendClient = false; return false; }
  try {
    const { Resend } = require('resend');
    _resendClient = new Resend(apiKey);
    return _resendClient;
  } catch {
    _resendClient = false;
    return false;
  }
}

/**
 * Send a verification code email via Resend.
 * Requires configured delivery; missing transport must never report success.
 */
async function sendVerificationEmail(email, code, requestId = crypto.randomUUID()) {
  const resend = _getResend();
  const from = process.env.RESEND_FROM?.trim();

  if (!resend || !from) throw new Error('Email delivery is not configured');

  const { data, error } = await resend.emails.send({
    from,
    to: email,
    subject: 'Eagleye 邮箱验证 / Verify your email',
    text: `Eagleye 注册验证码：${code}。10 分钟内有效。如非本人操作，请忽略此邮件。`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #ffffff; color: #253047;">
        <h2 style="color: #253047;">🦅 Eagleye</h2>
        <p style="color: #455168; font-size: 14px;">您的注册验证码 / Your verification code:</p>
        <div style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #64b5f6; text-align: center; padding: 24px 0; border: 1px solid #333; border-radius: 8px; margin: 16px 0;">
          ${code}
        </div>
        <p style="color: #707080; font-size: 12px;">验证码 10 分钟内有效。如非本人操作请忽略此邮件。<br>The code expires in 10 minutes.</p>
      </div>
    `,
  }, { idempotencyKey: `eagleye-verification/${requestId}`, signal: AbortSignal.timeout(20000) });

  if (error || !data?.id) {
    const failure = new Error('Verification email provider rejected the request');
    failure.code = error?.name || 'provider_error';
    throw failure;
  }
  return data;
}

// Reserve a durable per-email slot before network I/O. Keep the previous code
// valid if sending fails; replace it only after Resend accepts the new email.
async function requestVerificationEmail(rawEmail) {
  const email = normalizeEmail(rawEmail);
  const db = getDB();
  const requestId = crypto.randomUUID();
  db.transaction(() => {
    const last = db.prepare('SELECT attempted_at FROM verification_delivery WHERE email=?').get(email);
    const retryAfter = last ? Math.ceil((last.attempted_at + 60000 - Date.now()) / 1000) : 0;
    if (retryAfter > 0) throw Object.assign(new Error('Please wait before requesting another code'), {status:429,retryAfter});
    db.prepare(`INSERT INTO verification_delivery(email,request_id,attempted_at,status)
      VALUES(?,?,?,'sending') ON CONFLICT(email) DO UPDATE SET request_id=excluded.request_id,
      attempted_at=excluded.attempted_at,status='sending',provider_id=NULL,error_class=NULL`)
      .run(email,requestId,Date.now());
  }).immediate();
  const code = generateVerificationCode();
  try {
    const sent = await sendVerificationEmail(email,code,requestId);
    db.transaction(() => {
      const current = db.prepare('SELECT request_id FROM verification_delivery WHERE email=?').get(email);
      if (current?.request_id !== requestId) throw new Error('Verification request superseded');
      storeVerificationCode(email,'register',code);
      db.prepare("UPDATE verification_delivery SET status='accepted',provider_id=? WHERE email=? AND request_id=?")
        .run(sent.id,email,requestId);
    }).immediate();
    return {retry_after:60};
  } catch (error) {
    db.prepare("UPDATE verification_delivery SET status='failed',error_class=? WHERE email=? AND request_id=?")
      .run(error.code || 'delivery_error',email,requestId);
    console.warn('[verification-email] delivery failed', error.code || 'delivery_error');
    throw Object.assign(new Error('Verification email could not be sent. Please resend after 60 seconds.'), {status:503,retryAfter:60});
  }
}

// ─── User Helpers ────────────────────────────────────────────────────────

function getUserByEmail(email) {
  const db = getDB();
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase().trim());
}

function getUserCount() {
  const db = getDB();
  return db.prepare('SELECT COUNT(*) as c FROM users').get().c;
}

function createUser(email, passwordHash) {
  const db = getDB();
  const id = crypto.randomUUID();
  const isFirstUser = getUserCount() === 0;
  const role = isFirstUser ? 'admin' : 'user';

  db.prepare(`
    INSERT INTO users (id, email, password_hash, role, email_verified)
    VALUES (?, ?, ?, ?, 0)
  `).run(id, String(email).toLowerCase().trim(), passwordHash, role);

  return { id, email, role, isFirstUser };
}

function getAllUsers() {
  const db = getDB();
  return db.prepare(`
    SELECT id, email, display_name, role, status, email_verified, created_at, last_login_at
    FROM users ORDER BY created_at ASC
  `).all();
}

function updateUserRole(userId, role) {
  const db = getDB();
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
}

function updateUserStatus(userId, status) {
  const db = getDB();
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);
}

// ─── API Keys (service-to-service) ───────────────────────────────────────

function generateApiKey() {
  return 'eg_' + crypto.randomBytes(24).toString('hex');
}

function createApiKey(name, userId) {
  const db = getDB();
  const key = generateApiKey();
  db.prepare('INSERT INTO api_keys (key, name, user_id) VALUES (?, ?, ?)').run(key, name, userId);
  return key;
}

function getApiKeyOwner(key) {
  const db = getDB();
  if (!key || !key.startsWith('eg_')) return null;
  const row = db.prepare(`
    SELECT k.key, k.name, k.active, k.expires_at,
           u.id, u.email, u.display_name, u.role, u.status
    FROM api_keys k
    JOIN users u ON k.user_id = u.id
    WHERE k.key = ? AND k.active = 1
  `).get(key);
  if (!row) return null;
  if (row.status !== 'active') return null;
  if (row.expires_at !== null && hasExpired(row.expires_at)) return null;

  // Update last_used_at (non-blocking, cheap)
  try { db.prepare('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE key = ?').run(key); } catch {}

  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
  };
}

function listApiKeys(userId) {
  const db = getDB();
  return db.prepare(`
    SELECT key, name, created_at, last_used_at, active
    FROM api_keys WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId);
}

function revokeApiKey(key) {
  const db = getDB();
  db.prepare('UPDATE api_keys SET active = 0 WHERE key = ?').run(key);
}

module.exports = {
  normalizeEmail,
  requestVerificationEmail,
  hashPassword,
  verifyPassword,
  createSession,
  clearSession,
  getSessionUser,
  storeVerificationCode,
  verifyCode,
  sendVerificationEmail,
  getUserByEmail,
  getUserCount,
  createUser,
  getAllUsers,
  updateUserRole,
  updateUserStatus,
  createApiKey,
  getApiKeyOwner,
  listApiKeys,
  revokeApiKey,
};
