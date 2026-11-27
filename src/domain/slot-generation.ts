import { DateTime } from "luxon";
import { BookingError, type BookingErrorCode } from "./errors.js";
import type {
  AvailabilitySlot,
  ExceptionWindow,
  ISODate,
  OccupiedInterval,
  PricingRule,
  ScheduleBreak,
  ScheduleException,
  ScheduleWindow,
  SelectionCheckResult,
  SlotOverride,
  SlotPolicy,
  TimeInterval,
  UUID,
} from "./model.js";
import {
  addDaysToLocalDate,
  decodeSlotRef,
  encodeSlotRef,
  enumerateLocalInstants,
  resolveWindowBoundary,
} from "./validation.js";

export interface EffectiveWindowInput {
  opensAt: string;
  closesAt: string;
  endDayOffset: 0 | 1;
  breaks: ScheduleBreak[];
}

export interface ResolvedWindow {
  raw?: EffectiveWindowInput | undefined;
  opening: Date;
  closing: Date;
  breaks: TimeInterval[];
}

export interface CandidateWithWindow {
  slot: AvailabilitySlot;
  window: ResolvedWindow;
  occupiedRange: TimeInterval;
}

export interface GenerateSlotsForRangeInput {
  facilityId: UUID;
  configurationRevision: number;
  fromDate: ISODate;
  toDate: ISODate;
  timeZone: string;
  weeklyWindows: ScheduleWindow[];
  exceptions: ScheduleException[];
  overrides: SlotOverride[];
  policy: SlotPolicy;
  pricing: PricingRule | null;
  occupied: OccupiedInterval[];
  asOf: Date;
  bypassMinNotice?: boolean | undefined;
  maxCandidates?: number | undefined;
}

export interface GenerateSlotsLegacyInput {
  localDate: string;
  timeZone: string;
  windows: ScheduleWindow[];
  policy: SlotPolicy & { priceMinor?: number; currency?: string };
  occupied: TimeInterval[];
  now?: Date;
}

function parseMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

function formatOffsetMinutes(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function getConstantOffsetMinutes(businessDate: ISODate, timeZone: string): number | null {
  const base = DateTime.fromISO(`${businessDate}T00:00`, { zone: timeZone });
  if (!base.isValid) return null;
  const off0 = base.offset;
  for (const hrs of [12, 24, 36, 48]) {
    if (base.plus({ hours: hrs }).offset !== off0) return null;
  }
  return off0;
}

function formatUtcOffsetDateTime(epochMs: number, offsetMinutes: number): string {
  const shifted = new Date(epochMs + offsetMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}`;
}

function utcMidnightMs(businessDate: ISODate): number {
  const [y, m, d] = businessDate.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!, 0, 0, 0, 0);
}

function minutesToLocalDateAndTime(businessDate: ISODate, totalMinutes: number): { localDate: ISODate; localTime: string } {
  const dayOffset = Math.floor(totalMinutes / 1440);
  const rem = totalMinutes % 1440;
  const hh = String(Math.floor(rem / 60)).padStart(2, "0");
  const mm = String(rem % 60).padStart(2, "0");
  return {
    localDate: dayOffset === 0 ? businessDate : addDaysToLocalDate(businessDate, dayOffset),
    localTime: `${hh}:${mm}`,
  };
}

/** Resolve weekly rules vs date-specific exception for one business date (§4.3). */
export function getEffectiveWindowsForBusinessDate(
  businessDate: ISODate,
  timeZone: string,
  weeklyWindows: ScheduleWindow[],
  exceptions: ScheduleException[],
): EffectiveWindowInput[] {
  const exception = exceptions.find((item) => item.businessDate === businessDate);
  if (exception) {
    if (exception.isClosed) return [];
    return exception.windows.map((w: ExceptionWindow) => ({
      opensAt: w.opensAt,
      closesAt: w.closesAt,
      endDayOffset: w.endDayOffset,
      breaks: w.breaks,
    }));
  }

  const weekday = DateTime.fromISO(businessDate, { zone: timeZone }).weekday;
  return weeklyWindows
    .filter((w) => w.weekday === weekday && w.effectiveFrom <= businessDate && (!w.effectiveUntil || w.effectiveUntil >= businessDate))
    .map((w) => ({
      opensAt: w.opensAt,
      closesAt: w.closesAt,
      endDayOffset: w.endDayOffset,
      breaks: w.breaks,
    }));
}

/** Resolve effective windows for a business date into absolute UTC intervals and verify no DST-induced overlap (§4.5). */
export function resolveWindowsForBusinessDate(
  businessDate: ISODate,
  timeZone: string,
  rawWindows: EffectiveWindowInput[],
): ResolvedWindow[] {
  const resolved: ResolvedWindow[] = [];
  for (const w of rawWindows) {
    const opening = resolveWindowBoundary(businessDate, w.opensAt, timeZone, "opening");
    const closingDate = w.endDayOffset === 1 ? addDaysToLocalDate(businessDate, 1) : businessDate;
    const closing = resolveWindowBoundary(closingDate, w.closesAt, timeZone, "closing");
    if (opening.getTime() >= closing.getTime()) {
      continue;
    }
    const breaks: TimeInterval[] = [];
    for (const br of w.breaks) {
      const bStartDate = br.startDayOffset === 1 ? addDaysToLocalDate(businessDate, 1) : businessDate;
      const bEndDate = br.endDayOffset === 1 ? addDaysToLocalDate(businessDate, 1) : businessDate;
      const bStart = resolveWindowBoundary(bStartDate, br.startsAt, timeZone, "opening");
      const bEnd = resolveWindowBoundary(bEndDate, br.endsAt, timeZone, "closing");
      if (bStart.getTime() < bEnd.getTime()) {
        breaks.push({ startsAt: bStart, endsAt: bEnd });
      }
    }
    resolved.push({ raw: w, opening, closing, breaks });
  }

  resolved.sort((a, b) => a.opening.getTime() - b.opening.getTime());
  for (let i = 1; i < resolved.length; i += 1) {
    if (resolved[i]!.opening.getTime() < resolved[i - 1]!.closing.getTime()) {
      throw new BookingError("INVALID_CONFIGURATION", `Operating windows overlap in absolute time on ${businessDate}`);
    }
  }
  return resolved;
}

/** Validate that weekly schedules and date exceptions do not overlap even across midnight (§4.2, §4.3). */
export function validateScheduleOverlaps(
  timeZone: string,
  weeklyWindows: ScheduleWindow[],
  exceptions: ScheduleException[] = [],
): void {
  // 1. Nominal weekly cross-midnight overlap check
  for (let i = 0; i < weeklyWindows.length; i += 1) {
    const a = weeklyWindows[i]!;
    for (let j = 0; j < i; j += 1) {
      const b = weeklyWindows[j]!;
      const datesOverlap = (!a.effectiveUntil || b.effectiveFrom <= a.effectiveUntil)
        && (!b.effectiveUntil || a.effectiveFrom <= b.effectiveUntil);
      if (!datesOverlap) continue;

      const aStart = (a.weekday - 1) * 1440 + parseMinutes(a.opensAt);
      const aEnd = (a.weekday - 1) * 1440 + a.endDayOffset * 1440 + parseMinutes(a.closesAt);
      const bStart = (b.weekday - 1) * 1440 + parseMinutes(b.opensAt);
      const bEnd = (b.weekday - 1) * 1440 + b.endDayOffset * 1440 + parseMinutes(b.closesAt);

      // Check direct week-minute overlap and Sunday-to-Monday wraparound (shift +/- 7 days)
      const overlapsDirect = aStart < bEnd && bStart < aEnd;
      const overlapsWrapA = (aStart - 7 * 1440) < bEnd && bStart < (aEnd - 7 * 1440);
      const overlapsWrapB = aStart < (bEnd - 7 * 1440) && (bStart - 7 * 1440) < aEnd;
      if (overlapsDirect || overlapsWrapA || overlapsWrapB) {
        throw new BookingError("INVALID_CONFIGURATION", `Schedule windows overlap between weekday ${b.weekday} and weekday ${a.weekday}`);
      }
    }
  }

  // 2. Check adjacent business-date absolute overlaps for exceptions (D-1, D, D+1)
  for (const exc of exceptions) {
    const prevDate = addDaysToLocalDate(exc.businessDate, -1);
    const nextDate = addDaysToLocalDate(exc.businessDate, 1);
    const prevResolved = resolveWindowsForBusinessDate(prevDate, timeZone, getEffectiveWindowsForBusinessDate(prevDate, timeZone, weeklyWindows, exceptions));
    const currResolved = resolveWindowsForBusinessDate(exc.businessDate, timeZone, getEffectiveWindowsForBusinessDate(exc.businessDate, timeZone, weeklyWindows, exceptions));
    const nextResolved = resolveWindowsForBusinessDate(nextDate, timeZone, getEffectiveWindowsForBusinessDate(nextDate, timeZone, weeklyWindows, exceptions));

    const combined = [...prevResolved, ...currResolved, ...nextResolved].sort((a, b) => a.opening.getTime() - b.opening.getTime());
    for (let i = 1; i < combined.length; i += 1) {
      if (combined[i]!.opening.getTime() < combined[i - 1]!.closing.getTime()) {
        throw new BookingError("INVALID_CONFIGURATION", `Schedule exception on ${exc.businessDate} overlaps an adjacent operating window`);
      }
    }
  }
}

function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function evaluateCandidateStatus(
  serviceStartMs: number,
  serviceEndMs: number,
  window: ResolvedWindow,
  policy: SlotPolicy,
  occupied: OccupiedInterval[],
  horizonEndMs: number,
  asOfMs: number,
  bypassMinNotice: boolean,
): BookingErrorCode | null {
  const occupiedStartMs = serviceStartMs - policy.bufferBeforeMinutes * 60_000;
  const occupiedEndMs = serviceEndMs + policy.bufferAfterMinutes * 60_000;

  if (serviceStartMs < window.opening.getTime() || serviceEndMs > window.closing.getTime()) {
    return "OUTSIDE_OPERATING_HOURS";
  }
  if (occupiedStartMs < window.opening.getTime() || occupiedEndMs > window.closing.getTime()) {
    return "BUFFER_CONFLICT";
  }
  for (const br of window.breaks) {
    if (intervalsOverlap(serviceStartMs, serviceEndMs, br.startsAt.getTime(), br.endsAt.getTime())) {
      return "OUTSIDE_OPERATING_HOURS";
    }
    if (intervalsOverlap(occupiedStartMs, occupiedEndMs, br.startsAt.getTime(), br.endsAt.getTime())) {
      return "BUFFER_CONFLICT";
    }
  }
  for (const item of occupied) {
    if (item.kind === "block") {
      if (intervalsOverlap(serviceStartMs, serviceEndMs, item.startsAt.getTime(), item.endsAt.getTime())) {
        return "BLACKOUT_CONFLICT";
      }
      if (intervalsOverlap(occupiedStartMs, occupiedEndMs, item.startsAt.getTime(), item.endsAt.getTime())) {
        return "BUFFER_CONFLICT";
      }
    }
  }
  for (const item of occupied) {
    if (item.kind === "allocation") {
      if (intervalsOverlap(occupiedStartMs, occupiedEndMs, item.startsAt.getTime(), item.endsAt.getTime())) {
        if (
          item.serviceStart !== undefined && item.serviceEnd !== undefined
          && intervalsOverlap(serviceStartMs, serviceEndMs, item.serviceStart.getTime(), item.serviceEnd.getTime())
        ) {
          return "SLOT_CONFLICT";
        }
        return intervalsOverlap(serviceStartMs, serviceEndMs, item.startsAt.getTime(), item.endsAt.getTime())
          ? "SLOT_CONFLICT"
          : "BUFFER_CONFLICT";
      }
    }
  }

  // No retroactive allocations in V1 (§4.7)
  if (occupiedStartMs < asOfMs) {
    return "MINIMUM_NOTICE_REQUIRED";
  }
  if (!bypassMinNotice && serviceStartMs < asOfMs + policy.minNoticeMinutes * 60_000) {
    return "MINIMUM_NOTICE_REQUIRED";
  }
  if (serviceEndMs > horizonEndMs) {
    return "BOOKING_HORIZON_EXCEEDED";
  }

  return null;
}

/**
 * Generate candidate slots for one business date (including overrides, DST folds/gaps, and overnight windows).
 * Returns candidates along with their owning ResolvedWindow for combined-selection checks.
 */
export function generateCandidatesForBusinessDate(params: {
  facilityId: UUID;
  configurationRevision: number;
  businessDate: ISODate;
  timeZone: string;
  weeklyWindows: ScheduleWindow[];
  exceptions: ScheduleException[];
  overrides: SlotOverride[];
  policy: SlotPolicy;
  pricing: PricingRule | null;
  occupied: OccupiedInterval[];
  asOf: Date;
  bypassMinNotice?: boolean | undefined;
  maxCandidates?: number | undefined;
}): CandidateWithWindow[] {
  const {
    facilityId, configurationRevision, businessDate, timeZone,
    weeklyWindows, exceptions, overrides, policy, pricing, occupied, asOf,
  } = params;
  const bypassMinNotice = params.bypassMinNotice ?? false;
  const maxCandidates = params.maxCandidates;

  const rawWindows = getEffectiveWindowsForBusinessDate(businessDate, timeZone, weeklyWindows, exceptions);
  const resolvedWindows = resolveWindowsForBusinessDate(businessDate, timeZone, rawWindows);
  if (resolvedWindows.length === 0) return [];

  const durationMs = policy.durationMinutes * 60_000;
  const asOfMs = asOf.getTime();
  const horizonEndMs = DateTime.fromJSDate(asOf, { zone: timeZone })
    .startOf("day")
    .plus({ days: policy.maxAdvanceDays })
    .toMillis();

  const dateOverrides = overrides.filter((item) => item.businessDate === businessDate);
  const suppressedKeys = new Set(
    dateOverrides
      .filter((item) => item.action === "suppress")
      .map((item) => `${item.startsAt.getTime()}:${item.endsAt.getTime()}`),
  );

  const byInterval = new Map<string, { start: Date; end: Date; window: ResolvedWindow }>();
  const constOffset = getConstantOffsetMinutes(businessDate, timeZone);
  const baseUtcMs = constOffset !== null ? utcMidnightMs(businessDate) - constOffset * 60_000 : 0;

  for (const resolved of resolvedWindows) {
    const raw = resolved.raw;
    if (!raw) continue;

    const openMin = parseMinutes(raw.opensAt);
    const closeMin = raw.endDayOffset * 1440 + parseMinutes(raw.closesAt);

    if (constOffset !== null) {
      const openMs = resolved.opening.getTime();
      const closeMs = resolved.closing.getTime();
      for (let m = openMin; m < closeMin; m += policy.intervalMinutes) {
        const startMs = baseUtcMs + m * 60_000;
        const endMs = startMs + durationMs;
        if (startMs >= openMs && endMs <= closeMs) {
          const key = `${startMs}:${endMs}`;
          if (!suppressedKeys.has(key) && !byInterval.has(key)) {
            byInterval.set(key, { start: new Date(startMs), end: new Date(endMs), window: resolved });
            if (maxCandidates !== undefined && byInterval.size > maxCandidates) {
              throw new BookingError(
                "QUERY_LIMIT_EXCEEDED",
                `Availability query exceeds candidate limit of ${maxCandidates}`,
              );
            }
          }
        }
      }
      continue;
    }

    for (let m = openMin; m < closeMin; m += policy.intervalMinutes) {
      const { localDate, localTime } = minutesToLocalDateAndTime(businessDate, m);
      const instants = enumerateLocalInstants(localDate, localTime, timeZone);
      for (const startInstant of instants) {
        const endInstant = new Date(startInstant.getTime() + durationMs);
        if (
          startInstant.getTime() >= resolved.opening.getTime()
          && endInstant.getTime() <= resolved.closing.getTime()
        ) {
          const key = `${startInstant.getTime()}:${endInstant.getTime()}`;
          if (!suppressedKeys.has(key) && !byInterval.has(key)) {
            byInterval.set(key, { start: startInstant, end: endInstant, window: resolved });
            if (maxCandidates !== undefined && byInterval.size > maxCandidates) {
              throw new BookingError(
                "QUERY_LIMIT_EXCEEDED",
                `Availability query exceeds candidate limit of ${maxCandidates}`,
              );
            }
          }
        }
      }
    }
  }

  // Explicit added overrides under current revision (§4.4)
  for (const ov of dateOverrides) {
    if (ov.action !== "add") continue;
    const startMs = ov.startsAt.getTime();
    const endMs = ov.endsAt.getTime();
    if (endMs - startMs !== durationMs) continue;
    const key = `${startMs}:${endMs}`;
    if (suppressedKeys.has(key) || byInterval.has(key)) continue;
    const matchingWindow = resolvedWindows.find(
      (w) => startMs >= w.opening.getTime() && endMs <= w.closing.getTime(),
    );
    if (matchingWindow) {
      byInterval.set(key, { start: ov.startsAt, end: ov.endsAt, window: matchingWindow });
    }
  }

  // Filter occupied intervals once for this business date's full span + buffers
  const minWindowMs = resolvedWindows[0]!.opening.getTime() - policy.bufferBeforeMinutes * 60_000;
  const maxWindowMs = resolvedWindows[resolvedWindows.length - 1]!.closing.getTime() + policy.bufferAfterMinutes * 60_000;
  const relevantOccupied = occupied.filter(
    (item) => item.startsAt.getTime() < maxWindowMs && item.endsAt.getTime() > minWindowMs,
  );

  const results: CandidateWithWindow[] = [];
  const constOffsetStr = constOffset !== null ? formatOffsetMinutes(constOffset) : null;
  for (const entry of byInterval.values()) {
    const startMs = entry.start.getTime();
    const endMs = entry.end.getTime();
    let localStart: string;
    let localEnd: string;
    let localOffset: string;
    if (constOffset !== null && constOffsetStr !== null) {
      localStart = formatUtcOffsetDateTime(startMs, constOffset);
      localEnd = formatUtcOffsetDateTime(endMs, constOffset);
      localOffset = constOffsetStr;
    } else {
      const startDt = DateTime.fromJSDate(entry.start, { zone: timeZone });
      const endDt = DateTime.fromJSDate(entry.end, { zone: timeZone });
      localStart = startDt.toFormat("yyyy-LL-dd'T'HH:mm");
      localEnd = endDt.toFormat("yyyy-LL-dd'T'HH:mm");
      localOffset = formatOffsetMinutes(startDt.offset);
    }
    const reasonCode = evaluateCandidateStatus(
      startMs,
      endMs,
      entry.window,
      policy,
      relevantOccupied,
      horizonEndMs,
      asOfMs,
      bypassMinNotice,
    );
    const slot: AvailabilitySlot = {
      facilityId,
      slotRef: `v1.${facilityId}.${businessDate}.${configurationRevision}.${startMs}.${endMs}`,
      configurationRevision,
      businessDate,
      startsAt: entry.start,
      endsAt: entry.end,
      localStart,
      localEnd,
      timeZone,
      localOffset,
      available: reasonCode === null,
      reasonCode,
      amountMinor: pricing ? pricing.amountMinor : null,
      currency: pricing ? pricing.currency : null,
    };
    results.push({
      slot,
      window: entry.window,
      occupiedRange: {
        startsAt: new Date(startMs - policy.bufferBeforeMinutes * 60_000),
        endsAt: new Date(endMs + policy.bufferAfterMinutes * 60_000),
      },
    });
  }

  results.sort((a, b) => a.slot.startsAt.getTime() - b.slot.startsAt.getTime() || a.slot.endsAt.getTime() - b.slot.endsAt.getTime());
  return results;
}

/**
 * Generate availability slots for a local calendar date range [fromDate, toDate],
 * examining prior-day business dates for overnight spillover (§4.2) and bounding by work budget (§4.7).
 */
export function generateAvailabilitySlots(input: GenerateSlotsForRangeInput): AvailabilitySlot[] {
  const prevDate = addDaysToLocalDate(input.fromDate, -1);
  const businessDates: ISODate[] = [];
  let cursor = prevDate;
  while (cursor <= input.toDate) {
    businessDates.push(cursor);
    cursor = addDaysToLocalDate(cursor, 1);
  }

  const maxCandidates = input.maxCandidates ?? 5000;
  const seenRefs = new Set<string>();
  const collected: AvailabilitySlot[] = [];
  for (const businessDate of businessDates) {
    const candidates = generateCandidatesForBusinessDate({
      facilityId: input.facilityId,
      configurationRevision: input.configurationRevision,
      businessDate,
      timeZone: input.timeZone,
      weeklyWindows: input.weeklyWindows,
      exceptions: input.exceptions,
      overrides: input.overrides,
      policy: input.policy,
      pricing: input.pricing,
      occupied: input.occupied,
      asOf: input.asOf,
      bypassMinNotice: input.bypassMinNotice,
      maxCandidates: maxCandidates - collected.length + 1,
    });
    for (const item of candidates) {
      const localStartDate = item.slot.localStart.slice(0, 10);
      if (localStartDate >= input.fromDate && localStartDate <= input.toDate) {
        if (!seenRefs.has(item.slot.slotRef)) {
          seenRefs.add(item.slot.slotRef);
          collected.push(item.slot);
          if (collected.length > maxCandidates) {
            throw new BookingError(
              "QUERY_LIMIT_EXCEEDED",
              `Availability query exceeds candidate limit of ${maxCandidates}`,
            );
          }
        }
      }
    }
  }

  collected.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.endsAt.getTime() - b.endsAt.getTime());
  return collected;
}

/**
 * Validate a contiguous multi-slot selection against the combined outer occupied range (§4.4, §4.6, §4.7).
 * Used both by advisory `checkSelection` and inside authoritative write transactions.
 */
export function validateSlotSelection(params: {
  facilityId: UUID;
  configurationRevision: number;
  timeZone: string;
  slotRefs: string[];
  weeklyWindows: ScheduleWindow[];
  exceptions: ScheduleException[];
  overrides: SlotOverride[];
  policy: SlotPolicy;
  pricing: PricingRule | null;
  occupied: OccupiedInterval[];
  asOf: Date;
  bypassMinNotice?: boolean | undefined;
}): SelectionCheckResult {
  const {
    facilityId, configurationRevision, timeZone, slotRefs,
    weeklyWindows, exceptions, overrides, policy, pricing, occupied, asOf,
  } = params;
  const bypassMinNotice = params.bypassMinNotice ?? false;

  if (slotRefs.length === 0 || slotRefs.length > policy.maxSlotsPerBooking) {
    throw new BookingError(
      "INVALID_SLOT_SELECTION",
      `Selection must contain between 1 and ${policy.maxSlotsPerBooking} slots`,
    );
  }

  const decoded = slotRefs.map(decodeSlotRef);
  for (const item of decoded) {
    if (item.facilityId !== facilityId) {
      throw new BookingError("INVALID_SLOT_SELECTION", "All selected slots must belong to the requested facility");
    }
    if (item.configurationRevision !== configurationRevision) {
      throw new BookingError("STALE_CONFIGURATION", "Slot reference belongs to an outdated facility configuration");
    }
  }

  // Sort by start time and reject duplicates
  const sortedDecoded = [...decoded].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  for (let i = 1; i < sortedDecoded.length; i += 1) {
    const prev = sortedDecoded[i - 1]!;
    const curr = sortedDecoded[i]!;
    if (prev.startsAt.getTime() === curr.startsAt.getTime() && prev.endsAt.getTime() === curr.endsAt.getTime()) {
      throw new BookingError("INVALID_SLOT_SELECTION", "Duplicate slot selection is not permitted");
    }
    if (prev.endsAt.getTime() !== curr.startsAt.getTime()) {
      throw new BookingError("INVALID_SLOT_SELECTION", "Selected slots must be contiguous (each slot must begin when the previous ends)");
    }
  }

  const durationMs = policy.durationMinutes * 60_000;
  const horizonEndMs = DateTime.fromJSDate(asOf, { zone: timeZone })
    .startOf("day")
    .plus({ days: policy.maxAdvanceDays })
    .toMillis();

  // Direct verification per businessDate without generating unused slots on the day
  const resolvedByDate = new Map<ISODate, ResolvedWindow[]>();
  for (const ref of sortedDecoded) {
    if (!resolvedByDate.has(ref.businessDate)) {
      const raw = getEffectiveWindowsForBusinessDate(ref.businessDate, timeZone, weeklyWindows, exceptions);
      resolvedByDate.set(ref.businessDate, resolveWindowsForBusinessDate(ref.businessDate, timeZone, raw));
    }
  }

  const matched: CandidateWithWindow[] = sortedDecoded.map((ref) => {
    const startMs = ref.startsAt.getTime();
    const endMs = ref.endsAt.getTime();
    if (endMs - startMs !== durationMs) {
      throw new BookingError("SLOT_NOT_FOUND", `Slot ${ref.startsAt.toISOString()} does not match configured duration`);
    }

    const dateOverrides = overrides.filter((item) => item.businessDate === ref.businessDate);
    if (dateOverrides.some((ov) => ov.action === "suppress" && ov.startsAt.getTime() === startMs && ov.endsAt.getTime() === endMs)) {
      throw new BookingError("SLOT_NOT_FOUND", `Slot ${ref.startsAt.toISOString()} is suppressed`);
    }

    const windowsForDate = resolvedByDate.get(ref.businessDate) ?? [];
    const matchingWindow = windowsForDate.find((w) => startMs >= w.opening.getTime() && endMs <= w.closing.getTime());
    if (!matchingWindow || !matchingWindow.raw) {
      throw new BookingError("SLOT_NOT_FOUND", `Slot ${ref.startsAt.toISOString()} is outside effective operating windows`);
    }

    const isExplicitAdd = dateOverrides.some((ov) => ov.action === "add" && ov.startsAt.getTime() === startMs && ov.endsAt.getTime() === endMs);
    const startDt = DateTime.fromJSDate(ref.startsAt, { zone: timeZone });
    const endDt = DateTime.fromJSDate(ref.endsAt, { zone: timeZone });
    const startLocalDate = startDt.toISODate()!;
    const startLocalMin = startDt.hour * 60 + startDt.minute;
    const dayDiff = Math.round((utcMidnightMs(startLocalDate) - utcMidnightMs(ref.businessDate)) / 86_400_000);

    if (!isExplicitAdd) {
      if (startDt.second !== 0 || startDt.millisecond !== 0 || dayDiff < 0 || dayDiff > 1) {
        throw new BookingError("SLOT_NOT_FOUND", `Slot ${ref.startsAt.toISOString()} does not align to schedule cadence`);
      }
      const mFromBusinessDay = dayDiff * 1440 + startLocalMin;
      const openMin = parseMinutes(matchingWindow.raw.opensAt);
      const closeMin = matchingWindow.raw.endDayOffset * 1440 + parseMinutes(matchingWindow.raw.closesAt);
      if (mFromBusinessDay < openMin || mFromBusinessDay >= closeMin || (mFromBusinessDay - openMin) % policy.intervalMinutes !== 0) {
        throw new BookingError("SLOT_NOT_FOUND", `Slot ${ref.startsAt.toISOString()} does not align to schedule cadence`);
      }
    }

    const reasonCode = evaluateCandidateStatus(
      startMs,
      endMs,
      matchingWindow,
      policy,
      occupied,
      horizonEndMs,
      asOf.getTime(),
      bypassMinNotice,
    );
    const slot: AvailabilitySlot = {
      facilityId,
      slotRef: encodeSlotRef({
        facilityId,
        businessDate: ref.businessDate,
        configurationRevision,
        startsAt: ref.startsAt,
        endsAt: ref.endsAt,
      }),
      configurationRevision,
      businessDate: ref.businessDate,
      startsAt: ref.startsAt,
      endsAt: ref.endsAt,
      localStart: startDt.toFormat("yyyy-LL-dd'T'HH:mm"),
      localEnd: endDt.toFormat("yyyy-LL-dd'T'HH:mm"),
      timeZone,
      localOffset: formatOffsetMinutes(startDt.offset),
      available: reasonCode === null,
      reasonCode,
      amountMinor: pricing ? pricing.amountMinor : null,
      currency: pricing ? pricing.currency : null,
    };
    return {
      slot,
      window: matchingWindow,
      occupiedRange: {
        startsAt: new Date(startMs - policy.bufferBeforeMinutes * 60_000),
        endsAt: new Date(endMs + policy.bufferAfterMinutes * 60_000),
      },
    };
  });

  const first = matched[0]!;
  const last = matched[matched.length - 1]!;
  const serviceStart = first.slot.startsAt;
  const serviceEnd = last.slot.endsAt;
  const occupiedStart = new Date(serviceStart.getTime() - policy.bufferBeforeMinutes * 60_000);
  const occupiedEnd = new Date(serviceEnd.getTime() + policy.bufferAfterMinutes * 60_000);

  // All consecutive slots in one booking must fit within one single effective operating window (§4.6)
  const sharedWindow = matched.every(
    (c) => c.window.opening.getTime() === first.window.opening.getTime()
      && c.window.closing.getTime() === first.window.closing.getTime(),
  );

  let reasonCode: BookingErrorCode | null = null;
  if (!sharedWindow) {
    reasonCode = "OUTSIDE_OPERATING_HOURS";
  } else {
    const horizonEndMs = DateTime.fromJSDate(asOf, { zone: timeZone })
      .startOf("day")
      .plus({ days: policy.maxAdvanceDays })
      .toMillis();
    reasonCode = evaluateCandidateStatus(
      serviceStart.getTime(),
      serviceEnd.getTime(),
      first.window,
      policy,
      occupied,
      horizonEndMs,
      asOf.getTime(),
      bypassMinNotice,
    );
  }

  let totalMinor: number | null = null;
  let currency: string | null = null;
  if (pricing) {
    totalMinor = matched.length * pricing.amountMinor;
    if (!Number.isSafeInteger(totalMinor)) {
      throw new BookingError("INVALID_INPUT", "Booking total exceeds safe integer bounds");
    }
    currency = pricing.currency;
  }

  return {
    asOf,
    valid: reasonCode === null,
    facilityId,
    configurationRevision,
    reasonCode,
    message: reasonCode ? `Selection rejected with ${reasonCode}` : null,
    serviceStart,
    serviceEnd,
    occupiedStart,
    occupiedEnd,
    totalMinor,
    currency,
    slots: matched.map((m) => m.slot),
  };
}

/** Legacy-compatible wrapper for simple domain slot generation. */
export function generateSlots(input: GenerateSlotsLegacyInput): AvailabilitySlot[] {
  const asOf = input.now ?? new Date();
  const pricing: PricingRule | null = input.policy.priceMinor !== undefined && input.policy.currency !== undefined
    ? {
        facilityId: "00000000-0000-0000-0000-000000000000",
        revision: 1,
        amountMinor: input.policy.priceMinor,
        currency: input.policy.currency,
        createdAt: asOf,
      }
    : null;
  return generateAvailabilitySlots({
    facilityId: "00000000-0000-0000-0000-000000000000",
    configurationRevision: 1,
    fromDate: input.localDate,
    toDate: input.localDate,
    timeZone: input.timeZone,
    weeklyWindows: input.windows,
    exceptions: [],
    overrides: [],
    policy: input.policy,
    pricing,
    occupied: input.occupied.map((item) => ({ kind: "allocation", startsAt: item.startsAt, endsAt: item.endsAt })),
    asOf,
  });
}
