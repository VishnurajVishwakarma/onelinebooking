import { randomUUID } from "node:crypto";
import type {
  AvailabilityResult,
  Blackout,
  BookingHistoryEntry,
  BookingListPage,
  BookingSummary,
  ConfigurationMutationResult,
  Facility,
  HoldResult,
  ScheduleWindow,
  SelectionCheckResult,
  SlotPolicy,
} from "../domain/model.js";
import type {
  CreatedWebhookEndpoint,
  Location,
  PlatformTenant,
  UsageSummaryRow,
  WebhookDeliveryRecord,
  WebhookDeliveryStatus,
  WebhookEndpointSummary,
} from "../platform/model.js";

export interface OneLineBookingErrorEnvelope {
  error: {
    code: string;
    category: string;
    message: string;
    retryable: boolean;
    retryAfterSeconds?: number;
    correlationId?: string;
    details?: Record<string, unknown>;
  };
}

export class OneLineBookingApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly category: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly correlationId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, envelope: OneLineBookingErrorEnvelope["error"]) {
    super(envelope.message);
    this.name = "OneLineBookingApiError";
    this.status = status;
    this.code = envelope.code;
    this.category = envelope.category;
    this.retryable = envelope.retryable;
    this.retryAfterSeconds = envelope.retryAfterSeconds;
    this.correlationId = envelope.correlationId;
    this.details = envelope.details;
  }
}

export interface OneLineBookingClientOptions {
  baseUrl: string;
  apiKey: string;
  tenantId?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  retryBaseDelayMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
}

export interface SdkRequestOptions {
  idempotencyKey?: string | undefined;
  correlationId?: string | undefined;
  tenantId?: string | undefined;
}

/**
 * Typed Developer SDK wrapping OneLineBooking REST API (`/v1`).
 * Automatically injects correlation headers, request timeouts, and safe idempotency-preserving retries.
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
    list: (query?: { limit?: number; cursor?: string }) => Promise<{ items: PlatformTenant[]; nextCursor: string | null }>;
    create: (input: { name: string; metadata?: Record<string, unknown> }, opts?: SdkRequestOptions) => Promise<PlatformTenant>;
  };

  readonly facilities: {
    list: (query?: { activeOnly?: boolean; limit?: number; cursor?: string }, opts?: SdkRequestOptions) => Promise<{ items: Facility[]; nextCursor: string | null }>;
    create: (
      input: {
        name: string;
        category: string;
        timeZone: string;
        active?: boolean;
        metadata?: Record<string, unknown>;
      },
      opts?: SdkRequestOptions,
    ) => Promise<Facility>;
    get: (facilityId: string, opts?: SdkRequestOptions) => Promise<Facility>;
    update: (
      facilityId: string,
      input: { name?: string; category?: string; timeZone?: string; active?: boolean; metadata?: Record<string, unknown> },
      opts?: SdkRequestOptions,
    ) => Promise<Facility>;
    setSchedule: (
      facilityId: string,
      windows: Array<Omit<ScheduleWindow, "id" | "facilityId" | "tenantId" | "revision" | "active">>,
      opts?: SdkRequestOptions,
    ) => Promise<ConfigurationMutationResult>;
    setSlotPolicy: (
      facilityId: string,
      input: Omit<SlotPolicy, "facilityId" | "tenantId" | "revision" | "updatedAt">,
      opts?: SdkRequestOptions,
    ) => Promise<ConfigurationMutationResult>;
    setPricing: (
      facilityId: string,
      input: { amountMinor: number; currency: string },
      opts?: SdkRequestOptions,
    ) => Promise<ConfigurationMutationResult>;
    createBlackout: (
      facilityId: string,
      input: { startsAt: string; endsAt: string; reason: string },
      opts?: SdkRequestOptions,
    ) => Promise<Blackout>;
    createLocation: (
      input: {
        name: string;
        timeZone: string;
        addressLine1?: string;
        city?: string;
        region?: string;
        postalCode?: string;
        country?: string;
      },
      opts?: SdkRequestOptions,
    ) => Promise<Location>;
    attachLocation: (
      facilityId: string,
      input: { locationId: string; resourceKind?: string },
      opts?: SdkRequestOptions,
    ) => Promise<{ attached: boolean; facilityId: string; locationId: string }>;
  };

  readonly availability: {
    get: (
      query: { facilityId: string; fromDate: string; toDate: string },
      opts?: SdkRequestOptions,
    ) => Promise<AvailabilityResult>;
    checkSelection: (
      input: { facilityId: string; customerId?: string; slotRefs: string[] },
      opts?: SdkRequestOptions,
    ) => Promise<SelectionCheckResult>;
  };

  readonly holds: {
    create: (
      input: {
        facilityId: string;
        slotRefs: string[];
        externalCustomerId?: string;
        expiresInMinutes?: number;
        bypassMinNotice?: boolean;
        metadata?: Record<string, unknown>;
      },
      opts?: SdkRequestOptions,
    ) => Promise<HoldResult>;
    get: (holdId: string, opts?: SdkRequestOptions) => Promise<HoldResult>;
    release: (holdId: string, opts?: SdkRequestOptions) => Promise<HoldResult>;
    convert: (
      holdId: string,
      input?: {
        expectedAmountMinor?: number;
        expectedCurrency?: string;
        metadata?: Record<string, unknown>;
      },
      opts?: SdkRequestOptions,
    ) => Promise<BookingSummary>;
  };

  readonly bookings: {
    create: (
      input: {
        facilityId: string;
        slotRefs: string[];
        externalCustomerId?: string;
        expectedAmountMinor?: number;
        expectedCurrency?: string;
        bypassMinNotice?: boolean;
        metadata?: Record<string, unknown>;
      },
      opts?: SdkRequestOptions,
    ) => Promise<BookingSummary>;
    list: (
      query?: {
        facilityId?: string;
        externalCustomerId?: string;
        status?: string;
        limit?: number;
        cursor?: string;
      },
      opts?: SdkRequestOptions,
    ) => Promise<BookingListPage>;
    get: (bookingId: string, opts?: SdkRequestOptions) => Promise<BookingSummary>;
    cancel: (
      bookingId: string,
      input?: { reason?: string; overrideCancellationPolicy?: boolean },
      opts?: SdkRequestOptions,
    ) => Promise<BookingSummary>;
    complete: (bookingId: string, opts?: SdkRequestOptions) => Promise<BookingSummary>;
    markNoShow: (bookingId: string, opts?: SdkRequestOptions) => Promise<BookingSummary>;
    getHistory: (bookingId: string, opts?: SdkRequestOptions) => Promise<BookingHistoryEntry[]>;
  };

  readonly webhooks: {
    createEndpoint: (
      input: { url: string; description?: string; eventTypes?: string[] },
      opts?: SdkRequestOptions,
    ) => Promise<CreatedWebhookEndpoint>;
    listEndpoints: (opts?: SdkRequestOptions) => Promise<WebhookEndpointSummary[]>;
    disableEndpoint: (endpointId: string, opts?: SdkRequestOptions) => Promise<WebhookEndpointSummary>;
    listDeliveries: (
      query?: { endpointId?: string; status?: WebhookDeliveryStatus; limit?: number },
      opts?: SdkRequestOptions,
    ) => Promise<WebhookDeliveryRecord[]>;
    replayDelivery: (deliveryId: string, opts?: SdkRequestOptions) => Promise<WebhookDeliveryRecord>;
  };

  readonly usage: {
    getSummary: (
      query?: { tenantId?: string; from?: string; to?: string },
      opts?: SdkRequestOptions,
    ) => Promise<{ environmentId: string; metrics: UsageSummaryRow[] }>;
  };

  constructor(options: OneLineBookingClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.defaultTenantId = options.tenantId;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 50;
    this.fetchImpl = options.fetchFn ?? fetch;

    this.tenants = {
      list: async (query) => {
        const qs = new URLSearchParams();
        if (query?.limit !== undefined) qs.set("limit", String(query.limit));
        if (query?.cursor !== undefined) qs.set("cursor", query.cursor);
        const suffix = qs.toString() ? `?${qs.toString()}` : "";
        return this.request("GET", `/v1/tenants${suffix}`);
      },
      create: async (input, opts) => {
        const res = await this.request<{ tenant: PlatformTenant }>(
          "POST",
          "/v1/tenants",
          input,
          { ...opts, idempotencyKey: opts?.idempotencyKey ?? `sdk_${randomUUID()}` },
        );
        return res.tenant;
      },
    };

    this.facilities = {
      list: async (query, opts) => {
        const qs = new URLSearchParams();
        if (query?.activeOnly !== undefined) qs.set("activeOnly", String(query.activeOnly));
        if (query?.limit !== undefined) qs.set("limit", String(query.limit));
        if (query?.cursor !== undefined) qs.set("cursor", query.cursor);
        const suffix = qs.toString() ? `?${qs.toString()}` : "";
        return this.request("GET", `/v1/facilities${suffix}`, undefined, opts);
      },
      create: async (input, opts) => {
        const res = await this.request<{ facility: Facility }>(
          "POST",
          "/v1/facilities",
          input,
          { ...opts, idempotencyKey: opts?.idempotencyKey ?? `sdk_${randomUUID()}` },
        );
        return res.facility;
      },
      get: async (facilityId, opts) => {
        const res = await this.request<{ facility: Facility }>(
          "GET",
          `/v1/facilities/${encodeURIComponent(facilityId)}`,
          undefined,
          opts,
        );
        return res.facility;
      },
      update: async (facilityId, input, opts) => {
        const res = await this.request<{ facility: Facility }>(
          "PATCH",
          `/v1/facilities/${encodeURIComponent(facilityId)}`,
          input,
          opts,
        );
        return res.facility;
      },
      setSchedule: async (facilityId, windows, opts) => {
        const res = await this.request<{ schedule: ConfigurationMutationResult }>(
          "PUT",
          `/v1/facilities/${encodeURIComponent(facilityId)}/schedule`,
          { windows },
          opts,
        );
        return res.schedule;
      },
      setSlotPolicy: async (facilityId, input, opts) => {
        const res = await this.request<{ slotPolicy: ConfigurationMutationResult }>(
          "PUT",
          `/v1/facilities/${encodeURIComponent(facilityId)}/slot-policy`,
          input,
          opts,
        );
        return res.slotPolicy;
      },
      setPricing: async (facilityId, input, opts) => {
        const res = await this.request<{ pricing: ConfigurationMutationResult }>(
          "PUT",
          `/v1/facilities/${encodeURIComponent(facilityId)}/pricing`,
          input,
          opts,
        );
        return res.pricing;
      },
      createBlackout: async (facilityId, input, opts) => {
        const res = await this.request<{ blackout: Blackout }>(
          "POST",
          `/v1/facilities/${encodeURIComponent(facilityId)}/blackouts`,
          input,
          opts,
        );
        return res.blackout;
      },
      createLocation: async (input, opts) => {
        const res = await this.request<{ location: Location }>("POST", "/v1/locations", input, opts);
        return res.location;
      },
      attachLocation: async (facilityId, input, opts) => {
        return this.request(
          "POST",
          `/v1/facilities/${encodeURIComponent(facilityId)}/location`,
          input,
          opts,
        );
      },
    };

    this.availability = {
      get: async (query, opts) => {
        const qs = new URLSearchParams({
          facilityId: query.facilityId,
          fromDate: query.fromDate,
          toDate: query.toDate,
        });
        return this.request("GET", `/v1/availability?${qs.toString()}`, undefined, opts);
      },
      checkSelection: async (input, opts) => {
        return this.request("POST", "/v1/availability/check", input, opts);
      },
    };

    this.holds = {
      create: async (input, opts) => {
        const res = await this.request<{ hold: HoldResult }>(
          "POST",
          "/v1/holds",
          input,
          { ...opts, idempotencyKey: opts?.idempotencyKey ?? `sdk_${randomUUID()}` },
        );
        return res.hold;
      },
      get: async (holdId, opts) => {
        const res = await this.request<{ hold: HoldResult }>(
          "GET",
          `/v1/holds/${encodeURIComponent(holdId)}`,
          undefined,
          opts,
        );
        return res.hold;
      },
      release: async (holdId, opts) => {
        const res = await this.request<{ hold: HoldResult }>(
          "DELETE",
          `/v1/holds/${encodeURIComponent(holdId)}`,
          undefined,
          { ...opts, idempotencyKey: opts?.idempotencyKey ?? `sdk_${randomUUID()}` },
        );
        return res.hold;
      },
      convert: async (holdId, input, opts) => {
        const res = await this.request<{ booking: BookingSummary }>(
          "POST",
          `/v1/holds/${encodeURIComponent(holdId)}/convert`,
          input ?? {},
          { ...opts, idempotencyKey: opts?.idempotencyKey ?? `sdk_${randomUUID()}` },
        );
        return res.booking;
      },
    };

    this.bookings = {
      create: async (input, opts) => {
        const res = await this.request<{ booking: BookingSummary }>(
          "POST",
          "/v1/bookings",
          input,
          { ...opts, idempotencyKey: opts?.idempotencyKey ?? `sdk_${randomUUID()}` },
        );
        return res.booking;
      },
      list: async (query, opts) => {
        const qs = new URLSearchParams();
        if (query?.facilityId) qs.set("facilityId", query.facilityId);
        if (query?.externalCustomerId) qs.set("externalCustomerId", query.externalCustomerId);
        if (query?.status) qs.set("status", query.status);
        if (query?.limit !== undefined) qs.set("limit", String(query.limit));
        if (query?.cursor) qs.set("cursor", query.cursor);
        const suffix = qs.toString() ? `?${qs.toString()}` : "";
        return this.request("GET", `/v1/bookings${suffix}`, undefined, opts);
      },
      get: async (bookingId, opts) => {
        const res = await this.request<{ booking: BookingSummary }>(
          "GET",
          `/v1/bookings/${encodeURIComponent(bookingId)}`,
          undefined,
          opts,
        );
        return res.booking;
      },
      cancel: async (bookingId, input, opts) => {
        const res = await this.request<{ booking: BookingSummary }>(
          "POST",
          `/v1/bookings/${encodeURIComponent(bookingId)}/cancel`,
          input ?? {},
          { ...opts, idempotencyKey: opts?.idempotencyKey ?? `sdk_${randomUUID()}` },
        );
        return res.booking;
      },
      complete: async (bookingId, opts) => {
        const res = await this.request<{ booking: BookingSummary }>(
          "POST",
          `/v1/bookings/${encodeURIComponent(bookingId)}/complete`,
          {},
          { ...opts, idempotencyKey: opts?.idempotencyKey ?? `sdk_${randomUUID()}` },
        );
        return res.booking;
      },
      markNoShow: async (bookingId, opts) => {
        const res = await this.request<{ booking: BookingSummary }>(
          "POST",
          `/v1/bookings/${encodeURIComponent(bookingId)}/no-show`,
          {},
          { ...opts, idempotencyKey: opts?.idempotencyKey ?? `sdk_${randomUUID()}` },
        );
        return res.booking;
      },
      getHistory: async (bookingId, opts) => {
        const res = await this.request<{ items: BookingHistoryEntry[] }>(
          "GET",
          `/v1/bookings/${encodeURIComponent(bookingId)}/history`,
          undefined,
          opts,
        );
        return res.items;
      },
    };

    this.webhooks = {
      createEndpoint: async (input, opts) => {
        return this.request("POST", "/v1/webhooks/endpoints", input, opts);
      },
      listEndpoints: async (opts) => {
        const res = await this.request<{ items: WebhookEndpointSummary[] }>(
          "GET",
          "/v1/webhooks/endpoints",
          undefined,
          opts,
        );
        return res.items;
      },
      disableEndpoint: async (endpointId, opts) => {
        const res = await this.request<{ endpoint: WebhookEndpointSummary }>(
          "DELETE",
          `/v1/webhooks/endpoints/${encodeURIComponent(endpointId)}`,
          undefined,
          opts,
        );
        return res.endpoint;
      },
      listDeliveries: async (query, opts) => {
        const qs = new URLSearchParams();
        if (query?.endpointId) qs.set("endpointId", query.endpointId);
        if (query?.status) qs.set("status", query.status);
        if (query?.limit !== undefined) qs.set("limit", String(query.limit));
        const suffix = qs.toString() ? `?${qs.toString()}` : "";
        const res = await this.request<{ items: WebhookDeliveryRecord[] }>(
          "GET",
          `/v1/webhooks/deliveries${suffix}`,
          undefined,
          opts,
        );
        return res.items;
      },
      replayDelivery: async (deliveryId, opts) => {
        const res = await this.request<{ delivery: WebhookDeliveryRecord }>(
          "POST",
          `/v1/webhooks/deliveries/${encodeURIComponent(deliveryId)}/replay`,
          {},
          opts,
        );
        return res.delivery;
      },
    };

    this.usage = {
      getSummary: async (query, opts) => {
        const qs = new URLSearchParams();
        if (query?.tenantId) qs.set("tenantId", query.tenantId);
        if (query?.from) qs.set("from", query.from);
        if (query?.to) qs.set("to", query.to);
        const suffix = qs.toString() ? `?${qs.toString()}` : "";
        return this.request("GET", `/v1/usage${suffix}`, undefined, opts);
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

    let lastError: unknown;

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      timeout.unref();

      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.apiKey}`,
          "X-Correlation-Id": correlationId,
        };
        if (tenantId) {
          headers["X-Tenant-Id"] = tenantId;
        }
        if (opts?.idempotencyKey) {
          headers["Idempotency-Key"] = opts.idempotencyKey;
        }
        if (body !== undefined) {
          headers["Content-Type"] = "application/json";
        }

        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const parsed = (await res.json().catch(() => null)) as unknown;
        if (res.ok) {
          return parsed as T;
        }

        const env = (parsed as OneLineBookingErrorEnvelope | null)?.error ?? {
          code: "INTERNAL_ERROR",
          category: "infrastructure",
          message: `HTTP ${res.status}`,
          retryable: res.status === 429 || res.status >= 500,
        };
        const apiErr = new OneLineBookingApiError(res.status, env);
        const isTransientStatus = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;

        if (canRetry && isTransientStatus && attempt + 1 < totalAttempts) {
          const retryAfterMs = apiErr.retryAfterSeconds
            ? apiErr.retryAfterSeconds * 1000
            : this.retryBaseDelayMs * 2 ** attempt;
          await new Promise((r) => setTimeout(r, Math.min(retryAfterMs, 5_000)));
          lastError = apiErr;
          continue;
        }
        throw apiErr;
      } catch (err) {
        clearTimeout(timeout);
        if (err instanceof OneLineBookingApiError) {
          throw err;
        }
        lastError = err;
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

    throw lastError;
  }
}
