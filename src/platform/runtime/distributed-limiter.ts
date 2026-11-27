import type { Pool } from "pg";
import { BookingError } from "../../domain/errors.js";
import type { RateLimitDecision } from "./concurrency-limiter.js";

export interface DistributedLimiterOptions {
  instanceId: string;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  maxTenantConcurrentLeases: number;
  leaseTtlSeconds: number;
}

/**
 * Multi-instance distributed rate limiter and tenant concurrency lease controller backed by PostgreSQL.
 * Bounds noisy-neighbor bursts across horizontal API replicas using atomic UPSERTs and expiring lease rows.
 */
export class PostgresDistributedLimiter {
  private readonly options: DistributedLimiterOptions;

  constructor(
    private readonly pool: Pool,
    options?: Partial<DistributedLimiterOptions>,
  ) {
    this.options = {
      instanceId: options?.instanceId ?? `api-${process.pid}`,
      rateLimitWindowMs: options?.rateLimitWindowMs ?? 60_000,
      rateLimitMaxRequests: options?.rateLimitMaxRequests ?? 1_200,
      maxTenantConcurrentLeases: options?.maxTenantConcurrentLeases ?? 40,
      leaseTtlSeconds: options?.leaseTtlSeconds ?? 20,
    };
  }

  async checkAndIncrementRateLimit(bucketKey: string, nowMs = Date.now()): Promise<RateLimitDecision> {
    const windowMs = this.options.rateLimitWindowMs;
    const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
    const resetMs = windowStartMs + windowMs;
    const resetAtEpochSeconds = Math.ceil(resetMs / 1000);
    const expiresAt = new Date(resetMs + 60_000);

    const res = await this.pool.query<{ request_count: number }>(
      `INSERT INTO distributed_rate_limit_counters (bucket_key, window_start_ms, request_count, expires_at)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (bucket_key, window_start_ms)
       DO UPDATE SET request_count = distributed_rate_limit_counters.request_count + 1
       RETURNING request_count`,
      [bucketKey, windowStartMs, expiresAt],
    );

    const count = Number(res.rows[0]?.request_count ?? 1);
    if (count > this.options.rateLimitMaxRequests) {
      return {
        allowed: false,
        limit: this.options.rateLimitMaxRequests,
        remaining: 0,
        resetAtEpochSeconds,
        retryAfterSeconds: Math.max(1, Math.ceil((resetMs - nowMs) / 1000)),
      };
    }

    return {
      allowed: true,
      limit: this.options.rateLimitMaxRequests,
      remaining: Math.max(0, this.options.rateLimitMaxRequests - count),
      resetAtEpochSeconds,
      retryAfterSeconds: 0,
    };
  }

  /**
   * Acquires a cross-instance expiring lease slot for `tenantScope` under an advisory transaction lock.
   * Ensures crashed instances cannot permanently hold concurrency slots past `leaseTtlSeconds`.
   */
  async acquireTenantLease(tenantScope: string): Promise<() => Promise<void>> {
    const client = await this.pool.connect();
    let leaseId: string | null = null;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7))", [
        `tenant-lease:${tenantScope}`,
      ]);
      // Reclaim expired leases cleanly before checking active ceiling
      await client.query(
        `DELETE FROM distributed_tenant_leases
         WHERE tenant_scope = $1 AND expires_at <= now()`,
        [tenantScope],
      );
      const countRes = await client.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt
         FROM distributed_tenant_leases
         WHERE tenant_scope = $1 AND expires_at > now()`,
        [tenantScope],
      );
      const activeCount = Number(countRes.rows[0]?.cnt ?? 0);
      if (activeCount >= this.options.maxTenantConcurrentLeases) {
        await client.query("ROLLBACK");
        throw new BookingError(
          "TEMPORARY_UNAVAILABLE",
          "Distributed tenant concurrency limit exceeded across API cluster",
          {
            retryable: true,
            details: {
              reason: "TENANT_CONCURRENCY_LIMIT",
              maxTenantConcurrentLeases: this.options.maxTenantConcurrentLeases,
              retryAfterSeconds: 1,
            },
          },
        );
      }

      const insRes = await client.query<{ id: string }>(
        `INSERT INTO distributed_tenant_leases (tenant_scope, instance_id, expires_at)
         VALUES ($1, $2, now() + ($3::int * interval '1 second'))
         RETURNING id`,
        [tenantScope, this.options.instanceId, this.options.leaseTtlSeconds],
      );
      leaseId = insRes.rows[0]!.id;
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    let released = false;
    return async () => {
      if (released || !leaseId) return;
      released = true;
      await this.pool
        .query(`DELETE FROM distributed_tenant_leases WHERE id = $1`, [leaseId])
        .catch(() => {});
    };
  }
}

