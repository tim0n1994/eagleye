-- Eagleye Schema Migration 040: Transactional outbox (R0-07)
--
-- Plan v1.0 §R0-07 / §7.4: committed data must be recoverable for delivery
-- ("数据已提交但未投递可补发"), redelivery must not duplicate business
-- results ("重复消费无重复业务结果"), and the ingestion checkpoint may only
-- advance once the original record AND its pending follow-up work are both
-- persisted in the same transaction.
--
-- Producers (connectors/base.js saveItems) insert an event row in the SAME
-- transaction as the information_items row, so a committed item always has a
-- pending event and a rolled-back batch never leaves an orphan event.
-- drainOutbox() (server/services/outbox.js) dispatches pending events
-- at-least-once and marks each dispatched in its own short transaction.
-- unique_key is the idempotency identity: duplicate registrations are
-- absorbed by the UNIQUE constraint (INSERT ... ON CONFLICT DO NOTHING) and
-- consumers dedup redelivery by business identity on the same key.
--
-- Dead letters stay visible: a failing event keeps dispatched_at NULL and
-- grows attempts/last_error on every retry until attempts >= the drain's
-- maxAttempts, after which drainOutbox() stops selecting it but the row
-- remains queryable for inspection.

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  unique_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  dispatched_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox (created_at) WHERE dispatched_at IS NULL;
