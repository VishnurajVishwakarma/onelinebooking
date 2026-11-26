import type { BookingErrorCode } from "./errors.js";

export type UUID = string;
export type ISODate = string;
export type ISODateTime = string;

export type TenantStatus = "active" | "archived";

export interface Tenant {
  id: UUID;
  name: string;
  status: TenantStatus;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export type ActorType = "customer" | "staff" | "admin" | "system";

export type Capability =
  | "facility:read"
  | "facility:write"
  | "schedule:write"
  | "blackout:write"
  | "availability:read"
  | "hold:create"
  | "hold:read"
  | "hold:release"
  | "hold:convert"
  | "booking:create_direct"
  | "booking:read"
  | "booking:cancel"
  | "booking:complete"
  | "booking:no_show"
  | "booking:override_notice"
  | "booking:override_cancellation"
  | "audit:read"
  | "maintenance:run";

export interface Actor {
  id: string;
  type: ActorType;
  capabilities: readonly Capability[];
  customerId?: string | undefined;
  callerNamespace?: string | undefined;
}

export interface TenantContext {
  tenantId: UUID;
  actor: Actor;
  correlationId?: string | undefined;
}

export interface RequestOptions {
  idempotencyKey: string;
  correlationId?: string | undefined;
}

export interface Facility {
  id: UUID;
  tenantId: UUID;
  name: string;
  category: string;
  timeZone: string;
  active: boolean;
  configurationRevision: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface ScheduleBreak {
  startsAt: string;
  endsAt: string;
  startDayOffset: 0 | 1;
  endDayOffset: 0 | 1;
}

export interface ScheduleWindow {
  /** ISO weekday: Monday = 1, Sunday = 7. */
  weekday: number;
  opensAt: string;
  closesAt: string;
  endDayOffset: 0 | 1;
  effectiveFrom: ISODate;
  effectiveUntil: ISODate | null;
  breaks: ScheduleBreak[];
}

export interface ExceptionWindow {
  opensAt: string;
  closesAt: string;
  endDayOffset: 0 | 1;
  breaks: ScheduleBreak[];
}

export interface ScheduleException {
  id: UUID;
  facilityId: UUID;
  businessDate: ISODate;
  isClosed: boolean;
  windows: ExceptionWindow[];
  revision: number;
}

export type SlotOverrideAction = "add" | "suppress";

export interface SlotOverride {
  id: UUID;
  facilityId: UUID;
  businessDate: ISODate;
  startsAt: Date;
  endsAt: Date;
  action: SlotOverrideAction;
  reason: string;
  configurationRevision: number;
}

export interface SlotPolicy {
  durationMinutes: number;
  intervalMinutes: number;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  maxSlotsPerBooking: number;
  defaultHoldMinutes: number;
  maxActiveHoldsPerCustomer: number;
  revision?: number | undefined;
}

export interface PricingRule {
  facilityId: UUID;
  revision: number;
  amountMinor: number;
  currency: string;
  createdAt: Date;
}

export interface CancellationPolicy {
  customerCancellationAllowed: boolean;
  minNoticeMinutes: number;
  adminOverrideAllowed: boolean;
  revision?: number | undefined;
}

export interface Blackout {
  id: UUID;
  facilityId: UUID;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  active: boolean;
  createdAt: Date;
}

export interface TimeInterval {
  startsAt: Date;
  endsAt: Date;
}

export interface OccupiedInterval extends TimeInterval {
  kind: "block" | "allocation";
  serviceStart?: Date | undefined;
  serviceEnd?: Date | undefined;
}

export interface AvailabilitySlot {
  facilityId: UUID;
  slotRef: string;
  configurationRevision: number;
  businessDate: ISODate;
  startsAt: Date;
  endsAt: Date;
  localStart: string;
  localEnd: string;
  timeZone: string;
  localOffset: string;
  available: boolean;
  reasonCode: BookingErrorCode | null;
  amountMinor: number | null;
  currency: string | null;
}

export interface AvailabilityDiagnostic {
  facilityId: UUID;
  localDate?: ISODate | undefined;
  code: string;
  message: string;
}

export interface AvailabilityResult {
  asOf: Date;
  facilities: Facility[];
  fromDate: ISODate;
  toDate: ISODate;
  slots: AvailabilitySlot[];
  diagnostics: AvailabilityDiagnostic[];
}

export interface SelectionCheckResult {
  asOf: Date;
  valid: boolean;
  facilityId: UUID;
  configurationRevision: number;
  reasonCode: BookingErrorCode | null;
  message: string | null;
  serviceStart: Date | null;
  serviceEnd: Date | null;
  occupiedStart: Date | null;
  occupiedEnd: Date | null;
  totalMinor: number | null;
  currency: string | null;
  slots: AvailabilitySlot[];
}

export type HoldState = "active" | "converted" | "released" | "expired";
export type BookingStatus = "confirmed" | "cancelled" | "completed" | "no_show";
export type AllocationStatus = "held" | "reserved" | "released";

export interface ReservationItem {
  id: UUID;
  slotRef: string;
  businessDate: ISODate;
  startsAt: Date;
  endsAt: Date;
  localStart: string;
  localEnd: string;
  localOffset: string;
  priceMinor: number;
  currency: string;
}

export interface HoldResult {
  id: UUID;
  tenantId: UUID;
  facilityId: UUID;
  state: HoldState;
  expiresAt: Date;
  expiredRecordedAt: Date | null;
  convertedBookingId: UUID | null;
  externalCustomerId: string | null;
  facilityTimeZone: string;
  configurationRevision: number;
  pricingRevision: number;
  cancellationPolicy: CancellationPolicy;
  totalMinor: number;
  currency: string;
  quoteCreatedAt: Date;
  startsAt: Date;
  endsAt: Date;
  occupiedFrom: Date;
  occupiedUntil: Date;
  items: ReservationItem[];
  createdAt: Date;
  updatedAt: Date;
}

export interface BookingSummary {
  id: UUID;
  tenantId: UUID;
  facilityId: UUID;
  status: BookingStatus;
  sourceHoldId: UUID | null;
  externalCustomerId: string | null;
  externalPaymentRef: string | null;
  facilityTimeZone: string;
  configurationRevision: number;
  pricingRevision: number;
  cancellationPolicy: CancellationPolicy;
  startsAt: Date;
  endsAt: Date;
  occupiedFrom: Date;
  occupiedUntil: Date;
  totalMinor: number;
  currency: string;
  items: ReservationItem[];
  cancelledAt: Date | null;
  cancellationReason: string | null;
  completedAt: Date | null;
  noShowAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BookingListPage {
  items: BookingSummary[];
  nextCursor: string | null;
}

export interface BookingHistoryEntry {
  id: UUID;
  tenantId: UUID;
  aggregateType: string;
  aggregateId: UUID;
  facilityId: UUID | null;
  action: string;
  actor: Actor;
  priorState: string | null;
  newState: string | null;
  diff: Record<string, unknown> | null;
  reason: string | null;
  correlationId: string | null;
  decisionAt: Date;
  recordedAt: Date;
}

export type OutboxEventStatus = "pending" | "failed" | "delivered";

export interface OutboxEvent {
  id: UUID;
  tenantId: UUID;
  aggregateType: string;
  aggregateId: UUID;
  aggregateSequence: number;
  eventType: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  occurredAt: Date;
  recordedAt: Date;
  status: OutboxEventStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  leaseToken: UUID | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  deliveredAt: Date | null;
}

export interface ConfigurationWarning {
  code: string;
  bookingId: UUID;
  startsAt: Date;
  endsAt: Date;
  message: string;
}

export interface ConfigurationMutationResult {
  configurationRevision: number;
  warnings: ConfigurationWarning[];
}

export interface ExpireHoldsResult {
  expiredCount: number;
  expiredHoldIds: UUID[];
}

export interface BookingLogger {
  info?(event: string, fields: Record<string, unknown>): void;
  warn?(event: string, fields: Record<string, unknown>): void;
  error?(event: string, fields: Record<string, unknown>): void;
}

export interface BookingMetrics {
  recordOperation?(metric: {
    operation: string;
    durationMs: number;
    success: boolean;
    errorCode?: BookingErrorCode | undefined;
  }): void;
  recordConflict?(code: BookingErrorCode): void;
  recordHoldExpiry?(count: number): void;
  recordOutboxAction?(action: "claimed" | "acked" | "retried" | "failed", count: number): void;
}

export interface ObservabilityHooks {
  logger?: BookingLogger | undefined;
  metrics?: BookingMetrics | undefined;
}
