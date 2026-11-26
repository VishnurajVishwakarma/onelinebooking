import type {
  AvailabilityResult,
  Blackout,
  BookingHistoryEntry,
  BookingListPage,
  BookingStatus,
  BookingSummary,
  CancellationPolicy,
  ConfigurationMutationResult,
  ExceptionWindow,
  ExpireHoldsResult,
  Facility,
  HoldResult,
  ISODate,
  OutboxEvent,
  RequestOptions,
  ScheduleException,
  ScheduleWindow,
  SelectionCheckResult,
  SlotOverride,
  SlotOverrideAction,
  SlotPolicy,
  Tenant,
  TenantContext,
  UUID,
} from "../../domain/model.js";

export interface CreateTenantInput {
  name: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface CreateFacilityInput {
  name: string;
  category: string;
  timeZone: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface UpdateFacilityInput {
  name?: string | undefined;
  category?: string | undefined;
  timeZone?: string | undefined;
  active?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface SetScheduleExceptionInput {
  facilityId: UUID;
  businessDate: ISODate;
  windows: ExceptionWindow[];
}

export interface SetSlotOverrideInput {
  facilityId: UUID;
  businessDate: ISODate;
  startsAt: Date;
  endsAt: Date;
  action: SlotOverrideAction;
  reason: string;
}

export interface SetPricingInput {
  facilityId: UUID;
  amountMinor: number;
  currency: string;
}

export interface SetCancellationPolicyInput {
  facilityId: UUID;
  customerCancellationAllowed: boolean;
  minNoticeMinutes: number;
  adminOverrideAllowed: boolean;
}

export interface CreateBlackoutInput {
  facilityId: UUID;
  startsAt: Date;
  endsAt: Date;
  reason: string;
}

export interface AvailabilityQueryInput {
  facilityIds: UUID[];
  fromDate: ISODate;
  toDate: ISODate;
  includeUnavailable: boolean;
  includeInactiveDiagnostics: boolean;
}

export interface CheckSelectionInput {
  facilityId: UUID;
  slotRefs: string[];
  bypassMinNotice: boolean;
}

export interface CreateHoldInput {
  facilityId: UUID;
  slotRefs: string[];
  externalCustomerId?: string | undefined;
  expectedAmountMinor?: number | undefined;
  expectedCurrency?: string | undefined;
  holdMinutes?: number | undefined;
  bypassMinNotice: boolean;
  metadata?: Record<string, unknown> | undefined;
}

export interface ConvertHoldInput {
  holdId: UUID;
  expectedAmountMinor?: number | undefined;
  expectedCurrency?: string | undefined;
  externalPaymentRef?: string | undefined;
}

export interface CreateDirectBookingInput {
  facilityId: UUID;
  slotRefs: string[];
  externalCustomerId?: string | undefined;
  expectedAmountMinor?: number | undefined;
  expectedCurrency?: string | undefined;
  externalPaymentRef?: string | undefined;
  bypassMinNotice: boolean;
  metadata?: Record<string, unknown> | undefined;
}

export interface CancelBookingInput {
  bookingId: UUID;
  reason?: string | undefined;
}

export interface ListBookingsQuery {
  facilityId?: UUID | undefined;
  status?: BookingStatus | undefined;
  externalCustomerId?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}

export interface BookingStore {
  // Tenant provisioning (privileged)
  createTenant(input: CreateTenantInput): Promise<Tenant>;
  getTenant(tenantId: UUID): Promise<Tenant>;
  archiveTenant(tenantId: UUID): Promise<Tenant>;

  // Facilities
  createFacility(ctx: TenantContext, input: CreateFacilityInput): Promise<Facility>;
  getFacility(ctx: TenantContext, facilityId: UUID): Promise<Facility>;
  listFacilities(ctx: TenantContext, options?: { includeInactive?: boolean }): Promise<Facility[]>;
  updateFacility(ctx: TenantContext, facilityId: UUID, input: UpdateFacilityInput): Promise<Facility>;
  deactivateFacility(ctx: TenantContext, facilityId: UUID, reason?: string): Promise<Facility>;

  // Configuration
  setSchedule(ctx: TenantContext, facilityId: UUID, windows: ScheduleWindow[]): Promise<ConfigurationMutationResult>;
  setScheduleException(ctx: TenantContext, input: SetScheduleExceptionInput): Promise<ConfigurationMutationResult & { exception: ScheduleException }>;
  removeScheduleException(ctx: TenantContext, facilityId: UUID, businessDate: ISODate): Promise<ConfigurationMutationResult>;
  setSlotPolicy(ctx: TenantContext, facilityId: UUID, policy: SlotPolicy): Promise<ConfigurationMutationResult>;
  setSlotOverride(ctx: TenantContext, input: SetSlotOverrideInput): Promise<ConfigurationMutationResult & { override: SlotOverride }>;
  removeSlotOverride(ctx: TenantContext, facilityId: UUID, overrideId: UUID): Promise<ConfigurationMutationResult>;
  setPricing(ctx: TenantContext, input: SetPricingInput): Promise<ConfigurationMutationResult>;
  setCancellationPolicy(ctx: TenantContext, input: SetCancellationPolicyInput): Promise<ConfigurationMutationResult & { policy: CancellationPolicy }>;

  // Blackouts
  createBlackout(ctx: TenantContext, input: CreateBlackoutInput): Promise<Blackout>;
  removeBlackout(ctx: TenantContext, facilityId: UUID, blackoutId: UUID, reason?: string): Promise<void>;
  listBlackouts(ctx: TenantContext, facilityId: UUID, options?: { includeInactive?: boolean }): Promise<Blackout[]>;

  // Availability & selection
  getAvailability(ctx: TenantContext, query: AvailabilityQueryInput): Promise<AvailabilityResult>;
  checkSelection(ctx: TenantContext, input: CheckSelectionInput): Promise<SelectionCheckResult>;

  // Holds
  createHold(ctx: TenantContext, input: CreateHoldInput, options: RequestOptions): Promise<HoldResult>;
  getHold(ctx: TenantContext, holdId: UUID): Promise<HoldResult>;
  releaseHold(ctx: TenantContext, holdId: UUID, options?: Partial<RequestOptions>): Promise<HoldResult>;
  convertHoldToBooking(ctx: TenantContext, input: ConvertHoldInput, options: RequestOptions): Promise<BookingSummary>;

  // Bookings
  createBooking(ctx: TenantContext, input: CreateDirectBookingInput, options: RequestOptions): Promise<BookingSummary>;
  getBooking(ctx: TenantContext, bookingId: UUID): Promise<BookingSummary>;
  listBookings(ctx: TenantContext, query: ListBookingsQuery): Promise<BookingListPage>;
  cancelBooking(ctx: TenantContext, input: CancelBookingInput, options?: Partial<RequestOptions>): Promise<BookingSummary>;
  completeBooking(ctx: TenantContext, bookingId: UUID, options?: Partial<RequestOptions>): Promise<BookingSummary>;
  markNoShow(ctx: TenantContext, bookingId: UUID, options?: Partial<RequestOptions>): Promise<BookingSummary>;
  getBookingHistory(ctx: TenantContext, aggregateType: string, aggregateId: UUID): Promise<BookingHistoryEntry[]>;

  // Maintenance & durable outbox
  expireHolds(limit?: number): Promise<ExpireHoldsResult>;
  claimEvents(options?: { limit?: number; leaseSeconds?: number }): Promise<OutboxEvent[]>;
  ackEvent(eventId: UUID, leaseToken: UUID): Promise<void>;
  retryEvent(eventId: UUID, leaseToken: UUID, errorMessage?: string, backoffSeconds?: number): Promise<OutboxEvent>;
  replayFailedEvent(eventId: UUID): Promise<OutboxEvent>;
  cleanupIdempotencyRecords(limit?: number): Promise<number>;
}
