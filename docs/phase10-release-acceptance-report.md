# Phase 10 — Release Acceptance Report (`v1.0.0-rc.1`)

**FINAL RELEASE VERDICT: `APPROVED FOR STAGING`**

OneLineBooking (`v1.0.0-rc.1`) is **approved for staging deployment** and **not yet approved** for controlled private beta or general production launch. Every executable local automated suite, PgBouncer transaction-pooling suite, operational reliability drill, physical PostgreSQL fault/PITR check, Playwright browser UI flow, multi-container Docker runtime verification, Terraform syntax/schema validation, security regression test, and all five independent SDK/API consumer examples executed and passed cleanly against `HEAD` + release-candidate changes. General production / private beta remain gated behind **unexecuted** 30-minute, 60-minute, and 24-hour continuous soak benchmarks, real AWS account provisioning (`terraform plan`/`apply` + live KMS IAM roles), authenticated external TLS SMTP relays, live payment provider test-mode charges/webhooks, and staging pilot validation.

---

## 1. Release Freeze Inventory

### Source & Runtime Provenance
- **Git `HEAD` Commit**: `5b236b9b43680e8eac4bce122212b3b8d07d0718` (`feat: add CI/CD workflow and Next.js build output for console app`)
- **Working Tree State**: Contains uncommitted Phase 5–10 engineering and release-candidate changes (`313` status entries including build/test artifacts; `.git/COMMIT_EDITMSG` preserved untouched, no automated `git commit` performed)
- **Local Toolchain**: Node.js `v24.16.0` (engines `>=22` root, `>=20` SDK), npm `11.13.0`, Docker images based on `node:22-alpine`, Terraform `hashicorp/terraform:1.9` (`hashicorp/aws v5.100.0`)

### Package & Artifact Dependency Versions
| Artifact / Package | Version | Key Dependencies | Artifact / Lockfile |
| --- | --- | --- | --- |
| Root Engine & Platform (`mygamingslot-booking-engine`) | `1.0.0` | `@aws-sdk/client-kms@^3.1178.0`, `dotenv@^18.0.10`, `luxon@^3.7.2`, `pg@^8.16.3`, `zod@^4.1.12`, `typescript@^5.9.3` | [package.json](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/package.json) |
| Client & Server SDK (`@onelinebooking/sdk`) | `1.0.0` | Zero runtime prod npm deps in distribution (standard Web `fetch` + `crypto`); dual ESM/CJS/DTS exports | [packages/sdk/package.json](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/packages/sdk/package.json) |
| SDK Publication Tarball (`onelinebooking-sdk-1.0.0.tgz`) | `1.0.0` | `2CD05D27F88F5999A8615A42B27A78DE90A9BC6240CF679E701A7997DEA0186A` (SHA-256, packed locally without publishing to npm) | [onelinebooking-sdk-1.0.0.tgz](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/reports/onelinebooking-sdk-1.0.0.tgz) |
| Developer Console (`onelinebooking-console`) | `1.0.0` | `next@^16.0.0`, `pg@^8.16.0`, `react@^19.0.0`, `react-dom@^19.0.0`, `typescript@^5.8.0` | [apps/console/package.json](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/apps/console/package.json) |

### PostgreSQL Migration SHA-256 Checksums
Measured directly via `Get-FileHash -Algorithm SHA256 src/infrastructure/postgres/migrations/*.sql`:

| Migration File | SHA-256 Checksum |
| --- | --- |
| [0001_initial.sql](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/migrations/0001_initial.sql) | `EF04D17816107E27990DF28704F97D763CAEFECCC55ABA46830818FA77958F65` |
| [0002_v1_schema.sql](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/migrations/0002_v1_schema.sql) | `D004219ADC01BFEDB951C5F166352E6E19F9BE9C120E7B3D602C21864E25CF48` |
| [0003_v1_performance_indexes.sql](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/migrations/0003_v1_performance_indexes.sql) | `A13354F949DE54F2D939ADF1E02956E0C09152B831B5AB980E7A5279ED71D28D` |
| [0004_platform_schema.sql](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/migrations/0004_platform_schema.sql) | `7C297EB6E1E531260F351DB50FA3D8BFEDD89B430D8235D2B3C6894FF9F0E6DE` |
| [0005_phase7_security_and_ops.sql](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/migrations/0005_phase7_security_and_ops.sql) | `71C61B30AACC02750ED7392844A98BEC5A6FF22DFA321FEB4FE3151A502579BF` |
| [0006_phase8_auth_and_billing.sql](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/migrations/0006_phase8_auth_and_billing.sql) | `60E1326D2FDCD1D21E7459A6A253A0B7F0C7E95DDBF7B38B94885A1CF7267BBC` |

### Regression Test Diff & Determinism Audit
1. **`git diff -- tests/` review**: Only two pre-existing test files were modified prior to Phase 10 additions:
   - [phase6-platform.test.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/tests/integration/phase6-platform.test.ts): Switched local `http://127.0.0.1` webhook endpoint registration from `liveEnvironment` to `testEnvironment` after live-mode SSRF egress lockdown banned loopback hosts, and updated expected `dlq.length` from `1` to `2` to assert replay of both `booking.created` and `booking.confirmed` deliveries. Zero weakened assertions.
   - [phase7-acceptance.test.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/tests/integration/phase7-acceptance.test.ts): Expanded cipher-prefix regex from `enc.v1.` to `/^enc\.v[12]\./` to cover `enc.v2.` envelope ciphertext.
2. **Event-sequence bug caught by PgBouncer integration testing**: In [postgres-booking-store.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/postgres-booking-store.ts), `convertHoldToBooking` previously inserted `bookings.sequence = 1` despite emitting both `booking.created` (`seq 1`) and `booking.confirmed` (`seq 2`), causing a subsequent `cancelBooking` outbox insert to collide at `aggregate_sequence = 2` (`23505`). Fixed to `sequence = 2` and re-verified across both direct Postgres and PgBouncer suites.
3. **Observed connection-pool & suite-isolation sensitivity (remediated, documented transparently)**:
   - Under `node --test --test-concurrency=2`, when `mygamingslot-pgbouncer-1` held ~45 idle server connections against PostgreSQL `max_connections = 100`, [production-reliability.test.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/tests/integration/production-reliability.test.ts) (`max: 20` main pool + `3 x max: 10` multi-API pools = `50` sockets running concurrently alongside another test file) overflowed PostgreSQL's `100`-connection limit (`53300: too many clients already` mapped to `TEMPORARY_UNAVAILABLE`), failing `"serializes multiple independent API instances against the same PostgreSQL database"` (`4 !== 29` `SLOT_CONFLICT` assertions). Restarting PgBouncer prior to direct-PG tests yielded `32/32` passing results.
   - Because `"recovers from real PostgreSQL deadlock (40P01) retries and from database backend connection loss"` executes direct backend PID termination (`SELECT pg_backend_pid()` + `SELECT pg_terminate_backend($1)`), `production-reliability.test.js` executes against direct PostgreSQL only (`9/9` pass) and is excluded from the PgBouncer transaction-pooling run (`8` suites / `23` tests pass).

---

## 2. Executed Verification & Test Results

All checks below ran after all code and image changes completed and exited with status `0`:

| Check / Command | Scope | Outcome | Details |
| --- | --- | --- | --- |
| `npm run typecheck` | Full workspace TypeScript check | **PASSED (`0` errors)** | Clean compilation under `tsconfig.json` |
| `npm run test:all` (Unit + Stress) | All unit, DST oracle, SSRF, SigV4 KMS, SDK boundary suites | **PASSED (`47/47`, `6` suites)** | `5,535.56 ms`, `0` failed, `0` skipped |
| `npm run test:all` (Direct PG Integration) | Core engine, Phase 5C, 6, 7, 7B Console, 8, 9, 10, Production Reliability | **PASSED (`32/32`, `9` suites)** | `21,887.88 ms`, `0` failed, `0` skipped |
| PgBouncer (`127.0.0.1:6432`) Integration | All 8 PgBouncer-compatible integration suites (`production-reliability.test.js` excluded per raw PID termination) | **PASSED (`23/23`, `8` suites)** | `19,823.35 ms`, `0` failed, `0` skipped |
| `npm run verify:reliability-ops` | Physical SIGKILL recovery, PG restart recovery, populated schema upgrade (`0002`–`0006`), WAL PITR backup/restore | **PASSED (`4/4` drills)** | `sigkillMidTx`, `postgresRestartRecovery`, `populatedMigrationUpgrade`, `backupAndRestore` all `passed: true` |
| `node scripts/phase10-container-verify.mjs` | Live multi-container stack (`olb-docs:rc1`, `olb-api:rc1`, `olb-workers`, `olb-console:rc1` via PgBouncer `:6432`) | **PASSED** | `containerVerificationPassed: true`, `pgBouncerPooledRuntime: true`, `restrictedMetricsVerified: true`; `SIGTERM` exits: docs `0` (`431 ms`), api `0` (`719 ms`), workers `0` (`172 ms`), console `143` (`1,012 ms`) |
| `node examples/playwright-e2e/run-e2e.mjs` | Real Google Chrome Headless browser E2E against Next.js Developer Console | **PASSED (`5/5` flows)** | `register_ui_and_cookie_auth`, `onboarding_wizard_ui`, `facilities_and_availability_calendar`, `playground_test_vs_live_block`, `billing_plan_creation_ui` |
| `node examples/sdk-consumer-smoke/verify.mjs` & `.cjs` | Independent ESM & CommonJS consumer smoke tests of packed SDK | **PASSED (`2/2`)** | Verified dual ESM `import` and CJS `require` boundaries |
| Terraform `fmt -check` & `validate` | [infra/terraform/main.tf](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/terraform/main.tf) via `hashicorp/terraform:1.9` | **PASSED** | Formatted cleanly; `terraform init -backend=false` (`aws v5.100.0`); `Success! The configuration is valid.` |
| `npm audit --json` (Root, SDK, Console) | Root (`46` deps), `@onelinebooking/sdk` (`1` prod dep), Console (`75` deps) | **PASSED (`0` vulnerabilities)** | `info: 0, low: 0, moderate: 0, high: 0, critical: 0` across all 3 packages |

---

## 3. Performance & Long-Duration Soak Status

### Executed Short-Duration Memory & Sustained Baseline (Phase 9 Raw Artifact Preserved)
Complete telemetry is recorded in [reports/soak-phase9-120s.json](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/reports/soak-phase9-120s.json) and analyzed in [phase9-production-acceptance-report.md](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/docs/phase9-production-acceptance-report.md):
- **120-Second Soak (`concurrency = 16`, `conflict-ratio = 0.1`, `120.23 s`)**: `7,686` total ops (`63.9 ops/s`) — `5,127` availability reads (`42.6/s`, `p50=167.99 ms`, `p95=224.10 ms`, `p99=283.18 ms`), `2,334` completed booking lifecycles (`19.4 workflows/s`, `9.7 confirmed bookings/s`, `p50=430.48 ms`, `p95=556.36 ms`, `p99=666.25 ms`), `225` conflict rejections (`p50=26.49 ms`), `0` retryable errors, `0` unexpected errors, `0` overlapping allocations.
- **RSS Expansion Root Cause**: Under `node --expose-gc` (`68.57 s`, `2,435` ops), forced post-GC live JS `heapUsed` stayed completely flat (`17.23 MB -> 16.40 -> 16.47 -> 16.45 MB`, `-880.45 KB/min` slope) while RSS growth (`100.6 -> 247.9 MB` plateau in natural-GC 120s soak) reflected `pg.Pool` socket expansion (`1 -> 17-18` active handles) plus V8 `heapTotal` semi-space commitment (`53.7 -> 197.2 MB`). PostgreSQL DB size grew from `148.31 -> 163.07 MB` during the workerless 120s run, reinforcing scheduled `OutboxWebhookWorker` delivery + `runSafeRetentionCleanup()` in staging/prod.

### Unexecuted Long-Duration Benchmarks (Mandatory Gate Before Production)
The following scripts exist in [package.json](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/package.json) and [soak-24h-staging.mjs](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/scripts/soak-24h-staging.mjs) and **MUST NOT** be treated as passed:
- **`npm run test:soak:30m`**: **NOT EXECUTED** (requires 30 minutes wall time; left for staging runner).
- **`npm run test:soak:60m`**: **NOT EXECUTED** (requires 60 minutes wall time; left for staging runner).
- **`npm run test:soak:24h`**: **NOT EXECUTED** (requires 24 hours wall time; mandatory staging acceptance gate).

---

## 4. Infrastructure Validation & External Service Status

### Container Build, Networking, & Configuration Validation
- Added [.dockerignore](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/.dockerignore) reducing Next.js build context size to `756.73 kB` and built `olb-api:rc1`, `olb-console:rc1`, and `olb-docs:rc1` from [Dockerfile.api](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/docker/Dockerfile.api), [Dockerfile.console](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/docker/Dockerfile.console), and [Dockerfile.docs](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/docker/Dockerfile.docs).
- Fixed container networking in [apps/docs/server.mjs](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/apps/docs/server.mjs) (`127.0.0.1` -> `process.env.HOST || "0.0.0.0"` + graceful `SIGTERM`/`SIGINT` exit) after live container probe detection.
- Verified production Compose topology ([docker-compose.prod.yml](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/docker/docker-compose.prod.yml)): PgBouncer (`POOL_MODE=transaction`, `DEFAULT_POOL_SIZE=60`, `MAX_CLIENT_CONN=400`, `AUTH_TYPE=scram-sha-256`) shielding `PG_MAX_CONNECTIONS=100` with explicit per-instance budgeting across `API_INSTANCE_COUNT=4` plus reserved admin/worker/migration slots.

### External Service Acceptance (`NOT EXECUTED` Disclosure)
Environment inspection verified only `DATABASE_URL` exists in `.env` (no `AWS_*`, `STRIPE_*`, `SMTP_*`, or production `OLB_*` credentials):
- **Official AWS KMS SDK & STS Support**: Upgraded `AwsKmsEnvelopeProvider` in [crypto.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/security/crypto.ts) to official `@aws-sdk/client-kms` (`KMSClient`, `GenerateDataKeyCommand`, `DecryptCommand`) supporting temporary STS `sessionToken` credentials and credential rotation. **Verified against local SigV4 HTTP KMS emulator** (asserting `x-amz-security-token` header); **live AWS KMS IAM calls**: **`NOT EXECUTED`**.
- **`terraform plan` / `terraform apply` & Cloud Provisioning**: **`NOT EXECUTED`** (no authorized AWS account credentials in environment; zero paid resources provisioned, zero external DNS changes made).
- **External Authenticated TLS SMTP (`STARTTLS`/`SMTPS`)**: **`NOT EXECUTED`** externally (verified via in-process RFC 5321 SMTP capture).
- **Live / Test Payment Gateway (`Stripe` sandbox HTTP)**: **`NOT EXECUTED`** externally (verified via deterministic `SandboxStripePaymentProvider`).

---

## 5. Security Hardening Summary

Verified across unit and Phase 10 integration suites ([phase10-release-acceptance.test.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/tests/integration/phase10-release-acceptance.test.ts)):
1. **Operational Endpoint Access Restriction**: Added `OLB_OPS_TOKEN` / `opsAuthToken` (`timingSafeEqual`) in [server.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/api/server.ts) and [run-api.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/bin/run-api.ts). When set, unauthenticated `GET /v1/metrics` returns `401 UNAUTHORIZED`, while unauthenticated `/v1/health` and `/v1/ready` return minimal `{"status":"ok"}` / `{"ready":true}` (redacting PG versions, active connection counts, and queue lag). Verified inside live `olb-api:rc1` Docker container and integration tests.
2. **Webhook Egress SSRF / DNS Rebinding / Redirect Protection & Test-vs-Live Isolation**: Verified private IPv4/IPv6, CGNAT, link-local metadata (`169.254.169.254`), mixed-DNS rebinding, and 3xx redirects blocked; `live` environment enforces strict HTTPS/public-egress checks separate from `test` environments; Terraform NACL (`aws_network_acl.webhook_egress_guard`) enforces host/metadata blocks at VPC layer.
3. **Distributed Lease Renewal Across Long Requests**: Verified `DistributedTenantLease.renew()` extends active leases cleanly past initial short `1 s` TTL windows without duplicate eviction in PostgreSQL.
4. **Booking-to-Usage Ledger Crash Recovery**: Verified mid-flight outbox/usage interruption leaves booking state atomic (`bookings`) and reconciles `usage_records` idempotently upon worker retry/recovery without double-billing (`UNIQUE` scoped idempotency keys).
5. **Backup Encryption & Secret Scrubbing**: Terraform RDS `storage_encrypted = true` with customer-managed `aws_kms_key` (`enable_key_rotation = true`) and TLS-only secret transport; telemetry & error serializers redact bearer keys, webhook secrets, and customer PII.

---

## 6. SDK Acceptance & Executable Examples

Verified `@onelinebooking/sdk@1.0.0` types, browser vs server boundary enforcement, `AbortSignal` cancellation (`SdkRequestOptions.signal` wired through [packages/sdk/src/types.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/packages/sdk/src/types.ts), [server.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/packages/sdk/src/server.ts), and [browser.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/packages/sdk/src/browser.ts)), safe bound `globalThis.fetch` wrapper (fixing browser `TypeError: Illegal invocation`), 429/503 retries reusing `Idempotency-Key`, and **live end-to-end execution of all 5 independent examples** in `phase10-release-acceptance.test.ts`:
1. **Next.js App Router BFF**: [examples/integrations/nextjs-app/app/api/booking/route.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/examples/integrations/nextjs-app/app/api/booking/route.ts) (compiled cleanly to `dist/app/api/booking/route.js` and invoked live).
2. **Express.js Server**: [examples/integrations/express-app/server.mjs](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/examples/integrations/express-app/server.mjs).
3. **React Browser Widget**: [examples/integrations/react-widget/BookingWidget.tsx](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/examples/integrations/react-widget/BookingWidget.tsx) (bundled with `esbuild` + React 19 and clicked end-to-end inside real headless Chrome).
4. **Python 3 REST Client**: [examples/integrations/python-rest/client.py](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/examples/integrations/python-rest/client.py).
5. **cURL Quickstart Script**: [examples/integrations/curl-quickstart/quickstart.sh](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/examples/integrations/curl-quickstart/quickstart.sh) (executed directly via Git Bash against live API).

---

## 7. Book My Game Pilot Acceptance

All **13 pilot scenarios** in [examples/book-my-game/server.mjs](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/examples/book-my-game/server.mjs) (multi-outlet Koramangala/Whitefield onboarding, station inventory, live availability, online 2-phase hold->convert, online payment ref, walk-in + cash settlement, dynamic pricing `409` rejection + update, hold expiration reclamation, blackout blocks, cancellation, customer history, 8-way concurrency race) passed against both local direct PostgreSQL and PgBouncer `/v1` API.
- **Explicit Staging / Payment Caveat**: Remote cloud staging pilot traffic and live external customer payment transactions remain **`NOT EXECUTED`**.

---

## 8. Monthly Cloud Operating Cost Estimate (Planning Baseline)

Derived directly from instance sizing in [staging/terraform.tfvars](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/terraform/environments/staging/terraform.tfvars) and [production/terraform.tfvars](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/terraform/environments/production/terraform.tfvars) (`aws_region = "ap-south-1"` planning approximations; **not live AWS Billing API quotes**):

| Component | Smallest Functional Staging Spec | Staging Est./mo | Production Spec | Production Est./mo |
| --- | --- | ---: | --- | ---: |
| RDS PostgreSQL 17 | Single-AZ `db.t4g.medium`, 50 GB `gp3`, 7d PITR backups, KMS encrypted | \$62 | Multi-AZ `db.r6g.large`, 200 GB `gp3`, 35d PITR backups, KMS encrypted | \$385 |
| ECS Fargate Compute | 2 API (`0.25 vCPU/0.5 GB`) + 2 Workers + 1 PgBouncer + 1 Console + 1 Docs | \$55 | 4 API (`1 vCPU/2 GB`) + 2 Workers + 2 PgBouncer + 2 Console + Docs | \$215 |
| Ingress & Edge WAF | Shared ALB + 1 Regional WAFv2 WebACL + ACM TLS | \$25 | Production ALB + WAFv2 WebACL + ACM TLS | \$45 |
| Networking, KMS, Logs | 1 NAT Gateway + data transfer + CloudWatch Logs + 1 KMS CMK + Secrets Manager | \$42 | 2 Multi-AZ NAT Gateways + 90d logs + CloudWatch alarms + KMS CMK | \$115 |
| **Estimated Monthly Total** | **Staging (`staging.onelinebooking.example.com`)** | **~\$184 / mo** | **Production (`onelinebooking.example.com`)** | **~\$760 / mo** |

---

## 9. Staging Deployment, Rollback Procedures & Release Blockers

### Deployment & Rollback Steps (Summary from [phase7-runbooks.md](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/docs/phase7-runbooks.md))
1. **Provision & Configure Secrets**: Run `terraform apply -var-file=environments/staging/terraform.tfvars`, seed `DATABASE_URL`, `OLB_WEBHOOK_MASTER_KEY`, `OLB_OPS_TOKEN`, TLS SMTP relay credentials, and payment provider test keys in AWS Secrets Manager, and attach KMS `GenerateDataKey`/`Decrypt` IAM role permissions to ECS tasks.
2. **Additive Schema Migration**: Run `npm run db:migrate` inside the private subnet before rolling ECS application containers (`0001`–`0006` are additive and backward-compatible).
3. **Staged ECS Cutover**: Start PgBouncer -> `run-workers.js` (isolated in `aws_security_group.webhook_worker`) -> rolling deploy `olb-api`, `olb-console`, and `olb-docs`, gating ALB health registration on `GET /v1/ready` (`HTTP 200`, `postgresOk: true`) with `X-Ops-Token` protection active on `/v1/metrics`.
4. **Rollback**:
   - **Application rollback**: Update ECS service back to the prior container image digest and drain running tasks (`SIGTERM` exits cleanly in `<1 s`).
   - **Data rollback / recovery**: Execute RDS snapshot + WAL Point-in-Time Recovery (`recovery_target_time`, `recovery_target_action = 'promote'`) and verify exclusion constraint integrity (`allocations_tenant_id_facility_id_occupied_range_excl`) before restarting `OutboxWebhookWorker`.

### Remaining Blockers Before Private Beta / General Availability
1. Execute `npm run test:soak:30m`, `npm run test:soak:60m`, and `npm run test:soak:24h` cleanly in deployed staging (`postWarmupHeapSlopeKbPerMin <= 512`, zero overlapping allocations).
2. Run `terraform plan` / `terraform apply` against an authorized AWS staging account and validate real STS KMS envelope encryption/decryption calls.
3. Verify external authenticated TLS SMTP (SES/Postmark), live Stripe test-mode webhooks/charges/refunds, and Book My Game pilot against the live HTTPS staging deployment.
4. Keep direct-PostgreSQL multi-pool contention tests aware of PostgreSQL `max_connections = 100` when PgBouncer holds cached idle backend connections locally.
