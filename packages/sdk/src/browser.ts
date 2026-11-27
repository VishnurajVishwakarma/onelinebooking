import {
  OneLineBookingApiError,
  SdkSecurityBoundaryError,
  type AvailabilityResultDto,
  type BookingSummaryDto,
  type HoldResultDto,
  type OneLineBookingErrorEnvelope,
  type SdkRequestOptions,
} from "./types.js";

export * from "./types.js";
export { formatMinorCurrency, minorUnitExponent } from "./money.js";

export interface OneLineBookingPublicClientOptions {
  /** Base URL of your own application's BFF/proxy endpoints (never send secret olb_live_ keys from browsers). */
  proxyBaseUrl: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  fetchFn?: typeof fetch;
  headers?: Record<string, string>;
}

function generateClientUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * Browser-safe OneLineBooking client designed for React/Next.js frontend components.
 * Communicates strictly with your own backend proxy (which holds server-only `olb_*` credentials).
 */
export class OneLineBookingPublicClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders: Record<string, string>;

  readonly availability: {
    get: (query: { facilityId: string; fromDate: string; toDate: string }) => Promise<AvailabilityResultDto>;
  };

  readonly holds: {
    create: (
      input: { facilityId: string; slotRefs: string[]; externalCustomerId?: string },
      opts?: SdkRequestOptions,
    ) => Promise<HoldResultDto>;
    convert: (
      holdId: string,
      input?: { expectedAmountMinor?: number; expectedCurrency?: string },
      opts?: SdkRequestOptions,
    ) => Promise<BookingSummaryDto>;
  };

  constructor(options: OneLineBookingPublicClientOptions) {
    if (options.headers) {
      for (const value of Object.values(options.headers)) {
        if (/olb_(test|live)_/i.test(value)) {
          throw new SdkSecurityBoundaryError(
            "Do not pass OneLineBooking secret API keys in browser headers. Use a server-side proxy instead.",
          );
        }
      }
    }
    this.baseUrl = options.proxyBaseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 100;
    this.fetchImpl = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.extraHeaders = options.headers ?? {};

    this.availability = {
      get: async (query) => {
        const qs = new URLSearchParams(query);
        return this.request("GET", `/availability?${qs.toString()}`);
      },
    };

    this.holds = {
      create: async (input, opts) => {
        const key = opts?.idempotencyKey ?? `pub_${generateClientUuid()}`;
        const res = await this.request<{ hold: HoldResultDto }>("POST", "/holds", input, {
          ...opts,
          idempotencyKey: key,
        });
        return res.hold;
      },
      convert: async (holdId, input, opts) => {
        const key = opts?.idempotencyKey ?? `pub_${generateClientUuid()}`;
        const res = await this.request<{ booking: BookingSummaryDto }>(
          "POST",
          `/holds/${encodeURIComponent(holdId)}/convert`,
          input ?? {},
          { ...opts, idempotencyKey: key },
        );
        return res.booking;
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
    const correlationId = opts?.correlationId ?? `pubcor_${generateClientUuid()}`;

    let lastErr: unknown;
    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      if (opts?.signal?.aborted) {
        throw opts.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      }
      const controller = new AbortController();
      const onCallerAbort = () => controller.abort(opts?.signal?.reason);
      opts?.signal?.addEventListener("abort", onCallerAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = {
          ...this.extraHeaders,
          "X-Correlation-Id": correlationId,
        };
        if (opts?.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
        if (body !== undefined) headers["Content-Type"] = "application/json";

        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", onCallerAbort);
        const parsed = (await res.json().catch(() => null)) as unknown;
        if (res.ok) return parsed as T;

        const env = (parsed as OneLineBookingErrorEnvelope | null)?.error ?? {
          code: "INTERNAL_ERROR",
          category: "infrastructure",
          message: `HTTP ${res.status}`,
          retryable: res.status === 429 || res.status >= 500,
        };
        const apiErr = new OneLineBookingApiError(res.status, env);
        if (
          canRetry &&
          (res.status === 429 || res.status === 503 || res.status === 504) &&
          attempt + 1 < totalAttempts &&
          !opts?.signal?.aborted
        ) {
          await new Promise((r) => setTimeout(r, this.retryBaseDelayMs * 2 ** attempt));
          lastErr = apiErr;
          continue;
        }
        throw apiErr;
      } catch (err) {
        clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", onCallerAbort);
        if (opts?.signal?.aborted) throw err;
        if (err instanceof OneLineBookingApiError) throw err;
        lastErr = err;
        if (canRetry && attempt + 1 < totalAttempts) {
          await new Promise((r) => setTimeout(r, this.retryBaseDelayMs * 2 ** attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }
}

