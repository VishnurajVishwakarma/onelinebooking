import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { TimeSlotEngine } from "../../application/time-slot-engine.js";
import { PlatformService, mapWebhookDeliveryRow } from "../control-plane.js";
import type { WebhookDeliveryRecord } from "../model.js";
import type { PlatformMetricsRegistry } from "../runtime/observability.js";
import { sendSsrfProtectedWebhookPost, type SsrfValidationOptions } from "../security/ssrf.js";

export interface WebhookSignatureParts {
  timestampSeconds: number;
  signatures: string[];
}

export function signWebhookPayload(
  secret: string,
  payloadJson: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
  previousSecret?: string,
): { headerValue: string; timestampSeconds: number; digestHex: string } {
  const signedPayload = `${timestampSeconds}.${payloadJson}`;
  const digestHex = createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
  const sigParts = [`t=${timestampSeconds}`, `v1=${digestHex}`];
  if (previousSecret) {
    const prevDigestHex = createHmac("sha256", previousSecret)
      .update(signedPayload, "utf8")
      .digest("hex");
    sigParts.push(`v1=${prevDigestHex}`);
  }
  return {
    headerValue: sigParts.join(","),
    timestampSeconds,
    digestHex,
  };
}

export function parseWebhookSignatureHeader(header: string): WebhookSignatureParts | null {
  const parts = header.split(",").map((p) => p.trim());
  let timestampSeconds: number | null = null;
  const signatures: string[] = [];
  for (const part of parts) {
    const [k, v] = part.split("=", 2);
    if (k === "t" && v) {
      const parsed = Number(v);
      if (Number.isInteger(parsed) && parsed > 0) {
        timestampSeconds = parsed;
      }
    } else if (k === "v1" && v) {
      signatures.push(v);
    }
  }
  if (timestampSeconds === null || signatures.length === 0) return null;
  return { timestampSeconds, signatures };
}

/**
 * Verifies an incoming `X-OneLine-Signature` header using HMAC-SHA256 + constant-time comparison
 * and bounded timestamp replay tolerance.
 */
export function verifyWebhookSignature(input: {
  secret: string;
  payloadJson: string;
  signatureHeader: string;
  toleranceSeconds?: number | undefined;
  nowSeconds?: number | undefined;
}): boolean {
  const parsed = parseWebhookSignatureHeader(input.signatureHeader);
  if (!parsed) return false;
  const tolerance = input.toleranceSeconds ?? 300;
  const nowSec = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parsed.timestampSeconds) > tolerance) {
    return false;
  }

  const expectedHex = signWebhookPayload(
    input.secret,
    input.payloadJson,
    parsed.timestampSeconds,
  ).digestHex;
  const expectedBuf = Buffer.from(expectedHex, "hex");

  for (const candidateHex of parsed.signatures) {
    if (!/^[a-f0-9]+$/i.test(candidateHex)) continue;
    const candidateBuf = Buffer.from(candidateHex, "hex");
    if (candidateBuf.length === expectedBuf.length && timingSafeEqual(expectedBuf, candidateBuf)) {
      return true;
    }
  }
  return false;
}

export interface OutboxWebhookWorkerOptions {
  pool: Pool;
  engine: TimeSlotEngine;
  platform: PlatformService;
  pollIntervalMs?: number | undefined;
  batchSize?: number | undefined;
  deliveryTimeoutMs?: number | undefined;
  maxAttempts?: number | undefined;
  baseRetryDelaySeconds?: number | undefined;
  /** Optional tenant scoping to avoid claiming another suite's events in shared-DB integration tests. */
  tenantFilter?: readonly string[] | undefined;
  /** Optional custom HTTP transport (for mocked transport tests); defaults to SSRF-protected transport. */
  fetchFn?: typeof fetch | undefined;
  /** SSRF network egress options (production defaults forbid HTTP and private/loopback/metadata IPs). */
  ssrfOptions?: SsrfValidationOptions | undefined;
  /** Optional Prometheus/observability metrics registry. */
  metricsRegistry?: PlatformMetricsRegistry | undefined;
  onError?: ((error: unknown) => void) | undefined;
}

/**
 * Managed worker with two stages:
 * 1) Polls transactional `outbox_events` and fans them out idempotently into `webhook_deliveries`
 * 2) Dispatches pending/retrying `webhook_deliveries` via HMAC-signed HTTP POST with exponential backoff & dead-lettering.
 */
export class OutboxWebhookWorker {
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly deliveryTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseRetryDelaySeconds: number;
  private readonly fetchImpl: typeof fetch | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: OutboxWebhookWorkerOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.batchSize = options.batchSize ?? 50;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseRetryDelaySeconds = options.baseRetryDelaySeconds ?? 2;
    this.fetchImpl = options.fetchFn;
  }

  /**
   * Fans out due outbox events to active matching webhook endpoints and acks the outbox event.
   */
  async dispatchOutboxToDeliveries(): Promise<{ claimedEvents: number; queuedDeliveries: number }> {
    const events = this.options.tenantFilter?.length
      ? await this.claimScopedOutboxEvents(this.options.tenantFilter)
      : await this.options.engine.claimEvents({ limit: this.batchSize, leaseSeconds: 30 });

    let queuedDeliveries = 0;

    for (const evt of events) {
      const endpointsRes = await this.options.pool.query(
        `SELECT id, organization_id, project_id, environment_id, tenant_id, event_types
         FROM webhook_endpoints
         WHERE tenant_id = $1 AND active = true`,
        [evt.tenantId],
      );

      for (const row of endpointsRes.rows as Array<{
        id: string;
        organization_id: string;
        project_id: string;
        environment_id: string;
        tenant_id: string;
        event_types: string[];
      }>) {
        const subscribed =
          row.event_types.length === 0 || row.event_types.includes(evt.eventType);
        if (!subscribed) continue;

        const envelope = {
          id: evt.id,
          type: evt.eventType,
          schemaVersion: evt.schemaVersion,
          tenantId: evt.tenantId,
          environmentId: row.environment_id,
          aggregateType: evt.aggregateType,
          aggregateId: evt.aggregateId,
          aggregateSequence: evt.aggregateSequence,
          occurredAt: evt.occurredAt,
          data: evt.payload,
        };

        const insertRes = await this.options.pool.query(
          `INSERT INTO webhook_deliveries (
            organization_id, project_id, environment_id, tenant_id,
            outbox_event_id, endpoint_id, event_type, payload, max_attempts
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
          ON CONFLICT (outbox_event_id, endpoint_id) DO NOTHING
          RETURNING id`,
          [
            row.organization_id,
            row.project_id,
            row.environment_id,
            row.tenant_id,
            evt.id,
            row.id,
            evt.eventType,
            JSON.stringify(envelope),
            this.maxAttempts,
          ],
        );
        if ((insertRes.rowCount ?? 0) > 0) {
          queuedDeliveries += 1;
        }
      }

      if (evt.leaseToken) {
        await this.options.engine.ackEvent(evt.id, evt.leaseToken);
      }
    }

    return { claimedEvents: events.length, queuedDeliveries };
  }

  private async claimScopedOutboxEvents(tenantIds: readonly string[]) {
    const client = await this.options.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `WITH candidate AS (
          SELECT id
          FROM outbox_events
          WHERE status = 'pending'
            AND tenant_id = ANY($1::uuid[])
            AND next_attempt_at <= now()
            AND (lease_expires_at IS NULL OR lease_expires_at <= now())
          ORDER BY recorded_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        )
        UPDATE outbox_events o
        SET lease_token = gen_random_uuid(),
            lease_expires_at = now() + interval '30 seconds',
            attempts = o.attempts + 1
        FROM candidate
        WHERE o.id = candidate.id
        RETURNING o.*`,
        [tenantIds, this.batchSize],
      );
      await client.query("COMMIT");
      return res.rows.map((r) => ({
        id: String(r.id),
        tenantId: String(r.tenant_id),
        aggregateType: String(r.aggregate_type),
        aggregateId: String(r.aggregate_id),
        aggregateSequence: Number(r.aggregate_sequence),
        eventType: String(r.event_type),
        schemaVersion: Number(r.schema_version),
        payload: (r.payload as Record<string, unknown>) ?? {},
        occurredAt: new Date(String(r.occurred_at)).toISOString(),
        recordedAt: new Date(String(r.recorded_at)).toISOString(),
        status: r.status as "pending" | "failed" | "delivered",
        attempts: Number(r.attempts),
        maxAttempts: Number(r.max_attempts),
        nextAttemptAt: new Date(String(r.next_attempt_at)).toISOString(),
        leaseToken: r.lease_token != null ? String(r.lease_token) : null,
        leaseExpiresAt: r.lease_expires_at != null ? new Date(String(r.lease_expires_at)).toISOString() : null,
        lastError: r.last_error != null ? String(r.last_error) : null,
      }));
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Claims due webhook deliveries (`FOR UPDATE SKIP LOCKED`) and sends signed HTTP POST requests.
   */
  async deliverPendingWebhooks(): Promise<{
    attempted: number;
    delivered: number;
    retrying: number;
    deadLettered: number;
  }> {
    const client = await this.options.pool.connect();
    let dueRows: Array<{
      delivery: WebhookDeliveryRecord;
      url: string;
      primarySecret: string;
      previousSecret?: string;
      endpointActive: boolean;
    }> = [];

    try {
      await client.query("BEGIN");
      const res = await client.query(
        `WITH candidate AS (
          SELECT d.id
          FROM webhook_deliveries d
          WHERE d.status IN ('pending', 'retrying')
            AND d.next_attempt_at <= now()
            AND ($1::uuid[] IS NULL OR d.tenant_id = ANY($1::uuid[]))
          ORDER BY d.next_attempt_at ASC
          FOR UPDATE OF d SKIP LOCKED
          LIMIT $2
        )
        SELECT d.*, e.url, e.signing_secret, e.signing_secret_encrypted,
               e.previous_signing_secret_encrypted, e.previous_secret_expires_at,
               e.active AS endpoint_active
        FROM webhook_deliveries d
        JOIN candidate c ON c.id = d.id
        JOIN webhook_endpoints e ON e.id = d.endpoint_id`,
        [this.options.tenantFilter?.length ? this.options.tenantFilter : null, this.batchSize],
      );

      dueRows = res.rows.map((r) => {
        const secrets = this.options.platform.resolveEndpointSecrets({
          signing_secret: r.signing_secret as string | null,
          signing_secret_encrypted: r.signing_secret_encrypted as string | null,
          previous_signing_secret_encrypted: r.previous_signing_secret_encrypted as string | null,
          previous_secret_expires_at: r.previous_secret_expires_at as Date | string | null,
        });
        return {
          delivery: mapWebhookDeliveryRow(r as Record<string, unknown>),
          url: String(r.url),
          primarySecret: secrets.primary,
          ...(secrets.previous ? { previousSecret: secrets.previous } : {}),
          endpointActive: Boolean(r.endpoint_active),
        };
      });

      // Bump next_attempt_at as a short lease before releasing transaction lock during network I/O
      if (dueRows.length > 0) {
        await client.query(
          `UPDATE webhook_deliveries
           SET next_attempt_at = now() + interval '15 seconds',
               updated_at = now()
           WHERE id = ANY($1::uuid[])`,
          [dueRows.map((x) => x.delivery.id)],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    let delivered = 0;
    let retrying = 0;
    let deadLettered = 0;

    for (const item of dueRows) {
      const { delivery } = item;
      const attemptNum = delivery.attempts + 1;

      if (!item.endpointActive) {
        await this.markDeadLetter(delivery.id, attemptNum, null, "Endpoint disabled");
        deadLettered += 1;
        continue;
      }

      const payloadJson = JSON.stringify(delivery.payload);
      const sig = signWebhookPayload(
        item.primarySecret,
        payloadJson,
        Math.floor(Date.now() / 1000),
        item.previousSecret,
      );
      const headers = {
        "Content-Type": "application/json",
        "User-Agent": "OneLineBooking-Webhook/1.0",
        "X-OneLine-Event-Id": delivery.outboxEventId,
        "X-OneLine-Delivery-Id": delivery.id,
        "X-OneLine-Event-Type": delivery.eventType,
        "X-OneLine-Signature": sig.headerValue,
      };

      try {
        let status: number;
        let excerpt: string;

        if (this.fetchImpl) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), this.deliveryTimeoutMs);
          timeout.unref();
          try {
            const response = await this.fetchImpl(item.url, {
              method: "POST",
              headers,
              body: payloadJson,
              redirect: "manual",
              signal: controller.signal,
            });
            status = response.status;
            const text = await response.text().catch(() => "");
            excerpt = text.slice(0, 500);
          } finally {
            clearTimeout(timeout);
          }
        } else {
          const result = await sendSsrfProtectedWebhookPost({
            url: item.url,
            headers,
            body: payloadJson,
            timeoutMs: this.deliveryTimeoutMs,
            ssrfOptions: this.options.ssrfOptions,
          });
          status = result.status;
          excerpt = result.bodyExcerpt;
        }

        if (status >= 200 && status < 300) {
          await this.options.pool.query(
            `UPDATE webhook_deliveries
             SET status = 'delivered',
                 attempts = $2,
                 response_status = $3,
                 response_body_excerpt = $4,
                 last_error = NULL,
                 delivered_at = now(),
                 last_attempt_at = now(),
                 updated_at = now()
             WHERE id = $1`,
            [delivery.id, attemptNum, status, excerpt],
          );
          await this.options.platform.recordUsage({
            organizationId: delivery.organizationId,
            projectId: delivery.projectId,
            environmentId: delivery.environmentId,
            tenantId: delivery.tenantId,
            scopeKey: delivery.tenantId,
            metric: "webhook_delivered",
            idempotencyKey: `wh:${delivery.id}:${delivery.replayedCount}`,
            metadata: { endpointId: delivery.endpointId, eventType: delivery.eventType },
          });
          this.options.metricsRegistry?.recordWebhookOutcome("delivered");
          delivered += 1;
        } else if (attemptNum >= delivery.maxAttempts) {
          await this.markDeadLetter(
            delivery.id,
            attemptNum,
            status,
            `HTTP ${status}: ${excerpt}`,
          );
          this.options.metricsRegistry?.recordWebhookOutcome("dead_letter");
          deadLettered += 1;
        } else {
          await this.markRetry(
            delivery.id,
            attemptNum,
            status,
            `HTTP ${status}: ${excerpt}`,
          );
          this.options.metricsRegistry?.recordWebhookOutcome("retrying");
          retrying += 1;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attemptNum >= delivery.maxAttempts) {
          await this.markDeadLetter(delivery.id, attemptNum, null, message);
          this.options.metricsRegistry?.recordWebhookOutcome("dead_letter");
          deadLettered += 1;
        } else {
          await this.markRetry(delivery.id, attemptNum, null, message);
          this.options.metricsRegistry?.recordWebhookOutcome("retrying");
          retrying += 1;
        }
      }
    }

    return { attempted: dueRows.length, delivered, retrying, deadLettered };
  }

  private async markRetry(
    deliveryId: string,
    attempts: number,
    responseStatus: number | null,
    errorMessage: string,
  ): Promise<void> {
    const delaySeconds = this.baseRetryDelaySeconds * 2 ** Math.max(0, attempts - 1);
    await this.options.pool.query(
      `UPDATE webhook_deliveries
       SET status = 'retrying',
           attempts = $2,
           response_status = $3,
           last_error = $4,
           last_attempt_at = now(),
           next_attempt_at = now() + ($5::int * interval '1 second'),
           updated_at = now()
       WHERE id = $1`,
      [deliveryId, attempts, responseStatus, errorMessage.slice(0, 500), delaySeconds],
    );
  }

  private async markDeadLetter(
    deliveryId: string,
    attempts: number,
    responseStatus: number | null,
    errorMessage: string,
  ): Promise<void> {
    await this.options.pool.query(
      `UPDATE webhook_deliveries
       SET status = 'dead_letter',
           attempts = $2,
           response_status = $3,
           last_error = $4,
           dead_lettered_at = now(),
           last_attempt_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [deliveryId, attempts, responseStatus, errorMessage.slice(0, 500)],
    );
  }

  async runOnce() {
    const fanned = await this.dispatchOutboxToDeliveries();
    const sent = await this.deliverPendingWebhooks();
    return { ...fanned, ...sent };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.runOnce()
        .catch((err) => {
          this.options.onError?.(err);
        })
        .finally(() => {
          this.running = false;
        });
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

