import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  OneLineBookingApiError,
  SdkSecurityBoundaryError,
  type AvailabilityResultDto,
  type BookingSummaryDto,
  type FacilityDto,
  type HoldResultDto,
  type OneLineBookingErrorEnvelope,
  type PlatformTenantDto,
  type SdkRequestOptions,
} from "./types.js";

export * from "./types.js";

export interface OneLineBookingClientOptions {
  baseUrl: string;
  apiKey: string;
  tenantId?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Verifies an incoming `X-OneLine-Signature` header (`t=...,v1=...`) against your webhook signing secret.
 */
export function verifyWebhookSignature(input: {
  secret: string;
  payloadJson: string;
  signatureHeader: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): boolean {
  const parts = input.signatureHeader.split(",").map((p) => p.trim());
  let timestampSeconds: number | null = null;
  const sigs: string[] = [];
  for (const part of parts) {
    const [k, v] = part.split("=", 2);
    if (k === "t" && v) {
      const n = Number(v);
      if (Number.isInteger(n) && n > 0) timestampSeconds = n;
    } else if (k === "v1" && v) {
      sigs.push(v);
    }
  }
  if (timestampSeconds === null || sigs.length === 0) return false;

  const tolerance = input.toleranceSeconds ?? 300;
  const nowSec = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestampSeconds) > tolerance) return false;

  const expectedHex = createHmac("sha256", input.secret)
    .update(`${timestampSeconds}.${input.payloadJson}`, "utf8")
    .digest("hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  for (const sig of sigs) {
    if (!/^[a-f0-9]+$/i.test(sig)) continue;
    const candidateBuf = Buffer.from(sig, "hex");
    if (candidateBuf.length === expectedBuf.length && timingSafeEqual(expectedBuf, candidateBuf)) {
      return true;
    }
  }
  return false;
}

/**
 * Server-side OneLineBooking client for trusted backend runtimes (Node.js / Next.js Route Handlers / Workers).
 * Enforces an explicit boundary blocking live secret key instantiation inside browser environments.
 */
export class OneLineBookingClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultTenantId: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  readonly tenants: {
    list: (query?: { limit?: number; cursor?: string }) => Promise<{ items: PlatformTenantDto[]; nextCursor: string | null }>;
    create: (input: { name: string; metadata?: Record<string, unknown> }, opts?: SdkRequestOptions) => Promise<PlatformTenantDto>;
  };

  readonly facilities: {
    list: (query?: { includeInactive?: boolean; limit?: number; cursor?: string }, opts?: SdkRequestOptions) => Promise<{ items: FacilityDto[]; nextCursor: string | null }>;
    create: (input: { name: string; category: string; timeZone: string; metadata?: Record<string, unknown> }, opts?: SdkRequestOptions) => Promise<FacilityDto>;
    get: (facilityId: string, opts?: SdkRequestOptions) => Promise<FacilityDto>;
    setSchedule: (facilityId: string, windows: unknown[], opts?: SdkRequestOptions) => Promise<{ configurationRevision: number }>;
    setSlotPolicy: (facilityId: string, policy: Record<string, unknown>, opts?: SdkRequestOptions) => Promise<{ configurationRevision: number }>;
    setPricing: (facilityId: string, pricing: { amountMinor: number; currency: string }, opts?: SdkRequestOptions) => Promise<{ configurationRevision: number }>;
  };

  readonly availability: {
    get: (query: { facilityId: string; fromDate: string; toDate: string }, opts?: SdkRequestOptions) => Promise<AvailabilityResultDto>;
  };

  readonly holds: {
    create: (input: { facilityId: string; slotRefs: string[]; externalCustomerId?: string; expiresInMinutes?: number }, opts?: SdkRequestOptions) => Promise<HoldResultDto>;
    get: (holdId: string, opts?: SdkRequestOptions) => Promise<HoldResultDto>;
    release: (holdId: string, opts?: SdkRequestOptions) => Promise<HoldResultDto>;
    convert: (holdId: string, input?: { expectedAmountMinor?: number; expectedCurrency?: string }, opts?: SdkRequestOptions) => Promise<BookingSummaryDto>;
  };

  readonly bookings: {
    create: (input: { facilityId: string; slotRefs: string[]; externalCustomerId?: string; expectedAmountMinor?: number; expectedCurrency?: string }, opts?: SdkRequestOptions) => Promise<BookingSummaryDto>;
    list: (query?: { facilityId?: string; externalCustomerId?: string; status?: string; limit?: number; cursor?: string }, opts?: SdkRequestOptions) => Promise<{ items: BookingSummaryDto[]; nextCursor: string | null }>;
    get: (bookingId: string, opts?: SdkRequestOptions) => Promise<BookingSummaryDto>;
    cancel: (bookingId: string, input?: { reason?: string }, opts?: SdkRequestOptions) => Promise<BookingSummaryDto>;
  };

  constructor(options: OneLineBookingClientOptions) {
    if (typeof (globalThis as { window?: unknown }).window !== "undefined" && options.apiKey.startsWith("olb_live_")) {
      throw new SdkSecurityBoundaryError(
        "Server-only OneLineBookingClient cannot be instantiated in a browser with an olb_live_ key. Use OneLineBookingPublicClient.",
      );
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.defaultTenantId = options.tenantId;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 50;
    this.fetchImpl = options.fetchFn ?? fetch;

    this.tenants = {
      list: async (q) => {
        const qs = new URLSearchParams();
        if (q?.limit) qs.set("limit", String(q.limit));
        if (q?.cursor) qs.set("cursor", q.cursor);
        const s = qs.toString() ? `?${qs.toString()}` : "";
        return this.request("GET", `/v1/tenants${s}`);
      },
      create: async (input, opts) => {
        const r = await this.request<{ tenant: PlatformTenantDto }>("POST", "/v1/tenants", input, {
          idempotencyKey: opts?.idempotencyKey ?? `sdk_${randomUUID()}`,
          ...opts,
        });
        return r.tenant;
      },
    };

    this.facilities = {
      list: async (q, opts) => {
        const qs = new URLSearchParams();
        if (q?.includeInactive !== undefined) qs.set("includeInactive", String(q.includeInactive));
        if (q?.limit) qs.set("limit", String(q.limit));
        if (q?.cursor) qs.set("cursor", q.cursor);
        const s = qs.toString() ? `?${qs.toString()}` : "";
        return this.request("GET", `/v1/facilities${s}`, undefined, opts);
      },
      create: async (input, opts) => {
        const r = await this.request<{ facility: FacilityDto }>("POST", "/v1/facilities", input, {
          idempotencyKey: opts?.idempotencyKey ?? `sdk_${randomUUID()}`,
          ...opts,
        });
        return r.facility;
      },
      get: async (id, opts) => {
        const r = await this.request<{ facility: FacilityDto }>(
          "GET",
          `/v1/facilities/${encodeURIComponent(id)}`,
          undefined,
          opts,
        );
        return r.facility;
      },
      setSchedule: async (id, windows, opts) => {
        const r = await this.request<{ schedule: { configurationRevision: number } }>(
          "PUT",
          `/v1/facilities/${encodeURIComponent(id)}/schedule`,
          { windows },
          opts,
        );
        return r.schedule;
      },
      setSlotPolicy: async (id, policy, opts) => {
        const r = await this.request<{ slotPolicy: { configurationRevision: number } }>(
          "PUT",
          `/v1/facilities/${encodeURIComponent(id)}/slot-policy`,
          policy,
          opts,
        );
        return r.slotPolicy;
      },
      setPricing: async (id, pricing, opts) => {
        const r = await this.request<{ pricing: { configurationRevision: number } }>(
          "PUT",
          `/v1/facilities/${encodeURIComponent(id)}/pricing`,
          pricing,
          opts,
        );
        return r.pricing;
      },
    };

    this.availability = {
      get: async (q, opts) => {
        const qs = new URLSearchParams(q);
        return this.request("GET", `/v1/availability?${qs.toString()}`, undefined, opts);
      },
    };

    this.holds = {
      create: async (input, opts) => {
        const r = await this.request<{ hold: HoldResultDto }>("POST", "/v1/holds", input, {
          idempotencyKey: opts?.idempotencyKey ?? `sdk_${randomUUID()}`,
          ...opts,
        });
        return r.hold;
      },
      get: async (id, opts) => {
        const r = await this.request<{ hold: HoldResultDto }>(
          "GET",
          `/v1/holds/${encodeURIComponent(id)}`,
          undefined,
          opts,
        );
        return r.hold;
      },
      release: async (id, opts) => {
        const r = await this.request<{ hold: HoldResultDto }>(
          "DELETE",
          `/v1/holds/${encodeURIComponent(id)}`,
          undefined,
          { idempotencyKey: opts?.idempotencyKey ?? `sdk_${randomUUID()}`, ...opts },
        );
        return r.hold;
      },
      convert: async (id, input, opts) => {
        const r = await this.request<{ booking: BookingSummaryDto }>(
          "POST",
          `/v1/holds/${encodeURIComponent(id)}/convert`,
          input ?? {},
          { idempotencyKey: opts?.idempotencyKey ?? `sdk_${randomUUID()}`, ...opts },
        );
        return r.booking;
      },
    };

    this.bookings = {
      create: async (input, opts) => {
        const r = await this.request<{ booking: BookingSummaryDto }>("POST", "/v1/bookings", input, {
          idempotencyKey: opts?.idempotencyKey ?? `sdk_${randomUUID()}`,
          ...opts,
        });
        return r.booking;
      },
      list: async (q, opts) => {
        const qs = new URLSearchParams();
        if (q?.facilityId) qs.set("facilityId", q.facilityId);
        if (q?.externalCustomerId) qs.set("externalCustomerId", q.externalCustomerId);
        if (q?.status) qs.set("status", q.status);
        if (q?.limit) qs.set("limit", String(q.limit));
        if (q?.cursor) qs.set("cursor", q.cursor);
        const s = qs.toString() ? `?${qs.toString()}` : "";
        return this.request("GET", `/v1/bookings${s}`, undefined, opts);
      },
      get: async (id, opts) => {
        const r = await this.request<{ booking: BookingSummaryDto }>(
          "GET",
          `/v1/bookings/${encodeURIComponent(id)}`,
          undefined,
          opts,
        );
        return r.booking;
      },
      cancel: async (id, input, opts) => {
        const r = await this.request<{ booking: BookingSummaryDto }>(
          "POST",
          `/v1/bookings/${encodeURIComponent(id)}/cancel`,
          input ?? {},
          { idempotencyKey: opts?.idempotencyKey ?? `sdk_${randomUUID()}`, ...opts },
        );
        return r.booking;
      },
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: SdkRequestOptions,
  ): Promise<T> {
    const canRetry = method === "GET" || Boolean(opts?.idempotencyKey);
    const totalAttempts = canRetry ? 1 + this.maxRetries : 1;
    const correlationId = opts?.correlationId ?? `sdk_${randomUUID()}`;
    const tenantId = opts?.tenantId ?? this.defaultTenantId;

    let lastErr: unknown;
    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      timeout.unref?.();

      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.apiKey}`,
          "X-Correlation-Id": correlationId,
        };
        if (tenantId) headers["X-Tenant-Id"] = tenantId;
        if (opts?.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
        if (body !== undefined) headers["Content-Type"] = "application/json";

        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const parsed = (await res.json().catch(() => null)) as unknown;
        if (res.ok) return parsed as T;

        const env = (parsed as OneLineBookingErrorEnvelope | null)?.error ?? {
          code: "INTERNAL_ERROR",
          category: "infrastructure",
          message: `HTTP ${res.status}`,
          retryable: res.status === 429 || res.status >= 500,
        };
        const apiErr = new OneLineBookingApiError(res.status, env);
        const transient = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
        if (canRetry && transient && attempt + 1 < totalAttempts) {
          const delayMs = apiErr.retryAfterSeconds
            ? apiErr.retryAfterSeconds * 1000
            : this.retryBaseDelayMs * 2 ** attempt;
          await new Promise((r) => setTimeout(r, Math.min(delayMs, 5_000)));
          lastErr = apiErr;
          continue;
        }
        throw apiErr;
      } catch (err) {
        clearTimeout(timeout);
        if (err instanceof OneLineBookingApiError) throw err;
        lastErr = err;
        if (canRetry && attempt + 1 < totalAttempts) {
          await new Promise((r) => setTimeout(r, this.retryBaseDelayMs * 2 ** attempt));
          continue;
        }
        throw new OneLineBookingApiError(503, {
          code: "TEMPORARY_UNAVAILABLE",
          category: "infrastructure",
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
          correlationId,
        });
      }
    }
    throw lastErr;
  }
}
