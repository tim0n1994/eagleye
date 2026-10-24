-- Eagleye Schema Migration 043: Per-source fetch duration (Round 2 ⑤)
--
-- sources.last_fetch_duration_ms records the wall time of a source's most
-- recent fetch round in milliseconds. Successful, empty, AND failed rounds
-- all stamp it (a failed round still burned crawl time): connectors/index.js
-- fetchSource writes it on every completed round via recordFetchDuration,
-- and recordFailedAttempt writes it on the error path. The value is
-- overwrite-on-every-round — it holds the LATEST round's duration, not an
-- accumulation. NULL = never measured (rows predating this migration); no
-- 0 default is fabricated on purpose so "never ran" stays distinguishable
-- from "ran instantly".
--
-- Consumers: /api/sources (rides along via SELECT s.*), /sources page
-- duration badge (js/modules/pages/sources.js).
-- Additive only — one nullable INTEGER column, no rewrites, safe via the
-- standard migration runner (fresh installs and existing databases both
-- start with NULLs).

ALTER TABLE sources ADD COLUMN last_fetch_duration_ms INTEGER;
