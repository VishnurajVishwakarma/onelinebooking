# Phase 8 — Cloud Deployment Architecture, Containers, CI/CD & Rollback

This document specifies the production-compatible deployment architecture created for **OneLineBooking** (`Phase 8C`), spanning three environments (`development`, `staging`, `production`) without provisioning live cloud infrastructure from this local workspace.

---

## 1. Multi-Service Topology & Network Isolation

| Component | Entrypoint / Artifact | Runtime Port | Network Placement | Notes |
| --- | --- | ---: | --- | --- |
| Marketing Site | [apps/marketing/index.html](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/apps/marketing/index.html) / [Dockerfile.docs](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/docker/Dockerfile.docs) | `4300` | Public CDN / ALB edge | Static HTML via `apps/docs/server.mjs` |
| Developer Docs | [apps/docs/index.html](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/apps/docs/index.html) / [apps/docs/server.mjs](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/apps/docs/server.mjs) | `4300` | Public CDN / ALB edge | Covers all 13 onboarding & reference topics |
| Developer Console | [apps/console](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/apps/console) / [Dockerfile.console](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/docker/Dockerfile.console) | `3000` | Private app subnet behind WAF + ALB TLS | Next.js `16.4.6`; checks CSRF `Origin` vs `Host`/`X-Forwarded-Host` and sets cookie `Secure` under HTTPS |
| Versioned Public API (`/v1`) | [src/platform/bin/run-api.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/bin/run-api.ts) / [Dockerfile.api](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/docker/Dockerfile.api) | `4100` | Private app subnet behind WAF + ALB TLS | Uses `computeConnectionBudget`, `PostgresDistributedLimiter`, graceful `SIGTERM`/`SIGINT` drain |
| Background Workers | [src/platform/bin/run-workers.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/bin/run-workers.ts) | N/A | Private app subnet (egress-restricted) | Runs `HoldExpiryWorker` + `OutboxWebhookWorker`; SSFR-filtered outbound webhook delivery (`live` forces `allowLocalHttpForTesting: false`) |
| Connection Pooler | PgBouncer (`POOL_MODE=transaction`, `AUTH_TYPE=scram-sha-256`) | `6432` | Private app subnet | Pools high app concurrency into fixed backend DB pool |
| Managed PostgreSQL 17 | `postgres:17-alpine` / RDS PostgreSQL | `5432` | Private DB subnet (`private_db`) | Zero public IPs (`map_public_ip_on_launch = false`); ingress strictly from `aws_security_group.app` |

---

## 2. Terraform Infrastructure as Code (`infra/terraform/main.tf`)

[main.tf](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/terraform/main.tf) defines environment-parameterized AWS primitives validated for `development`, `staging`, and `production`:

1. **VPC & Private Database Subnets**:
   - `aws_vpc.main` (`cidr_block = var.vpc_cidr`, default `10.42.0.0/16`) with DNS hostnames & support enabled.
   - `aws_subnet.private_app` (2 AZs) and `aws_subnet.private_db` (2 AZs), both configured with `map_public_ip_on_launch = false`.
   - `aws_security_group.postgres` allows TCP `5432` strictly from `aws_security_group.app` — never from `0.0.0.0/0` or public subnets.
2. **Secret Management & KMS Envelope Encryption**:
   - `aws_kms_key.webhook_secrets` (`enable_key_rotation = true`, `deletion_window_in_days = 30`).
   - `aws_secretsmanager_secret.platform_secrets` (`onelinebooking/${var.environment}/runtime`) encrypted by `aws_kms_key.webhook_secrets`.
   - Application layer pairs this with `OLB_WEBHOOK_KEYRING_JSON` / `OLB_WEBHOOK_MASTER_KEY` (`enc.v2.<ver>.*` envelope tags and `PlatformService.reEncryptWebhookSecrets()`).
3. **Edge WAF & Rate Limiting**:
   - `aws_wafv2_web_acl.edge` enforces per-IP rate limits (`2,000` requests/5m window in `production`, `5,000` in lower environments) with CloudWatch sampled metrics.

---

## 3. Container Builds & Connection Budgeting

- **Multi-stage containers**:
  - [Dockerfile.api](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/docker/Dockerfile.api): Compiles TypeScript on `node:22-alpine`, ships `--omit=dev` dependencies + `dist/` + `src/infrastructure/postgres/migrations/`, executes as non-root user `node`.
  - [Dockerfile.console](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/docker/Dockerfile.console): Runs `npm --prefix apps/console run build`, serves `next start -H 0.0.0.0 -p 3000` as user `node`.
  - [Dockerfile.docs](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/infra/docker/Dockerfile.docs): Serves public documentation & marketing landing assets on `:4300` as user `node`.
- **Database connection budgeting**:
  - Both [run-api.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/bin/run-api.ts) and [run-workers.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/bin/run-workers.ts) derive pool sizing via `computeConnectionBudget({ postgresMaxConnections, apiInstanceCount, pgbouncerDefaultPoolSize })`, reserving dedicated slots for workers (`8`), migrations (`3`), and emergency admin sessions (`5`).

---

## 4. CI/CD Pipeline (`.github/workflows/ci-cd.yml`)

1. **`verify` job (every push/PR to `main`)**:
   - Boots PostgreSQL `17-alpine` service with `pg_isready` health check.
   - Runs `npm ci`, `npm run typecheck`, `npm --prefix packages/sdk run build`, `npm --prefix apps/console ci && npm --prefix apps/console run build`, `npm run db:migrate`, and `npm run test:all`.
2. **`deploy-staging` job (`main` pushes)**:
   - Builds `olb-api:${SHA}`, `olb-console:${SHA}`, and `olb-docs:${SHA}` Docker images.
   - Staging gate executes additive migrations before rolling app containers and checks `GET /v1/ready` before shifting traffic.

---

## 5. Monitoring, Alerts & Rollback Procedures

### Key SLIs & Alert Thresholds
| Signal | Endpoint / Source | Threshold | Action |
| --- | --- | --- | --- |
| API & Worker DB Readiness | `GET /v1/ready` | Non-`200` for > 30s | Abort deploy, isolate failing AZ/instance |
| Hold Expiration Backlog | `GET /v1/ready` (`maxHoldExpirationLagSeconds`) | `> 30s` | Scale/restart `run-workers`, inspect `pg_stat_activity` |
| Webhook Delivery Lag | `GET /v1/ready` (`oldestPendingOutboxLagSeconds`) | `> 60s` | Check failing webhook destinations / DLQ & worker logs |
| Error Rate & Pool Exhaustion | `GET /v1/metrics` (`olb_pg_pool_connections`, `5xx` rate) | Sustained `TEMPORARY_UNAVAILABLE` | Check PgBouncer client queue & slow lock holders |

### Zero-Downtime Rollback Procedure
1. **Application Rollback**: Re-point ECS/Kubernetes target group or task definition to the previous verified image tag (`olb-api:<prev-sha>`, `olb-console:<prev-sha>`), confirm `GET /v1/ready` returns `200`, and monitor 5xx drop.
2. **Schema Safety**: Migrations (`0001` through `0006`) are strictly additive (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). Previous stable app releases ignore newly added Phase 8 tables/columns cleanly during emergency app rollback.
3. **Database Corruption / Operator Error**: Execute physical WAL-based PITR from base backup + `/wal_archive` up to `recovery_target_time` using [phase7-runbooks.md](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/docs/phase7-runbooks.md) and verified by [phase8-pitr-drill.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/scripts/phase8-pitr-drill.ts).

