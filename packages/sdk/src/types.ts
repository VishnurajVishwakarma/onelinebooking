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

export class SdkSecurityBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SdkSecurityBoundaryError";
  }
}

export interface PlatformTenantDto {
  id: string;
  name: string;
  status: "active" | "archived";
  organizationId: string;
  projectId: string;
  environmentId: string;
  environmentType: "test" | "live";
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface FacilityDto {
  id: string;
  tenantId: string;
  name: string;
  category: string;
  timeZone: string;
  active: boolean;
  configurationRevision: number;
  metadata: Record<string, unknown>;
}

export interface AvailabilitySlotDto {
  facilityId: string;
  slotRef: string;
  configurationRevision: number;
  businessDate: string;
  startsAt: string;
  endsAt: string;
  localStart: string;
  localEnd: string;
  timeZone: string;
  localOffset: string;
  available: boolean;
  reasonCode: string | null;
  amountMinor: number | null;
  currency: string | null;
}

export interface AvailabilityResultDto {
  asOf: string;
  facilities: FacilityDto[];
  fromDate: string;
  toDate: string;
  slots: AvailabilitySlotDto[];
  diagnostics: Array<{ facilityId: string; localDate?: string; code: string; message: string }>;
}

export interface HoldResultDto {
  id: string;
  tenantId: string;
  facilityId: string;
  state: "active" | "converted" | "released" | "expired";
  expiresAt: string;
  externalCustomerId: string | null;
  totalMinor: number;
  currency: string;
  startsAt: string;
  endsAt: string;
}

export interface BookingSummaryDto {
  id: string;
  tenantId: string;
  facilityId: string;
  status: "confirmed" | "cancelled" | "completed" | "no_show";
  sourceHoldId: string | null;
  externalCustomerId: string | null;
  totalMinor: number;
  currency: string;
  startsAt: string;
  endsAt: string;
  createdAt: string;
}

export interface SdkRequestOptions {
  idempotencyKey?: string;
  correlationId?: string;
  tenantId?: string;
}

