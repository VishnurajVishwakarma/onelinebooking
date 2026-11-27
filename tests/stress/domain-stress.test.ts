import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { performance } from "node:perf_hooks";
import { DateTime } from "luxon";
import {
  ALL_ADMIN_CAPABILITIES,
  BookingError,
  computeRequestHash,
  decodeSlotRef,
  generateAvailabilitySlots,
  TimeSlotEngine,
  validateScheduleOverlaps,
  validateSlotSelection,
  type BookingStore,
  type OccupiedInterval,
  type PricingRule,
  type ScheduleWindow,
  type SlotPolicy,
} from "../../src/index.js";

const FACILITY_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number(sorted[idx]!.toFixed(2));
}

describe("Domain & validation stress tests", () => {
  it("survives 365-day overnight + DST sweeps across 5 global timezones", () => {
    const zones = [
      "America/New_York",
      "Europe/London",
      "Australia/Lord_Howe", // 30-min DST transitions
      "Pacific/Apia",
      "Asia/Kolkata",
    ];
    const weeklyWindows: ScheduleWindow[] = Array.from({ length: 7 }, (_, i) => ({
      weekday: i + 1,
      opensAt: "18:00",
      closesAt: "04:00",
      endDayOffset: 1 as const,
      effectiveFrom: "2026-01-01",
      effectiveUntil: null,
      breaks: [{ startsAt: "23:30", endsAt: "00:30", startDayOffset: 0 as const, endDayOffset: 1 as const }],
    }));
    const policy: SlotPolicy = {
      durationMinutes: 60,
      intervalMinutes: 60,
      minNoticeMinutes: 0,
      maxAdvanceDays: 365,
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 15,
      maxSlotsPerBooking: 12,
      defaultHoldMinutes: 5,
      maxActiveHoldsPerCustomer: 3,
    };
    const pricing: PricingRule = {
      facilityId: FACILITY_ID,
      revision: 1,
      amountMinor: 10000,
      currency: "USD",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    const asOf = new Date("2025-12-31T00:00:00Z");

    const start = performance.now();
    let totalSlotsChecked = 0;

    for (const tz of zones) {
      validateScheduleOverlaps(tz, weeklyWindows);
      // 12 monthly 31-day sweeps covering the entire year
      for (let month = 1; month <= 12; month += 1) {
        const fromDate = `2026-${String(month).padStart(2, "0")}-01`;
        const toDate = DateTime.fromISO(fromDate, { zone: "UTC" }).endOf("month").toISODate()!;
        const slots = generateAvailabilitySlots({
          facilityId: FACILITY_ID,
          configurationRevision: 1,
          fromDate,
          toDate,
          timeZone: tz,
          weeklyWindows,
          exceptions: [],
          overrides: [],
          policy,
          pricing,
          occupied: [],
          asOf,
        });
        const refs = new Set<string>();
        for (let i = 0; i < slots.length; i += 1) {
          const s = slots[i]!;
          assert.equal(s.endsAt.getTime() - s.startsAt.getTime(), 60 * 60_000);
          assert.equal(refs.has(s.slotRef), false);
          refs.add(s.slotRef);
          if (i > 0) {
            assert.ok(slots[i - 1]!.startsAt.getTime() <= s.startsAt.getTime());
          }
          totalSlotsChecked += 1;
        }
      }
    }

    const elapsedMs = performance.now() - start;
    assert.ok(totalSlotsChecked > 15_000, `Expected >15,000 slots checked, got ${totalSlotsChecked}`);
    process.stdout.write(`  [stress] 365-day x 5-TZ DST sweep: ${totalSlotsChecked} slots in ${elapsedMs.toFixed(1)}ms\n`);
  });

  it("handles 31-day generation with 1,000 occupied intervals and enforces 5,000-candidate budget fast", () => {
    const windows: ScheduleWindow[] = Array.from({ length: 7 }, (_, i) => ({
      weekday: i + 1,
      opensAt: "06:00",
      closesAt: "23:00",
      endDayOffset: 0 as const,
      effectiveFrom: "2026-11-01",
      effectiveUntil: null,
      breaks: [],
    }));
    const policy: SlotPolicy = {
      durationMinutes: 15,
      intervalMinutes: 15,
      minNoticeMinutes: 0,
      maxAdvanceDays: 90,
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 5,
      maxSlotsPerBooking: 24,
      defaultHoldMinutes: 5,
      maxActiveHoldsPerCustomer: 3,
    };
    const pricing: PricingRule = {
      facilityId: FACILITY_ID,
      revision: 1,
      amountMinor: 5000,
      currency: "INR",
      createdAt: new Date("2026-11-01T00:00:00Z"),
    };
    const asOf = new Date("2026-11-01T00:00:00Z");

    // 1,000 occupied intervals spread across 31 days
    const occupied: OccupiedInterval[] = Array.from({ length: 1000 }, (_, idx) => {
      const startMs = asOf.getTime() + idx * 45 * 60_000;
      return {
        kind: idx % 5 === 0 ? "block" : "allocation",
        startsAt: new Date(startMs),
        endsAt: new Date(startMs + 15 * 60_000),
      };
    });

    const latencies: number[] = [];
    for (let run = 0; run < 20; run += 1) {
      const t0 = performance.now();
      const slots = generateAvailabilitySlots({
        facilityId: FACILITY_ID,
        configurationRevision: 1,
        fromDate: "2026-11-02",
        toDate: "2026-12-02", // 31 days * 68 slots/day = 2,108 slots
        timeZone: "Asia/Kolkata",
        weeklyWindows: windows,
        exceptions: [],
        overrides: [],
        policy,
        pricing,
        occupied,
        asOf,
      });
      latencies.push(performance.now() - t0);
      assert.equal(slots.length, 31 * 68);
    }

    latencies.sort((a, b) => a - b);
    process.stdout.write(
      `  [stress] 31-day x 2,108 slots x 1,000 occupied (20 runs): p50=${percentile(latencies, 50)}ms p95=${percentile(latencies, 95)}ms p99=${percentile(latencies, 99)}ms\n`,
    );

    // Pathological 1-minute cadence over 31 days (> 5,000 work budget) must fail fast with QUERY_LIMIT_EXCEEDED
    const failStart = performance.now();
    assert.throws(
      () => generateAvailabilitySlots({
        facilityId: FACILITY_ID,
        configurationRevision: 1,
        fromDate: "2026-11-02",
        toDate: "2026-12-02",
        timeZone: "Asia/Kolkata",
        weeklyWindows: windows,
        exceptions: [],
        overrides: [],
        policy: { ...policy, durationMinutes: 1, intervalMinutes: 1 },
        pricing,
        occupied,
        asOf,
        maxCandidates: 5000,
      }),
      (err: unknown) => err instanceof BookingError && err.code === "QUERY_LIMIT_EXCEEDED",
    );
    const failMs = performance.now() - failStart;
    assert.ok(failMs < 3000, `Expected fast fail under 3s, took ${failMs}ms`);
  });

  it("validates 1,000 multi-slot contiguous selections and slotRef decoding under load", () => {
    const windows: ScheduleWindow[] = [{
      weekday: 1,
      opensAt: "00:00",
      closesAt: "00:00",
      endDayOffset: 1,
      effectiveFrom: "2026-11-01",
      effectiveUntil: null,
      breaks: [],
    }];
    const policy: SlotPolicy = {
      durationMinutes: 60,
      intervalMinutes: 60,
      minNoticeMinutes: 0,
      maxAdvanceDays: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      maxSlotsPerBooking: 24,
      defaultHoldMinutes: 5,
      maxActiveHoldsPerCustomer: 3,
    };
    const pricing: PricingRule = {
      facilityId: FACILITY_ID,
      revision: 4,
      amountMinor: 12000,
      currency: "INR",
      createdAt: new Date("2026-11-01T00:00:00Z"),
    };
    const asOf = new Date("2026-11-01T00:00:00Z");

    const daySlots = generateAvailabilitySlots({
      facilityId: FACILITY_ID,
      configurationRevision: 4,
      fromDate: "2026-11-02",
      toDate: "2026-11-02",
      timeZone: "Asia/Kolkata",
      weeklyWindows: windows,
      exceptions: [],
      overrides: [],
      policy,
      pricing,
      occupied: [],
      asOf,
    });
    assert.equal(daySlots.length, 24);

    const t0 = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      const len = (i % 6) + 1;
      const offset = i % (24 - len);
      const refs = daySlots.slice(offset, offset + len).map((s) => s.slotRef);
      const result = validateSlotSelection({
        facilityId: FACILITY_ID,
        configurationRevision: 4,
        timeZone: "Asia/Kolkata",
        slotRefs: refs,
        weeklyWindows: windows,
        exceptions: [],
        overrides: [],
        policy,
        pricing,
        occupied: [],
        asOf,
      });
      assert.equal(result.valid, true);
      assert.equal(result.totalMinor, len * 12000);
      assert.equal(decodeSlotRef(refs[0]!).configurationRevision, 4);
    }
    process.stdout.write(`  [stress] 1,000 contiguous multi-slot validations in ${(performance.now() - t0).toFixed(1)}ms\n`);
  });

  it("rejects 2,000 adversarial/malformed inputs and canonicalizes 5,000 hashed payloads deterministically", () => {
    const engine = new TimeSlotEngine({} as BookingStore);
    const admin = engine.forTenant({
      tenantId: TENANT_ID,
      actor: { id: "stress-admin", type: "admin", capabilities: ALL_ADMIN_CAPABILITIES },
    });

    const hugeMeta = { blob: "x".repeat(20_000) };
    const badPayloads: Array<() => unknown> = [
      () => admin.createFacility({ name: "", category: "pc", timeZone: "UTC" }),
      () => admin.createFacility({ name: "PC", category: "pc", timeZone: "Mars/Olympus" }),
      () => admin.createFacility({ name: "PC", category: "pc", timeZone: "UTC", metadata: hugeMeta }),
      () => admin.setPricing({ facilityId: FACILITY_ID, amountMinor: -1, currency: "INR" }),
      () => admin.setPricing({ facilityId: FACILITY_ID, amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: "INR" }),
      () => admin.setPricing({ facilityId: FACILITY_ID, amountMinor: 100, currency: "ZZZ" }),
      () => admin.createBlackout({ facilityId: FACILITY_ID, startsAt: "2026-11-02T10:00:00", endsAt: "2026-11-02T11:00:00", reason: "no offset" }),
      () => admin.getAvailability({ facilityIds: Array.from({ length: 51 }, () => FACILITY_ID), localDate: "2026-11-02" }),
      () => admin.createHold({ facilityId: FACILITY_ID, slotRefs: Array.from({ length: 25 }, () => "x") }, { idempotencyKey: "k1" }),
      () => decodeSlotRef("v1.not-a-uuid.2026-11-02.1.100.200"),
    ];

    const t0 = performance.now();
    for (let i = 0; i < 2000; i += 1) {
      const fn = badPayloads[i % badPayloads.length]!;
      assert.throws(fn, (err: unknown) => err instanceof BookingError);
    }

    for (let i = 0; i < 5000; i += 1) {
      const h1 = computeRequestHash({ a: i, nested: { z: "val", b: [1, 2, i] }, empty: undefined });
      const h2 = computeRequestHash({ nested: { b: [1, 2, i], z: "val" }, a: i });
      assert.equal(h1, h2);
    }
    process.stdout.write(`  [stress] 2,000 adversarial rejections + 5,000 canonical hashes in ${(performance.now() - t0).toFixed(1)}ms\n`);
  });
});

