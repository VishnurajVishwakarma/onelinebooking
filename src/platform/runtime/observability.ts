import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { redactSecrets } from "../control-plane.js";

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceparent: string;
}

const CUSTOMER_PII_PATTERN = /("?(?:externalCustomerId|email|customerEmail|phone)"?\s*:\s*)"([^"]{1,120})"/gi;

export function sanitizeTelemetryText(input: string): string {
  return redactSecrets(input).replace(CUSTOMER_PII_PATTERN, '$1"[REDACTED_PII]"');
}

export function sanitizeTelemetryObject(obj: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(sanitizeTelemetryText(JSON.stringify(obj))) as Record<string, unknown>;
}

/**
 * Parses incoming W3C traceparent (`00-<traceId>-<spanId>-<flags>`) or generates a fresh trace context.
 */
export function resolveTraceContext(incomingTraceparent?: string): TraceContext {
  const match = incomingTraceparent
    ? /^00-([a-f0-9]{32})-([a-f0-9]{16})-[a-f0-9]{2}$/i.exec(incomingTraceparent.trim())
    : null;
  const traceId = match ? match[1]!.toLowerCase() : randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  return {
    traceId,
    spanId,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

/**
 * Thread-safe process-local operational metrics registry rendered in Prometheus exposition format.
 */
export class PlatformMetricsRegistry {
  private readonly httpRequestsTotal = new Map<string, number>();
  private readonly httpDurationSumMs = new Map<string, number>();
  private readonly webhookDeliveriesTotal = new Map<string, number>();
  private readonly holdExpiriesTotal = { runs: 0, expiredHolds: 0 };

  recordHttpRequest(method: string, pathTemplate: string, status: number, durationMs: number): void {
    const key = `${method}|${pathTemplate}|${status}`;
    this.httpRequestsTotal.set(key, (this.httpRequestsTotal.get(key) ?? 0) + 1);
    const latKey = `${method}|${pathTemplate}`;
    this.httpDurationSumMs.set(latKey, (this.httpDurationSumMs.get(latKey) ?? 0) + durationMs);
  }

  recordWebhookOutcome(status: "delivered" | "retrying" | "dead_letter"): void {
    this.webhookDeliveriesTotal.set(status, (this.webhookDeliveriesTotal.get(status) ?? 0) + 1);
  }

  recordHoldExpiryRun(expiredCount: number): void {
    this.holdExpiriesTotal.runs += 1;
    this.holdExpiriesTotal.expiredHolds += expiredCount;
  }

  toPrometheusText(pool?: Pool): string {
    const lines: string[] = [
      "# HELP olb_http_requests_total Total HTTP requests handled by OneLineBooking API",
      "# TYPE olb_http_requests_total counter",
    ];
    for (const [k, v] of this.httpRequestsTotal.entries()) {
      const [method, path, status] = k.split("|");
      lines.push(`olb_http_requests_total{method="${method}",path="${path}",status="${status}"} ${v}`);
    }

    lines.push(
      "# HELP olb_http_request_duration_ms_sum Sum of HTTP request durations in milliseconds",
      "# TYPE olb_http_request_duration_ms_sum counter",
    );
    for (const [k, v] of this.httpDurationSumMs.entries()) {
      const [method, path] = k.split("|");
      lines.push(`olb_http_request_duration_ms_sum{method="${method}",path="${path}"} ${Math.round(v * 100) / 100}`);
    }

    lines.push(
      "# HELP olb_webhook_deliveries_total Webhook delivery attempt outcomes",
      "# TYPE olb_webhook_deliveries_total counter",
    );
    for (const [status, count] of this.webhookDeliveriesTotal.entries()) {
      lines.push(`olb_webhook_deliveries_total{status="${status}"} ${count}`);
    }

    lines.push(
      "# HELP olb_hold_expiries_total Total stale holds expired by managed worker",
      "# TYPE olb_hold_expiries_total counter",
      `olb_hold_expiries_total ${this.holdExpiriesTotal.expiredHolds}`,
    );

    if (pool) {
      lines.push(
        "# HELP olb_pg_pool_connections PostgreSQL pg-pool connection gauges",
        "# TYPE olb_pg_pool_connections gauge",
        `olb_pg_pool_connections{state="total"} ${pool.totalCount}`,
        `olb_pg_pool_connections{state="idle"} ${pool.idleCount}`,
        `olb_pg_pool_connections{state="waiting"} ${pool.waitingCount}`,
      );
    }

    return `${lines.join("\n")}\n`;
  }
}

export interface ReadinessReport {
  ready: boolean;
  postgresOk: boolean;
  pgVersion: string | null;
  pendingOutboxEvents: number;
  oldestPendingOutboxLagSeconds: number;
  overdueActiveHoldsCount: number;
  maxHoldExpirationLagSeconds: number;
  deadLetterWebhookCount: number;
  activeConnections: number;
  maxConnections: number;
}

/**
 * Checks PostgreSQL connectivity, backlog saturation (outbox lag, hold expiry lag), and connection headroom.
 */
export async function checkPlatformReadiness(pool: Pool): Promise<ReadinessReport> {
  try {
    const res = await pool.query<{
      pg_version: string;
      pending_outbox: number;
      oldest_outbox_lag_s: number;
      overdue_holds: number;
      max_hold_lag_s: number;
      dlq_count: number;
      active_conns: number;
      max_conns: number;
    }>(`
      SELECT
        current_setting('server_version') AS pg_version,
        (SELECT count(*)::int FROM outbox_events WHERE status = 'pending') AS pending_outbox,
        COALESCE((SELECT EXTRACT(EPOCH FROM (now() - min(recorded_at)))::float8 FROM outbox_events WHERE status = 'pending'), 0) AS oldest_outbox_lag_s,
        (SELECT count(*)::int FROM holds WHERE state = 'active' AND expires_at < now()) AS overdue_holds,
        COALESCE((SELECT EXTRACT(EPOCH FROM (now() - min(expires_at)))::float8 FROM holds WHERE state = 'active' AND expires_at < now()), 0) AS max_hold_lag_s,
        (SELECT count(*)::int FROM webhook_deliveries WHERE status = 'dead_letter') AS dlq_count,
        (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS active_conns,
        current_setting('max_connections')::int AS max_conns
    `);
    const r = res.rows[0]!;
    return {
      ready: true,
      postgresOk: true,
      pgVersion: r.pg_version,
      pendingOutboxEvents: Number(r.pending_outbox),
      oldestPendingOutboxLagSeconds: Math.max(0, Math.round(Number(r.oldest_outbox_lag_s) * 100) / 100),
      overdueActiveHoldsCount: Number(r.overdue_holds),
      maxHoldExpirationLagSeconds: Math.max(0, Math.round(Number(r.max_hold_lag_s) * 100) / 100),
      deadLetterWebhookCount: Number(r.dlq_count),
      activeConnections: Number(r.active_conns),
      maxConnections: Number(r.max_conns),
    };
  } catch {
    return {
      ready: false,
      postgresOk: false,
      pgVersion: null,
      pendingOutboxEvents: -1,
      oldestPendingOutboxLagSeconds: -1,
      overdueActiveHoldsCount: -1,
      maxHoldExpirationLagSeconds: -1,
      deadLetterWebhookCount: -1,
      activeConnections: -1,
      maxConnections: -1,
    };
  }
}

export interface RetentionCleanupResult {
  deletedApiIdempotency: number;
  deletedEngineIdempotency: number;
  deletedRateLimitCounters: number;
  deletedRequestLogs: number;
  deletedDeliveredOutbox: number;
}

/**
 * Bounded retention cleanup preserving financial/booking/usage/audit ledger integrity while pruning ephemeral operational tables.
 */
export async function runSafeRetentionCleanup(
  pool: Pool,
  options?: {
    requestLogRetentionDays?: number;
    deliveredOutboxRetentionDays?: number;
    batchLimit?: number;
  },
): Promise<RetentionCleanupResult> {
  const logDays = options?.requestLogRetentionDays ?? 30;
  const outboxDays = options?.deliveredOutboxRetentionDays ?? 14;
  const limit = options?.batchLimit ?? 5_000;

  const r1 = await pool.query(
    `DELETE FROM api_idempotency_records
     WHERE ctid IN (SELECT ctid FROM api_idempotency_records WHERE expires_at <= now() LIMIT $1)`,
    [limit],
  );
  const r2 = await pool.query(
    `DELETE FROM idempotency_records
     WHERE ctid IN (SELECT ctid FROM idempotency_records WHERE expires_at <= now() LIMIT $1)`,
    [limit],
  );
  const r3 = await pool.query(
    `DELETE FROM distributed_rate_limit_counters
     WHERE ctid IN (SELECT ctid FROM distributed_rate_limit_counters WHERE expires_at <= now() LIMIT $1)`,
    [limit],
  );
  const r4 = await pool.query(
    `DELETE FROM api_request_logs
     WHERE id IN (
       SELECT id FROM api_request_logs WHERE created_at < now() - ($1::int * interval '1 day') LIMIT $2
     )`,
    [logDays, limit],
  );
  const r5 = await pool.query(
    `DELETE FROM outbox_events
     WHERE id IN (
       SELECT id FROM outbox_events WHERE status = 'delivered' AND delivered_at < now() - ($1::int * interval '1 day') LIMIT $2
     )`,
    [outboxDays, limit],
  );

  return {
    deletedApiIdempotency: r1.rowCount ?? 0,
    deletedEngineIdempotency: r2.rowCount ?? 0,
    deletedRateLimitCounters: r3.rowCount ?? 0,
    deletedRequestLogs: r4.rowCount ?? 0,
    deletedDeliveredOutbox: r5.rowCount ?? 0,
  };
}
