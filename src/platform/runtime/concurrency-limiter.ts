import { BookingError } from "../../domain/errors.js";

export interface LimiterOptions {
  /** Maximum requests executing simultaneously on this API instance. */
  maxConcurrentRequests: number;
  /** Maximum queued requests waiting for an execution slot before failing fast. */
  maxQueueDepth: number;
  /** Maximum milliseconds a queued request waits before timing out with Retry-After. */
  queueTimeoutMs: number;
  /** Maximum concurrent in-flight requests allowed for any single tenant on this instance. */
  maxPerTenantInFlight: number;
  /** Rate limit window length in milliseconds. */
  rateLimitWindowMs: number;
  /** Maximum requests permitted per credential/tenant inside each window. */
  rateLimitMaxRequests: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtEpochSeconds: number;
  retryAfterSeconds: number;
}

export interface LimiterStats {
  inFlight: number;
  queueDepth: number;
  maxConcurrentRequests: number;
  maxQueueDepth: number;
  rejectedQueueFull: number;
  rejectedTenantConcurrency: number;
  rejectedRateLimit: number;
  rejectedQueueTimeout: number;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  tenantKey: string;
}

/**
 * Provides bounded process-local request admission control:
 * 1) Fixed-window rate limiting per API credential/tenant
 * 2) Per-tenant in-flight concurrency isolation (noisy-neighbor protection)
 * 3) Global execution concurrency + bounded wait queue with fail-fast Retry-After guidance
 */
export class RuntimeTrafficLimiter {
  private readonly options: LimiterOptions;
  private activeCount = 0;
  private readonly queue: Waiter[] = [];
  private readonly tenantInFlight = new Map<string, number>();
  private readonly rateBuckets = new Map<string, { windowStartMs: number; count: number }>();

  private rejectedQueueFull = 0;
  private rejectedTenantConcurrency = 0;
  private rejectedRateLimit = 0;
  private rejectedQueueTimeout = 0;

  constructor(options?: Partial<LimiterOptions>) {
    this.options = {
      maxConcurrentRequests: options?.maxConcurrentRequests ?? 64,
      maxQueueDepth: options?.maxQueueDepth ?? 128,
      queueTimeoutMs: options?.queueTimeoutMs ?? 2_000,
      maxPerTenantInFlight: options?.maxPerTenantInFlight ?? 24,
      rateLimitWindowMs: options?.rateLimitWindowMs ?? 60_000,
      rateLimitMaxRequests: options?.rateLimitMaxRequests ?? 1_200,
    };
  }

  checkRateLimit(bucketKey: string, nowMs = Date.now()): RateLimitDecision {
    const { rateLimitWindowMs, rateLimitMaxRequests } = this.options;
    let bucket = this.rateBuckets.get(bucketKey);
    if (!bucket || nowMs - bucket.windowStartMs >= rateLimitWindowMs) {
      bucket = { windowStartMs: nowMs, count: 0 };
      this.rateBuckets.set(bucketKey, bucket);
    }

    const resetMs = bucket.windowStartMs + rateLimitWindowMs;
    const resetAtEpochSeconds = Math.ceil(resetMs / 1000);
    if (bucket.count >= rateLimitMaxRequests) {
      this.rejectedRateLimit += 1;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetMs - nowMs) / 1000));
      return {
        allowed: false,
        limit: rateLimitMaxRequests,
        remaining: 0,
        resetAtEpochSeconds,
        retryAfterSeconds,
      };
    }

    bucket.count += 1;
    // Bound map growth in long-running processes
    if (this.rateBuckets.size > 10_000) {
      for (const [key, entry] of this.rateBuckets.entries()) {
        if (nowMs - entry.windowStartMs >= rateLimitWindowMs) {
          this.rateBuckets.delete(key);
        }
      }
    }

    return {
      allowed: true,
      limit: rateLimitMaxRequests,
      remaining: Math.max(0, rateLimitMaxRequests - bucket.count),
      resetAtEpochSeconds,
      retryAfterSeconds: 0,
    };
  }

  async acquire(tenantKey: string): Promise<() => void> {
    const currentTenantCount = this.tenantInFlight.get(tenantKey) ?? 0;
    if (currentTenantCount >= this.options.maxPerTenantInFlight) {
      this.rejectedTenantConcurrency += 1;
      throw new BookingError(
        "TEMPORARY_UNAVAILABLE",
        "Tenant concurrency limit exceeded",
        {
          retryable: true,
          details: {
            reason: "TENANT_CONCURRENCY_LIMIT",
            maxPerTenantInFlight: this.options.maxPerTenantInFlight,
            retryAfterSeconds: 1,
          },
        },
      );
    }

    this.tenantInFlight.set(tenantKey, currentTenantCount + 1);
    let released = false;

    const releaseTenantSlot = (): void => {
      const next = (this.tenantInFlight.get(tenantKey) ?? 1) - 1;
      if (next <= 0) {
        this.tenantInFlight.delete(tenantKey);
      } else {
        this.tenantInFlight.set(tenantKey, next);
      }
    };

    if (this.activeCount < this.options.maxConcurrentRequests) {
      this.activeCount += 1;
      return () => {
        if (released) return;
        released = true;
        releaseTenantSlot();
        this.releaseGlobalSlot();
      };
    }

    if (this.queue.length >= this.options.maxQueueDepth) {
      releaseTenantSlot();
      this.rejectedQueueFull += 1;
      throw new BookingError(
        "TEMPORARY_UNAVAILABLE",
        "API request queue is saturated",
        {
          retryable: true,
          details: {
            reason: "QUEUE_SATURATED",
            maxQueueDepth: this.options.maxQueueDepth,
            retryAfterSeconds: 1,
          },
        },
      );
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        tenantKey,
        timer: setTimeout(() => {
          const idx = this.queue.indexOf(waiter);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
          }
          releaseTenantSlot();
          this.rejectedQueueTimeout += 1;
          reject(
            new BookingError(
              "TEMPORARY_UNAVAILABLE",
              "Timed out waiting in API admission queue",
              {
                retryable: true,
                details: {
                  reason: "QUEUE_TIMEOUT",
                  queueTimeoutMs: this.options.queueTimeoutMs,
                  retryAfterSeconds: 1,
                },
              },
            ),
          );
        }, this.options.queueTimeoutMs),
      };
      this.queue.push(waiter);
    });

    return () => {
      if (released) return;
      released = true;
      releaseTenantSlot();
      this.releaseGlobalSlot();
    };
  }

  private releaseGlobalSlot(): void {
    const nextWaiter = this.queue.shift();
    if (nextWaiter) {
      clearTimeout(nextWaiter.timer);
      // activeCount stays unchanged because the slot transfers directly to nextWaiter
      nextWaiter.resolve();
      return;
    }
    this.activeCount = Math.max(0, this.activeCount - 1);
  }

  getStats(): LimiterStats {
    return {
      inFlight: this.activeCount,
      queueDepth: this.queue.length,
      maxConcurrentRequests: this.options.maxConcurrentRequests,
      maxQueueDepth: this.options.maxQueueDepth,
      rejectedQueueFull: this.rejectedQueueFull,
      rejectedTenantConcurrency: this.rejectedTenantConcurrency,
      rejectedRateLimit: this.rejectedRateLimit,
      rejectedQueueTimeout: this.rejectedQueueTimeout,
    };
  }
}

