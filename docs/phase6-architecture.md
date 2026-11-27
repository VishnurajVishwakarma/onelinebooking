# Phase 6 — OneLineBooking Infrastructure Platform Architecture

## 1. Platform Overview

Phase 6 layers a multi-tenant Booking Infrastructure as a Service (BaaS) platform around the V1 PostgreSQL booking engine (`TimeSlotEngine` + `PostgresBookingStore`) without altering or weakening any V1 transactional invariants, exclusion constraints, or `FOR SHARE` / `FOR UPDATE` locking rules.

```
Developer App / SDK (OneLineBookingClient)
  │  Authorization: Bearer olb_live_... | Idempotency-Key | X-Correlation-Id
  ▼
REST API Gateway (/v1 - createPlatformHttpServer)
  ├─ RuntimeTrafficLimiter (global concurrency, bounded queue, per-tenant cap, rate limit)
  ├─ PlatformService credential verification (SHA-256 + timingSafeEqual, derived tenant/env)
  ├─ HTTP Idempotency layer (api_idempotency_records + V1 engine idempotency_records)
  ├─ TimeSlotEngine -> PostgresBookingStore (Budgeted pg Pool / optional PgBouncer :6432)
  └─ Usage metering (append-only usage_records via ON CONFLICT DO NOTHING)

Managed Background Workers (reserved DB pool budget)
  ├─ HoldExpiryWorker -> engine.expireHolds(limit)
  └─ OutboxWebhookWorker -> claimEvents() -> webhook_deliveries (HMAC-SHA256 + retries + DLQ)
```

---

## 2. Database Schema Extensions ([0004_platform_schema.sql](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/infrastructure/postgres/migrations/0004_platform_schema.sql))

All V1 core tables (`tenants`, `facilities`, `facility_schedules`, `holds`, `bookings`, `allocations`, `outbox_events`) retain full standalone compatibility:

- **Control plane**: `organizations`, `organization_members` (`owner | admin | developer | viewer`), `projects` (`UNIQUE (organization_id, slug)`), `environments` (`test | live`, `UNIQUE (project_id, type)`).
- **Scoped tenants & resources**:
  - `tenants` adds nullable `organization_id`, `project_id`, `environment_id`, `environment_type` guarded by `tenants_platform_tuple_consistency_check` (all NULL for V1 standalone callers, all NOT NULL for platform callers) and `UNIQUE (environment_id, id)`.
  - `locations` stores physical venues (`tenant_id, id`); `facilities` adds nullable `location_id` and `resource_kind` referencing `locations(tenant_id, id)`.
- **API Credentials**: `api_keys` stores only `key_prefix` (`olb_test_<16hex>` / `olb_live_<16hex>`) and `key_hash` (SHA-256 hex), never plaintext secrets, with `scopes text[]`, `status` (`active | rotated | revoked`), `rotated_from_key_id`, `last_used_at`, `expires_at`, and `revoked_at`.
- **Webhooks**: `webhook_endpoints` + `webhook_deliveries` (`UNIQUE (outbox_event_id, endpoint_id)`, states `pending | retrying | delivered | dead_letter`, `replayed_count`).
- **Usage & Audit**: `usage_records` (`UNIQUE (environment_id, metric, idempotency_key)`), `platform_audit_logs`, and `api_idempotency_records` (24h HTTP replay cache with payload-hash verification).

---

## 3. Infrastructure Hardening & Connection Budgeting

### Problem Diagnosed in Phase 5
In Phase 5 (`benchmark-phase5.ts`), 4 independent child API processes plus 1 coordinator allocated 4 x 20 + 80 = 160 pool connections against PostgreSQL `max_connections = 100`, triggering `76` `TEMPORARY_UNAVAILABLE` failures under heavy load.

### Solution ([connection-budget.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/db/connection-budget.ts) & [concurrency-limiter.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/src/platform/runtime/concurrency-limiter.ts))
1. **Explicit Connection Reservation (`computeConnectionBudget`)**:
   - Reserves `5` admin + `8` background worker + `3` migration = `16` connections permanently off-limits to API pools.
   - Splits remaining `84` slots deterministically across `apiInstanceCount` processes (for 4 instances: `perApiInstancePoolMax = 21`, total API budget = `84`).
   - Behind PgBouncer transaction pooling (`compose.yaml` optional `pgbouncer` profile, `POOL_MODE=transaction`, `DEFAULT_POOL_SIZE=60`, `MAX_CLIENT_CONN=400`), application processes multiplex `pgbouncerClientMaxPerInstance = 45` logical connections per instance onto `60` PostgreSQL backend connections.
   - Note on transaction pooling compatibility: `PostgresBookingStore` uses parameterized prepared-free simple transaction queries (`BEGIN` / `SET LOCAL` timeouts inside transactions) and hash-locked transaction-scoped advisory locks (`pg_advisory_xact_lock`), avoiding session-scoped prepared statements and session-scoped advisory locks, making it directly compatible with PgBouncer `transaction` mode.
2. **Admission & Noisy-Neighbor Protection (`RuntimeTrafficLimiter`)**:
   - Bounds active HTTP handlers (`maxConcurrentRequests`), bounded waiting queue (`maxQueueDepth` + `queueTimeoutMs`), per-tenant active concurrency (`maxPerTenantInFlight`), and per-credential sliding/fixed-window rate limits (`429 RATE_LIMITED` + `Retry-After`).

---

## 4. Availability Profiling Results ([profile-availability.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/scripts/profile-availability.ts))

Profiled against PostgreSQL 17 with 900 seeded 30-minute slots in `America/New_York` (schedule breaks + active bookings):

| Query Horizon | Slots Returned | Avg (ms) | p50 (ms) | p95 (ms) | p99 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 day | 30 | 76.60 | 75.27 | 90.81 | 97.76 |
| 7 days | 210 | 126.43 | 121.66 | 167.66 | 176.49 |
| 30 days | 900 | 265.49 | 262.23 | 307.90 | 310.70 |

`EXPLAIN (ANALYZE, BUFFERS)` on `allocations`:
- Plan node: `Index Scan` using `allocations_tenant_id_facility_id_occupied_range_excl`
- Planning time: `1.972 ms`
- Execution time: `1.112 ms`

**Architectural conclusion**: PostgreSQL storage/range scans consume < 2 ms; > 95% of availability latency comes from Node.js per-slot Luxon timezone/DST conversions (`DateTime` instantiation per candidate). Adding read replicas prematurely would not speed up availability responses; short-TTL read-through caching per `(facilityId, fromDate, toDate, configurationRevision)` or zone-offset memoization in the API tier should precede read-replica routing, while `checkSelection` and `createHold` continue reading authoritative state directly inside PostgreSQL transactions.

---

## 5. Multi-Process Benchmark & Operational Verification

### 4-Process Budgeted Contention Benchmark ([bench-phase6-4proc.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/scripts/bench-phase6-4proc.ts))
Configured with `postgresMaxConnections = 100`, 4 child processes, `perApiInstancePoolMax = 21`, total offered concurrency = 80 across 1,000 requests per scenario:

| Scenario | Throughput (req/s) | Confirmed | Conflicts | Retryable | Unexpected Errors | Peak PG Connections | Overlapping Allocations | p50 (ms) | p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `hot_slot` (same slot) | 89.2 | 1 | 990 | 9 | 0 | 85 / 100 | 0 | 120.70 | 5266.69 |
| `multi_slot` (distinct slots) | 70.1 | 240 | 758 | 2 | 0 | 84 / 100 | 0 | 190.01 | 5997.98 |

Compared against Phase 5's 4-process run (160 configured connections exceeding `max_connections = 100`, 76 `TEMPORARY_UNAVAILABLE` failures), peak backend connections stayed strictly bounded at `<= 85` with `0` unexpected errors and `0` overlapping allocations.

### Sustained Soak Smoke Verification ([soak-test.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/scripts/soak-test.ts))
- 30-minute (`npm run test:soak:30m`) and 60-minute (`npm run test:soak:60m`) soak commands are implemented and configurable via `--duration-minutes` / `--duration-seconds`.
- Verified **15-second smoke soak** (concurrency `16`, mixed reads + hold lifecycle + active `HoldExpiryWorker`): `643` operations (`42.4 ops/s`), `434` availability reads, `209` hold create/(convert|release) cycles, `0` unexpected errors, `0` overlapping allocations, RSS `84.7 MB -> 143.0 MB`. Full 30m and 60m duration runs were **not** executed during this verification session.

---

## 6. Security & Threat Model Summary

| Threat | Mitigation Implemented | Verification Status |
| --- | --- | --- |
| Unauthenticated / forged API key | Bearer token format check (`olb_(test|live)_...`) + SHA-256 hash lookup + `timingSafeEqual` | Tested in `phase6-platform.test.ts` (401 on tampered/revoked/rotated keys) |
| Cross-tenant spoofing (`X-Tenant-Id` / body manipulation) | Tenant-bound keys reject any mismatched header/body tenant (`403`); environment keys verify `tenant.environment_id === principal.environmentId` | Tested (`phase6-platform.test.ts`) |
| Cross-project / Test-vs-Live privilege confusion | `environments(type)` + FK composite constraints `(organization_id, project_id, environment_id)` + prefix matching (`olb_test_` vs `olb_live_`) | Tested (`phase6-platform.test.ts`) |
| Over-privileged API credentials | Route-level `assertScope` + least-privilege `mapScopesToCapabilities` forwarded into V1 `Actor` | Tested (`phase6-platform.test.ts` & `phase6-sdk-and-crypto.test.ts`) |
| Secret leakage in logs / errors | Hash-only key persistence; `redactSecrets()` scrubs `olb_*` & `whsec_*` from API errors/logs; signing secrets returned once on creation | Tested (`phase6-sdk-and-crypto.test.ts` & `phase6-platform.test.ts`) |
| Duplicate webhooks / webhook forgery | HMAC-SHA256 `X-OneLine-Signature: t=...,v1=...` with constant-time verify & timestamp tolerance (`300s`); `UNIQUE (outbox_event_id, endpoint_id)` | Tested (`phase6-sdk-and-crypto.test.ts` & `phase6-platform.test.ts`) |
| Retried mutations causing double bookings | SDK reuses single `Idempotency-Key` on `429`/`503`; API enforces canonical `request_hash` check (`409 IDEMPOTENCY_KEY_CONFLICT`) + V1 `idempotency_records` | Tested (`phase6-platform.test.ts`) |
| Noisy-neighbor / DB exhaustion | `RuntimeTrafficLimiter` per-tenant cap + bounded queue + `computeConnectionBudget` hard pool limits | Tested (`phase6-sdk-and-crypto.test.ts` & `bench-phase6-4proc.js`) |

---

## 7. Webhook Consumer Idempotency Contract

`OutboxWebhookWorker` provides **at-least-once** delivery semantics: network timeouts, process restarts between HTTP receipt and database acknowledgment, or manual `replayDelivery()` calls can deliver the same event more than once.

Every webhook receiver **must**:
1. Verify `X-OneLine-Signature` (`t=<unix>,v1=<hmac_sha256_hex>`) using the endpoint's `signingSecret` and reject stale timestamps (`|now - t| > 300s`).
2. Persist processed `X-OneLine-Event-Id` (or payload `id`) in a deduplicated consumer table (`UNIQUE (event_id)`) inside the consumer's local transaction before applying side effects.
3. Order entity updates by payload `aggregateSequence` rather than arrival wall-clock time.

---

## 8. OpenAPI Specification & Developer Integration Example

- **OpenAPI 3.1 Spec**: [docs/openapi-v1.json](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/docs/openapi-v1.json) (also served live at `GET /v1/openapi.json`).
- **End-to-End Integration Example**: [examples/platform-sdk-quickstart.ts](file:///c:/Users/vishn/Desktop/my%20project/mygamingslot/examples/platform-sdk-quickstart.ts) (verified live run creating org/project/tenant/API key, provisioning location & simulator bay, creating/converting hold via `OneLineBookingClient`, dispatching 4 signed HMAC webhook events, and reading deduplicated `usage_records`).

---

## 9. Unresolved Operational Limitations (Honest Scope)

1. **In-memory rate limiting and admission queues** are per-API-process rather than globally coordinated across horizontal replicas; production deployments behind multiple instances should front `/v1` with edge rate limiting (e.g. Envoy/API Gateway) or a shared counter when strict global per-key quotas are required.
2. **Webhook SSRF filtering**: Endpoint URL validation enforces `http:`/`https:` syntax; deployments handling untrusted third-party webhook URLs in shared infrastructure should add DNS-resolution private-IP/loopback egress blocking (`169.254.0.0/16`, `10.0.0.0/8`, `127.0.0.0/8`).
3. **Long-duration soak & live PgBouncer container**: `test:soak:30m` and `test:soak:60m` scripts and the `compose.yaml` `pgbouncer` service profile are implemented cleanly, while live verification in this workspace executed a 15s smoke soak and direct budgeted 4-process PostgreSQL connections (`max = 21` per process).
4. **TLS termination**: `createPlatformHttpServer` binds HTTP (`node:http`); production deployments must terminate TLS at an ingress reverse proxy/load balancer.

