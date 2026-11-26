import type {
  Actor,
  AvailabilityResult,
  Blackout,
  BookingSummary,
  ConfigurationMutationResult,
  Facility,
  HoldResult,
  RequestOptions,
  ScheduleWindow,
  SlotPolicy,
  UUID,
} from "../domain/model.js";
import type { BookingStore } from "./ports/booking-store.js";
import { ALL_ADMIN_CAPABILITIES, TenantBookingClient, TimeSlotEngine } from "./time-slot-engine.js";

/**
 * Compatibility facade preserving the M1 `TimeSlotBooking(store, tenantId)` entry point
 * while delegating every operation to the V1 `TimeSlotEngine` and `TenantBookingClient` (§11).
 */
export class TimeSlotBooking {
  private readonly client: TenantBookingClient;

  constructor(
    store: BookingStore,
    tenantId: UUID,
    actor: Actor = {
      id: "host-trusted-admin",
      type: "admin",
      capabilities: ALL_ADMIN_CAPABILITIES,
      callerNamespace: "default",
    },
  ) {
    const engine = new TimeSlotEngine(store);
    this.client = engine.forTenant({ tenantId, actor });
  }

  createFacility(input: unknown): Promise<Facility> {
    return this.client.createFacility(input);
  }

  setSchedule(facilityId: UUID, input: ScheduleWindow[] | unknown[]): Promise<ConfigurationMutationResult> {
    return this.client.setSchedule(facilityId, input);
  }

  async setSlotPolicy(
    facilityId: UUID,
    input: (Partial<SlotPolicy> & { priceMinor?: number; currency?: string }) | unknown,
  ): Promise<ConfigurationMutationResult> {
    const obj = input as Record<string, unknown>;
    const policyRes = await this.client.setSlotPolicy(facilityId, obj);
    if (obj && typeof obj.priceMinor === "number" && typeof obj.currency === "string") {
      return this.client.setPricing({
        facilityId,
        amountMinor: obj.priceMinor,
        currency: obj.currency,
      });
    }
    return policyRes;
  }

  createBlackout(input: unknown): Promise<Blackout> {
    return this.client.createBlackout(input);
  }

  async createBlock(input: unknown): Promise<UUID> {
    const blackout = await this.client.createBlackout(input);
    return blackout.id;
  }

  getAvailability(input: unknown): Promise<AvailabilityResult> {
    return this.client.getAvailability(input);
  }

  createHold(input: unknown, options: RequestOptions): Promise<HoldResult> {
    return this.client.createHold(input, options);
  }

  /** Compatibility alias mapping directly to `convertHoldToBooking` (§11). */
  confirmHold(holdId: UUID, options: RequestOptions): Promise<BookingSummary> {
    return this.client.convertHoldToBooking({ holdId }, options);
  }

  convertHoldToBooking(input: unknown, options: RequestOptions): Promise<BookingSummary> {
    return this.client.convertHoldToBooking(input, options);
  }

  cancelBooking(bookingId: UUID, reason?: string): Promise<BookingSummary> {
    return this.client.cancelBooking({ bookingId, ...(reason ? { reason } : {}) });
  }

  getBooking(bookingId: UUID): Promise<BookingSummary> {
    return this.client.getBooking(bookingId);
  }
}
