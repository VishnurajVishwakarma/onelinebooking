# OneLineBooking — Deployment, PITR & Incident Response Runbooks

## 1. Deployment & Rolling Connection Budget Runbook

### Connection Budgeting Formula (`computeConnectionBudget`)
For a PostgreSQL server with `max_connections = N`:
1. Permanently reserve `reservedAdminConnections = 5` (superuser diagnostics, psql recovery).
2. Permanently reserve `reservedWorkerConnections = 8` (HoldExpiryWorker + OutboxWebhookWorker pools).
3. Permanently reserve `reservedMigrationConnections = 3` (`npm run db:migrate`).
4. Size API instance pool max using `apiInstanceCount = desiredReplicas + rollingSurgeReplicas`.
   - Direct Postgres (`N = 100`, 4 active + 1 rolling deploy = 5 instances): `perApiInstancePoolMax = floor((100 - 16) / 5) = 16` connections/process.
   - Behind PgBouncer (`POOL_MODE = transaction`, `DEFAULT_POOL_SIZE = 60`, `MAX_CLIENT_CONN = 400`): backend DB connections stay capped at `60`, while API pods hold `pgbouncerClientMaxPerInstance = 36` logical app connections each.

### Zero-Downtime Deployment Checklist
1. Verify `OLB_WEBHOOK_MASTER_KEY` (64-char hex / 32-byte key) is set (`NODE_ENV=production` rejects boot without it).
2. Run additive migrations before rolling app containers (`npm run db:migrate`).
3. Confirm readiness probe `GET /v1/ready` returns `200 { ready: true }`.
4. Drain old API replicas gracefully so in-flight transactions commit/rollback cleanly; PgBouncer `SERVER_RESET_QUERY=DISCARD ALL` cleans pooled state between transactions.

---

## 2. Backup & Point-in-Time Recovery (PITR) Procedure

### Continuous Archiving Configuration
Enable WAL archiving on PostgreSQL primary:
```sql
ALTER SYSTEM SET wal_level = 'replica';
ALTER SYSTEM SET archive_mode = 'on';
ALTER SYSTEM SET archive_command = 'test ! -f /pg_wal_archive/%f && cp %p /pg_wal_archive/%f';
```
Schedule daily encrypted base backups (`pg_basebackup -Ft -z -P` or managed snapshot) paired with continuous WAL archival.

### Recovery Procedure
1. Provision clean PostgreSQL 17 instance from latest base backup.
2. Restore WAL archive path and set target in `postgresql.auto.conf`:
   ```
   restore_command = 'cp /pg_wal_archive/%f %p'
   recovery_target_time = '2026-11-27 12:30:00+00'
   recovery_target_action = 'promote'
   ```
3. Start PostgreSQL, verify `allocations` exclusion constraints (`allocations_tenant_id_facility_id_occupied_range_excl`) and confirm latest outbox cursor before re-enabling webhook dispatch workers.

---

## 3. Incident Response Runbooks

### A. Elevated Hold Expiration or Outbox Backlog (`GET /v1/ready`)
**Alert thresholds**: `maxHoldExpirationLagSeconds > 30` OR `oldestPendingOutboxLagSeconds > 60`.
1. Check `GET /v1/ready` and `GET /v1/metrics` (`olb_pg_pool_connections`, `olb_hold_expiries_total`).
2. Inspect DB locks:
   ```sql
   SELECT pid, state, wait_event_type, wait_event, query
   FROM pg_stat_activity WHERE datname = current_database() AND state <> 'idle';
   ```
3. Restart stuck `HoldExpiryWorker` / `OutboxWebhookWorker` processes; workers claim via `FOR UPDATE SKIP LOCKED` and 15s–30s leases so restarts require zero manual lease clearing.

### B. Compromised API Key or Webhook Secret
1. Immediately revoke key via Console `/credentials` or `PlatformService.revokeApiKey()` -> instant `401 UNAUTHORIZED` across all API nodes.
2. For webhook secrets, rotate immediately with `gracePeriodMinutes = 0` to cut off compromised signatures at once.

### C. Suspected SSRF / Webhook Egress Anomaly
1. Inspect `webhook_deliveries` where `status IN ('retrying', 'dead_letter')` and `last_error ILIKE '%SSRF%'`.
2. Disable malicious endpoints via `disableWebhookEndpoint()`. All outbound calls resolve DNS at send time and pin validated non-private IPs while blocking 3xx redirects.

### D. Ephemeral Table Growth Management
Schedule daily execution of `runSafeRetentionCleanup(pool)` (prunes expired `api_idempotency_records`, `idempotency_records`, `distributed_rate_limit_counters`, `api_request_logs > 30d`, `outbox_events` delivered `> 14d`) while keeping `bookings`, `booking_history`, `usage_records`, and `platform_audit_logs` permanently intact.

