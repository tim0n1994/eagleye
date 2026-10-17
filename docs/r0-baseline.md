# Eagleye R0 Baseline Report

- Generated: 2026-09-18 (Asia/Shanghai)
- Plan: Eagleye_Iteration_Plan_v1.0_2026-09-17.md (924 lines; PDF/DOCX not present on this host)
- Branch: `codex/radar-trust-incremental` @ `b841f21` + 155 in-flight dirty files (no stash/checkout/revert/clean performed)

## Runtime Environment (VERIFIED)

- Node.js v22.22.2
- better-sqlite3 12.10.0, embedded SQLite 3.53.1 (>= 3.51.3, includes WAL-reset fix)
- Python 3.14.6
- macOS 26.6.2
- sqlite3 CLI reports 3.51.0; driver-embedded 3.53.1 is authoritative for schema behaviour
- No Eagleye service processes running at measurement time (ps verified)

## Production Database Survey (read-only, VERIFIED)

Database: `eagleye.db` (default path, read-only access)

| Table | Rows | Notes |
|---|---|---|
| sources | 18 | active connector definitions |
| information_items | 41,958 | `score` range 0 to 887,517.313 (unbounded legacy) |
| signal_scores | 41,117 | `alpha_score` range 0.228-0.992 (already clamped via MIN(1.0,...)) |
| background_jobs | 3,679 total | completed 3,606 / failed 56 / cancelled 17 |
| daily_digests | present | `digest_date` 20260525-20260801 (canonical column; no `digests` table) |

## R0 Package Delivery Status

| ID | Scope | Status | Evidence |
|---|---|---|---|
| R0-01 | Baseline doc | DELIVERED | this document |
| R0-02 | Date contract | DELIVERED (prior) | `server/services/date-contract.js`, migration 033/034, tests pass |
| R0-03 | Content sufficiency | DELIVERED | `server/services/content-sufficiency.js` (7 states incl. 3 blocking enums), `sufficiency_gate` switch (default true, fail-open), guards in llm.js + llm-digest.js, 13 test cases |
| R0-04 | LLM error classification | DELIVERED (prior) | `server/services/llm-error-class.js`, migration 038 |
| R0-05 | Isolation / runtime switches | DELIVERED (prior) | `server/services/runtime-switches.js` (7 switches incl. new `sufficiency_gate`), degraded-endpoint fallback |
| R0-06 | Job lease | DELIVERED | migration 039 (`lease_owner`/`lease_epoch`/`lease_expiry`/`attempt`), `claimJob` epoch check rejects late commits, `isJobIntakePaused` via EAGLEYE_JOBS_PAUSED, graceful degradation on legacy schema without lease columns, 8 test cases |
| R0-07 | Transactional outbox | DELIVERED | migration 040, `server/services/outbox.js` (registerEvent ON CONFLICT DO NOTHING, drainOutbox dead-letter), `connectors/base.js` same-transaction hook (item row + outbox row), 8 test cases |
| R0-08 | Rate limiting | DELIVERED (prior) | `server/services/rate-limit.js` |
| R0-09 | Source health + backup/restore | DELIVERED (prior) | `server/services/source-health.js`, migration 037, `scripts/backup-eagleye.js` + `scripts/restore-verify.js` |
| OBS-08 | Score scale observability | DELIVERED | `items.js` emits `score_scale: {score: 'unbounded-legacy'}`, `signals.js` emits `score_scale: {alpha_score: '0-1', alpha_score_audience: '0-1'}` (audience clamped via MIN(1.0,...) verified in source), `score-scale.test.js` 2 cases |

## Integration Fixes

Four fixture conflicts between concurrently developed packages were resolved:

- `sync-source.test.js` line 46: outbox require uses `require('../outbox')` (vm harness resolves from `server/` root, interceptor resolves from `__tests__`; `require('../services/outbox')` would double-resolve to `services/services/`). beforeEach extended to run migration 040.
- `job-cancellation-chain.test.js` line 32: added `'./content-sufficiency': {deepEnrichSkipReason: () => null}` stub.
- `migrations-fresh.test.js` line 31: expected migration count 36 -> 38 (039 + 040).
- `runtime-switches-routes.test.js` line 68: switch count six -> seven, numeric 6 -> 7.

## Acceptance Run

- ESLint: 0 errors on all 17 JS files changed by this iteration's R0 packages (see verification log).
- Test suite: 45 files, all passing (baseline was 41 files / 600 tests; +4 new test files for R0-03/06/07/OBS-08).
- Command: `EAGLEYE_DB_PATH=$(mktemp -d)/t.db npm test`

## Known Unknowns (not verifiable on this host)

- Production deployment topology and real traffic patterns
- Token cost attribution per LLM lane
- RPO/RTO disaster-recovery drill results
- Browser-level end-to-end acceptance (frontend tests are unit-level only)
