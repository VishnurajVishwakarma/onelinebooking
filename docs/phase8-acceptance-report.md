# Phase 8 — Deployment, Security Acceptance, Billing & Private Beta Report

This report documents all findings, security fixes, test & operational drill results, commercial infrastructure, developer portal assets, pilot integration, and remaining gaps observed for **OneLineBooking** across Phase 8. Unexecuted checks are explicitly recorded as not executed.

---

## 1. Independent Security Audit & Resolved Vulnerabilities

During the independent code and runtime review of the V1 platform, SDK, Developer Console, Workers, and REST API, the following concrete gaps were identified and remediated with regression tests:

| Finding | Severity | Remediation Implemented | Code Location | Verification |
| --- | --- | --- | --- | --- |
| Browser key guard only blocked `olb_live_` while allowing `olb_test_` in `window` | High | Blocked BOTH `olb_live_` and `olb_test_` keys (`/^olb_(test|live)_/i`) inside browser `window` (`SdkSecurityBoundaryError`); fixed explicit `{ ...opts, idempotencyKey }` spread precedence on mutating SDK methods | [packages/sdk/src/server.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/packages/sdk/src/server.ts) | `phase7-security.test.ts`, `phase8-security-and-billing.test.ts` |
| Live environments could allow local/internal webhook override flags | High | Forced `allowLocalHttpForTesting: false` on every `live` environment webhook registration (`createWebhookEndpoint`) and every `live` outbound delivery (`OutboxWebhookWorker` joins `environments`) | [control-plane.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/control-plane.ts), [outbox-webhook-worker.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/workers/outbox-webhook-worker.ts) | `phase8-security-and-billing.test.ts` |
| Single-key webhook encryption had no versioned keyring rotation | High | Added `KmsKeyring`, `resolveMasterKeyring`, versioned `enc.v2.<ver>.<iv>.<tag>.<cipher>` format preserving `enc.v1.` decode compatibility, and atomic `reEncryptWebhookSecrets()` | [crypto.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/security/crypto.ts), [control-plane.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/control-plane.ts) | `phase8-security-and-billing.test.ts` |
| Console mutating endpoints lacked server-side CSRF `Origin` validation & TLS-aware `Secure` cookies | Medium-High | Added `verifyConsoleCsrfOrigin(req)` verifying `Origin` host against `Host` / `X-Forwarded-Host` on mutating Console API routes; updated session cookies to set `Secure` when HTTPS / `x-forwarded-proto` is present | [engine.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/apps/console/src/lib/engine.ts) + mutating routes under [apps/console/src/app/api/console](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/apps/console/src/app/api/console) | Built & exercised in live Next.js Playwright + HTTP E2E |
| HTTP idempotency hashed raw object keys & usage metering risked duplicate billing on retry | Medium | Added `canonicalJsonStringify()` for key-order-insensitive request hashing; scoped usage ledger idempotency keys (`idem:${mutationIdempotencyKey}:${metric}`) + `scopeKey`; wired `emitBoundedJson` (`maxResponseBytes` enforcement) | [server.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/api/server.ts) | `phase8-security-and-billing.test.ts` |

---

## 2. Complete Verification Results (All Latest Observed Runs)

### A. Automated Test Suite (`npm run test:all`)
Executed against live PostgreSQL `17-alpine` with migration `0006_phase8_auth_and_billing` applied (`--test-concurrency=2` across integration files):
- **Unit & Stress (`dist/tests/unit/*.test.js` + `dist/tests/stress/*.test.js`)**: **45 passed, 0 failed, 0 skipped, 0 cancelled** across **5 suites** (`22,288.1 ms`), covering domain scheduling/DST stress sweeps (365-day x 5-TZ, Luxon oracle parity), Phase 6 budgets/HMAC/scoping, and Phase 7 SSRF/crypto/PII scrubbing/SDK security boundaries.
- **PostgreSQL Integration & End-to-End (`dist/tests/integration/*.test.js`)**: **27 passed, 0 failed, 0 skipped, 0 cancelled** across **7 suites** (`43,593.6 ms`):
  - `PostgreSQL integration and concurrency matrix`: 6/6 passed
  - `Phase 3 Production reliability & edge-case tests`: 9/9 passed
  - `Phase 5C Correctness audit`: 5/5 passed
  - `Phase 6 Integration Tests`: 2/2 passed
  - `Phase 7 Private Beta Acceptance Suite`: 2/2 passed
  - `Phase 7B Developer Console End-to-End Acceptance Suite` (live built Next.js 16.4.6 app): 1/1 passed
  - `Phase 8 Security Regression, KMS Rotation, Auth Email, Billing & Book My Game Pilot`: 2/2 passed

### B. PgBouncer Transaction Pooling Suite (`localhost:6432`, `AUTH_TYPE=scram-sha-256`)
Executed against `postgres://postgres:postgres@localhost:6432/mygamingslot`:
- **Result**: **17 passed, 0 failed, 0 skipped** across **5 suites** (`postgres-booking`, `phase5-correctness`, `phase6-platform`, `phase7-acceptance`, `phase8-security-and-billing`) in `26,699.9 ms`.

### C. Playwright Headless Chrome Browser E2E ([examples/playwright-e2e/run-e2e.mjs](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/examples/playwright-e2e/run-e2e.mjs))
Executed against live built Next.js Developer Console using `C:\Program Files\Google\Chrome\Application\chrome.exe`:
- **Result**: `playwrightBrowserE2EPassed: true`.
- **Verified UI Flows**:
  1. `register_ui_and_cookie_auth` (`/login` -> Register -> Create Account -> authenticated redirect)
  2. `onboarding_wizard_ui` (Provision org, project, venue, facility -> displays `olb_test_` key)
  3. `facilities_and_availability_calendar` (`/facilities` -> Load Slots -> live slots rendered)
  4. `playground_test_vs_live_block` (`/playground` executes in Test mode, switches Environment selector to `LIVE` and renders disabled guard)
  5. `billing_plan_creation_ui` (`/billing` -> Add Growth Plan -> rendered in plans table)

### D. Sustained Workload Soak Test ([scripts/soak-test.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/scripts/soak-test.ts))
Executed `node dist/scripts/soak-test.js --duration-seconds=120 --concurrency=16`:
- **Actual Duration**: `120.25 s` (**NOTE**: Continuous 30-minute and 60-minute soak executions were **not executed** in this interactive session due to elapsed-time constraints; see Section 8).
- **Throughput & Counts**: `7,226` total operations (`60.1 ops/s`: `4,820` availability reads + `2,406` completed hold lifecycles).
- **Correctness & Stability**: `0` expected conflicts, `0` retryable errors, `0` unexpected errors, `0` overlapping allocations; RSS `84.7 MB -> 203.1 MB` (`+118.4 MB`), latency `p50 = 188.69 ms`, `p95 = 514.34 ms`, `p99 = 618.85 ms`.

### E. Independent SDK Package Smoke Verification ([examples/sdk-consumer-smoke](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/examples/sdk-consumer-smoke))
- Verified `@onelinebooking/sdk` installed via `file:../../packages/sdk`:
  - `node examples/sdk-consumer-smoke/verify.mjs` -> `ESM SDK import verified cleanly.`
  - `node examples/sdk-consumer-smoke/verify.cjs` -> `CJS SDK require verified cleanly.`

---

## 3. Infrastructure & Cloud Deployment Architecture

Complete container Dockerfiles (`Dockerfile.api`, `Dockerfile.console`, `Dockerfile.docs`), GitHub Actions CI/CD (`.github/workflows/ci-cd.yml`), Terraform IaC (`infra/terraform/main.tf` with private DB subnets, KMS envelope encryption, Secrets Manager, and regional WAF), budget-aware entrypoints (`run-api.ts`, `run-workers.ts`), monitoring thresholds, and additive rollback procedures are documented in [phase8-cloud-architecture.md](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/docs/phase8-cloud-architecture.md).

---

## 4. Backup, Restore & WAL Point-in-Time Recovery (PITR) Drills

### A. Operational Reliability Drills (`npm run verify:reliability-ops`, [scripts/reliability-phase5.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/scripts/reliability-phase5.ts))
- **`sigkillMidTx`**: `passed: true` (`uncommittedRolledBack: true`, `postKillHoldId: eba593bf-3916-471e-b35a-4f898c4d5d71`).
- **`postgresRestartRecovery`**: `passed: true` (`preBookingPreservedId: 3b9c9f07-88e7-4181-9a0e-c516b72becff`, `postRestartNewHoldId: b1994d41-d4ab-4902-aa60-681b00af78db`).
- **`populatedMigrationUpgrade`**: `passed: true` across populated legacy state (`0002_v1_schema`, `0003_v1_performance_indexes`, `0004_platform_schema`, `0005_phase7_security_and_ops`, `0006_phase8_auth_and_billing`; `migratedHolds: 4`, `migratedBookings: 2`, `backfilledPriceMinor: 12000`).
- **`backupAndRestore`**: `passed: true` (`restoredBookingsInitial: 2`, `liveBookingAfterRestoreId: 96d64723-b0d7-402f-bfe3-1e2e50d0bd35`).

### B. Physical WAL-Based PITR Drill ([scripts/phase8-pitr-drill.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/scripts/phase8-pitr-drill.ts))
Executed using isolated `postgres:17-alpine` containers (`wal_level=replica`, `archive_mode=on`, `pg_basebackup`, `pg_switch_wal()`, and `recovery_target_time` promotion):
- **`pitrPassed: true`**
- **`targetRecoveryTimestamp`**: `2026-11-27 08:39:29.257235+00`
- **`recoveredRows`**: `["BEFORE_CUTOFF_BOOKING"]`
- **`postCutoffMutationRolledBackByWalPitr`**: `true` (confirmed `AFTER_CUTOFF_ACCIDENTAL_DROP` excluded upon promotion).

---

## 5. Commercial Billing & Usage Reconciliation Model

Implemented in [0006_phase8_auth_and_billing.sql](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/migrations/0006_phase8_auth_and_billing.sql), [billing.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/billing.ts), and Console `/billing` UI ([billing/page.tsx](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/apps/console/src/app/billing/page.tsx)):
- **Separation from Booking Correctness**: Booking hold/confirm/cancel PostgreSQL transactions never depend on payment gateway calls or billing ledger queries.
- **Plans, Versions & Trials**: Immutable `billing_plan_versions` snapshot pricing (`monthly_base_minor`, `included_bookings`, `included_api_requests`, `overage_booking_minor`, `overage_api_request_1k_minor`, `trial_days`, `overage_policy` in `{allow_and_bill, hard_cap}`). `BillingService.startSubscription()` manages `trialing` / `active` state via pluggable `PaymentProviderAdapter` (`ManualInvoicingProvider` implemented cleanly without fake gateway credentials).
- **Idempotent Append-Only Ledger & Invoices**: `billing_ledger_entries` enforces `UNIQUE (organization_id, idempotency_key)`; `generateInvoiceForPeriod()` computes included allowance vs overages and finalizes immutable invoices; `reconcileProviderWebhook()` deduplicates via `billing_webhook_events` `UNIQUE (provider, provider_event_id)` and transitions invoices (`invoice.paid` -> `paid`).
- **Quota Enforcement**: `evaluateOrganizationQuota()` reads aggregated usage cleanly to drive soft overage billing or `hard_cap` entitlements.

---

## 6. Developer Onboarding, Public Docs & Auth Delivery

- **Email Verification, Password Reset & Invitations**:
  - [mailer.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/security/mailer.ts) (`SmtpEmailTransport` RFC 5321 TCP SMTP client) + [console-auth.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/console-auth.ts) + [auth/route.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/apps/console/src/app/api/console/auth/route.ts) implement real verification tokens, single-use reset tokens revoking all existing sessions on completion, and organization invite notifications. Verified end-to-end against live RFC 5321 SMTP capture in `phase8-security-and-billing.test.ts`.
- **Marketing & Documentation Portal**:
  - [apps/marketing/index.html](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/apps/marketing/index.html) and [apps/docs/index.html](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/apps/docs/index.html) (`createDocsServer` checked `HTTP 200` with all 13 documentation sections: Five-Minute Quickstart, Authentication, API Reference, SDK Documentation, Booking Lifecycle, Resource Configuration, Availability Generation, Idempotency, Error Handling, Webhook Verification, Rate & Concurrency Limits, Test & Live Environments, and Migration & Versioning Policy).

---

## 7. Real-World Pilot: "Book My Game" ([examples/book-my-game](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/examples/book-my-game))

An independent gaming café application (`examples/book-my-game/server.mjs` + `public/index.html`) consuming OneLineBooking strictly through `/v1` HTTP endpoints and `@onelinebooking/sdk/server` (`OneLineBookingClient`, `verifyWebhookSignature`, `OneLineBookingApiError`) with zero direct database/store imports:
- Multi-outlet setup (`Koramangala Arena`, `Indiranagar Arena`) with PC bays and PS5 lounges.
- Live availability lookups, two-phase online hold -> confirm checkout, receptionist walk-in pay-at-counter booking path, customer booking history lookup, maintenance blackout window creation, cancellation flow, and signed webhook receiver verification. Verified end-to-end inside `phase8-security-and-billing.test.ts`.

---

## 8. Incomplete Features

1. **Full Continuous 30-Minute and 60-Minute Soak Runs**: Only a `120.25 s` mixed workload soak (`7,226` ops) was executed interactively; full 30-minute and 60-minute continuous production soak windows (`npm run test:soak:30m` / `npm run test:soak:60m`) remain unexecuted and are required before general availability.
2. **External Payment Gateway Adapter (e.g., Stripe)**: Commercial infrastructure implements the `PaymentProviderAdapter` abstraction and `ManualInvoicingProvider`, plus webhook reconciliation deduplication; live third-party Stripe/Adyen API integration and webhook HMAC verification for payment providers were intentionally left as pluggable adapters.
3. **Live Cloud Provisioning**: Terraform IaC (`infra/terraform/main.tf`) and GitHub Actions workflow (`ci-cd.yml`) were authored and inspected locally; `terraform validate` / `terraform apply` against a live AWS account and Docker image registry pushes were not executed from this workspace.

---

## 9. Unverified Assumptions

1. **Managed AWS EKS / ECS / RDS Performance Parity**: Throughput, latency (`p50`/`p95`/`p99`), and `maxHoldExpirationLagSeconds` metrics were measured in Docker on a Windows developer host rather than across multi-AZ RDS + PgBouncer network hops.
2. **External Mailpit / Production SMTP TLS Relay**: SMTP flows (`verifyEmail`, `resetPassword`, `inviteMember`) were verified against an in-process RFC 5321 plain TCP SMTP capture server; authenticated TLS (`STARTTLS`/`SMTPS`) relay credentials against an external provider (SES/Postmark) were not exercised live.
3. **Email-Reset Click Journey Inside Headless Chrome**: Console Playwright browser E2E tested registration, onboarding wizard, facilities availability, Test-vs-Live playground isolation, and Billing plan UI in Chrome; the password reset and email verification token flows were exercised over HTTP + SMTP in `phase8-security-and-billing.test.ts` rather than clicking emailed links inside Playwright.

---

## 10. Remaining Security Risks for General Availability

1. **CSRF Relying on `Origin` / `Host` Headers Without Per-Session Anti-CSRF Token**: `verifyConsoleCsrfOrigin` rejects cross-origin `Origin` headers on mutating requests and session cookies use `SameSite=Lax` + `HttpOnly`, yet state-changing routes with missing `Origin` behind permissive proxies or future CORS changes should pair `Origin` validation with synchronized double-submit or server-bound CSRF tokens for defense-in-depth before GA.
2. **Console Auth & Password Reset Endpoint Brute-Force Limiting**: Global API `/v1` endpoints enforce `PostgresDistributedLimiter` + WAF IP limits, whereas Developer Console `/api/console/auth` (`login`, `request_password_reset`, `register`) relies primarily on edge WAF (`aws_wafv2_web_acl`) rather than dedicated per-account / per-IP Postgres lockout counters inside Next.js routes.
3. **Automated Scheduled KMS Key Re-Encryption Trigger**: Versioned keyring rotation (`OLB_WEBHOOK_KEYRING_JSON`, `reEncryptWebhookSecrets()`) is implemented and tested, but no automated cron/operator job is scheduled yet to trigger periodic re-encryption across all organizations when AWS KMS rotates customer master keys annually.
4. **Hard-Cap Plan Quota Hook in Runtime API**: `BillingService.evaluateOrganizationQuota()` accurately computes overage status and `hard_cap` flags for the control plane and Console UI, while the hot-path `/v1` API booking path currently remains decoupled (`RuntimeTrafficLimiter` + `PostgresDistributedLimiter` enforce per-tenant concurrency/rate limits rather than querying commercial plan subscription status synchronously on every booking).

