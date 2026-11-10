-- Per-address send cooldown and provider acceptance ledger; never log OTPs.
CREATE TABLE verification_delivery (
  email TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  provider_id TEXT,
  error_class TEXT
);
UPDATE verification_codes SET email = lower(trim(email));
