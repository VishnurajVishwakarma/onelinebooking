import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import {
  ALL_ADMIN_CAPABILITIES,
  assertAllocationTransition,
  assertBookingTransition,
  assertHoldTransition,
  BookingError,
  computeRequestHash,
  decodeSlotRef,
  DEFAULT_CUSTOMER_CAPABILITIES,
  effectiveHoldState,
  generateAvailabilitySlots,
  getCurrencyExponent,
  resolveWindowBoundary,
  TimeSlotEngine,
  validateScheduleOverlaps,
  validateSlotSelection,
  type BookingStore,
  type PricingRule,
  type ScheduleException,
  type ScheduleWindow,
  type SlotOverride,
  type SlotPolicy,
} from "../../src/index.js";

const FACILITY_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";

const basePolicy: SlotPolicy = {
  durationMinutes: 60,
  intervalMinutes: 60,
  minNoticeMinutes: 0,
  maxAdvanceDays: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  maxSlotsPerBooking: 6,
  defaultHoldMinutes: 5,
  maxActiveHoldsPerCustomer: 3,
};

const basePricing: PricingRule = {
  facilityId: FACILITY_ID,
  revision: 1,
  amountMinor: 15000,
  currency: "INR",
  createdAt: new Date("2026-11-01T00:00:00Z"),
};

describe("Domain scheduling, DST, overnight, buffers, and pricing (§14.1)", () => {
  it("handles different durations and cadences without shortened final slots", () => {
    const windows: ScheduleWindow[] = [{
      weekday: 1,
      opensAt: "09:00",
      closesAt: "11:15",
      endDayOffset: 0,
      effectiveFrom: "2026-11-01",
      effectiveUntil: null,
      breaks: [],
    }];

    // 60m duration, 30m cadence -> overlapping alternatives, stops before 11:15
    const slots = generateAvailabilitySlots({
      facilityId: FACILITY_ID,
      configurationRevision: 1,
      fromDate: "2026-11-02", // Monday
      toDate: "2026-11-02",
      timeZone: "Asia/Kolkata",
      weeklyWindows: windows,
      exceptions: [],
      overrides: [],
      policy: { ...basePolicy, durationMinutes: 60, intervalMinutes: 30 },
      pricing: basePricing,
      occupied: [],
      asOf: new Date("2026-11-01T00:00:00Z"),
    });

    assert.deepEqual(
      slots.map((s) => `${s.localStart.slice(11)}-${s.localEnd.slice(11)}`),
      ["09:00-10:00", "09:30-10:30", "10:00-11:00"],
    );
  });

  it("handles gaps (duration < cadence) and rejects noncontiguous multi-slot selection", () => {
    const windows: ScheduleWindow[] = [{
      weekday: 1,
      opensAt: "09:00",
      closesAt: "12:00",
      endDayOffset: 0,
      effectiveFrom: "2026-11-01",
      effectiveUntil: null,
      breaks: [],
    }];
    const policy = { ...basePolicy, durationMinutes: 45, intervalMinutes: 60 };
    const slots = generateAvailabilitySlots({
      facilityId: FACILITY_ID,
      configurationRevision: 1,
      fromDate: "2026-11-02",
      toDate: "2026-11-02",
      timeZone: "Asia/Kolkata",
      weeklyWindows: windows,
      exceptions: [],
      overrides: [],
      policy,
      pricing: basePricing,
      occupied: [],
      asOf: new Date("2026-11-01T00:00:00Z"),
    });

    assert.equal(slots.length, 3);
    assert.throws(
      () => validateSlotSelection({
        facilityId: FACILITY_ID,
        configurationRevision: 1,
        timeZone: "Asia/Kolkata",
        slotRefs: [slots[0]!.slotRef, slots[1]!.slotRef],
        weeklyWindows: windows,
        exceptions: [],
        overrides: [],
        policy,
        pricing: basePricing,
        occupied: [],
        asOf: new Date("2026-11-01T00:00:00Z"),
      }),
      (err: unknown) => err instanceof BookingError && err.code === "INVALID_SLOT_SELECTION",
    );
  });

  it("supports overnight windows, prior-day spillover queries, and calendar-day blackouts", () => {
    const fridayOvernight: ScheduleWindow[] = [{
      weekday: 5, // Friday
      opensAt: "22:00",
      closesAt: "02:00",
      endDayOffset: 1,
      effectiveFrom: "2026-11-01",
      effectiveUntil: null,
      breaks: [],
    }];

    // Querying Saturday 2026-11-07 returns Friday's 00:00 and 01:00 spillover slots belonging to businessDate 2026-11-06
    const saturdaySlots = generateAvailabilitySlots({
      facilityId: FACILITY_ID,
      configurationRevision: 2,
      fromDate: "2026-11-07",
      toDate: "2026-11-07",
      timeZone: "Asia/Kolkata",
      weeklyWindows: fridayOvernight,
      exceptions: [],
      overrides: [],
      policy: basePolicy,
      pricing: basePricing,
      occupied: [
        {
          kind: "block",
          startsAt: DateTime.fromISO("2026-11-07T01:00", { zone: "Asia/Kolkata" }).toJSDate(),
          endsAt: DateTime.fromISO("2026-11-07T02:00", { zone: "Asia/Kolkata" }).toJSDate(),
        },
      ],
      asOf: new Date("2026-11-01T00:00:00Z"),
    });

    assert.equal(saturdaySlots.length, 2);
    assert.equal(saturdaySlots[0]!.businessDate, "2026-11-06");
    assert.equal(saturdaySlots[0]!.localStart, "2026-11-07T00:00");
    assert.equal(saturdaySlots[0]!.available, true);
    assert.equal(saturdaySlots[1]!.localStart, "2026-11-07T01:00");
    assert.equal(saturdaySlots[1]!.available, false);
    assert.equal(saturdaySlots[1]!.reasonCode, "BLACKOUT_CONFLICT");

    // Overlapping Sunday overnight -> Monday morning rejected
    assert.throws(
      () => validateScheduleOverlaps("Asia/Kolkata", [
        { weekday: 7, opensAt: "22:00", closesAt: "08:00", endDayOffset: 1, effectiveFrom: "2026-11-01", effectiveUntil: null, breaks: [] },
        { weekday: 1, opensAt: "06:00", closesAt: "12:00", endDayOffset: 0, effectiveFrom: "2026-11-01", effectiveUntil: null, breaks: [] },
      ]),
      (err: unknown) => err instanceof BookingError && err.code === "INVALID_CONFIGURATION",
    );
  });

  it("applies schedule exceptions and slot overrides (suppression overrides addition)", () => {
    const weekly: ScheduleWindow[] = [{
      weekday: 1,
      opensAt: "09:00",
      closesAt: "12:00",
      endDayOffset: 0,
      effectiveFrom: "2026-11-01",
      effectiveUntil: null,
      breaks: [],
    }];
    const exceptions: ScheduleException[] = [{
      id: "33333333-3333-4333-8333-333333333333",
      facilityId: FACILITY_ID,
      businessDate: "2026-11-02",
      isClosed: false,
      windows: [{ opensAt: "10:00", closesAt: "13:00", endDayOffset: 0, breaks: [] }],
      revision: 2,
    }];
    const addedStart = DateTime.fromISO("2026-11-02T10:30", { zone: "Asia/Kolkata" }).toJSDate();
    const addedEnd = DateTime.fromISO("2026-11-02T11:30", { zone: "Asia/Kolkata" }).toJSDate();
    const suppressedStart = DateTime.fromISO("2026-11-02T11:00", { zone: "Asia/Kolkata" }).toJSDate();
    const suppressedEnd = DateTime.fromISO("2026-11-02T12:00", { zone: "Asia/Kolkata" }).toJSDate();

    const overrides: SlotOverride[] = [
      { id: "44444444-4444-4444-8444-444444444444", facilityId: FACILITY_ID, businessDate: "2026-11-02", startsAt: addedStart, endsAt: addedEnd, action: "add", reason: "special", configurationRevision: 2 },
      { id: "55555555-5555-4555-8555-555555555555", facilityId: FACILITY_ID, businessDate: "2026-11-02", startsAt: suppressedStart, endsAt: suppressedEnd, action: "suppress", reason: "blocked", configurationRevision: 2 },
      { id: "66666666-6666-4666-8666-666666666666", facilityId: FACILITY_ID, businessDate: "2026-11-02", startsAt: suppressedStart, endsAt: suppressedEnd, action: "add", reason: "suppressed wins", configurationRevision: 2 },
    ];

    const slots = generateAvailabilitySlots({
      facilityId: FACILITY_ID,
      configurationRevision: 2,
      fromDate: "2026-11-02",
      toDate: "2026-11-02",
      timeZone: "Asia/Kolkata",
      weeklyWindows: weekly,
      exceptions,
      overrides,
      policy: basePolicy,
      pricing: basePricing,
      occupied: [],
      asOf: new Date("2026-11-01T00:00:00Z"),
    });

    assert.deepEqual(
      slots.map((s) => s.localStart.slice(11)),
      ["10:00", "10:30", "12:00"],
    );
  });

  it("applies buffers only once at outer boundaries of a consecutive selection", () => {
    const windows: ScheduleWindow[] = [{
      weekday: 1,
      opensAt: "09:00",
      closesAt: "13:00",
      endDayOffset: 0,
      effectiveFrom: "2026-11-01",
      effectiveUntil: null,
      breaks: [],
    }];
    const policy: SlotPolicy = {
      ...basePolicy,
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 15,
    };

    const slots = generateAvailabilitySlots({
      facilityId: FACILITY_ID,
      configurationRevision: 1,
      fromDate: "2026-11-02",
      toDate: "2026-11-02",
      timeZone: "Asia/Kolkata",
      weeklyWindows: windows,
      exceptions: [],
      overrides: [],
      policy,
      pricing: basePricing,
      occupied: [],
      asOf: new Date("2026-11-01T00:00:00Z"),
    });

    // 09:00-10:00 is unavailable standalone because prep buffer hits 08:45 (< 09:00 opening)
    assert.equal(slots[0]!.available, false);
    assert.equal(slots[0]!.reasonCode, "BUFFER_CONFLICT");

    // 10:00-11:00 + 11:00-12:00 combined selection has occupied range [09:45, 12:15), valid!
    const selection = validateSlotSelection({
      facilityId: FACILITY_ID,
      configurationRevision: 1,
      timeZone: "Asia/Kolkata",
      slotRefs: [slots[1]!.slotRef, slots[2]!.slotRef],
      weeklyWindows: windows,
      exceptions: [],
      overrides: [],
      policy,
      pricing: basePricing,
      occupied: [],
      asOf: new Date("2026-11-01T00:00:00Z"),
    });

    assert.equal(selection.valid, true);
    assert.equal(selection.totalMinor, 30000);
    assert.equal(selection.occupiedStart!.getTime(), slots[1]!.startsAt.getTime() - 15 * 60_000);
    assert.equal(selection.occupiedEnd!.getTime(), slots[2]!.endsAt.getTime() + 15 * 60_000);
  });

  it("enforces exact notice and calendar-day horizon boundaries", () => {
    const windows: ScheduleWindow[] = [{
      weekday: 2, // Tuesday 2026-11-03
      opensAt: "22:00",
      closesAt: "00:00",
      endDayOffset: 1,
      effectiveFrom: "2026-11-01",
      effectiveUntil: null,
      breaks: [],
    }];
    const policy: SlotPolicy = { ...basePolicy, minNoticeMinutes: 60, maxAdvanceDays: 2 };
    // asOf = 2026-11-02T21:00 local -> today + 2 days start = 2026-11-04T00:00 local
    const asOf = DateTime.fromISO("2026-11-02T21:00", { zone: "Asia/Kolkata" }).toJSDate();

    const slots = generateAvailabilitySlots({
      facilityId: FACILITY_ID,
      configurationRevision: 1,
      fromDate: "2026-11-03",
      toDate: "2026-11-03",
      timeZone: "Asia/Kolkata",
      weeklyWindows: windows,
      exceptions: [],
      overrides: [],
      policy,
      pricing: basePricing,
      occupied: [],
      asOf,
    });

    // 23:00-00:00 ends at 2026-11-04T00:00 == exclusive boundary -> allowed (§4.7)
    assert.equal(slots[1]!.available, true);

    // Move horizon to 1 day -> boundary 2026-11-03T00:00 -> exceeded
    const tightSlots = generateAvailabilitySlots({
      facilityId: FACILITY_ID,
      configurationRevision: 1,
      fromDate: "2026-11-03",
      toDate: "2026-11-03",
      timeZone: "Asia/Kolkata",
      weeklyWindows: windows,
      exceptions: [],
      overrides: [],
      policy: { ...policy, maxAdvanceDays: 1 },
      pricing: basePricing,
      occupied: [],
      asOf,
    });
    assert.equal(tightSlots[0]!.available, false);
    assert.equal(tightSlots[0]!.reasonCode, "BOOKING_HORIZON_EXCEEDED");
  });

  it("handles DST spring-forward gaps and fall-back folds accurately (§4.5)", () => {
    // 1. Gap: America/New_York 2026-03-08 jumps 02:00 -> 03:00
    const gapBoundary = resolveWindowBoundary("2026-03-08", "02:30", "America/New_York", "opening");
    assert.equal(DateTime.fromJSDate(gapBoundary, { zone: "America/New_York" }).toFormat("HH:mm"), "03:00");

    const springSlots = generateAvailabilitySlots({
      facilityId: FACILITY_ID,
      configurationRevision: 1,
      fromDate: "2026-03-08",
      toDate: "2026-03-08",
      timeZone: "America/New_York",
      weeklyWindows: [{
        weekday: 7,
        opensAt: "01:00",
        closesAt: "05:00",
        endDayOffset: 0,
        effectiveFrom: "2026-01-01",
        effectiveUntil: null,
        breaks: [],
      }],
      exceptions: [],
      overrides: [],
      policy: basePolicy,
      pricing: basePricing,
      occupied: [],
      asOf: new Date("2026-03-01T00:00:00Z"),
    });
    // Nonexistent 02:00 start is skipped; 01:00 lasts 60 elapsed min -> ends at 03:00 EDT
    assert.deepEqual(
      springSlots.map((s) => `${s.localStart.slice(11)}-${s.localEnd.slice(11)}`),
      ["01:00-03:00", "03:00-04:00", "04:00-05:00"],
    );

    // 2. Fold: America/New_York 2026-11-01 repeats 01:00-02:00
    const fallSlots = generateAvailabilitySlots({
      facilityId: FACILITY_ID,
      configurationRevision: 1,
      fromDate: "2026-11-01",
      toDate: "2026-11-01",
      timeZone: "America/New_York",
      weeklyWindows: [{
        weekday: 7,
        opensAt: "00:00",
        closesAt: "03:00",
        endDayOffset: 0,
        effectiveFrom: "2026-01-01",
        effectiveUntil: null,
        breaks: [],
      }],
      exceptions: [],
      overrides: [],
      policy: basePolicy,
      pricing: basePricing,
      occupied: [],
      asOf: new Date("2026-10-20T00:00:00Z"),
    });
    // Expect 00:00 (-04:00), 01:00 (-04:00), 01:00 (-05:00), 02:00 (-05:00)
    assert.equal(fallSlots.length, 4);
    assert.equal(fallSlots[1]!.localOffset, "-04:00");
    assert.equal(fallSlots[2]!.localOffset, "-05:00");
    assert.notEqual(fallSlots[1]!.slotRef, fallSlots[2]!.slotRef);
    assert.equal(fallSlots[1]!.endsAt.getTime(), fallSlots[2]!.startsAt.getTime());
  });

  it("supports zero-decimal, two-decimal, and three-decimal currencies and slotRef decoding", () => {
    assert.equal(getCurrencyExponent("JPY"), 0);
    assert.equal(getCurrencyExponent("INR"), 2);
    assert.equal(getCurrencyExponent("BHD"), 3);
    assert.throws(() => getCurrencyExponent("XYZ"), (err: unknown) => err instanceof BookingError && err.code === "INVALID_INPUT");

    const decoded = decodeSlotRef(`v1.${FACILITY_ID}.2026-11-02.3.1793600000000.1793603600000`);
    assert.equal(decoded.facilityId, FACILITY_ID);
    assert.equal(decoded.configurationRevision, 3);
  });

  it("enforces hold, booking, and allocation state machines and cancellation policy", () => {
    const decisionTime = new Date("2026-11-02T09:00:00Z");
    assert.equal(effectiveHoldState("active", new Date("2026-11-02T09:00:00Z"), decisionTime), "expired");
    assert.throws(
      () => assertHoldTransition("expired", "converted"),
      (err: unknown) => err instanceof BookingError && err.code === "HOLD_EXPIRED",
    );

    const customerActor = { id: "c1", type: "customer" as const, customerId: "cust_1", capabilities: DEFAULT_CUSTOMER_CAPABILITIES };
    const adminActor = { id: "a1", type: "admin" as const, capabilities: ALL_ADMIN_CAPABILITIES };

    // Exact notice boundary (60 min) -> accepted
    const exactOk = assertBookingTransition("confirmed", "cancelled", {
      startsAt: new Date("2026-11-02T10:00:00Z"),
      endsAt: new Date("2026-11-02T11:00:00Z"),
      decisionTime: new Date("2026-11-02T09:00:00Z"),
      cancellationPolicy: { customerCancellationAllowed: true, minNoticeMinutes: 60, adminOverrideAllowed: true },
      actor: customerActor,
    });
    assert.equal(exactOk.idempotentReplay, false);

    // Admin override requires reason
    assert.throws(
      () => assertBookingTransition("confirmed", "cancelled", {
        startsAt: new Date("2026-11-02T09:30:00Z"),
        endsAt: new Date("2026-11-02T10:30:00Z"),
        decisionTime: new Date("2026-11-02T09:00:00Z"),
        cancellationPolicy: { customerCancellationAllowed: true, minNoticeMinutes: 60, adminOverrideAllowed: true },
        actor: adminActor,
      }),
      (err: unknown) => err instanceof BookingError && err.code === "INVALID_INPUT",
    );

    // After service start rejected even for admin
    assert.throws(
      () => assertBookingTransition("confirmed", "cancelled", {
        startsAt: new Date("2026-11-02T08:59:00Z"),
        endsAt: new Date("2026-11-02T09:59:00Z"),
        decisionTime: new Date("2026-11-02T09:00:00Z"),
        cancellationPolicy: { customerCancellationAllowed: true, minNoticeMinutes: 0, adminOverrideAllowed: true },
        actor: adminActor,
        overrideReason: "late",
      }),
      (err: unknown) => err instanceof BookingError && err.code === "POLICY_VIOLATION",
    );

    // Repeated terminal transition is idempotent
    const replay = assertBookingTransition("cancelled", "cancelled", {
      startsAt: new Date("2026-11-02T10:00:00Z"),
      endsAt: new Date("2026-11-02T11:00:00Z"),
      decisionTime,
      cancellationPolicy: { customerCancellationAllowed: true, minNoticeMinutes: 0, adminOverrideAllowed: true },
      actor: customerActor,
    });
    assert.equal(replay.idempotentReplay, true);

    assert.throws(() => assertAllocationTransition("released", "reserved"), BookingError);
  });

  it("canonicalizes request hashes and enforces actor capabilities cleanly", async () => {
    assert.equal(
      computeRequestHash({ a: 1, b: { y: 2, x: 3 } }),
      computeRequestHash({ b: { x: 3, y: 2 }, a: 1 }),
    );

    const dummyStore = {} as BookingStore;
    const engine = new TimeSlotEngine(dummyStore, {
      logger: { info: () => { throw new Error("log sink down"); } },
    });

    const customerClient = engine.forTenant({
      tenantId: TENANT_ID,
      actor: { id: "u1", type: "customer", customerId: "cust_1", capabilities: DEFAULT_CUSTOMER_CAPABILITIES },
    });

    assert.throws(
      () => customerClient.createFacility({ name: "X", category: "c", timeZone: "UTC" }),
      (err: unknown) => err instanceof BookingError && err.code === "FORBIDDEN",
    );
    assert.throws(
      () => customerClient.getAvailability({ facilityIds: [FACILITY_ID], fromDate: "2026-11-01", toDate: "2026-12-10" }),
      (err: unknown) => err instanceof BookingError && err.code === "QUERY_LIMIT_EXCEEDED",
    );
  });
});

