# Phase 10 — Release Candidate Deployment Acceptance Report (`v1.0.0-rc.1`)

**FINAL RELEASE VERDICT: `APPROVED FOR STAGING`**

OneLineBooking (`v1.0.0-rc.1`) has completed **Steps 1–3** of release-candidate deployment acceptance locally with full raw evidence: a clean Git release commit and tag, repaired and database-enforced `outbox_events` sequence uniqueness (`0007_outbox_sequence_integrity.sql`), resolved PgBouncer connection pooling and idle-cleanup behavior (passing `npm run test:all` immediately after PgBouncer load without manual restart), container runtime checks, operational disaster-recovery drills, headless Chrome UI tests, Terraform offline syntax/schema validation, and **continuous 30-minute (`1,800.17 s`) and 60-minute (`3,600.19 s`) sustained soak benchmarks**.

It remains **`APPROVED FOR STAGING`** (and **blocked** for general production / external beta) strictly because **Steps 4–7** require authorized AWS credentials, explicit deployment authorization, external TLS SMTP credentials, live payment-gateway test credentials, a deployed HTTPS staging environment, the 24-hour staging endurance run, and live customer pilot traffic — all of which remain **`NOT EXECUTED`**.

---

## Step 1 — Release Integrity & Outbox Sequence Audit

### Release Commit, Clean Working Tree & Checksums
- **Release Tag**: `v1.0.0-rc.1` (Git commit `7e0e24ae3ba1c12d8f00466c94224ed0137a516f` prior to final doc sync, re-tagged upon committing this report with `git status --porcelain` = clean `0`)
- **Clean Build Artifacts From Release Commit**:
  - Root engine (`mygamingslot-booking-engine@1.0.0`, Node `v24.16.0`, TypeScript `^5.9.3`)
  - Developer Console (`onelinebooking-console@1.0.0`, `next@^16.0.0` — `.next/` untracked and `.gitignore`d so builds never dirty Git)
  - SDK tarball [onelinebooking-sdk-1.0.0.tgz](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/reports/onelinebooking-sdk-1.0.0.tgz) (`7.6 kB` compressed / `62.9 kB` unpacked, `18` files, SHA-256: `2CD05D27F88F5999A8615A42B27A78DE90A9BC6240CF679E701A7997DEA0186A`)
  - Release container images built & tagged `:v1.0.0-rc.1` and `:rc1`: `olb-api:v1.0.0-rc.1`, `olb-console:v1.0.0-rc.1`, `olb-docs:v1.0.0-rc.1`

| Migration File | SHA-256 Checksum |
| --- | --- |
| [0001_initial.sql](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/migrations/0001_initial.sql) | `EF04D17816107E27990DF28704F97D763CAEFECCC55ABA46830818FA77958F65` |
| [0002_v1_schema.sql](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/migrations/0002_v1_schema.sql) | `D004219ADC01BFEDB951C5F166352E6E19F9BE9C120E7B3D602C21864E25CF48` |
| [0003_v1_performance_indexes.sql](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/migrations/0003_v1_performance_indexes.sql) | `A13354F949DE54F2D939ADF1E02956E0C09152B831B5AB980E7A5279ED71D28D` |
| [0004_platform_schema.sql](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/migrations/0004_platform_schema.sql) | `7C297EB6E1E531260F351DB50FA3D8BFEDD89B430D8235D2B3C6894FF9F0E6DE` |
| [0005_phase7_security_and_ops.sql](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/migrations/0005_phase7_security_and_ops.sql) | `71C61B30AACC02750ED7392844A98BEC5A6FF22DFA321FEB4FE3151A502579BF` |
| [0006_phase8_auth_and_billing.sql](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/migrations/0006_phase8_auth_and_billing.sql) | `60E1326D2FDCD1D21E7459A6A253A0B7F0C7E95DDBF7B38B94885A1CF7267BBC` |
| [0007_outbox_sequence_integrity.sql](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/migrations/0007_outbox_sequence_integrity.sql) | `A66B81A999AFB7433C5E81DF0900507C1640CB65F5EE71BCA9B6BEC5EAA8CFED` |

### Historical Outbox Collision Audit & Remediation
- **Audit Discovery**: Querying `outbox_events` pre-remediation detected **`61` collided booking groups** (`booking.confirmed` and `booking.cancelled` both at `aggregate_sequence = 2`), produced prior to fixing `convertHoldToBooking`'s `bookings.sequence` insert (`1` -> `2`) in [postgres-booking-store.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/postgres-booking-store.ts) and enabled by non-unique index `outbox_events_aggregate_idx`.
- **Remediation ([0007_outbox_sequence_integrity.sql](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/migrations/0007_outbox_sequence_integrity.sql))**:
  1. Deterministically renumbered collided `(tenant_id, aggregate_type, aggregate_id)` rows (`ROW_NUMBER()` by `aggregate_sequence, occurred_at, recorded_at, id`).
  2. Synchronized `bookings.sequence` and `holds.sequence` with `MAX(aggregate_sequence)`.
  3. Replaced the non-unique index with `UNIQUE` index `outbox_events_aggregate_seq_uidx ON outbox_events(tenant_id, aggregate_type, aggregate_id, aggregate_sequence)`.
- **Post-Soak DB Verification (`488,442` total `outbox_events` rows)**: `0` duplicate sequence groups (`SELECT ... HAVING COUNT(*) > 1` -> `0 rows`), `0` lifecycle monotonicity violations (`booking.created=1 [81,900] -> booking.confirmed=2 [81,900] -> booking.cancelled=3 [264]`; `hold.created=1 [162,241] -> hold.converted=2 [80,642] / hold.released=2 [76,165] / hold.expired=2 [5,434]`).

---

## Step 2 — Connection Reliability Investigation & Fix

- **Root Cause**:
  1. PgBouncer in [compose.yaml](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/compose.yaml) ran with `DEFAULT_POOL_SIZE=60`, `RESERVE_POOL_SIZE=10`, unconfigured `MAX_DB_CONNECTIONS=0`, and PgBouncer default `server_idle_timeout=600` (10 minutes). After heavy concurrent PgBouncer bursts, PgBouncer kept ~45 idle server connections open against PostgreSQL `max_connections = 100`. Running direct-PG `npm run test:all` (`--test-concurrency=2`, where `production-reliability.test.ts` opens a `max=50` pool + `3 x max=10` multi-API pools alongside another suite) then overflowed `max_connections=100` (`53300: too many clients already`).
  2. In [postgres-booking-store.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/postgres-booking-store.ts), `translatePgError` matched `/timeout expired/i` rather than `pg-pool`'s `"timeout exceeded when trying to connect"`, misclassifying pool exhaustion timeouts as non-retryable `INTERNAL_ERROR` instead of retryable `TEMPORARY_UNAVAILABLE`.
  3. In [docker-compose.prod.yml](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/docker/docker-compose.prod.yml) and [apps/console/src/lib/engine.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/apps/console/src/lib/engine.ts), Console connected directly to `DATABASE_URL` instead of preferring `PGBOUNCER_URL`.
- **Fixes Applied & Verified**:
  - Configured PgBouncer bounds and automatic idle cleanup in [compose.yaml](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/compose.yaml) (`DEFAULT_POOL_SIZE=30`, `MAX_DB_CONNECTIONS=35`, `RESERVE_POOL_SIZE=5`, `SERVER_IDLE_TIMEOUT=5`, `SERVER_LIFETIME=900`, `IDLE_TRANSACTION_TIMEOUT=30`) and [docker-compose.prod.yml](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/docker/docker-compose.prod.yml) (`DEFAULT_POOL_SIZE=50`, `MAX_DB_CONNECTIONS=70`, `RESERVE_POOL_SIZE=5`, `SERVER_IDLE_TIMEOUT=30`, `SERVER_LIFETIME=1800`, `IDLE_TRANSACTION_TIMEOUT=60`, plus Console `PGBOUNCER_URL`).
  - Updated `translatePgError` regex (`timeout exceeded`) and default unbudgeted `connectionTimeoutMillis` (`10_000`) while preserving `buildBudgetedPoolConfig`'s fail-fast `2_500 ms` timeout.
  - Executed [scripts/verify-connection-reliability.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/scripts/verify-connection-reliability.ts):
    - `75` concurrent pooled connections (`3 x max=25`) capped cleanly at `peakBackendsDuringBurst = 29 <= 35`.
    - Automatic idle cleanup reduced idle Postgres server connections to `backendsAfterIdleCleanup = 0` without restarting PgBouncer.
    - `5` repeated rolling API pool deployments leaked `0` connections.
    - `automaticPgBouncerRecovery = true` after live PgBouncer restart.
  - **No-Restart Proof**: Executed the **23/23 PgBouncer test run** (`8` suites, `37,151.07 ms`) followed **immediately** by **`npm run test:all`** (**47/47** unit/stress in `11,297.49 ms` + **32/32** direct PG integration in `50,159.84 ms`) with **zero manual PgBouncer restart** — `0` failures, `0` skipped.
  - Additional latest passing checks: `verify:reliability-ops` (`4/4` drills passing, applying `0002`–`0007`), `phase10-container-verify.mjs` (`containerVerificationPassed: true`, `restrictedMetricsVerified: true`), `sdk-consumer-smoke` (ESM & CJS), and `playwright-e2e` (`5/5` Google Chrome Headless UI flows).

---

## Step 3 — Executed Long-Duration Soak Tests (`30m` & `60m`)

Both commands ran directly via [scripts/soak-test.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/scripts/soak-test.ts) (`concurrency = 16`, `conflict-ratio = 0.1`, `20` facilities x `330` days = `310,200` distinct 30-min slots, active `HoldExpiryWorker` every `2s`) and saved complete raw JSON telemetry:

| Metric | `npm run test:soak:30m` ([soak-30m.json](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/reports/soak-30m.json)) | `npm run test:soak:60m` ([soak-60m.json](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/reports/soak-60m.json)) |
| --- | ---: | ---: |
| Actual Duration | **`1,800.17 s` (30.0 min)** | **`3,600.19 s` (60.0 min)** |
| Total Operations / Throughput | `161,591` ops (`89.8 ops/s`) | `324,006` ops (`90.0 ops/s`) |
| Availability Reads (`throughput`, `p50`/`p95`/`p99`) | `107,733` (`59.8/s`, `109.57 / 137.76 / 196.16 ms`) | `216,010` (`60.0/s`, `131.49 / 170.84 / 336.94 ms`) |
| Holds Created / Released | `48,491` / `24,247` | `97,208` / `48,605` |
| **Confirmed Bookings** (`workflows/s`, `confirmed/s`) | **`24,244`** (`26.9/s` cycles, `13.5/s` confirmed) | **`48,603`** (`27.0/s` cycles, `13.5/s` confirmed) |
| Workflow Latency (`p50`/`p95`/`p99`) | `294.14 / 388.43 / 500.39 ms` | `343.73 / 468.60 / 664.27 ms` |
| Intent Conflicts Rejected (`p50`/`p95`/`p99`) | `5,367` (`3.0/s`, `20.37 / 28.71 / 37.40 ms`) | `10,788` (`3.0/s`, `20.39 / 28.76 / 39.57 ms`) |
| Process RSS (`start -> end`, delta) | `306.5 MB -> 340.1 MB` (`+33.6 MB`) | `369.9 MB -> 375.8 MB` (`+5.9 MB`; settled from `693.5 MB` peak at `300s`) |
| Post-Warmup JS `heapUsed` Slope | **`-1,159.82 KB/min`** (`endHeapUsed: 173.4 MB`) | **`-2,505.91 KB/min`** (`endHeapUsed: 123.3 MB`) |
| Active Handles / PG Pool (`total`, `waiting`) | `18` / `17–18`, `waiting = 0` | `18` / `17–18`, `waiting = 0` |
| PostgreSQL DB Growth (`dbSizeMb`, `allocations`) | `192.86 -> 634.94 MB` (`17,799 -> 66,290`) | `635.04 -> 1,560.25 MB` (`66,291 -> 163,499`) |
| `HoldExpiryWorker` Lag & Sweeps | `897` sweeps, `111` expired, **`maxLag: 0 s`** | `1,797` sweeps, **`maxLag: 0 s`** |
| Outbox Backlog (`OutboxWebhookWorker` unattached in harness) | `2 -> 145,472` pending (`1,800.45 s` oldest) | `2 -> 291,624` pending (`3,600.89 s` oldest) |
| Errors / Integrity Violations (`retryable`, `unexpected`, `overlaps`) | **`0` / `0` / `0`** | **`0` / `0` / `0`** |

- **Findings**: Zero memory leaks across **485,597 total soak operations** (`1.5 hours` continuous), zero overlapping allocations, zero retryable or unexpected errors, and `0 s` hold-expiry lag. Outbox and `allocations` disk growth (~`15 MB/min` under `~90 ops/s` without active webhook draining/archival) confirms that persistent `OutboxWebhookWorker` + daily `runSafeRetentionCleanup()` archival + RDS autovacuum are required in deployed staging/production.

---

## Steps 4–7 — Infrastructure Plan Inventory, Cost Estimate, Blocked External Checks & Remaining Blockers

### Step 4 — Staging IaC Inventory (`terraform plan` **`NOT EXECUTED`**)
- `hashicorp/terraform:1.9` (`hashicorp/aws v5.100.0`) passed offline `terraform fmt -check` and `terraform validate` (`Success! The configuration is valid.`).
- Live `terraform plan` against staging ([staging/terraform.tfvars](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/terraform/environments/staging/terraform.tfvars)) is **`NOT EXECUTED`** because no authorized AWS credentials exist in this environment (`AWS_*` absent; zero cloud resources provisioned).
- **Declared Resources in [main.tf](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/terraform/main.tf)**:
  - Networking & SSRF Edge: `aws_vpc.main` (`10.42.0.0/16`), `aws_subnet.private_db` (x2), `aws_subnet.private_app` (x2), `aws_subnet.public_edge` (x2), `aws_db_subnet_group.postgres`, `aws_security_group.app`, `aws_security_group.webhook_worker`, `aws_security_group.postgres` (5432 strictly from app/worker SGs), `aws_network_acl.webhook_egress_guard` (explicitly denies `169.254.169.254/32`), `aws_wafv2_web_acl.edge` (IP rate limit `5,000` staging / `2,000` prod).
  - Security & Data: `aws_kms_key.webhook_secrets` (`enable_key_rotation = true`), `aws_secretsmanager_secret.platform_secrets`, `aws_db_instance.postgres` (PG `17.2`, `db.t4g.medium`, 50 GB encrypted gp3, 7d backup retention staging / 35d multi-AZ prod, `publicly_accessible = false`), `aws_acm_certificate.public_tls`.
  - Compute & Observability: `aws_ecs_cluster.main` (Container Insights enabled; staging `2` API + `2` Worker tasks), `aws_cloudwatch_log_group.platform` (KMS-encrypted, 30d/90d retention), `aws_cloudwatch_metric_alarm.high_5xx`.
- **Deployment Dependency Order**: IAM/KMS & VPC/Subnets -> Security Groups/NACLs -> KMS CMK & Secrets Manager (`DATABASE_URL`, `OLB_WEBHOOK_MASTER_KEY`, `OLB_OPS_TOKEN`, TLS SMTP, payment keys) -> RDS PostgreSQL 17 & `npm run db:migrate` -> PgBouncer -> Workers (`webhook_worker` SG) -> API / Console / Docs ECS services -> ALB (`GET /v1/ready`) + ACM DNS TLS + WAFv2.
- **Estimated Monthly Cloud Costs** (`ap-south-1` planning baseline approximations, **not live AWS Billing quotes**): Staging **~\$184 / mo** (`\$62` RDS `db.t4g.medium` + `\$55` Fargate + `\$25` ALB/WAF + `\$42` NAT/CW/KMS/Secrets); Production Multi-AZ **~\$760 / mo** (`\$385` RDS `db.r6g.large` + `\$215` Fargate + `\$45` ALB/WAF + `\$115` 2x NAT/CW/KMS).

### Steps 5, 6 & 7 — Unexecuted External & Cloud Staging Checks (Explicit Register)
All items below remain **`NOT EXECUTED`** pending AWS deployment authorization and external service credentials:
1. **Step 4**: Live `terraform plan` (and explicitly authorized `terraform apply`) using IAM credentials.
2. **Step 5**: Live AWS KMS (`@aws-sdk/client-kms` tested locally against SigV4 HTTP KMS server), authenticated TLS external SMTP relay (tested via local RFC5321 TCP capture), external payment gateway test-mode webhooks/charges (tested via `SandboxStripePaymentProvider`), live HTTPS API/Console endpoints, cloud VPC NACL egress enforcement, CloudWatch alarm firing, live ECS rolling deployments, and RDS snapshot/PITR validation.
3. **Step 6**: 24-hour endurance benchmark (`npm run test:soak:24h`) against the deployed staging environment.
4. **Step 7**: Connecting **Book My Game** (`examples/book-my-game/server.mjs`, `13/13` scenarios passing locally) to the deployed staging HTTPS REST/SDK URL and executing controlled onboarding for the first real gaming café and independent developer.

---

**FINAL RELEASE VERDICT: `APPROVED FOR STAGING`** — Ready to run `terraform plan` / staging deployment once cloud credentials and deployment authorization are supplied.
