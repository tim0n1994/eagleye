-- Eagleye Schema Migration 033: Item time contract columns (R0-02, plan §4.2)
--
-- Separates the raw source timestamp from the parsed value:
--   published_raw          original string exactly as the connector saw it
--   published_precision    'day' | 'second' | 'unknown'
--   published_parse_status 'ok' | 'unparseable' | 'missing'
--
-- Additive only; safe to run online. The value backfill is a boot-time,
-- idempotent JS pass (server/services/date-contract.js
-- backfillPublishedProvenance) because it needs real date parsing
-- (ISO 8601 and RFC 5322 RSS dates). Rows written after this migration get
-- all four fields from connectors/base.js directly.

ALTER TABLE information_items ADD COLUMN published_raw TEXT;
ALTER TABLE information_items ADD COLUMN published_precision TEXT;
ALTER TABLE information_items ADD COLUMN published_parse_status TEXT;
