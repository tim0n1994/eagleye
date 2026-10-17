-- 028_user_scoped_data.sql
--
-- user_data was a global key/value store from the single-user era, and
-- saved_items/seen_items carried a hardcoded 'anonymous' owner. Migrations 026
-- (users) and 027 (api_keys) added real accounts and registration is reachable
-- from the public tunnel, so a second account would have shared and overwritten
-- the first account's watchlist, personal lens and saved searches.
--
-- Not every key is personal. llm_config / scheduler_config / es_last_sync
-- describe the server itself, so they stay global (user_id = '') and are
-- admin-gated in the route layer. Only the three personal keys get scoped.
--
-- Existing personal rows attach to the single existing account so the current
-- owner keeps their data. With zero or 2+ accounts there is no safe owner to
-- infer, so they stay global and read back as unset for everyone — data is
-- preserved either way, never dropped.

CREATE TABLE IF NOT EXISTS user_data (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE user_data_scoped (
  key     TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  value   TEXT,
  PRIMARY KEY (key, user_id)
);

-- System keys: stay global.
INSERT INTO user_data_scoped (key, user_id, value)
SELECT key, '', value
FROM user_data
WHERE key NOT IN ('watchlist', 'personal_lens', 'es_saved_searches');

-- Personal keys: attach to the sole account when there is exactly one.
INSERT INTO user_data_scoped (key, user_id, value)
SELECT key,
       COALESCE((SELECT id FROM users WHERE (SELECT COUNT(*) FROM users) = 1), ''),
       value
FROM user_data
WHERE key IN ('watchlist', 'personal_lens', 'es_saved_searches');

DROP TABLE user_data;
ALTER TABLE user_data_scoped RENAME TO user_data;

-- Re-home rows written under the literal 'anonymous' owner. Guarded on there
-- being exactly one account, for the same reason as above.
UPDATE seen_items
SET user_id = (SELECT id FROM users)
WHERE user_id = 'anonymous' AND (SELECT COUNT(*) FROM users) = 1;

UPDATE saved_items
SET user_id = (SELECT id FROM users)
WHERE user_id = 'anonymous' AND (SELECT COUNT(*) FROM users) = 1;
