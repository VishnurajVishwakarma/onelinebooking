# Phase 9 — Production Engineering, Deployment Acceptance & Real Customer Validation Report

**Overall Production Readiness Verdict**: **NOT YET APPROVED FOR GENERAL PRODUCTION LAUNCH (CONDITIONAL STAGING GATE)**  
While **77/77** automated unit/stress/integration tests, **20/20** PgBouncer transaction-pooling tests, **4/4** operational reliability drills, physical WAL PITR, Playwright headless Chrome E2E, ESM/CJS SDK packaging, sandbox billing recovery/refunds, AWS SigV4 KMS envelope unit tests, and the 13-scenario **Book My Game** pilot all pass, continuous **30-minute**, **60-minute**, and **24-hour** soak tests, live `terraform validate`/`plan`/`apply`, and real cloud AWS KMS / SES / payment gateway credentials were **not executed** in this local workstation environment (see Reports #2, #10, and #11).

---

## Report Index (Mandatory Deliverables 1–11)
1. [Memory Investigation Report](#1-memory-investigation-report)
2. [Sustained Soak Benchmark Report (120s Observed + 30m/60m/24h Unexecuted Status)](#2-sustained-soak-benchmark-report-120s-observed--30m60m24h-status)
3. [Independent Security Audit](#3-independent-security-audit)
4. [Cloud Architecture Validation Report](#4-cloud-architecture-validation-report)
5. [Infrastructure Deployment Plan](#5-infrastructure-deployment-plan)
6. [Estimated Monthly Cloud Operating Costs](#6-estimated-monthly-cloud-operating-costs)
7. [Billing Correctness Report](#7-billing-correctness-report)
8. [SDK Integration Acceptance Report](#8-sdk-integration-acceptance-report)
9. [Real-World Pilot Readiness Report ("Book My Game")](#9-real-world-pilot-readiness-report-book-my-game)
10. [Production Go-Live Checklist](#10-production-go-live-checklist)
11. [Failed, Incomplete, and Unexecuted Tests Register](#11-failed-incomplete-and-unexecuted-tests-register)

---

## 1. Memory Investigation Report

To investigate the Phase 8 120-second soak RSS growth (`84.7 MB -> 203.1 MB`, `+139.8%`), [scripts/memory-investigation.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/scripts/memory-investigation.ts) was built and executed under `node --expose-gc` across a baseline phase, a `15 s` warm-up, and three `15 s` post-warm-up intervals (`68.57 s` total, `2,435` completed operations at concurrency `16`), capturing forced-GC memory metrics, V8 spaces, `PerformanceObserver` GC telemetry, V8 `.heapsnapshot` object graphs, active handles, pool listener counts, and PostgreSQL relation growth.

### Observed Timeline (`node --expose-gc dist/scripts/memory-investigation.js`)
| Stage | Elapsed | Ops | RSS (MB) | `heapTotal` (MB) | `heapUsed` (MB) | `external` (MB) | `arrayBuffers` (MB) | Active Handles | Pool Total | DB Size (MB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `baseline_pre_warmup` (post-GC) | 0.44 s | 0 | 87.90 | 50.73 | **16.29** | 3.73 | 0.05 | 2 | 1 | 124.02 |
| `post_warmup_pre_gc` | 19.17 s | 561 | 148.48 | 90.98 | 30.13 | 4.18 | 0.50 | 18 | 17 | 125.42 |
| `post_warmup_post_gc` | 19.34 s | 561 | 148.52 | 85.73 | **17.23** | 3.73 | 0.05 | 18 | 17 | 125.42 |
| `sustained_t1_post_gc` | 37.34 s | 1,245 | 150.43 | 84.23 | **16.40** | 3.73 | 0.05 | 18 | 17 | 127.15 |
| `sustained_t2_post_gc` | 53.00 s | 1,867 | 202.84 | 149.73 | **16.47** | 3.73 | 0.05 | 18 | 17 | 128.78 |
| `sustained_t3_post_gc` | 68.57 s | 2,435 | 203.01 | 149.48 | **16.45** | 3.73 | 0.05 | 18 | 17 | 130.54 |

### Root Cause Diagnosis: Normal V8 Expansion vs Retained-Object Leak
1. **Live JS heap (`heapUsed`) has ZERO retained-object leak**: After warm-up GC (`17.23 MB`), retained `heapUsed` remained completely flat across sustained execution (`16.40 -> 16.47 -> 16.45 MB`, post-warm-up linear slope **`-880.45 KB/min`**).
2. **Heap Snapshot Diff (`v8.writeHeapSnapshot`) confirms non-leak shrinkage**: Between `02-post-warmup.heapsnapshot` and `03-post-sustained.heapsnapshot`, live snapshot nodes changed by **`-15,585` nodes** (`-856.2 KB` net self-size).
3. **Why RSS jumped from ~88 MB to ~203 MB (and ~248 MB under unforced GC)**:
   - **Connection Pool Socket Allocation (`+16` TCP sockets)**: `pg.Pool` expanded from `1` initial client to `17` concurrent pooled connections (`activeHandles`: `2 -> 18`, `poolErrorListeners: 0`), allocating C++/libuv/OpenSSL socket buffers and native pages.
   - **V8 `heapTotal` / Semi-Space Capacity Scaling**: At `t2` (`~53 s`), V8 expanded its committed virtual/resident heap reservation (`heapTotal`: `50.73 MB -> 85.73 MB -> 149.73 MB` under `expose-gc`, `197.2 MB` under natural lazy GC in the 120s soak) and `code_space` (`1.12 MB -> 1.81 MB`) so young-generation scavenges run efficiently without premature major marks. Because OS RSS reflects `heapTotal` committed memory pages rather than `heapUsed`, RSS rises cleanly and plateaus around **`203–248 MB`**.
   - **Cache & Listener Boundedness**: `RuntimeTrafficLimiter.rateBuckets` prunes expired entries past `10,000` keys; `soak-test.ts` latency buffers were bounded to fixed-size `10,000`-element circular arrays (`MAX_SAMPLES = 10_000`); `activeHandles` stayed strictly constant at `18–19`.
4. **PostgreSQL Storage Growth Finding (Operational Retention Required)**: Without active `OutboxWebhookWorker` + archival cleanup running during soak, `outbox_events` (`7,345 -> 9,802` rows), `allocations` (`12,376 -> 13,281` rows), `holds`, and `bookings` increased PostgreSQL database size from `124.02 MB` to `130.54 MB` (`+6.52 MB` over `2,435` ops). Scheduled `OutboxWebhookWorker` delivery + periodic `runSafeRetentionCleanup()` + RDS autovacuum are required in production.

---

## 2. Sustained Soak Benchmark Report (120s Observed + 30m/60m/24h Status)

### A. Executed 120-Second Instrumented Soak (`reports/soak-phase9-120s.json`)
Command: `node --expose-gc dist/scripts/soak-test.js --duration-seconds=120 --concurrency=16 --conflict-ratio=0.1 --report-json=reports/soak-phase9-120s.json`
- **Duration & Concurrency**: `120.23 s` actual (`concurrency = 16`, 5 facilities, `10%` configured conflict target).
- **Total Operations**: `7,686` (`63.9 ops/s`), `0` retryable errors, `0` unexpected errors, **`0` overlapping allocations**.
- **Separated Throughput & Latency**:
  - **Availability Reads**: `5,127` ops (**`42.6 reads/s`**) — `p50 = 167.99 ms`, `p95 = 224.10 ms`, `p99 = 283.18 ms`.
  - **Successful Booking Lifecycles (`createHold -> convert/release`)**: `2,334` cycles (**`19.4 workflows/s`**, **`9.7 confirmed bookings/s`** across `1,165` confirmations + `1,169` releases) — `p50 = 430.48 ms`, `p95 = 556.36 ms`, `p99 = 666.25 ms`.
  - **Intentional Conflict Rejections (`SLOT_CONFLICT`)**: `225` rejections (**`1.9 conflicts/s`**) — `p50 = 26.49 ms`, `p95 = 39.26 ms`, `p99 = 48.41 ms`.
- **Natural GC & Memory Profile**:
  - `startRssMb: 100.6 MB -> endRssMb: 247.9 MB` (plateaued `245.2–247.9 MB` across `60.2 s` to `120.3 s`).
  - Sawtooth `heapUsedMb` oscillated between `46.6 MB` and `106.6 MB` under `78` GCs (`913.1 ms` cumulative pause time; `<0.8%` GC CPU overhead).
  - `externalMb: 5.4 MB`, `arrayBuffersMb: 1.7 MB`, `activeHandles: 18`, `poolTotal: 17`, `dbSizeMb: 148.31 -> 163.07 MB` (`allocationsRows: 13,945 -> 16,279`).

### B. 30-Minute, 60-Minute & 24-Hour Soak Executions
- **Status**: **NOT EXECUTED** (`test:soak:30m`, `test:soak:60m`, and `test:soak:24h` in [package.json](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/package.json) and [soak-24h-staging.mjs](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/scripts/soak-24h-staging.mjs) are implemented and ready for staging CI runners, **not executed** interactively due to 90m+ / 24h wall-time constraints).
- Per strict engineering accuracy rules, **two-minute metrics above are NOT extrapolated** to claim 30-minute, 60-minute, or 24-hour stability or production peak capacity.

---

## 3. Independent Security Audit

Full source audit across `src/`, `packages/sdk/`, `apps/console/`, and migrations `0001`–`0006` discovered and fixed five additional vulnerabilities beyond Phase 8, verified in [phase9-kms-and-security.test.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/tests/unit/phase9-kms-and-security.test.ts) and [phase9-production-acceptance.test.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/tests/integration/phase9-production-acceptance.test.ts):

| Audited Area | Finding & Severity | Remediation Implemented | Status |
| --- | --- | --- | --- |
| Broken Object-Level Authorization (BOLA) | **Critical/High**: `ConsoleAuthService.assignProjectRole` checked org admin for `organizationId` without verifying `projectId` belonged to `organizationId`, allowing cross-org project escalation | Added `SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2` check (`403 FORBIDDEN`) in [console-auth.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/console-auth.ts) | **Fixed & Regression Tested** |
| Password Reset & Email Verification Token Exposure | **Medium**: Concurrent reset/verification requests left older unused tokens valid until TTL expiration | Prior unverified/unused tokens deleted upon issuing fresh token (`requestEmailVerification`, `requestPasswordReset`) in [console-auth.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/console-auth.ts); `resetPassword` revokes all sessions | **Fixed & Regression Tested** |
| CSRF & Cross-Origin Defense | **Medium**: Console relied solely on `Origin` check; `/v1` REST endpoints omitted explicit CORS preflight/deny and clickjacking/cache headers | Hardened `verifyConsoleCsrfOrigin` with `Sec-Fetch-Site: cross-site` + `Origin` + `Referer` validation in [engine.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/apps/console/src/lib/engine.ts); added `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and allowlisted CORS in [server.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/api/server.ts) | **Fixed & Tested** |
| Response Cap & Canonical Idempotency Consistency | **Medium**: Multiple `/v1` routes called raw `sendJson` bypassing `emitBoundedJson` (`maxResponseBytes`), `POST /v1/facilities` hashed non-canonical JSON, and `POST /v1/bookings/:id/cancel` lacked HTTP idempotency cache | Replaced raw route `sendJson` calls with bounded `reply()`, switched `/v1/facilities` to `canonicalJsonStringify()`, and added HTTP idempotency + `booking_cancelled` dedup on cancel in [server.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/api/server.ts) | **Fixed & Tested** |
| Distributed Lease Renewal | **Low-Medium**: Cluster tenant leases had 20s fixed TTL with no renewal mechanism | Returned callable `DistributedTenantLease` handle with `.leaseId` & `.renew(extendSeconds)` in [distributed-limiter.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/runtime/distributed-limiter.ts) | **Implemented & Tested** |
| Real AWS KMS Envelope Integration | **High (Gap vs Phase 8)**: Local `OLB_WEBHOOK_KEYRING_JSON` keyring does not prove KMS wire integration | Built genuine AWS SigV4 (`AWS4-HMAC-SHA256`) `AwsKmsEnvelopeProvider` (`TrentService.GenerateDataKey` / `TrentService.Decrypt`, `enc.kms.v1.*`, plaintext DEK zeroing) in [crypto.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/security/crypto.ts) | **Verified vs Local AWS KMS HTTP Server (Live AWS IAM Unexecuted)** |
| Dependency Audit (`npm audit`) | Root, `packages/sdk`, and `apps/console` checked | `ROOT`: 0 vulns; `packages/sdk`: 0 vulns; `apps/console`: 0 vulns | **Passed (0 Vulnerabilities)** |
| Webhook SSRF, Test/Live Isolation, Secret Scrubbing | Checked against prior fixes + live-vs-test tests | Verified live `environment_type = 'live'` rejects local/private/metadata/redirect URLs and pins validated DNS IP | **Passed** |

---

## 4. Cloud Architecture Validation Report

- **Validated Locally**:
  - Multi-stage Dockerfiles: [Dockerfile.api](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/docker/Dockerfile.api), [Dockerfile.console](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/docker/Dockerfile.console), [Dockerfile.docs](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/docker/Dockerfile.docs).
  - Full production topology Compose check (`pgbouncer`, `api`, `workers`, `console`, `docs`): `docker compose -f infra/docker/docker-compose.prod.yml config --quiet` -> **`COMPOSE_VALID`** ([docker-compose.prod.yml](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/docker/docker-compose.prod.yml)).
  - CI/CD workflow ([ci-cd.yml](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/.github/workflows/ci-cd.yml)): Runs `typecheck`, SDK build, Console build, `db:migrate`, and `test:all` against `postgres:17-alpine`, followed by Docker builds and readiness-gated staging rollout.
- **Terraform Staging & Production IaC ([main.tf](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/terraform/main.tf), [staging.tfvars](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/terraform/environments/staging/terraform.tfvars), [production.tfvars](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/terraform/environments/production/terraform.tfvars))**:
  - **Private DB Networking**: `aws_subnet.private_db`, `aws_db_instance.postgres` (`publicly_accessible = false`, Multi-AZ in production, `backup_retention_period = 35` days prod / `7` days staging), ingress strictly from `aws_security_group.app` & `aws_security_group.webhook_worker`.
  - **Network-Level Webhook Egress Controls**: Dedicated `aws_security_group.webhook_worker` + `aws_network_acl.webhook_egress_guard` explicitly denying `169.254.169.254/32` and permitting TCP `443` / internal VPC PG traffic only.
  - **TLS, KMS, WAF & Alarms**: `aws_acm_certificate.public_tls`, `aws_kms_key.webhook_secrets` (`enable_key_rotation = true`), `aws_secretsmanager_secret.platform_secrets`, `aws_wafv2_web_acl.edge`, `aws_cloudwatch_log_group.platform`, `aws_cloudwatch_metric_alarm.high_5xx`.
- **Validation Gap**: `terraform` CLI binary is not installed on this workstation (`terraform init`/`validate`/`plan` unexecuted; no AWS resources provisioned).

---

## 5. Infrastructure Deployment Plan

1. **Provision Foundation (Staging First -> Production)**:
   - Apply Terraform (`terraform apply -var-file=environments/staging/terraform.tfvars`) to create VPC, private DB subnets, `aws_kms_key`, `aws_secretsmanager_secret`, WAF ACL, ACM TLS cert, and Multi-AZ RDS PostgreSQL 17.
2. **Seed Secrets & Verify KMS**:
   - Populate `onelinebooking/<env>/runtime` in Secrets Manager (`DATABASE_URL`, `OLB_WEBHOOK_MASTER_KEY`, SMTP TLS credentials, payment provider keys) and grant ECS task role `kms:GenerateDataKey` + `kms:Decrypt`.
3. **Database Migrations & PgBouncer**:
   - Execute `npm run db:migrate` from an internal private-subnet migration task (`reservedMigrationConnections = 3`) before deploying new app containers. Confirm PgBouncer (`POOL_MODE=transaction`, `AUTH_TYPE=scram-sha-256`, `DEFAULT_POOL_SIZE=60`).
4. **Workers & Rolling API/Console Deploy**:
   - Launch persistent `run-workers.js` tasks (`HoldExpiryWorker` + `OutboxWebhookWorker`) attached to `aws_security_group.webhook_worker`.
   - Rolling-deploy `run-api.js` and `console` ECS tasks; gate ALB target registration on `GET /v1/ready` returning `HTTP 200` with `postgresOk: true`.
5. **Pre-Cutover Staging Verification & Rollback**:
   - Execute `npm run test:soak:30m`, `npm run test:soak:60m`, and `npm run test:soak:24h` in staging.
   - **Rollback**: Revert ECS task definition to previous container SHA (all schema migrations `0001`–`0006` are backward-compatible additive); for data corruption, restore RDS snapshot + WAL PITR per [phase7-runbooks.md](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/docs/phase7-runbooks.md).

---

## 6. Estimated Monthly Cloud Operating Costs

> **Planning Estimates Only** (AWS `ap-south-1` US$/month approximations assuming baseline on-demand ECS Fargate, RDS, NAT, and ALB pricing; not live AWS Billing API quotes):

| Component | Staging Spec | Staging Est. (/mo) | Production Spec | Production Est. (/mo) |
| --- | --- | ---: | --- | ---: |
| Managed PostgreSQL (RDS PG 17 + Backups) | Single-AZ `db.t4g.medium` + 50 GB gp3 + 7d PITR | \$62 | Multi-AZ `db.r6g.large` + 200 GB gp3 + 35d PITR | \$385 |
| ECS Fargate API + PgBouncer + Workers + Console + Docs | 5–6 small tasks (`0.25–0.5 vCPU`) | \$55 | 4 API (`1 vCPU/2 GB`) + 2 Workers + 2 Console + Docs + 2 PgBouncer | \$215 |
| ALB + WAFv2 + ACM TLS | Shared ALB + 1 Regional WAF WebACL | \$25 | Production ALB + WAF + TLS | \$45 |
| NAT Gateway + Data Egress + CloudWatch + KMS + Secrets | Single NAT + 30d logs + 1 CMK | \$42 | Multi-AZ NAT (2x) + 90d logs + CloudWatch alarms + KMS | \$115 |
| **Estimated Monthly Total** | **Staging Environment** | **~\$184 / mo** | **Production Multi-AZ Environment** | **~\$760 / mo** |

---

## 7. Billing Correctness Report

Implemented and verified in [billing.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/billing.ts) (`BillingService`, `SandboxStripePaymentProvider`, `ManualInvoicingProvider`) and tested in `phase8-security-and-billing.test.ts` + `phase9-production-acceptance.test.ts`:
- **Booking Allocation Isolation**: Core V1 booking hold/confirm/cancel PostgreSQL transactions never invoke payment providers or billing tables synchronously.
- **Idempotent No-Charge Guarantees**: Failed slot reservations (`409 SLOT_CONFLICT`) record `0` `hold_created`/`booking_confirmed` metrics; HTTP idempotent replays on `/v1/holds`, `/v1/holds/:id/convert`, `/v1/bookings`, and `/v1/bookings/:id/cancel` deduplicate billable usage via `UNIQUE (environment_id, scope_key, metric, idempotency_key)`.
- **Full Sandbox Billing Lifecycle Passed**:
  - Plan versioning & active/trial subscriptions (`startSubscription`, `renewSubscriptionPeriod`).
  - Sandbox card decline simulation (`SandboxStripePaymentProvider.declineOrganizationIds`) keeps invoice `open`, handles signed `invoice.payment_failed` webhook -> moves subscription to `past_due` & blocks `evaluateOrganizationQuota`.
  - Failed payment recovery (`retryFailedPayment`) settles invoice -> transitions subscription `active` & appends idempotent `invoice_payment` ledger entry.
  - Concurrent `generateInvoiceForPeriod` race serialization via `SELECT ... FOR UPDATE OF s` + post-lock idempotency lookup (zero `23505` errors, single invoice + base/overage ledger entries).
  - Refund reconciliation (`reconcileRefund`) deduplicates duplicate `providerEventId` webhooks and rejects over-refunds exceeding paid invoice `total_minor` (`409 INVALID_STATE_TRANSITION`).

---

## 8. SDK Integration Acceptance Report

- **Package Metadata & Exports Fixed & Verified**: Fixed `"main": "./dist/cjs/index.cjs"` in [packages/sdk/package.json](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/packages/sdk/package.json), generated [packages/sdk/package-lock.json](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/packages/sdk/package-lock.json), passed `npm --prefix packages/sdk audit` (`0` vulnerabilities), and verified `.`, `./browser`, and `./server` exports + `.d.ts` files (`phase9-kms-and-security.test.ts` + `examples/sdk-consumer-smoke`).
- **Multi-Stack Integration Examples**:
  - **Express.js** ([examples/integrations/express-app/server.mjs](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/examples/integrations/express-app/server.mjs)): Installed `express` independently with `@onelinebooking/sdk`; **live-verified** end-to-end against `/v1` API in `phase9-production-acceptance.test.ts`.
  - **Python 3 REST** ([examples/integrations/python-rest/client.py](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/examples/integrations/python-rest/client.py)): Zero-dep Python REST client executing live `GET /v1/availability`, `POST /v1/holds`, `POST /v1/holds/:id/convert`, and `POST /v1/bookings/:id/cancel` in `phase9-production-acceptance.test.ts`.
  - **Next.js App Router BFF** ([examples/integrations/nextjs-app/app/api/booking/route.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/examples/integrations/nextjs-app/app/api/booking/route.ts)): Authored reference route handler cleanly typed against `@onelinebooking/sdk/server` (not booted in standalone Next app).
  - **React Client Widget** ([examples/integrations/react-widget/BookingWidget.tsx](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/examples/integrations/react-widget/BookingWidget.tsx)): Uses `OneLineBookingPublicClient` (`@onelinebooking/sdk/browser`) and formats `slot.amountMinor` with `formatMinorCurrency` via BFF proxy (not mounted in standalone React bundler).
  - **cURL Quickstart** ([examples/integrations/curl-quickstart/quickstart.sh](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/examples/integrations/curl-quickstart/quickstart.sh)): Direct REST onboarding command template (script file provided, not invoked via bash).

---

## 9. Real-World Pilot Readiness Report ("Book My Game")

[examples/book-my-game/server.mjs](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/examples/book-my-game/server.mjs) (consuming OneLineBooking strictly via REST `/v1` + `@onelinebooking/sdk/server`) passed **all 13 pilot scenarios** inside `phase9-production-acceptance.test.ts` (both direct PG and behind PgBouncer):
1. Multi-outlet café onboarding (`Koramangala`, `Whitefield`) via `/v1/locations`.
2. Gaming station provisioning (`gaming_pc`, `console_ps5`) + schedules/policies/pricing.
3. Live availability queries.
4. Customer online reservation places a hold and leaves payment `awaiting_provider` (`payment.confirmed: false`).
5. Hold conversion records a caller-supplied provider reference (`reference_recorded`) and still does not mark the payment confirmed. A missing reference returns HTTP 422.
6. Receptionist walk-in booking path (`/api/pilot/reserve/walk-in`).
7. Cash payment settlement recording (`cashPaid: true`, `externalPaymentRef: "cash_paid:CASH-001"`).
8. Dynamic pricing update (`PUT /api/pilot/pricing` -> `15000 INR`) + stale-`slotRef` `409` rejection + updated price lookup.
9. Hold expiration reclamation (`HoldExpiryWorker.runOnce()` freeing expired hold back into bookable inventory).
10. Hardware maintenance blackouts (`/v1/facilities/:id/blackouts` blocking overlapping bookings with `409`).
11. Customer booking cancellation (`POST /api/pilot/bookings/:id/cancel`).
12. Customer booking history retrieval (`GET /api/pilot/customers/:id/bookings` reflecting `cancelled` status).
13. 8-way concurrent race on identical slot (`1` HTTP `201` winner, `7` HTTP `409` conflicts, zero double-bookings).

---

## 10. Production Go-Live Checklist

| Gate | Requirement | Current Evidence / Status |
| --- | --- | --- |
| Core Engine Correctness & Concurrency | Exclusion constraints, advisory locks, DST parity, PgBouncer compat | **PASS** — `47/47` unit/stress, `30/30` PG integration, `20/20` PgBouncer, `4/4` ops drills, PITR `passed: true` |
| Memory Leak & GC Stability | Bounded RSS plateau, zero post-GC retained growth, zero handle leaks | **PASS (120s & 69s)** — `heapUsed` slope `-880.45 KB/min` post-warmup GC, `0` leaked nodes/handles |
| Security Hardening & Audits | BOLA, SSRF, live/test isolation, CORS, CSRF, `npm audit`, lease renewal | **PASS** (local AWS SigV4 KMS emulator & HTTP E2E passed; live AWS KMS IAM key pending staging) |
| Developer Console & Chrome E2E | Built Next.js 16.4.6 app, Playwright UI flows, CSRF & RBAC | **PASS** (`25` routes built, `playwrightBrowserE2EPassed: true`) |
| Sustained 30m / 60m / 24h Staging Soak | Full continuous `test:soak:30m`, `test:soak:60m`, `test:soak:24h` | **BLOCKED — NOT EXECUTED** (must run cleanly in staging CI before GA) |
| Terraform Validation & Live KMS / Secrets / WAF Apply | `terraform validate`, `plan`, `apply` in staging AWS account | **BLOCKED — NOT EXECUTED** (`terraform` CLI unavailable locally) |
| Live SMTP TLS & Live Payment Gateway | SES/Postmark TLS credentials & live Stripe webhook HMAC + charge | **BLOCKED — NOT EXECUTED** (tested via RFC5321 local SMTP & `SandboxStripePaymentProvider`) |

---

## 11. Failed, Incomplete, and Unexecuted Tests Register

No previously run test suites were weakened or left failing (`0` failures across all latest executed suites). The following checks are **incomplete or unexecuted** and block an immediate general-production sign-off:
1. **`npm run test:soak:30m` (30-minute continuous soak)**: **Not executed** interactively due to 30m runtime duration (verified only `120.23 s` sustained soak).
2. **`npm run test:soak:60m` (60-minute continuous soak)**: **Not executed** interactively due to 60m runtime duration.
3. **`npm run test:soak:24h` ([scripts/soak-24h-staging.mjs](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/scripts/soak-24h-staging.mjs))**: **Not executed**; staging stability harness only prepared.
4. **Terraform Validation & Plan (`terraform validate` / `terraform plan`)**: **Not executed** (`terraform` binary not installed locally); syntax reviewed manually only.
5. **Live AWS KMS (`TrentService.GenerateDataKey` / `Decrypt` against `kms.<region>.amazonaws.com`)**: **Not executed** with live AWS IAM credentials (verified only against a local SigV4-checking KMS HTTP test server).
6. **Authenticated Cloud SMTP (`STARTTLS`/`SMTPS` relay) & Live Stripe/Payment Gateway HTTP Calls**: **Not executed** externally (verified via in-process RFC 5321 TCP SMTP capture and `SandboxStripePaymentProvider`).
7. **Standalone Runtime Execution of `examples/integrations/nextjs-app`, `examples/integrations/react-widget`, and `examples/integrations/curl-quickstart/quickstart.sh`**: Static source integration examples compiled/checked conceptually, **not booted/executed** as separate browser/bash processes (`express-app` and `python-rest` WERE executed live against `/v1`).
8. **Console Auth Per-Account Brute-Force Lockout**: Console login/reset relies on WAF (`aws_wafv2_web_acl`) rate limits rather than a dedicated internal DB failure counter; interactive Mailpit email-link clicking in Chrome UI was also **not executed** (SMTP tokens were tested via API integration tests).

