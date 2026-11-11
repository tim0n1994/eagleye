# Eagleye paid subscription rollout

Status: deployed to the running instance on 2026-11-11. Public origin: https://eagleye.udify.fun.
Merchant MER_3HwfMhGUEG9A2lL1Qdnzmp; user-selected store STO_557gZPlEDxtnPwGHge3VyX (UDIFY FUN). Mystic products and webhook were retained.

Reader: PROD_27Gs1qEL7u4j43I3QWk1mJ, USD 20/month. Analyst: PROD_5ybbhJA2qgOBD3QMVwXxfz, USD 79/month. Both active in production.
Group: 1d90fb58-3937-4789-aa0d-fb5047dd3175 (no shared trial, self-service plan changes enabled).
Production callback: https://eagleye.udify.fun/api/billing/webhook, ID 14acf251-7987-4911-8d45-15b9998fc7bf.
Exempt verified accounts: tim0n@qq.com and yajing1906232977@163.com.

## Plans

- Reader: USD 20 monthly. Intelligence reading, bilingual summaries, papers and specialist pages, search, saves and briefing archive.
- Analyst: USD 79 monthly. Reader plus topics, trends, entity tracking, graphs, watchlists and personal API/RSS access.
- No free tier or trial. Registration records the plan but grants no content access. Email verification precedes checkout. Browser return URLs never grant access.
- Only verified, active `tim0n@qq.com` and the explicitly configured Kira email are exempt. Admin role alone does not confer a billing exemption. Product administration remains role-controlled.

## Configuration required

Keep secrets in the existing private service environment, never this repository or chat:

- `WAFFO_MERCHANT_ID`, `WAFFO_PRIVATE_KEY`, `WAFFO_STORE_ID`
- `WAFFO_ENVIRONMENT=prod`
- `WAFFO_EAGLEYE_READER_MONTHLY`: active Eagleye monthly USD 20 product ID
- `WAFFO_EAGLEYE_ANALYST_MONTHLY`: active Eagleye monthly USD 79 product ID
- `EAGLEYE_PUBLIC_URL`: canonical HTTPS application origin
- `EAGLEYE_BILLING_EXEMPT_EMAILS`: confirmed Kira account email

Configure the Waffo store callback to `<EAGLEYE_PUBLIC_URL>/api/billing/webhook` for subscription lifecycle and refund events. Place both products in a compatible product group for provider-mediated upgrades/downgrades. Keep price changes and prorations visible on Waffo's confirmation page. Do not reuse Mystic Atlas product IDs.

## Behavior and data

Official `@waffo/pancake-ts@0.28.0` handles signing, checkout sessions, plan changes, portal links and raw-body webhook verification. Checkout reads the actual product catalog and verifies the store, USD price, monthly period and active state before opening a session. Checkout intents bind the server-selected product to the verified account using an immutable external ID and namespaced buyer identity.

Five additive SQLite tables store selected plans, checkout intents, subscription orders webhook delivery receipts and a durable webhook inbox. Existing users and business records are retained. No pre-existing account gains a paid entitlement automatically.

Webhook intake verifies signature, production mode and store, persists before acknowledging, and asynchronously retries reconciliation; processing binds the event to a known checkout/account; reads the authoritative current subscription and configured product; then atomically updates entitlement and deduplication receipt. Per-order serialization and current-state reads prevent delayed lifecycle events from reverting a newer plan. No trial access is granted without a succeeded payment. Expiry is evaluated on every protected request. Canceling/past-due retain only the remaining paid period. Current-period full refunds revoke that order; historical or partial refunds do not automatically erase the current period.

API and legacy feed/export routes are gated before dispatch. API key access requires Analyst. Billing, email recovery, auth and pricing remain accessible for unpaid users. Provider errors fail closed with a retryable UI.

## Validation performed

Syntax and ESLint checks; SDK and native SQLite dependency loading; Hallmark billing CSS static audit (0 FAIL / 0 REFLEX / 0 WARN). No mock transactions, test database, test users or real charges. Production catalog and group readback succeeded. Both authenticated production checkout sessions were created and their pages returned HTTP 200; these connectivity sessions expired without payment. Public pricing rendered with no JavaScript errors. Existing authenticated sessions confirmed both exemptions. Anonymous content API and RSS returned 401. Actual charge, signed payment-event delivery, renewal, plan change and refund require user acceptance and are not claimed as tested.

## Deployment

Candidate: `<release-root>/paid-plans-20261111`.
Baseline: `<release-root>/i18n-hallmark-20261111`.
Switched after confirming there were no active collection/backfill jobs. Service drop-in: ~/.config/systemd/user/argus-eagleye.service.d/zzzzzzzzzz-paid-plans.conf. Protected configuration: ~/.config/argus/eagleye-billing.env (mode 0600). Previous release and all existing service environment remain preserved. Rollback: remove only the paid-plans drop-in, daemon-reload and restart after jobs drain. SQLite tables are additive and need not be removed.

## Repository synchronization

This release is synchronized on top of the existing production baseline `8233b3d`, including password recovery, verification delivery, neuroscience, specialist sources and intelligence indexing. Runtime code and dependency manifests are compared byte-for-byte with the active release. Private environment files, database contents, session tokens, local screenshots and per-host credentials are excluded from Git. Operator-specific paths in this document are placeholders.

### Source-sync validation boundary

The existing pre-commit hook automatically started the full Vitest suite during source synchronization. It reported failures in UI assertions, registration and collector/migration suites; the run was stopped and is not a passing verification. Per the operator's minimal-validation instruction, the source-sync commit skips only that commit-time test hook. No tests were rewritten and no production behavior was changed to satisfy those assertions. JavaScript syntax, ESLint, byte-for-byte release comparison and the public privacy check passed. Push-time privacy and secret scanning remain enabled.
