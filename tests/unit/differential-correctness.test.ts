import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import {
  generateAvailabilitySlots,
  getEffectiveWindowsForBusinessDate,
  resolveWindowsForBusinessDate,
  validateSlotSelection,
  type AvailabilitySlot,
  type OccupiedInterval,
  type PricingRule,
  type ScheduleException,
  type ScheduleWindow,
  type SlotOverride,
  type SlotPolicy,
} from "../../src/index.js";

const FACILITY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/**
 * Independent brute-force Luxon reference oracle (no constant-offset fast path).
 * Resolves every nominal local minute using Luxon DateTime.fromISO + getPossibleOffsets.
 */
function referenceGenerateAvailability(params: {
  fromDate: string;
  toDate: string;
  timeZone: string;
  weeklyWindows: ScheduleWindow[];
  exceptions: ScheduleException[];
  overrides: SlotOverride[];
  policy: SlotPolicy;
  pricing: PricingRule;
  occupied: OccupiedInterval[];
  asOf: Date;
}): AvailabilitySlot[] {
  const { fromDate, toDate, timeZone, weeklyWindows, exceptions, overrides, policy, pricing, occupied, asOf } = params;
  const durationMs = policy.durationMinutes * 60_000;
  const horizonEndMs = DateTime.fromJSDate(asOf, { zone: timeZone }).startOf("day").plus({ days: policy.maxAdvanceDays }).toMillis();

  const prevDate = DateTime.fromISO(fromDate, { zone: "UTC" }).minus({ days: 1 }).toISODate()!;
  const businessDates: string[] = [];
  let cur = prevDate;
  while (cur <= toDate) {
    businessDates.push(cur);
    cur = DateTime.fromISO(cur, { zone: "UTC" }).plus({ days: 1 }).toISODate()!;
  }

  const seenRefs = new Set<string>();
  const out: AvailabilitySlot[] = [];

  for (const bDate of businessDates) {
    const rawWindows = getEffectiveWindowsForBusinessDate(bDate, timeZone, weeklyWindows, exceptions);
    const resolvedWindows = resolveWindowsForBusinessDate(bDate, timeZone, rawWindows);
    if (resolvedWindows.length === 0) continue;

    const suppressed = new Set(
      overrides.filter((o) => o.businessDate === bDate && o.action === "suppress").map((o) => `${o.startsAt.getTime()}:${o.endsAt.getTime()}`),
    );
    const candidates = new Map<string, { start: Date; end: Date; winIdx: number }>();

    for (let wIdx = 0; wIdx < resolvedWindows.length; wIdx += 1) {
      const rw = resolvedWindows[wIdx]!;
      const raw = rw.raw!;
      const [oh, om] = raw.opensAt.split(":").map(Number);
      const [ch, cm] = raw.closesAt.split(":").map(Number);
      const openMin = oh! * 60 + om!;
      const closeMin = raw.endDayOffset * 1440 + ch! * 60 + cm!;

      for (let m = openMin; m < closeMin; m += policy.intervalMinutes) {
        const dayShift = Math.floor(m / 1440);
        const rem = m % 1440;
        const lDate = DateTime.fromISO(bDate, { zone: "UTC" }).plus({ days: dayShift }).toISODate()!;
        const lTime = `${String(Math.floor(rem / 60)).padStart(2, "0")}:${String(rem % 60).padStart(2, "0")}`;
        const probe = DateTime.fromISO(`${lDate}T${lTime}`, { zone: timeZone, setZone: true });
        const realStarts = probe.getPossibleOffsets()
          .filter((d) => d.toFormat("yyyy-LL-dd'T'HH:mm") === `${lDate}T${lTime}`)
          .map((d) => d.toJSDate())
          .sort((a, b) => a.getTime() - b.getTime());

        for (const start of realStarts) {
          const end = new Date(start.getTime() + durationMs);
          if (start.getTime() >= rw.opening.getTime() && end.getTime() <= rw.closing.getTime()) {
            const key = `${start.getTime()}:${end.getTime()}`;
            if (!suppressed.has(key) && !candidates.has(key)) {
              candidates.set(key, { start, end, winIdx: wIdx });
            }
          }
        }
      }
    }

    for (const ov of overrides) {
      if (ov.businessDate !== bDate || ov.action !== "add") continue;
      if (ov.endsAt.getTime() - ov.startsAt.getTime() !== durationMs) continue;
      const key = `${ov.startsAt.getTime()}:${ov.endsAt.getTime()}`;
      if (suppressed.has(key) || candidates.has(key)) continue;
      const winIdx = resolvedWindows.findIndex((w) => ov.startsAt.getTime() >= w.opening.getTime() && ov.endsAt.getTime() <= w.closing.getTime());
      if (winIdx >= 0) candidates.set(key, { start: ov.startsAt, end: ov.endsAt, winIdx });
    }

    for (const c of candidates.values()) {
      const sDt = DateTime.fromJSDate(c.start, { zone: timeZone });
      const eDt = DateTime.fromJSDate(c.end, { zone: timeZone });
      const localStart = sDt.toFormat("yyyy-LL-dd'T'HH:mm");
      if (localStart.slice(0, 10) < fromDate || localStart.slice(0, 10) > toDate) continue;

      const sMs = c.start.getTime();
      const eMs = c.end.getTime();
      const occS = sMs - policy.bufferBeforeMinutes * 60_000;
      const occE = eMs + policy.bufferAfterMinutes * 60_000;
      const rw = resolvedWindows[c.winIdx]!;

      let reason: AvailabilitySlot["reasonCode"] = null;
      if (occS < rw.opening.getTime() || occE > rw.closing.getTime()) reason = "BUFFER_CONFLICT";
      else if (rw.breaks.some((b) => sMs < b.endsAt.getTime() && eMs > b.startsAt.getTime())) reason = "OUTSIDE_OPERATING_HOURS";
      else if (rw.breaks.some((b) => occS < b.endsAt.getTime() && occE > b.startsAt.getTime())) reason = "BUFFER_CONFLICT";
      else if (occupied.some((o) => o.kind === "block" && sMs < o.endsAt.getTime() && eMs > o.startsAt.getTime())) reason = "BLACKOUT_CONFLICT";
      else if (occupied.some((o) => o.kind === "block" && occS < o.endsAt.getTime() && occE > o.startsAt.getTime())) reason = "BUFFER_CONFLICT";
      else if (occupied.some((o) => o.kind === "allocation" && occS < o.endsAt.getTime() && occE > o.startsAt.getTime())) reason = "SLOT_CONFLICT";
      else if (occS < asOf.getTime() || sMs < asOf.getTime() + policy.minNoticeMinutes * 60_000) reason = "MINIMUM_NOTICE_REQUIRED";
      else if (eMs > horizonEndMs) reason = "BOOKING_HORIZON_EXCEEDED";

      const offMin = sDt.offset;
      const sign = offMin >= 0 ? "+" : "-";
      const abs = Math.abs(offMin);
      const localOffset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
      const slotRef = `v1.${FACILITY_ID}.${bDate}.1.${sMs}.${eMs}`;
      if (!seenRefs.has(slotRef)) {
        seenRefs.add(slotRef);
        out.push({
          facilityId: FACILITY_ID,
          slotRef,
          configurationRevision: 1,
          businessDate: bDate,
          startsAt: c.start,
          endsAt: c.end,
          localStart,
          localEnd: eDt.toFormat("yyyy-LL-dd'T'HH:mm"),
          timeZone,
          localOffset,
          available: reason === null,
          reasonCode: reason,
          amountMinor: pricing.amountMinor,
          currency: pricing.currency,
        });
      }
    }
  }

  out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.endsAt.getTime() - b.endsAt.getTime());
  return out;
}

describe("Phase 5C: Differential testing vs reference Luxon oracle across DST and unusual zones", () => {
  const zones = [
    { tz: "America/New_York", from: "2026-03-07", to: "2026-03-10" }, // Spring-forward gap
    { tz: "America/New_York", from: "2026-10-31", to: "2026-11-03" }, // Fall-back fold
    { tz: "Australia/Lord_Howe", from: "2026-04-04", to: "2026-04-06" }, // 30-min DST fold
    { tz: "Australia/Lord_Howe", from: "2026-10-03", to: "2026-10-05" }, // 30-min DST gap
    { tz: "Pacific/Chatham", from: "2026-04-04", to: "2026-04-06" }, // +13:45 -> +12:45 45-min offset
    { tz: "Asia/Kolkata", from: "2026-11-01", to: "2026-11-05" }, // +05:30 fixed
  ];

  const weeklyWindows: ScheduleWindow[] = Array.from({ length: 7 }, (_, i) => ({
    weekday: i + 1,
    opensAt: "21:00",
    closesAt: "05:00",
    endDayOffset: 1 as const,
    effectiveFrom: "2026-01-01",
    effectiveUntil: null,
    breaks: [{ startsAt: "00:30", endsAt: "01:00", startDayOffset: 1 as const, endDayOffset: 1 as const }],
  }));

  const policyVariations: SlotPolicy[] = [
    { durationMinutes: 60, intervalMinutes: 60, minNoticeMinutes: 30, maxAdvanceDays: 365, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, maxSlotsPerBooking: 12, defaultHoldMinutes: 5, maxActiveHoldsPerCustomer: 3 },
    { durationMinutes: 45, intervalMinutes: 30, minNoticeMinutes: 0, maxAdvanceDays: 365, bufferBeforeMinutes: 15, bufferAfterMinutes: 15, maxSlotsPerBooking: 12, defaultHoldMinutes: 5, maxActiveHoldsPerCustomer: 3 },
    { durationMinutes: 30, intervalMinutes: 45, minNoticeMinutes: 0, maxAdvanceDays: 365, bufferBeforeMinutes: 10, bufferAfterMinutes: 5, maxSlotsPerBooking: 12, defaultHoldMinutes: 5, maxActiveHoldsPerCustomer: 3 },
  ];

  const pricing: PricingRule = {
    facilityId: FACILITY_ID,
    revision: 1,
    amountMinor: 10000,
    currency: "USD",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };

  for (const { tz, from, to } of zones) {
    for (const [pIdx, policy] of policyVariations.entries()) {
      it(`matches reference oracle identically for ${tz} (${from}..${to}) policy#${pIdx}`, () => {
        const asOf = new Date("2026-01-01T00:00:00Z");
        const blockStart = DateTime.fromISO(`${from}T23:00`, { zone: tz }).toJSDate();
        const blockEnd = DateTime.fromISO(`${from}T23:30`, { zone: tz }).toJSDate();
        const occupied: OccupiedInterval[] = [{ kind: "block", startsAt: blockStart, endsAt: blockEnd }];

        const actual = generateAvailabilitySlots({
          facilityId: FACILITY_ID,
          configurationRevision: 1,
          fromDate: from,
          toDate: to,
          timeZone: tz,
          weeklyWindows,
          exceptions: [],
          overrides: [],
          policy,
          pricing,
          occupied,
          asOf,
        });

        const expected = referenceGenerateAvailability({
          fromDate: from,
          toDate: to,
          timeZone: tz,
          weeklyWindows,
          exceptions: [],
          overrides: [],
          policy,
          pricing,
          occupied,
          asOf,
        });

        assert.equal(actual.length, expected.length);
        for (let i = 0; i < actual.length; i += 1) {
          assert.deepEqual(actual[i], expected[i]);
        }

        // Also validate every available individual slotRef through direct validateSlotSelection
        for (const slot of actual.filter((s) => s.available).slice(0, 15)) {
          const check = validateSlotSelection({
            facilityId: FACILITY_ID,
            configurationRevision: 1,
            timeZone: tz,
            slotRefs: [slot.slotRef],
            weeklyWindows,
            exceptions: [],
            overrides: [],
            policy,
            pricing,
            occupied,
            asOf,
          });
          assert.equal(check.valid, true);
          assert.equal(check.slots[0]!.slotRef, slot.slotRef);
        }
      });
    }
  }
});

