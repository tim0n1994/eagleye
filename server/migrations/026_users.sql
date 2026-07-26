-- 026_users.sql — User accounts, sessions, and email verification codes
--
-- Adds authentication: email+password registration with email verification
-- via Resend. First registered user becomes admin. Sessions are server-side
-- tokens stored in an HttpOnly cookie.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',        -- 'admin' | 'user'
  status TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'disabled'
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS verification_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'register', -- 'register' | 'reset'
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT DEFAULT (datetime('now', '+10 minutes')),
  used INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_verif_email ON verification_codes(email, purpose);
