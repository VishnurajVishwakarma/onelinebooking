import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { TimeSlotEngine } from "../../application/time-slot-engine.js";
import { BookingError, type BookingErrorCode } from "../../domain/errors.js";
import { mapScopesToCapabilities, type AuthenticatedPrincipal, type PlatformScope } from "../model.js";
import { PlatformService, redactSecrets, sha256Hex } from "../control-plane.js";
import { RuntimeTrafficLimiter } from "../runtime/concurrency-limiter.js";
import { PostgresDistributedLimiter } from "../runtime/distributed-limiter.js";
import {
  PlatformMetricsRegistry,
  checkPlatformReadiness,
  resolveTraceContext,
  sanitizeTelemetryText,
} from "../runtime/observability.js";
import type { SsrfValidationOptions } from "../security/ssrf.js";
import { OPENAPI_V1_SPEC } from "./openapi.js";

export interface PlatformApiServerOptions {
  pool: Pool;
  engine: TimeSlotEngine;
  platform: PlatformService;
  limiter?: RuntimeTrafficLimiter | undefined;
  distributedLimiter?: PostgresDistributedLimiter | undefined;
  metricsRegistry?: PlatformMetricsRegistry | undefined;
  ssrfOptions?: SsrfValidationOptions | undefined;
  requestTimeoutMs?: number | undefined;
  maxBodyBytes?: number | undefined;
  maxResponseBytes?: number | undefined;
  corsAllowedOrigins?: string[] | undefined;
  /** Optional operational token required for `/v1/metrics` and detailed `/v1/ready` telemetry. */
  opsAuthToken?: string | undefined;
  meterUsage?: boolean | undefined;
  logRequestsToDb?: boolean | undefined;
  logger?: ((level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void) | undefined;
}

const createTenantBodySchema = z.object({
  name: z.string().min(1).max(200),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const createLocationBodySchema = z.object({
  name: z.string().min(1).max(200),
  timeZone: z.string().min(1).max(100),
  addressLine1: z.string().max(250).optional(),
  city: z.string().max(120).optional(),
  region: z.string().max(120).optional(),
  postalCode: z.string().max(40).optional(),
  country: z.string().length(2).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const attachLocationBodySchema = z.object({
  locationId: z.string().uuid(),
  resourceKind: z.string().min(1).max(60).optional(),
});

const createWebhookEndpointBodySchema = z.object({
  url: z.string().url(),
  description: z.string().max(240).optional(),
  eventTypes: z.array(z.string().min(1).max(120)).max(50).optional(),
});

function httpStatusForError(err: BookingError): { status: number; code: string; retryAfterSeconds?: number } {
  const map: Record<BookingErrorCode, number> = {
    INVALID_INPUT: 400,
    INVALID_CONFIGURATION: 400,
    INVALID_SLOT_SELECTION: 400,
    SLOT_NOT_FOUND: 400,
    QUERY_LIMIT_EXCEEDED: 400,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    FACILITY_INACTIVE: 422,
    OUTSIDE_OPERATING_HOURS: 422,
    MINIMUM_NOTICE_REQUIRED: 422,
    BOOKING_HORIZON_EXCEEDED: 422,
    POLICY_VIOLATION: 422,
    PRICE_CHANGED: 409,
    SLOT_CONFLICT: 409,
    BLACKOUT_CONFLICT: 409,
    BUFFER_CONFLICT: 409,
    HOLD_EXPIRED: 409,
    HOLD_LIMIT_EXCEEDED: 409,
    STALE_CONFIGURATION: 409,
    INVALID_STATE_TRANSITION: 409,
    IDEMPOTENCY_KEY_CONFLICT: 409,
    CONFIGURATION_CONFLICT: 409,
    TEMPORARY_UNAVAILABLE: 503,
    INTERNAL_ERROR: 500,
  };

  let status = map[err.code] ?? 500;
  let code: string = err.code;
  const retryAfterRaw = err.details?.retryAfterSeconds;
  const retryAfterSeconds = typeof retryAfterRaw === "number" ? retryAfterRaw : undefined;

  if (err.code === "TEMPORARY_UNAVAILABLE") {
    const reason = err.details?.reason;
    if (reason === "RATE_LIMITED" || reason === "TENANT_CONCURRENCY_LIMIT") {
      status = 429;
      code = reason;
    }
  }

  return {
    status,
    code,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJsonStringify(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonStringify(v)}`).join(",")}}`;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
  }
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new BookingError("INVALID_INPUT", `Request body exceeds limit of ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BookingError("INVALID_INPUT", "Malformed JSON request body");
  }
}

function getHeaderString(req: IncomingMessage, name: string): string | undefined {
  const val = req.headers[name.toLowerCase()];
  if (Array.isArray(val)) return val[0];
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : undefined;
}

function encodeCursor(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new BookingError("INVALID_INPUT", "Invalid pagination cursor");
  }
}

function assertScope(principal: AuthenticatedPrincipal, required: PlatformScope): void {
  if (!principal.scopes.includes(required)) {
    throw new BookingError("FORBIDDEN", `Missing required scope: ${required}`, {
      details: { requiredScope: required },
    });
  }
}

function resolveIdempotencyKey(req: IncomingMessage, body: Record<string, unknown> | undefined): string | undefined {
  const fromHeader = getHeaderString(req, "idempotency-key");
  const fromBody = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : undefined;
  if (fromHeader && fromBody && fromHeader !== fromBody) {
    throw new BookingError(
      "IDEMPOTENCY_KEY_CONFLICT",
      "Idempotency-Key header conflicts with body.idempotencyKey",
    );
  }
  return fromHeader ?? fromBody;
}

/**
 * Builds the versioned `/v1` HTTP REST API server wrapping TimeSlotEngine + PlatformService.
 */
export function createPlatformHttpServer(options: PlatformApiServerOptions): Server {
  const limiter = options.limiter ?? new RuntimeTrafficLimiter();
  const metrics = options.metricsRegistry ?? new PlatformMetricsRegistry();
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  const meterUsage = options.meterUsage ?? true;
  const logRequestsToDb = options.logRequestsToDb ?? true;
  const corsAllowlist = new Set((options.corsAllowedOrigins ?? []).map((o) => o.trim()).filter(Boolean));
  const opsToken = options.opsAuthToken?.trim() || process.env.OLB_OPS_TOKEN?.trim() || undefined;

  const isOpsAuthorized = (req: IncomingMessage): boolean => {
    if (!opsToken) return true;
    const xOps = getHeaderString(req, "x-ops-token");
    const auth = getHeaderString(req, "authorization");
    const candidate = xOps ?? (auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : undefined);
    if (!candidate) return false;
    const a = Buffer.from(opsToken, "utf8");
    const b = Buffer.from(candidate, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const log = (level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void => {
    if (!options.logger) return;
    const safeMsg = sanitizeTelemetryText(msg);
    const safeMeta = meta
      ? (JSON.parse(sanitizeTelemetryText(JSON.stringify(meta))) as Record<string, unknown>)
      : undefined;
    options.logger(level, safeMsg, safeMeta);
  };

  function emitBoundedJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    correlationId: string,
    headers?: Record<string, string>,
  ): number {
    const serialized = JSON.stringify(body);
    const byteLen = Buffer.byteLength(serialized);
    if (byteLen > maxResponseBytes) {
      const errBody = {
        error: {
          code: "INTERNAL_ERROR",
          category: "infrastructure",
          message: `Response payload exceeds maximum permitted size (${maxResponseBytes} bytes)`,
          retryable: false,
          correlationId,
        },
      };
      sendJson(res, 500, errBody);
      return Buffer.byteLength(JSON.stringify(errBody));
    }
    sendJson(res, status, body, headers);
    return byteLen;
  }

  async function resolveTenantIdForPrincipal(
    principal: AuthenticatedPrincipal,
    req: IncomingMessage,
    bodyObj?: Record<string, unknown>,
  ): Promise<string> {
    const headerTenantId = getHeaderString(req, "x-tenant-id");
    const bodyTenantId = typeof bodyObj?.tenantId === "string" ? bodyObj.tenantId.trim() : undefined;

    if (principal.tenantId !== null) {
      // Bound credential: NEVER allow client-supplied mismatched tenant IDs
      if (headerTenantId && headerTenantId !== principal.tenantId) {
        throw new BookingError("FORBIDDEN", "Cross-tenant access denied for tenant-bound API key");
      }
      if (bodyTenantId && bodyTenantId !== principal.tenantId) {
        throw new BookingError("FORBIDDEN", "Cross-tenant access denied for tenant-bound API key");
      }
      return principal.tenantId;
    }

    const candidate = headerTenantId ?? bodyTenantId;
    if (!candidate) {
      throw new BookingError(
        "INVALID_INPUT",
        "X-Tenant-Id header is required when using an environment-scoped API key",
      );
    }
    const tenant = await options.platform.getScopedTenant(principal.environmentId, candidate);
    if (!tenant) {
      throw new BookingError("FORBIDDEN", "Target tenant does not belong to authenticated environment");
    }
    return tenant.id;
  }

  async function tryReplayApiIdempotency(params: {
    environmentId: string;
    tenantScope: string;
    method: string;
    pathTemplate: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<{ status: number; body: unknown } | null> {
    const res = await options.pool.query(
      `SELECT request_hash, response_status, response_body
       FROM api_idempotency_records
       WHERE environment_id = $1
         AND tenant_scope = $2
         AND method = $3
         AND path_template = $4
         AND idempotency_key = $5
         AND expires_at > now()`,
      [
        params.environmentId,
        params.tenantScope,
        params.method,
        params.pathTemplate,
        params.idempotencyKey,
      ],
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0] as {
      request_hash: string;
      response_status: number;
      response_body: unknown;
    };
    if (row.request_hash !== params.requestHash) {
      throw new BookingError(
        "IDEMPOTENCY_KEY_CONFLICT",
        "Idempotency-Key was reused with a different request payload",
      );
    }
    return { status: row.response_status, body: row.response_body };
  }

  async function saveApiIdempotency(params: {
    environmentId: string;
    tenantScope: string;
    method: string;
    pathTemplate: string;
    idempotencyKey: string;
    requestHash: string;
    responseStatus: number;
    responseBody: unknown;
  }): Promise<void> {
    await options.pool.query(
      `INSERT INTO api_idempotency_records (
        environment_id, tenant_scope, method, path_template, idempotency_key,
        request_hash, response_status, response_body
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (environment_id, tenant_scope, method, path_template, idempotency_key) DO NOTHING`,
      [
        params.environmentId,
        params.tenantScope,
        params.method,
        params.pathTemplate,
        params.idempotencyKey,
        params.requestHash,
        params.responseStatus,
        JSON.stringify(params.responseBody),
      ],
    );
  }

  const server = createServer((req, res) => {
    const startedMs = performance.now();
    const correlationId = getHeaderString(req, "x-correlation-id") ?? `cor_${randomUUID()}`;
    const trace = resolveTraceContext(getHeaderString(req, "traceparent"));
    res.setHeader("X-Correlation-Id", correlationId);
    res.setHeader("X-Trace-Id", trace.traceId);
    res.setHeader("traceparent", trace.traceparent);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");

    const originHeader = getHeaderString(req, "origin");
    if (originHeader) {
      if (corsAllowlist.has(originHeader)) {
        res.setHeader("Access-Control-Allow-Origin", originHeader);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, X-Tenant-Id, X-Correlation-Id");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      } else if ((req.method ?? "").toUpperCase() === "OPTIONS") {
        sendJson(res, 403, {
          error: {
            code: "FORBIDDEN",
            category: "authorization",
            message: "Origin is not permitted by CORS policy",
            retryable: false,
            correlationId,
          },
        });
        return;
      }
    }
    if ((req.method ?? "").toUpperCase() === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const cancelController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cancelController.abort();
      sendJson(
        res,
        503,
        {
          error: {
            code: "TEMPORARY_UNAVAILABLE",
            category: "infrastructure",
            message: "Request timed out before completion",
            retryable: true,
            retryAfterSeconds: 1,
            correlationId,
          },
        },
        { "Retry-After": "1" },
      );
    }, requestTimeoutMs);
    timer.unref();

    const finish = (): void => {
      clearTimeout(timer);
    };
    res.on("finish", finish);
    res.on("close", () => {
      if (!res.writableEnded) {
        cancelController.abort();
      }
      finish();
    });

    void (async () => {
      let releaseLimiter: (() => void) | undefined;
      let releaseDistributedLease: (() => Promise<void>) | undefined;
      let principalForLog: AuthenticatedPrincipal | null = null;
      let tenantIdForLog: string | null = null;
      let responseBytesForLog = 0;
      let errorCodeForLog: string | null = null;
      const reqPathForLog = new URL(req.url ?? "/", "http://localhost").pathname;
      const reqMethodForLog = (req.method ?? "GET").toUpperCase();
      let reqBytesForLog = 0;

      try {
        const method = reqMethodForLog;
        const url = new URL(req.url ?? "/", "http://localhost");
        const pathname = url.pathname;

        // Public health probe (minimal unauthenticated signal; detailed telemetry gated by OLB_OPS_TOKEN when set)
        if (method === "GET" && pathname === "/v1/health") {
          await options.pool.query("SELECT 1");
          if (opsToken && !isOpsAuthorized(req)) {
            emitBoundedJson(res, 200, { status: "ok" }, correlationId);
            return;
          }
          emitBoundedJson(
            res,
            200,
            {
              status: "ok",
              limiter: limiter.getStats(),
              pool: {
                totalCount: options.pool.totalCount,
                idleCount: options.pool.idleCount,
                waitingCount: options.pool.waitingCount,
              },
            },
            correlationId,
          );
          return;
        }
        if (method === "GET" && pathname === "/v1/ready") {
          const readiness = await checkPlatformReadiness(options.pool);
          if (opsToken && !isOpsAuthorized(req)) {
            emitBoundedJson(res, readiness.ready ? 200 : 503, { ready: readiness.ready }, correlationId);
            return;
          }
          emitBoundedJson(res, readiness.ready ? 200 : 503, readiness, correlationId);
          return;
        }
        if (method === "GET" && pathname === "/v1/metrics") {
          if (!isOpsAuthorized(req)) {
            sendJson(
              res,
              401,
              {
                error: {
                  code: "UNAUTHORIZED",
                  category: "authorization",
                  message: "Operational metrics endpoint requires valid ops token",
                  retryable: false,
                  correlationId,
                },
              },
              { "WWW-Authenticate": "Bearer" },
            );
            return;
          }
          const prom = metrics.toPrometheusText(options.pool);
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
          res.end(prom);
          return;
        }
        if (method === "GET" && pathname === "/v1/openapi.json") {
          emitBoundedJson(res, 200, OPENAPI_V1_SPEC, correlationId);
          return;
        }

        // Authenticate via Bearer API credential
        const authHeader = getHeaderString(req, "authorization");
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          sendJson(
            res,
            401,
            {
              error: {
                code: "UNAUTHORIZED",
                category: "authorization",
                message: "Missing or invalid Bearer API key",
                retryable: false,
                correlationId,
              },
            },
            { "WWW-Authenticate": "Bearer" },
          );
          return;
        }
        const rawToken = authHeader.slice("Bearer ".length).trim();
        const principal = await options.platform.verifyApiKey(rawToken);
        if (!principal) {
          sendJson(
            res,
            401,
            {
              error: {
                code: "UNAUTHORIZED",
                category: "authorization",
                message: "Invalid, expired, or revoked API key",
                retryable: false,
                correlationId,
              },
            },
            { "WWW-Authenticate": "Bearer" },
          );
          return;
        }
        principalForLog = principal;

        // Per-key rate limit check (distributed PostgreSQL limiter when enabled, otherwise local window limiter)
        const rateDecision = options.distributedLimiter
          ? await options.distributedLimiter.checkAndIncrementRateLimit(`key:${principal.apiKeyId}`)
          : limiter.checkRateLimit(`key:${principal.apiKeyId}`);
        res.setHeader("X-RateLimit-Limit", String(rateDecision.limit));
        res.setHeader("X-RateLimit-Remaining", String(rateDecision.remaining));
        res.setHeader("X-RateLimit-Reset", String(rateDecision.resetAtEpochSeconds));

        if (!rateDecision.allowed) {
          errorCodeForLog = "RATE_LIMITED";
          sendJson(
            res,
            429,
            {
              error: {
                code: "RATE_LIMITED",
                category: "infrastructure",
                message: "API rate limit exceeded",
                retryable: true,
                retryAfterSeconds: rateDecision.retryAfterSeconds,
                correlationId,
              },
            },
            { "Retry-After": String(rateDecision.retryAfterSeconds) },
          );
          return;
        }

        const tenantLimiterKey = principal.tenantId ?? `env:${principal.environmentId}`;
        releaseLimiter = await limiter.acquire(tenantLimiterKey);
        if (options.distributedLimiter) {
          releaseDistributedLease = await options.distributedLimiter.acquireTenantLease(tenantLimiterKey);
        }
        if (cancelController.signal.aborted) {
          return;
        }

        const body =
          method === "POST" || method === "PUT" || method === "PATCH"
            ? await readJsonBody(req, maxBodyBytes)
            : undefined;
        reqBytesForLog = body !== undefined ? Buffer.byteLength(JSON.stringify(body)) : 0;
        const bodyObj =
          body && typeof body === "object" && !Array.isArray(body)
            ? (body as Record<string, unknown>)
            : undefined;

        const reply = (status: number, payload: unknown, headers?: Record<string, string>): void => {
          responseBytesForLog = emitBoundedJson(res, status, payload, correlationId, headers);
        };

        const recordApiUsage = async (
          tenantIdForMetric: string | null,
          extra?: {
            metric: "hold_created" | "booking_confirmed" | "booking_cancelled";
            mutationIdempotencyKey?: string;
          },
        ): Promise<void> => {
          if (!meterUsage) return;
          try {
            const scopeKey = tenantIdForMetric ?? "__env__";
            await options.platform.recordUsage({
              organizationId: principal.organizationId,
              projectId: principal.projectId,
              environmentId: principal.environmentId,
              tenantId: tenantIdForMetric,
              scopeKey,
              metric: "api_request",
              idempotencyKey: `req:${correlationId}:${method}:${pathname}`,
              metadata: { method, pathname, apiKeyId: principal.apiKeyId },
            });
            if (extra) {
              const stableKey = extra.mutationIdempotencyKey
                ? `idem:${extra.mutationIdempotencyKey}:${extra.metric}`
                : `evt:${correlationId}:${extra.metric}`;
              await options.platform.recordUsage({
                organizationId: principal.organizationId,
                projectId: principal.projectId,
                environmentId: principal.environmentId,
                tenantId: tenantIdForMetric,
                scopeKey,
                metric: extra.metric,
                idempotencyKey: stableKey,
                metadata: { method, pathname },
              });
            }
          } catch (usageErr) {
            log("warn", "Failed to record usage metric", {
              correlationId,
              error: usageErr instanceof Error ? usageErr.message : String(usageErr),
            });
          }
        };

        // /v1/tenants (environment-scoped)
        if (pathname === "/v1/tenants" && method === "GET") {
          assertScope(principal, "tenants:read");
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
          const cursorRaw = url.searchParams.get("cursor");
          const cursorObj = cursorRaw ? decodeCursor(cursorRaw) : undefined;
          const cursorCreatedAt =
            typeof cursorObj?.createdAt === "string" ? cursorObj.createdAt : undefined;
          const items = await options.platform.listScopedTenants(
            principal.environmentId,
            limit + 1,
            cursorCreatedAt,
          );
          const hasMore = items.length > limit;
          const sliced = hasMore ? items.slice(0, limit) : items;
          const nextCursor =
            hasMore && sliced.length > 0
              ? encodeCursor({ createdAt: sliced[sliced.length - 1]!.createdAt.toISOString() })
              : null;
          await recordApiUsage(principal.tenantId);
          reply(200, { items: sliced, nextCursor });
          return;
        }

        if (pathname === "/v1/tenants" && method === "POST") {
          assertScope(principal, "tenants:write");
          if (principal.tenantId !== null) {
            throw new BookingError(
              "FORBIDDEN",
              "Tenant-bound API keys cannot provision additional tenants",
            );
          }
          const parsed = createTenantBodySchema.safeParse(body);
          if (!parsed.success) {
            throw new BookingError("INVALID_INPUT", parsed.error.issues.map((i) => i.message).join("; "));
          }
          const idemKey = resolveIdempotencyKey(req, bodyObj);
          const reqHash = sha256Hex(canonicalJsonStringify(parsed.data));
          if (idemKey) {
            const cached = await tryReplayApiIdempotency({
              environmentId: principal.environmentId,
              tenantScope: "__env__",
              method,
              pathTemplate: pathname,
              idempotencyKey: idemKey,
              requestHash: reqHash,
            });
            if (cached) {
              reply(cached.status, cached.body, { "X-Idempotent-Replay": "true" });
              return;
            }
          }
          const tenant = await options.platform.createScopedTenant({
            organizationId: principal.organizationId,
            projectId: principal.projectId,
            environmentId: principal.environmentId,
            name: parsed.data.name,
            ...(parsed.data.metadata !== undefined ? { metadata: parsed.data.metadata } : {}),
            actorId: `api_key:${principal.apiKeyId}`,
          });
          const payload = { tenant };
          if (idemKey) {
            await saveApiIdempotency({
              environmentId: principal.environmentId,
              tenantScope: "__env__",
              method,
              pathTemplate: pathname,
              idempotencyKey: idemKey,
              requestHash: reqHash,
              responseStatus: 201,
              responseBody: payload,
            });
          }
          await recordApiUsage(tenant.id);
          reply(201, payload);
          return;
        }

        // /v1/usage (environment or bound tenant)
        if (pathname === "/v1/usage" && method === "GET") {
          assertScope(principal, "usage:read");
          const from = url.searchParams.get("from") ?? undefined;
          const to = url.searchParams.get("to") ?? undefined;
          const queryTenantId = url.searchParams.get("tenantId") ?? undefined;
          if (principal.tenantId !== null && queryTenantId && queryTenantId !== principal.tenantId) {
            throw new BookingError("FORBIDDEN", "Cannot query usage for another tenant");
          }
          const summary = await options.platform.getUsageSummary({
            environmentId: principal.environmentId,
            tenantId: principal.tenantId ?? queryTenantId,
            from,
            to,
          });
          await recordApiUsage(principal.tenantId ?? null);
          reply(200, { environmentId: principal.environmentId, metrics: summary });
          return;
        }

        // All remaining endpoints operate within a verified scoped tenant
        const tenantId = await resolveTenantIdForPrincipal(principal, req, bodyObj);
        const client = options.engine.forTenant({
          tenantId,
          correlationId,
          actor: {
            id: `api_key:${principal.apiKeyId}`,
            type: "admin",
            capabilities: mapScopesToCapabilities(principal.scopes),
            callerNamespace: `api:${principal.environmentId}`,
          },
        });

        // /v1/locations
        if (pathname === "/v1/locations" && method === "POST") {
          assertScope(principal, "facilities:write");
          const parsed = createLocationBodySchema.safeParse(body);
          if (!parsed.success) {
            throw new BookingError("INVALID_INPUT", parsed.error.issues.map((i) => i.message).join("; "));
          }
          const location = await options.platform.createLocation({
            tenantId,
            ...parsed.data,
          });
          await recordApiUsage(tenantId);
          reply(201, { location });
          return;
        }

        const facilityLocMatch = /^\/v1\/facilities\/([^/]+)\/location$/.exec(pathname);
        if (facilityLocMatch && method === "POST") {
          assertScope(principal, "facilities:write");
          const facilityId = facilityLocMatch[1]!;
          const parsed = attachLocationBodySchema.safeParse(body);
          if (!parsed.success) {
            throw new BookingError("INVALID_INPUT", parsed.error.issues.map((i) => i.message).join("; "));
          }
          await options.platform.attachFacilityLocation({
            tenantId,
            facilityId,
            locationId: parsed.data.locationId,
            resourceKind: parsed.data.resourceKind,
          });
          await recordApiUsage(tenantId);
          reply(200, { attached: true, facilityId, locationId: parsed.data.locationId });
          return;
        }

        // /v1/facilities
        if (pathname === "/v1/facilities" && method === "GET") {
          assertScope(principal, "facilities:read");
          const includeInactive = url.searchParams.get("includeInactive") === "true" || url.searchParams.get("activeOnly") === "false";
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
          const cursorRaw = url.searchParams.get("cursor");
          const offset = cursorRaw ? Number(decodeCursor(cursorRaw).offset ?? 0) : 0;
          const all = await client.listFacilities({ includeInactive });
          const sliced = all.slice(offset, offset + limit);
          const nextCursor =
            offset + limit < all.length ? encodeCursor({ offset: offset + limit }) : null;
          await recordApiUsage(tenantId);
          reply(200, { items: sliced, nextCursor });
          return;
        }

        if (pathname === "/v1/facilities" && method === "POST") {
          assertScope(principal, "facilities:write");
          const idemKey = resolveIdempotencyKey(req, bodyObj);
          const reqHash = sha256Hex(canonicalJsonStringify(body ?? {}));
          if (idemKey) {
            const cached = await tryReplayApiIdempotency({
              environmentId: principal.environmentId,
              tenantScope: tenantId,
              method,
              pathTemplate: pathname,
              idempotencyKey: idemKey,
              requestHash: reqHash,
            });
            if (cached) {
              reply(cached.status, cached.body, { "X-Idempotent-Replay": "true" });
              return;
            }
          }
          const facility = await client.createFacility(body as never);
          const payload = { facility };
          if (idemKey) {
            await saveApiIdempotency({
              environmentId: principal.environmentId,
              tenantScope: tenantId,
              method,
              pathTemplate: pathname,
              idempotencyKey: idemKey,
              requestHash: reqHash,
              responseStatus: 201,
              responseBody: payload,
            });
          }
          await recordApiUsage(tenantId);
          reply(201, payload);
          return;
        }

        const facilityMatch = /^\/v1\/facilities\/([^/]+)$/.exec(pathname);
        if (facilityMatch && method === "GET") {
          assertScope(principal, "facilities:read");
          const facility = await client.getFacility(facilityMatch[1]!);
          if (!facility) throw new BookingError("NOT_FOUND", "Facility not found");
          await recordApiUsage(tenantId);
          reply(200, { facility });
          return;
        }
        if (facilityMatch && method === "PATCH") {
          assertScope(principal, "facilities:write");
          const facility = await client.updateFacility(facilityMatch[1]!, body as never);
          await recordApiUsage(tenantId);
          reply(200, { facility });
          return;
        }

        const scheduleMatch = /^\/v1\/facilities\/([^/]+)\/schedule$/.exec(pathname);
        if (scheduleMatch && method === "PUT") {
          assertScope(principal, "facilities:write");
          const windows = Array.isArray(bodyObj?.windows) ? bodyObj.windows : body;
          const schedule = await client.setSchedule(scheduleMatch[1]!, windows as never);
          await recordApiUsage(tenantId);
          reply(200, { schedule });
          return;
        }

        const policyMatch = /^\/v1\/facilities\/([^/]+)\/slot-policy$/.exec(pathname);
        if (policyMatch && method === "PUT") {
          assertScope(principal, "facilities:write");
          const slotPolicy = await client.setSlotPolicy(policyMatch[1]!, body as never);
          await recordApiUsage(tenantId);
          reply(200, { slotPolicy });
          return;
        }

        const pricingMatch = /^\/v1\/facilities\/([^/]+)\/pricing$/.exec(pathname);
        if (pricingMatch && method === "PUT") {
          assertScope(principal, "facilities:write");
          const pricing = await client.setPricing({ ...(bodyObj ?? {}), facilityId: pricingMatch[1]! });
          await recordApiUsage(tenantId);
          reply(200, { pricing });
          return;
        }

        const blackoutMatch = /^\/v1\/facilities\/([^/]+)\/blackouts$/.exec(pathname);
        if (blackoutMatch && method === "POST") {
          assertScope(principal, "facilities:write");
          const blackout = await client.createBlackout({ ...(bodyObj ?? {}), facilityId: blackoutMatch[1]! });
          await recordApiUsage(tenantId);
          reply(201, { blackout });
          return;
        }

        // /v1/availability
        if (pathname === "/v1/availability" && method === "GET") {
          assertScope(principal, "availability:read");
          const facilityId = url.searchParams.get("facilityId") ?? "";
          const fromDate = url.searchParams.get("fromDate") ?? "";
          const toDate = url.searchParams.get("toDate") ?? "";
          const availability = await client.getAvailability({ facilityId, fromDate, toDate });
          await recordApiUsage(tenantId);
          reply(200, availability);
          return;
        }

        if (pathname === "/v1/availability/check" && method === "POST") {
          assertScope(principal, "availability:read");
          const check = await client.checkSelection(body as never);
          await recordApiUsage(tenantId);
          reply(200, check);
          return;
        }

        // /v1/holds
        if (pathname === "/v1/holds" && method === "POST") {
          assertScope(principal, "holds:write");
          const idemKey = resolveIdempotencyKey(req, bodyObj);
          if (!idemKey) {
            throw new BookingError(
              "INVALID_INPUT",
              "Idempotency-Key header (or body.idempotencyKey) is required for POST /v1/holds",
            );
          }
          const reqHash = sha256Hex(canonicalJsonStringify(body ?? {}));
          const cached = await tryReplayApiIdempotency({
            environmentId: principal.environmentId,
            tenantScope: tenantId,
            method,
            pathTemplate: pathname,
            idempotencyKey: idemKey,
            requestHash: reqHash,
          });
          if (cached) {
            reply(cached.status, cached.body, { "X-Idempotent-Replay": "true" });
            return;
          }
          const hold = await client.createHold(body as never, { idempotencyKey: idemKey });
          const payload = { hold };
          await saveApiIdempotency({
            environmentId: principal.environmentId,
            tenantScope: tenantId,
            method,
            pathTemplate: pathname,
            idempotencyKey: idemKey,
            requestHash: reqHash,
            responseStatus: 201,
            responseBody: payload,
          });
          await recordApiUsage(tenantId, { metric: "hold_created", mutationIdempotencyKey: idemKey });
          reply(201, payload);
          return;
        }

        const holdMatch = /^\/v1\/holds\/([^/]+)$/.exec(pathname);
        if (holdMatch && method === "GET") {
          assertScope(principal, "holds:read");
          const hold = await client.getHold(holdMatch[1]!);
          if (!hold) throw new BookingError("NOT_FOUND", "Hold not found");
          await recordApiUsage(tenantId);
          reply(200, { hold });
          return;
        }
        if (holdMatch && method === "DELETE") {
          assertScope(principal, "holds:write");
          const idemKey = resolveIdempotencyKey(req, undefined);
          const hold = await client.releaseHold(
            holdMatch[1]!,
            idemKey ? { idempotencyKey: idemKey } : undefined,
          );
          await recordApiUsage(tenantId);
          reply(200, { hold });
          return;
        }

        const holdConvertMatch = /^\/v1\/holds\/([^/]+)\/convert$/.exec(pathname);
        if (holdConvertMatch && method === "POST") {
          assertScope(principal, "holds:write");
          const idemKey = resolveIdempotencyKey(req, bodyObj);
          if (!idemKey) {
            throw new BookingError(
              "INVALID_INPUT",
              "Idempotency-Key header is required for converting holds",
            );
          }
          const reqHash = sha256Hex(canonicalJsonStringify({ holdId: holdConvertMatch[1], ...(bodyObj ?? {}) }));
          const pathTemplate = "/v1/holds/:holdId/convert";
          const cached = await tryReplayApiIdempotency({
            environmentId: principal.environmentId,
            tenantScope: tenantId,
            method,
            pathTemplate,
            idempotencyKey: idemKey,
            requestHash: reqHash,
          });
          if (cached) {
            reply(cached.status, cached.body, { "X-Idempotent-Replay": "true" });
            return;
          }
          const booking = await client.convertHoldToBooking(
            { ...(bodyObj ?? {}), holdId: holdConvertMatch[1]! } as never,
            { idempotencyKey: idemKey },
          );
          const payload = { booking };
          await saveApiIdempotency({
            environmentId: principal.environmentId,
            tenantScope: tenantId,
            method,
            pathTemplate,
            idempotencyKey: idemKey,
            requestHash: reqHash,
            responseStatus: 200,
            responseBody: payload,
          });
          await recordApiUsage(tenantId, { metric: "booking_confirmed", mutationIdempotencyKey: idemKey });
          reply(200, payload);
          return;
        }

        // /v1/bookings
        if (pathname === "/v1/bookings" && method === "POST") {
          assertScope(principal, "bookings:write");
          const idemKey = resolveIdempotencyKey(req, bodyObj);
          if (!idemKey) {
            throw new BookingError(
              "INVALID_INPUT",
              "Idempotency-Key header (or body.idempotencyKey) is required for POST /v1/bookings",
            );
          }
          const reqHash = sha256Hex(canonicalJsonStringify(body ?? {}));
          const cached = await tryReplayApiIdempotency({
            environmentId: principal.environmentId,
            tenantScope: tenantId,
            method,
            pathTemplate: pathname,
            idempotencyKey: idemKey,
            requestHash: reqHash,
          });
          if (cached) {
            reply(cached.status, cached.body, { "X-Idempotent-Replay": "true" });
            return;
          }
          const booking = await client.createBooking(body as never, { idempotencyKey: idemKey });
          const payload = { booking };
          await saveApiIdempotency({
            environmentId: principal.environmentId,
            tenantScope: tenantId,
            method,
            pathTemplate: pathname,
            idempotencyKey: idemKey,
            requestHash: reqHash,
            responseStatus: 201,
            responseBody: payload,
          });
          await recordApiUsage(tenantId, { metric: "booking_confirmed", mutationIdempotencyKey: idemKey });
          reply(201, payload);
          return;
        }

        if (pathname === "/v1/bookings" && method === "GET") {
          assertScope(principal, "bookings:read");
          const facilityId = url.searchParams.get("facilityId") ?? undefined;
          const externalCustomerId =
            url.searchParams.get("externalCustomerId") ??
            url.searchParams.get("customerId") ??
            undefined;
          const status = url.searchParams.get("status") ?? undefined;
          const limitParam = url.searchParams.get("limit");
          const cursor = url.searchParams.get("cursor") ?? undefined;
          const page = await client.listBookings({
            ...(facilityId !== undefined ? { facilityId } : {}),
            ...(externalCustomerId !== undefined ? { externalCustomerId } : {}),
            ...(status !== undefined ? { status: status as never } : {}),
            ...(limitParam !== null ? { limit: Number(limitParam) } : {}),
            ...(cursor !== undefined ? { cursor } : {}),
          });
          await recordApiUsage(tenantId);
          reply(200, page);
          return;
        }

        const bookingMatch = /^\/v1\/bookings\/([^/]+)$/.exec(pathname);
        if (bookingMatch && method === "GET") {
          assertScope(principal, "bookings:read");
          const booking = await client.getBooking(bookingMatch[1]!);
          if (!booking) throw new BookingError("NOT_FOUND", "Booking not found");
          await recordApiUsage(tenantId);
          reply(200, { booking });
          return;
        }

        const bookingCancelMatch = /^\/v1\/bookings\/([^/]+)\/cancel$/.exec(pathname);
        if (bookingCancelMatch && method === "POST") {
          assertScope(principal, "bookings:write");
          const idemKey = resolveIdempotencyKey(req, bodyObj);
          const pathTemplate = "/v1/bookings/:bookingId/cancel";
          const reqHash = sha256Hex(canonicalJsonStringify({ bookingId: bookingCancelMatch[1], ...(bodyObj ?? {}) }));
          if (idemKey) {
            const cached = await tryReplayApiIdempotency({
              environmentId: principal.environmentId,
              tenantScope: tenantId,
              method,
              pathTemplate,
              idempotencyKey: idemKey,
              requestHash: reqHash,
            });
            if (cached) {
              reply(cached.status, cached.body, { "X-Idempotent-Replay": "true" });
              return;
            }
          }
          const booking = await client.cancelBooking(
            { ...(bodyObj ?? {}), bookingId: bookingCancelMatch[1]! } as never,
            idemKey ? { idempotencyKey: idemKey } : undefined,
          );
          const payload = { booking };
          if (idemKey) {
            await saveApiIdempotency({
              environmentId: principal.environmentId,
              tenantScope: tenantId,
              method,
              pathTemplate,
              idempotencyKey: idemKey,
              requestHash: reqHash,
              responseStatus: 200,
              responseBody: payload,
            });
          }
          await recordApiUsage(tenantId, {
            metric: "booking_cancelled",
            ...(idemKey ? { mutationIdempotencyKey: idemKey } : {}),
          });
          reply(200, payload);
          return;
        }

        const bookingCompleteMatch = /^\/v1\/bookings\/([^/]+)\/complete$/.exec(pathname);
        if (bookingCompleteMatch && method === "POST") {
          assertScope(principal, "bookings:write");
          const idemKey = resolveIdempotencyKey(req, bodyObj);
          const booking = await client.completeBooking(
            bookingCompleteMatch[1]!,
            idemKey ? { idempotencyKey: idemKey } : undefined,
          );
          await recordApiUsage(tenantId);
          reply(200, { booking });
          return;
        }

        const bookingNoShowMatch = /^\/v1\/bookings\/([^/]+)\/no-show$/.exec(pathname);
        if (bookingNoShowMatch && method === "POST") {
          assertScope(principal, "bookings:write");
          const idemKey = resolveIdempotencyKey(req, bodyObj);
          const booking = await client.markNoShow(
            bookingNoShowMatch[1]!,
            idemKey ? { idempotencyKey: idemKey } : undefined,
          );
          await recordApiUsage(tenantId);
          reply(200, { booking });
          return;
        }

        const bookingHistoryMatch = /^\/v1\/bookings\/([^/]+)\/history$/.exec(pathname);
        if (bookingHistoryMatch && method === "GET") {
          assertScope(principal, "bookings:read");
          const history = await client.getBookingHistory("booking", bookingHistoryMatch[1]!);
          await recordApiUsage(tenantId);
          reply(200, { items: history });
          return;
        }

        // /v1/webhooks
        if (pathname === "/v1/webhooks/endpoints" && method === "POST") {
          assertScope(principal, "webhooks:write");
          const parsed = createWebhookEndpointBodySchema.safeParse(body);
          if (!parsed.success) {
            throw new BookingError("INVALID_INPUT", parsed.error.issues.map((i) => i.message).join("; "));
          }
          const created = await options.platform.createWebhookEndpoint({
            organizationId: principal.organizationId,
            projectId: principal.projectId,
            environmentId: principal.environmentId,
            tenantId,
            url: parsed.data.url,
            ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
            ...(parsed.data.eventTypes !== undefined ? { eventTypes: parsed.data.eventTypes } : {}),
          });
          await recordApiUsage(tenantId);
          reply(201, created);
          return;
        }

        if (pathname === "/v1/webhooks/endpoints" && method === "GET") {
          assertScope(principal, "webhooks:read");
          const endpoints = await options.platform.listWebhookEndpoints(principal.environmentId, tenantId);
          await recordApiUsage(tenantId);
          reply(200, { items: endpoints });
          return;
        }

        const endpointMatch = /^\/v1\/webhooks\/endpoints\/([^/]+)$/.exec(pathname);
        if (endpointMatch && method === "DELETE") {
          assertScope(principal, "webhooks:write");
          const endpoint = await options.platform.disableWebhookEndpoint(
            principal.environmentId,
            tenantId,
            endpointMatch[1]!,
          );
          await recordApiUsage(tenantId);
          reply(200, { endpoint });
          return;
        }

        if (pathname === "/v1/webhooks/deliveries" && method === "GET") {
          assertScope(principal, "webhooks:read");
          const endpointId = url.searchParams.get("endpointId") ?? undefined;
          const statusParam = url.searchParams.get("status") ?? undefined;
          const limitParam = url.searchParams.get("limit");
          const deliveries = await options.platform.listWebhookDeliveries({
            environmentId: principal.environmentId,
            tenantId,
            endpointId,
            status: statusParam as never,
            limit: limitParam ? Number(limitParam) : undefined,
          });
          await recordApiUsage(tenantId);
          reply(200, { items: deliveries });
          return;
        }

        const replayMatch = /^\/v1\/webhooks\/deliveries\/([^/]+)\/replay$/.exec(pathname);
        if (replayMatch && method === "POST") {
          assertScope(principal, "webhooks:write");
          const delivery = await options.platform.replayWebhookDelivery(
            principal.environmentId,
            tenantId,
            replayMatch[1]!,
          );
          await recordApiUsage(tenantId);
          reply(200, { delivery });
          return;
        }

        reply(404, {
          error: {
            code: "NOT_FOUND",
            category: "not_found",
            message: `Unknown route: ${method} ${pathname}`,
            retryable: false,
            correlationId,
          },
        });
      } catch (err) {
        if (timedOut || res.headersSent) return;
        if (err instanceof BookingError) {
          const mapped = httpStatusForError(err);
          errorCodeForLog = mapped.code;
          const extraHeaders: Record<string, string> = {};
          if (mapped.retryAfterSeconds !== undefined) {
            extraHeaders["Retry-After"] = String(mapped.retryAfterSeconds);
          }
          responseBytesForLog = emitBoundedJson(
            res,
            mapped.status,
            {
              error: {
                code: mapped.code,
                category: err.category,
                message: sanitizeTelemetryText(err.message),
                retryable: err.retryable,
                ...(mapped.retryAfterSeconds !== undefined
                  ? { retryAfterSeconds: mapped.retryAfterSeconds }
                  : {}),
                correlationId,
                ...(err.details ? { details: err.details } : {}),
              },
            },
            correlationId,
            extraHeaders,
          );
          return;
        }

        errorCodeForLog = "INTERNAL_ERROR";
        log("error", "Unhandled API error", {
          correlationId,
          traceId: trace.traceId,
          message: err instanceof Error ? err.message : String(err),
        });
        responseBytesForLog = emitBoundedJson(
          res,
          500,
          {
            error: {
              code: "INTERNAL_ERROR",
              category: "infrastructure",
              message: "Unexpected internal server error",
              retryable: true,
              correlationId,
            },
          },
          correlationId,
        );
      } finally {
        await releaseDistributedLease?.();
        releaseLimiter?.();
        const durationMs = Math.max(0, Math.round(performance.now() - startedMs));
        metrics.recordHttpRequest(reqMethodForLog, reqPathForLog, res.statusCode || 200, durationMs);
        if (logRequestsToDb && principalForLog && !reqPathForLog.startsWith("/v1/health") && !reqPathForLog.startsWith("/v1/metrics")) {
          const pLog = principalForLog;
          void options.pool
            .query(
              `INSERT INTO api_request_logs (
                organization_id, project_id, environment_id, tenant_id, api_key_id,
                correlation_id, trace_id, method, path_template, status_code,
                duration_ms, request_bytes, response_bytes, error_code
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
              [
                pLog.organizationId,
                pLog.projectId,
                pLog.environmentId,
                pLog.tenantId ?? tenantIdForLog,
                pLog.apiKeyId,
                correlationId,
                trace.traceId,
                reqMethodForLog,
                reqPathForLog.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id"),
                res.statusCode || 200,
                durationMs,
                reqBytesForLog,
                responseBytesForLog,
                errorCodeForLog,
              ],
            )
            .catch(() => { });
        }
      }
    })();
  });

  return server;
}
