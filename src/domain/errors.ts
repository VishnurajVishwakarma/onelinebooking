export type BookingErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CONFIGURATION"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "FACILITY_INACTIVE"
  | "OUTSIDE_OPERATING_HOURS"
  | "SLOT_NOT_FOUND"
  | "STALE_CONFIGURATION"
  | "SLOT_CONFLICT"
  | "BLACKOUT_CONFLICT"
  | "BUFFER_CONFLICT"
  | "MINIMUM_NOTICE_REQUIRED"
  | "BOOKING_HORIZON_EXCEEDED"
  | "INVALID_SLOT_SELECTION"
  | "HOLD_EXPIRED"
  | "INVALID_STATE_TRANSITION"
  | "PRICE_CHANGED"
  | "POLICY_VIOLATION"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "CONFIGURATION_CONFLICT"
  | "QUERY_LIMIT_EXCEEDED"
  | "HOLD_LIMIT_EXCEEDED"
  | "TEMPORARY_UNAVAILABLE"
  | "INTERNAL_ERROR";

export type BookingErrorCategory =
  | "validation"
  | "authorization"
  | "not_found"
  | "policy"
  | "conflict"
  | "infrastructure";

interface ErrorSpec {
  category: BookingErrorCategory;
  retryable: boolean;
}

const ERROR_SPECS: Record<BookingErrorCode, ErrorSpec> = {
  INVALID_INPUT: { category: "validation", retryable: false },
  INVALID_CONFIGURATION: { category: "validation", retryable: false },
  NOT_FOUND: { category: "not_found", retryable: false },
  FORBIDDEN: { category: "authorization", retryable: false },
  FACILITY_INACTIVE: { category: "policy", retryable: false },
  OUTSIDE_OPERATING_HOURS: { category: "policy", retryable: false },
  SLOT_NOT_FOUND: { category: "validation", retryable: false },
  STALE_CONFIGURATION: { category: "conflict", retryable: false },
  SLOT_CONFLICT: { category: "conflict", retryable: false },
  BLACKOUT_CONFLICT: { category: "conflict", retryable: false },
  BUFFER_CONFLICT: { category: "conflict", retryable: false },
  MINIMUM_NOTICE_REQUIRED: { category: "policy", retryable: false },
  BOOKING_HORIZON_EXCEEDED: { category: "policy", retryable: false },
  INVALID_SLOT_SELECTION: { category: "validation", retryable: false },
  HOLD_EXPIRED: { category: "conflict", retryable: false },
  INVALID_STATE_TRANSITION: { category: "conflict", retryable: false },
  PRICE_CHANGED: { category: "conflict", retryable: false },
  POLICY_VIOLATION: { category: "policy", retryable: false },
  IDEMPOTENCY_KEY_CONFLICT: { category: "conflict", retryable: false },
  CONFIGURATION_CONFLICT: { category: "conflict", retryable: false },
  QUERY_LIMIT_EXCEEDED: { category: "validation", retryable: false },
  HOLD_LIMIT_EXCEEDED: { category: "policy", retryable: false },
  TEMPORARY_UNAVAILABLE: { category: "infrastructure", retryable: true },
  INTERNAL_ERROR: { category: "infrastructure", retryable: false },
};

export interface BookingErrorOptions extends ErrorOptions {
  retryable?: boolean;
  correlationId?: string;
  details?: Record<string, unknown>;
}

/** Structured, sanitized domain/application error for all rejected booking operations. */
export class BookingError extends Error {
  readonly category: BookingErrorCategory;
  readonly retryable: boolean;
  readonly correlationId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    readonly code: BookingErrorCode,
    message: string,
    options?: BookingErrorOptions,
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "BookingError";
    const spec = ERROR_SPECS[code];
    this.category = spec.category;
    this.retryable = options?.retryable ?? spec.retryable;
    this.correlationId = options?.correlationId;
    this.details = options?.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      ...(this.correlationId ? { correlationId: this.correlationId } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function getErrorCategory(code: BookingErrorCode): BookingErrorCategory {
  return ERROR_SPECS[code].category;
}
