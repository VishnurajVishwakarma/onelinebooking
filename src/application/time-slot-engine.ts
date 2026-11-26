import { BookingError } from "../domain/errors.js";
import type {
  Actor,
  AvailabilityResult,
  Blackout,
  BookingHistoryEntry,
  BookingListPage,
  BookingSummary,
  CancellationPolicy,
  Capability,
  ConfigurationMutationResult,
  ExpireHoldsResult,
  Facility,
  HoldResult,
  ISODate,
  ObservabilityHooks,
  OutboxEvent,
  RequestOptions,
  ScheduleException,
  ScheduleWindow,
  SelectionCheckResult,
  SlotOverride,
  SlotPolicy,
  Tenant,
  TenantContext,
  UUID,
} from "../domain/model.js";
import { validateScheduleOverlaps } from "../domain/slot-generation.js";
import {
  availabilityQuerySchema,
  cancelBookingSchema,
  checkSelectionSchema,
  createBlackoutSchema,
  createDirectBookingSchema,
  createFacilitySchema,
  createHoldSchema,
  createTenantSchema,
  convertHoldSchema,
  idempotencyKeySchema,
  listBookingsSchema,
  localDateSchema,
  parseInput,
  scheduleWindowSchema,
  setCancellationPolicySchema,
  setPricingSchema,
  setScheduleExceptionSchema,
  setSlotOverrideSchema,
  slotPolicySchema,
  updateFacilitySchema,
  uuidSchema,
} from "../domain/validation.js";
import type { BookingStore } from "./ports/booking-store.js";

export const ALL_ADMIN_CAPABILITIES: readonly Capability[] = [
  "facility:read",
  "facility:write",
  "schedule:write",
  "blackout:write",
  "availability:read",
  "hold:create",
  "hold:read",
  "hold:release",
  "hold:convert",
  "booking:create_direct",
  "booking:read",
  "booking:cancel",
  "booking:complete",
  "booking:no_show",
  "booking:override_notice",
  "booking:override_cancellation",
  "audit:read",
  "maintenance:run",
];

export const DEFAULT_CUSTOMER_CAPABILITIES: readonly Capability[] = [
  "facility:read",
  "availability:read",
  "hold:create",
  "hold:read",
  "hold:release",
  "hold:convert",
  "booking:read",
  "booking:cancel",
];

function safeObserve(fn: (() => void) | undefined): void {
  if (!fn) return;
  try {
    fn();
  } catch {
    // Observability failures must never fail or roll back booking operations (§12.3).
  }
}

function assertCapability(actor: Actor, capability: Capability, correlationId?: string): void {
  if (!actor.capabilities.includes(capability)) {
    throw new BookingError("FORBIDDEN", `Actor lacks required capability: ${capability}`, {
      ...(correlationId ? { correlationId } : {}),
    });
  }
}

function assertRequestOptions(options: unknown, correlationId?: string): RequestOptions {
  if (!options || typeof options !== "object") {
    throw new BookingError("INVALID_INPUT", "RequestOptions with idempotencyKey is required", {
      ...(correlationId ? { correlationId } : {}),
    });
  }
  const obj = options as Record<string, unknown>;
  const idempotencyKey = parseInput(idempotencyKeySchema, obj.idempotencyKey);
  const resolvedCorr = typeof obj.correlationId === "string" ? obj.correlationId : correlationId;
  return {
    idempotencyKey,
    ...(resolvedCorr ? { correlationId: resolvedCorr } : {}),
  };
}

function parseOptionalRequestOptions(options: unknown, correlationId?: string): Partial<RequestOptions> | undefined {
  if (!options || typeof options !== "object") {
    return correlationId ? { correlationId } : undefined;
  }
  const obj = options as Record<string, unknown>;
  const idempotencyKey = obj.idempotencyKey !== undefined
    ? parseInput(idempotencyKeySchema, obj.idempotencyKey)
    : undefined;
  const resolvedCorr = typeof obj.correlationId === "string" ? obj.correlationId : correlationId;
  return {
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(resolvedCorr ? { correlationId: resolvedCorr } : {}),
  };
}

/**
 * Trusted server-side booking engine entry point (§11, §13).
 * Host applications supply authenticated tenant/actor context via `forTenant(context)`.
 */
export class TimeSlotEngine {
  constructor(
    private readonly store: BookingStore,
    private readonly hooks: ObservabilityHooks = {},
  ) {}

  forTenant(context: TenantContext): TenantBookingClient {
    parseInput(uuidSchema, context.tenantId);
    if (!context.actor || !context.actor.id?.trim()) {
      throw new BookingError("FORBIDDEN", "Authenticated actor context is required");
    }
    if (context.actor.type === "customer" && !context.actor.customerId?.trim()) {
      throw new BookingError("INVALID_INPUT", "Customer actor requires a customerId");
    }
    return new TenantBookingClient(this.store, context, this.hooks);
  }

  // Privileged tenant provisioning (§11)
  createTenant(input: unknown): Promise<Tenant> {
    const parsed = parseInput(createTenantSchema, input);
    return this.measure("createTenant", () => this.store.createTenant(parsed));
  }

  getTenant(tenantId: UUID): Promise<Tenant> {
    parseInput(uuidSchema, tenantId);
    return this.measure("getTenant", () => this.store.getTenant(tenantId));
  }

  archiveTenant(tenantId: UUID): Promise<Tenant> {
    parseInput(uuidSchema, tenantId);
    return this.measure("archiveTenant", () => this.store.archiveTenant(tenantId));
  }

  // Trusted host maintenance & outbox worker operations (§11, §12)
  async expireHolds(limit = 100): Promise<ExpireHoldsResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new BookingError("INVALID_INPUT", "limit must be an integer between 1 and 1000");
    }
    const res = await this.measure("expireHolds", () => this.store.expireHolds(limit));
    safeObserve(() => this.hooks.metrics?.recordHoldExpiry?.(res.expiredCount));
    return res;
  }

  async claimEvents(options?: { limit?: number; leaseSeconds?: number }): Promise<OutboxEvent[]> {
    const events = await this.measure("claimEvents", () => this.store.claimEvents(options));
    safeObserve(() => this.hooks.metrics?.recordOutboxAction?.("claimed", events.length));
    return events;
  }

  async ackEvent(eventId: UUID, leaseToken: UUID): Promise<void> {
    parseInput(uuidSchema, eventId);
    parseInput(uuidSchema, leaseToken);
    await this.measure("ackEvent", () => this.store.ackEvent(eventId, leaseToken));
    safeObserve(() => this.hooks.metrics?.recordOutboxAction?.("acked", 1));
  }

  async retryEvent(eventId: UUID, leaseToken: UUID, errorMessage?: string, backoffSeconds?: number): Promise<OutboxEvent> {
    parseInput(uuidSchema, eventId);
    parseInput(uuidSchema, leaseToken);
    const updated = await this.measure("retryEvent", () => this.store.retryEvent(eventId, leaseToken, errorMessage, backoffSeconds));
    safeObserve(() => this.hooks.metrics?.recordOutboxAction?.(updated.status === "failed" ? "failed" : "retried", 1));
    return updated;
  }

  replayFailedEvent(eventId: UUID): Promise<OutboxEvent> {
    parseInput(uuidSchema, eventId);
    return this.measure("replayFailedEvent", () => this.store.replayFailedEvent(eventId));
  }

  cleanupIdempotencyRecords(limit = 500): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
      throw new BookingError("INVALID_INPUT", "limit must be an integer between 1 and 5000");
    }
    return this.measure("cleanupIdempotencyRecords", () => this.store.cleanupIdempotencyRecords(limit));
  }

  private async measure<T>(operation: string, work: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await work();
      safeObserve(() => this.hooks.metrics?.recordOperation?.({ operation, durationMs: Date.now() - start, success: true }));
      return result;
    } catch (error) {
      const code = error instanceof BookingError ? error.code : "INTERNAL_ERROR";
      safeObserve(() => this.hooks.metrics?.recordOperation?.({ operation, durationMs: Date.now() - start, success: false, errorCode: code }));
      if (error instanceof BookingError && error.category === "conflict") {
        safeObserve(() => this.hooks.metrics?.recordConflict?.(error.code));
      }
      throw error;
    }
  }
}

/** Tenant- and actor-bound client returned by `TimeSlotEngine.forTenant(context)`. */
export class TenantBookingClient {
  constructor(
    private readonly store: BookingStore,
    private readonly context: TenantContext,
    private readonly hooks: ObservabilityHooks = {},
  ) {}

  private get actor(): Actor {
    return this.context.actor;
  }

  private get correlationId(): string | undefined {
    return this.context.correlationId;
  }

  // Facilities
  createFacility(input: unknown): Promise<Facility> {
    assertCapability(this.actor, "facility:write", this.correlationId);
    const parsed = parseInput(createFacilitySchema, input);
    return this.run("createFacility", () => this.store.createFacility(this.context, parsed));
  }

  getFacility(facilityId: UUID): Promise<Facility> {
    assertCapability(this.actor, "facility:read", this.correlationId);
    parseInput(uuidSchema, facilityId);
    return this.run("getFacility", () => this.store.getFacility(this.context, facilityId));
  }

  listFacilities(options?: { includeInactive?: boolean }): Promise<Facility[]> {
    assertCapability(this.actor, "facility:read", this.correlationId);
    return this.run("listFacilities", () => this.store.listFacilities(this.context, options));
  }

  updateFacility(facilityId: UUID, input: unknown): Promise<Facility> {
    assertCapability(this.actor, "facility:write", this.correlationId);
    parseInput(uuidSchema, facilityId);
    const parsed = parseInput(updateFacilitySchema, input);
    return this.run("updateFacility", () => this.store.updateFacility(this.context, facilityId, parsed));
  }

  deactivateFacility(facilityId: UUID, reason?: string): Promise<Facility> {
    assertCapability(this.actor, "facility:write", this.correlationId);
    parseInput(uuidSchema, facilityId);
    return this.run("deactivateFacility", () => this.store.deactivateFacility(this.context, facilityId, reason));
  }

  // Schedules, policies, pricing, overrides
  async setSchedule(facilityId: UUID, input: unknown[]): Promise<ConfigurationMutationResult> {
    assertCapability(this.actor, "schedule:write", this.correlationId);
    parseInput(uuidSchema, facilityId);
    if (!Array.isArray(input)) {
      throw new BookingError("INVALID_INPUT", "Schedule windows must be an array");
    }
    const windows = input.map((w) => parseInput(scheduleWindowSchema, w, "INVALID_CONFIGURATION")) as ScheduleWindow[];
    validateScheduleOverlaps("UTC", windows);
    return this.run("setSchedule", () => this.store.setSchedule(this.context, facilityId, windows));
  }

  setScheduleException(input: unknown): Promise<ConfigurationMutationResult & { exception: ScheduleException }> {
    assertCapability(this.actor, "schedule:write", this.correlationId);
    const parsed = parseInput(setScheduleExceptionSchema, input, "INVALID_CONFIGURATION");
    return this.run("setScheduleException", () => this.store.setScheduleException(this.context, parsed));
  }

  removeScheduleException(facilityId: UUID, businessDate: ISODate): Promise<ConfigurationMutationResult> {
    assertCapability(this.actor, "schedule:write", this.correlationId);
    parseInput(uuidSchema, facilityId);
    parseInput(localDateSchema, businessDate);
    return this.run("removeScheduleException", () => this.store.removeScheduleException(this.context, facilityId, businessDate));
  }

  setSlotPolicy(facilityId: UUID, input: unknown): Promise<ConfigurationMutationResult> {
    assertCapability(this.actor, "schedule:write", this.correlationId);
    parseInput(uuidSchema, facilityId);
    const policy = parseInput(slotPolicySchema, input, "INVALID_CONFIGURATION") as SlotPolicy;
    return this.run("setSlotPolicy", () => this.store.setSlotPolicy(this.context, facilityId, policy));
  }

  setSlotOverride(input: unknown): Promise<ConfigurationMutationResult & { override: SlotOverride }> {
    assertCapability(this.actor, "schedule:write", this.correlationId);
    const parsed = parseInput(setSlotOverrideSchema, input, "INVALID_CONFIGURATION");
    return this.run("setSlotOverride", () =>
      this.store.setSlotOverride(this.context, {
        facilityId: parsed.facilityId,
        businessDate: parsed.businessDate,
        startsAt: new Date(parsed.startsAt),
        endsAt: new Date(parsed.endsAt),
        action: parsed.action,
        reason: parsed.reason,
      }),
    );
  }

  removeSlotOverride(facilityId: UUID, overrideId: UUID): Promise<ConfigurationMutationResult> {
    assertCapability(this.actor, "schedule:write", this.correlationId);
    parseInput(uuidSchema, facilityId);
    parseInput(uuidSchema, overrideId);
    return this.run("removeSlotOverride", () => this.store.removeSlotOverride(this.context, facilityId, overrideId));
  }

  setPricing(input: unknown): Promise<ConfigurationMutationResult> {
    assertCapability(this.actor, "schedule:write", this.correlationId);
    const parsed = parseInput(setPricingSchema, input, "INVALID_CONFIGURATION");
    return this.run("setPricing", () => this.store.setPricing(this.context, parsed));
  }

  setCancellationPolicy(input: unknown): Promise<ConfigurationMutationResult & { policy: CancellationPolicy }> {
    assertCapability(this.actor, "schedule:write", this.correlationId);
    const parsed = parseInput(setCancellationPolicySchema, input, "INVALID_CONFIGURATION");
    return this.run("setCancellationPolicy", () => this.store.setCancellationPolicy(this.context, parsed));
  }

  // Blackouts
  createBlackout(input: unknown): Promise<Blackout> {
    assertCapability(this.actor, "blackout:write", this.correlationId);
    const parsed = parseInput(createBlackoutSchema, input);
    return this.run("createBlackout", () =>
      this.store.createBlackout(this.context, {
        facilityId: parsed.facilityId,
        startsAt: new Date(parsed.startsAt),
        endsAt: new Date(parsed.endsAt),
        reason: parsed.reason,
      }),
    );
  }

  removeBlackout(facilityId: UUID, blackoutId: UUID, reason?: string): Promise<void> {
    assertCapability(this.actor, "blackout:write", this.correlationId);
    parseInput(uuidSchema, facilityId);
    parseInput(uuidSchema, blackoutId);
    return this.run("removeBlackout", () => this.store.removeBlackout(this.context, facilityId, blackoutId, reason));
  }

  listBlackouts(facilityId: UUID, options?: { includeInactive?: boolean }): Promise<Blackout[]> {
    assertCapability(this.actor, "facility:read", this.correlationId);
    parseInput(uuidSchema, facilityId);
    return this.run("listBlackouts", () => this.store.listBlackouts(this.context, facilityId, options));
  }

  // Availability & Selection
  getAvailability(input: unknown): Promise<AvailabilityResult> {
    assertCapability(this.actor, "availability:read", this.correlationId);
    const parsed = parseInput(availabilityQuerySchema, input);
    const facilityIds = [...new Set(parsed.facilityIds ?? (parsed.facilityId ? [parsed.facilityId] : []))];
    const fromDate = parsed.fromDate ?? parsed.localDate!;
    const toDate = parsed.toDate ?? parsed.localDate ?? fromDate;
    const includeInactiveDiagnostics = this.actor.capabilities.includes("facility:write") || this.actor.type === "admin" || this.actor.type === "staff";
    return this.run("getAvailability", () =>
      this.store.getAvailability(this.context, {
        facilityIds,
        fromDate,
        toDate,
        includeUnavailable: parsed.includeUnavailable,
        includeInactiveDiagnostics,
      }),
    );
  }

  checkSelection(input: unknown): Promise<SelectionCheckResult> {
    assertCapability(this.actor, "availability:read", this.correlationId);
    const parsed = parseInput(checkSelectionSchema, input);
    if (parsed.bypassMinNotice) {
      assertCapability(this.actor, "booking:override_notice", this.correlationId);
    }
    return this.run("checkSelection", () => this.store.checkSelection(this.context, parsed));
  }

  // Holds
  createHold(input: unknown, options: RequestOptions): Promise<HoldResult> {
    assertCapability(this.actor, "hold:create", this.correlationId);
    const reqOpts = assertRequestOptions(options, this.correlationId);
    const parsed = parseInput(createHoldSchema, input);
    if (parsed.bypassMinNotice) {
      assertCapability(this.actor, "booking:override_notice", this.correlationId);
    }
    const externalCustomerId = this.resolveCustomerReference(parsed.externalCustomerId, true);
    return this.run("createHold", () =>
      this.store.createHold(
        this.context,
        {
          ...parsed,
          ...(externalCustomerId !== undefined ? { externalCustomerId } : {}),
        },
        reqOpts,
      ),
    );
  }

  getHold(holdId: UUID): Promise<HoldResult> {
    assertCapability(this.actor, "hold:read", this.correlationId);
    parseInput(uuidSchema, holdId);
    return this.run("getHold", () => this.store.getHold(this.context, holdId));
  }

  releaseHold(holdId: UUID, options?: Partial<RequestOptions>): Promise<HoldResult> {
    assertCapability(this.actor, "hold:release", this.correlationId);
    parseInput(uuidSchema, holdId);
    const reqOpts = parseOptionalRequestOptions(options, this.correlationId);
    return this.run("releaseHold", () => this.store.releaseHold(this.context, holdId, reqOpts));
  }

  convertHoldToBooking(input: unknown, options: RequestOptions): Promise<BookingSummary> {
    assertCapability(this.actor, "hold:convert", this.correlationId);
    const reqOpts = assertRequestOptions(options, this.correlationId);
    const parsed = parseInput(convertHoldSchema, input);
    return this.run("convertHoldToBooking", () => this.store.convertHoldToBooking(this.context, parsed, reqOpts));
  }

  // Bookings
  createBooking(input: unknown, options: RequestOptions): Promise<BookingSummary> {
    assertCapability(this.actor, "booking:create_direct", this.correlationId);
    const reqOpts = assertRequestOptions(options, this.correlationId);
    const parsed = parseInput(createDirectBookingSchema, input);
    if (parsed.bypassMinNotice) {
      assertCapability(this.actor, "booking:override_notice", this.correlationId);
    }
    const externalCustomerId = this.resolveCustomerReference(parsed.externalCustomerId, false);
    return this.run("createBooking", () =>
      this.store.createBooking(
        this.context,
        {
          ...parsed,
          ...(externalCustomerId !== undefined ? { externalCustomerId } : {}),
        },
        reqOpts,
      ),
    );
  }

  getBooking(bookingId: UUID): Promise<BookingSummary> {
    assertCapability(this.actor, "booking:read", this.correlationId);
    parseInput(uuidSchema, bookingId);
    return this.run("getBooking", () => this.store.getBooking(this.context, bookingId));
  }

  listBookings(input: unknown = {}): Promise<BookingListPage> {
    assertCapability(this.actor, "booking:read", this.correlationId);
    const parsed = parseInput(listBookingsSchema, input);
    const externalCustomerId = this.actor.type === "customer"
      ? this.actor.customerId
      : parsed.externalCustomerId;
    return this.run("listBookings", () =>
      this.store.listBookings(this.context, {
        ...parsed,
        ...(externalCustomerId !== undefined ? { externalCustomerId } : {}),
      }),
    );
  }

  cancelBooking(input: unknown, options?: Partial<RequestOptions>): Promise<BookingSummary> {
    assertCapability(this.actor, "booking:cancel", this.correlationId);
    const parsed = parseInput(cancelBookingSchema, input);
    const reqOpts = parseOptionalRequestOptions(options, this.correlationId);
    return this.run("cancelBooking", () => this.store.cancelBooking(this.context, parsed, reqOpts));
  }

  completeBooking(bookingId: UUID, options?: Partial<RequestOptions>): Promise<BookingSummary> {
    assertCapability(this.actor, "booking:complete", this.correlationId);
    parseInput(uuidSchema, bookingId);
    const reqOpts = parseOptionalRequestOptions(options, this.correlationId);
    return this.run("completeBooking", () => this.store.completeBooking(this.context, bookingId, reqOpts));
  }

  markNoShow(bookingId: UUID, options?: Partial<RequestOptions>): Promise<BookingSummary> {
    assertCapability(this.actor, "booking:no_show", this.correlationId);
    parseInput(uuidSchema, bookingId);
    const reqOpts = parseOptionalRequestOptions(options, this.correlationId);
    return this.run("markNoShow", () => this.store.markNoShow(this.context, bookingId, reqOpts));
  }

  getBookingHistory(aggregateType: "hold" | "booking" | "facility", aggregateId: UUID): Promise<BookingHistoryEntry[]> {
    assertCapability(this.actor, "audit:read", this.correlationId);
    parseInput(uuidSchema, aggregateId);
    return this.run("getBookingHistory", () => this.store.getBookingHistory(this.context, aggregateType, aggregateId));
  }

  private resolveCustomerReference(provided: string | undefined, requiredForCustomer: boolean): string | undefined {
    if (this.actor.type === "customer") {
      if (provided && provided !== this.actor.customerId) {
        throw new BookingError("FORBIDDEN", "Customer cannot act on behalf of another customer identifier");
      }
      return this.actor.customerId;
    }
    if (requiredForCustomer && !provided && this.actor.type !== "admin" && this.actor.type !== "staff" && this.actor.type !== "system") {
      throw new BookingError("INVALID_INPUT", "externalCustomerId is required");
    }
    return provided;
  }

  private async run<T>(operation: string, work: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await work();
      safeObserve(() => {
        this.hooks.metrics?.recordOperation?.({ operation, durationMs: Date.now() - start, success: true });
        this.hooks.logger?.info?.("booking.operation.succeeded", {
          operation,
          tenantId: this.context.tenantId,
          actorId: this.context.actor.id,
          correlationId: this.context.correlationId,
          durationMs: Date.now() - start,
        });
      });
      return result;
    } catch (error) {
      const code = error instanceof BookingError ? error.code : "INTERNAL_ERROR";
      safeObserve(() => {
        this.hooks.metrics?.recordOperation?.({ operation, durationMs: Date.now() - start, success: false, errorCode: code });
        if (error instanceof BookingError && error.category === "conflict") {
          this.hooks.metrics?.recordConflict?.(error.code);
        }
        this.hooks.logger?.warn?.("booking.operation.failed", {
          operation,
          tenantId: this.context.tenantId,
          actorId: this.context.actor.id,
          correlationId: this.context.correlationId,
          errorCode: code,
          durationMs: Date.now() - start,
        });
      });
      throw error;
    }
  }
}

