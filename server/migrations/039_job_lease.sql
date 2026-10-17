-- Eagleye Schema Migration 039: Job leases and late-commit protection (R0-06)
--
-- Per-claim lease on background_jobs so a worker that lost its job (server
-- restart, reclaim) cannot overwrite newer outcomes:
-- - lease_owner   process that claimed the job (informational).
-- - lease_epoch   monotonic per job: +1 on every claim and on every
--                 markInterruptedJobs pass; commit paths verify it unchanged
--                 in a short transaction (server/services/jobs.js).
-- - lease_expiry  soft claim deadline for observability and future reclaim;
--                 epoch verification is the enforcement, since a long stage
--                 may legitimately outlive it.
-- - attempt       claim counter, incremented on each claim.
--
-- Column semantics live here rather than in the DDL: the runner (server/db/
-- migrate.js) applies each file once inside a transaction, so a failed pass
-- rolls back fully and the next start retries; the _migrations ledger rules
-- out re-application.

ALTER TABLE background_jobs ADD COLUMN lease_owner TEXT;
ALTER TABLE background_jobs ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE background_jobs ADD COLUMN lease_expiry TEXT;
ALTER TABLE background_jobs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
