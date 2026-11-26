import { createHash } from "node:crypto";
import { DateTime, IANAZone } from "luxon";
import { z } from "zod";
import { BookingError, type BookingErrorCode } from "./errors.js";
import type { ISODate, UUID } from "./model.js";

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** ISO 4217 minor-unit exponents for supported currencies (§10.1). */
const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  AED: 2, ARS: 2, AUD: 2, BDT: 2, BHD: 3, BRL: 2, CAD: 2, CHF: 2,
  CLP: 0, CNY: 2, COP: 2, CZK: 2, DKK: 2, EGP: 2, EUR: 2, GBP: 2,
  HKD: 2, HUF: 2, IDR: 2, ILS: 2, INR: 2, ISK: 0, JOD: 3, JPY: 0,
  KES: 2, KRW: 0, KWD: 3, LKR: 2, MAD: 2, MXN: 2, MYR: 2, NGN: 2,
  NOK: 2, NZD: 2, OMR: 3, PEN: 2, PHP: 2, PKR: 2, PLN: 2, QAR: 2,
  RON: 2, RUB: 2, SAR: 2, SEK: 2, SGD: 2, THB: 2, TND: 3, TRY: 2,
  TWD: 2, USD: 2, VND: 0, ZAR: 2,
};

export function getCurrencyExponent(currency: string): number {
  const exponent = CURRENCY_EXPONENTS[currency];
  if (exponent === undefined) {
    throw new BookingError("INVALID_INPUT", `Unsupported ISO currency code: ${currency}`);
  }
  return exponent;
}

export function isSupportedCurrency(currency: string): boolean {
  return CURRENCY_EXPONENTS[currency] !== undefined;
}

export const uuidSchema = z.string().uuid();
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD local date").refine(
  (value) => DateTime.fromISO(value, { zone: "UTC" }).isValid,
  "Expected a valid YYYY-MM-DD date",
);
export const timeSchema = z.string().regex(TIME_PATTERN, "Expected HH:mm time");
export const timeZoneSchema = z.string().refine(IANAZone.isValidZone, "Expected an IANA time zone");
export const currencySchema = z.string().regex(/^[A-Z]{3}$/, "Expected 3-letter ISO currency").refine(
  isSupportedCurrency,
  "Unsupported ISO currency code",
);
export const isoTimestampSchema = z.string().datetime({ offset: true });
export const idempotencyKeySchema = z.string().trim().min(1).max(200);
export const metadataSchema = z.record(z.string().max(64), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 16_384, "Metadata exceeds 16KB limit")
  .default({});
export const externalCustomerIdSchema = z.string().trim().min(1).max(200);

export const createTenantSchema = z.object({
  name: z.string().trim().min(1).max(120),
  metadata: metadataSchema,
});

export const createFacilitySchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(60),
  timeZone: timeZoneSchema,
  metadata: metadataSchema,
});

export const updateFacilitySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().min(1).max(60).optional(),
  timeZone: timeZoneSchema.optional(),
  active: z.boolean().optional(),
  metadata: metadataSchema.optional(),
}).refine((val) => Object.keys(val).length > 0, "At least one field must be provided for update");

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

export const scheduleBreakSchema = z.object({
  startsAt: timeSchema,
  endsAt: timeSchema,
  startDayOffset: z.union([z.literal(0), z.literal(1)]).default(0),
  endDayOffset: z.union([z.literal(0), z.literal(1)]).default(0),
}).superRefine((item, ctx) => {
  const start = item.startDayOffset * 1440 + timeToMinutes(item.startsAt);
  const end = item.endDayOffset * 1440 + timeToMinutes(item.endsAt);
  if (end <= start) {
    ctx.addIssue({ code: "custom", path: ["endsAt"], message: "Break end must be after break start" });
  }
});

function validateWindowAndBreaks(
  window: {
    opensAt: string;
    closesAt: string;
    endDayOffset: 0 | 1;
    breaks: Array<{ startsAt: string; endsAt: string; startDayOffset: 0 | 1; endDayOffset: 0 | 1 }>;
  },
  ctx: z.RefinementCtx,
): void {
  const openMin = timeToMinutes(window.opensAt);
  const closeMin = window.endDayOffset * 1440 + timeToMinutes(window.closesAt);
  if (closeMin <= openMin) {
    ctx.addIssue({ code: "custom", path: ["closesAt"], message: "Closing time must be after opening time" });
  }
  if (closeMin - openMin > 1440) {
    ctx.addIssue({ code: "custom", path: ["closesAt"], message: "Operating window cannot exceed 24 wall-clock hours" });
  }
  for (const [index, br] of window.breaks.entries()) {
    const bStart = br.startDayOffset * 1440 + timeToMinutes(br.startsAt);
    const bEnd = br.endDayOffset * 1440 + timeToMinutes(br.endsAt);
    if (bStart < openMin || bEnd > closeMin || bEnd <= bStart) {
      ctx.addIssue({ code: "custom", path: ["breaks", index], message: "Break must fit inside the operating window" });
    }
  }
}

export const scheduleWindowSchema = z.object({
  weekday: z.number().int().min(1).max(7),
  opensAt: timeSchema,
  closesAt: timeSchema,
  endDayOffset: z.union([z.literal(0), z.literal(1)]).default(0),
  effectiveFrom: localDateSchema,
  effectiveUntil: localDateSchema.nullable().default(null),
  breaks: z.array(scheduleBreakSchema).default([]),
}).superRefine((window, ctx) => {
  validateWindowAndBreaks(window, ctx);
  if (window.effectiveUntil && window.effectiveUntil < window.effectiveFrom) {
    ctx.addIssue({ code: "custom", path: ["effectiveUntil"], message: "End date must not precede start date" });
  }
});

export const exceptionWindowSchema = z.object({
  opensAt: timeSchema,
  closesAt: timeSchema,
  endDayOffset: z.union([z.literal(0), z.literal(1)]).default(0),
  breaks: z.array(scheduleBreakSchema).default([]),
}).superRefine((window, ctx) => {
  validateWindowAndBreaks(window, ctx);
});

export const setScheduleExceptionSchema = z.object({
  facilityId: uuidSchema,
  businessDate: localDateSchema,
  windows: z.array(exceptionWindowSchema).max(20),
});

export const slotPolicySchema = z.object({
  durationMinutes: z.number().int().min(1).max(1440),
  intervalMinutes: z.number().int().min(1).max(1440),
  minNoticeMinutes: z.number().int().min(0).max(365 * 24 * 60).default(0),
  maxAdvanceDays: z.number().int().min(1).max(365).default(90),
  bufferBeforeMinutes: z.number().int().min(0).max(1440).default(0),
  bufferAfterMinutes: z.number().int().min(0).max(1440).default(0),
  maxSlotsPerBooking: z.number().int().min(1).max(24).default(24),
  defaultHoldMinutes: z.number().int().min(1).max(30).default(5),
  maxActiveHoldsPerCustomer: z.number().int().min(1).max(100).default(3),
}).superRefine((policy, ctx) => {
  if (policy.minNoticeMinutes > policy.maxAdvanceDays * 1440) {
    ctx.addIssue({ code: "custom", path: ["minNoticeMinutes"], message: "Minimum notice cannot exceed booking horizon" });
  }
});

export const setPricingSchema = z.object({
  facilityId: uuidSchema,
  amountMinor: z.number().int().safe().nonnegative(),
  currency: currencySchema,
});

export const setCancellationPolicySchema = z.object({
  facilityId: uuidSchema,
  customerCancellationAllowed: z.boolean().default(true),
  minNoticeMinutes: z.number().int().min(0).max(365 * 24 * 60).default(0),
  adminOverrideAllowed: z.boolean().default(true),
});

export const setSlotOverrideSchema = z.object({
  facilityId: uuidSchema,
  businessDate: localDateSchema,
  startsAt: isoTimestampSchema,
  endsAt: isoTimestampSchema,
  action: z.enum(["add", "suppress"]),
  reason: z.string().trim().min(1).max(300).default("manual_override"),
}).superRefine((val, ctx) => {
  if (new Date(val.startsAt).getTime() >= new Date(val.endsAt).getTime()) {
    ctx.addIssue({ code: "custom", path: ["endsAt"], message: "Override end must be after start" });
  }
});

export const createBlackoutSchema = z.object({
  facilityId: uuidSchema,
  startsAt: isoTimestampSchema,
  endsAt: isoTimestampSchema,
  reason: z.string().trim().min(1).max(300),
}).superRefine((value, ctx) => {
  if (new Date(value.startsAt).getTime() >= new Date(value.endsAt).getTime()) {
    ctx.addIssue({ code: "custom", path: ["endsAt"], message: "Blackout end must be after its start" });
  }
});

export const availabilityQuerySchema = z.object({
  facilityId: uuidSchema.optional(),
  facilityIds: z.array(uuidSchema).min(1).max(50).optional(),
  localDate: localDateSchema.optional(),
  fromDate: localDateSchema.optional(),
  toDate: localDateSchema.optional(),
  includeUnavailable: z.boolean().default(true),
}).superRefine((val, ctx) => {
  if (!val.facilityId && (!val.facilityIds || val.facilityIds.length === 0)) {
    ctx.addIssue({ code: "custom", path: ["facilityIds"], message: "Provide facilityId or facilityIds" });
  }
  if (!val.localDate && !val.fromDate) {
    ctx.addIssue({ code: "custom", path: ["localDate"], message: "Provide localDate or fromDate/toDate" });
  }
  const from = val.fromDate ?? val.localDate;
  const to = val.toDate ?? val.localDate ?? val.fromDate;
  if (from && to) {
    if (to < from) {
      ctx.addIssue({ code: "custom", path: ["toDate"], message: "toDate must not precede fromDate" });
    }
    const diff = DateTime.fromISO(to, { zone: "UTC" }).diff(DateTime.fromISO(from, { zone: "UTC" }), "days").days;
    if (diff + 1 > 31) {
      ctx.addIssue({ code: "custom", path: ["toDate"], message: "Availability date range cannot exceed 31 days" });
    }
  }
});

export const checkSelectionSchema = z.object({
  facilityId: uuidSchema,
  slotRefs: z.array(z.string().min(1)).min(1).max(24),
  bypassMinNotice: z.boolean().default(false),
});

export const createHoldSchema = z.object({
  facilityId: uuidSchema,
  slotRefs: z.array(z.string().min(1)).min(1).max(24),
  externalCustomerId: externalCustomerIdSchema.optional(),
  expectedAmountMinor: z.number().int().safe().nonnegative().optional(),
  expectedCurrency: currencySchema.optional(),
  holdMinutes: z.number().int().min(1).max(30).optional(),
  bypassMinNotice: z.boolean().default(false),
  metadata: metadataSchema,
}).superRefine((val, ctx) => {
  if ((val.expectedAmountMinor !== undefined) !== (val.expectedCurrency !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["expectedCurrency"], message: "Provide both expectedAmountMinor and expectedCurrency together" });
  }
});

export const convertHoldSchema = z.object({
  holdId: uuidSchema,
  expectedAmountMinor: z.number().int().safe().nonnegative().optional(),
  expectedCurrency: currencySchema.optional(),
  externalPaymentRef: z.string().trim().min(1).max(200).optional(),
}).superRefine((val, ctx) => {
  if ((val.expectedAmountMinor !== undefined) !== (val.expectedCurrency !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["expectedCurrency"], message: "Provide both expectedAmountMinor and expectedCurrency together" });
  }
});

export const createDirectBookingSchema = z.object({
  facilityId: uuidSchema,
  slotRefs: z.array(z.string().min(1)).min(1).max(24),
  externalCustomerId: externalCustomerIdSchema.optional(),
  expectedAmountMinor: z.number().int().safe().nonnegative().optional(),
  expectedCurrency: currencySchema.optional(),
  externalPaymentRef: z.string().trim().min(1).max(200).optional(),
  bypassMinNotice: z.boolean().default(false),
  metadata: metadataSchema,
}).superRefine((val, ctx) => {
  if ((val.expectedAmountMinor !== undefined) !== (val.expectedCurrency !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["expectedCurrency"], message: "Provide both expectedAmountMinor and expectedCurrency together" });
  }
});

export const cancelBookingSchema = z.object({
  bookingId: uuidSchema,
  reason: z.string().trim().min(1).max(300).optional(),
});

export const listBookingsSchema = z.object({
  facilityId: uuidSchema.optional(),
  status: z.enum(["confirmed", "cancelled", "completed", "no_show"]).optional(),
  externalCustomerId: externalCustomerIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export function parseInput<T>(schema: z.ZodType<T>, input: unknown, errorCode: BookingErrorCode = "INVALID_INPUT"): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join("; ");
    const exceedsBound = parsed.error.issues.some((issue) =>
      issue.message.includes("exceed 31 days") || issue.code === "too_big" && (issue.path.includes("facilityIds") || issue.path.includes("limit")),
    );
    throw new BookingError(exceedsBound ? "QUERY_LIMIT_EXCEEDED" : errorCode, message);
  }
  return parsed.data;
}

export interface DecodedSlotRef {
  facilityId: UUID;
  businessDate: ISODate;
  configurationRevision: number;
  startsAt: Date;
  endsAt: Date;
}

export function encodeSlotRef(parts: DecodedSlotRef): string {
  return `v1.${parts.facilityId}.${parts.businessDate}.${parts.configurationRevision}.${parts.startsAt.getTime()}.${parts.endsAt.getTime()}`;
}

export function decodeSlotRef(slotRef: string): DecodedSlotRef {
  const segments = slotRef.split(".");
  if (segments.length !== 6 || segments[0] !== "v1") {
    throw new BookingError("SLOT_NOT_FOUND", "Malformed slot reference");
  }
  const [, facilityId, businessDate, revStr, startStr, endStr] = segments;
  if (!uuidSchema.safeParse(facilityId).success || !localDateSchema.safeParse(businessDate).success) {
    throw new BookingError("SLOT_NOT_FOUND", "Invalid slot reference metadata");
  }
  const configurationRevision = Number(revStr);
  const startMs = Number(startStr);
  const endMs = Number(endStr);
  if (
    !Number.isInteger(configurationRevision) || configurationRevision < 1
    || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs >= endMs
  ) {
    throw new BookingError("SLOT_NOT_FOUND", "Invalid slot reference interval");
  }
  return {
    facilityId: facilityId!,
    businessDate: businessDate!,
    configurationRevision,
    startsAt: new Date(startMs),
    endsAt: new Date(endMs),
  };
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sorted: Record<string, unknown> = {};
    for (const [k, v] of entries) sorted[k] = canonicalize(v);
    return sorted;
  }
  return value;
}

export function computeRequestHash(payload: unknown): string {
  return `v1:${createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex")}`;
}

export function addDaysToLocalDate(localDate: ISODate, days: number): ISODate {
  return DateTime.fromISO(localDate, { zone: "UTC" }).plus({ days }).toISODate()!;
}

/**
 * Enumerate all real UTC instants matching a local wall-clock (YYYY-MM-DD, HH:mm) in an IANA zone.
 * Returns [] during a DST spring-forward gap, [d] normally, or [earlier, later] during a DST fall-back fold.
 */
export function enumerateLocalInstants(localDate: ISODate, localTime: string, timeZone: string): Date[] {
  const probe = DateTime.fromISO(`${localDate}T${localTime}`, { zone: timeZone, setZone: true });
  if (!probe.isValid) {
    throw new BookingError("INVALID_INPUT", `Invalid local date/time ${localDate} ${localTime} for ${timeZone}`);
  }
  const target = `${localDate}T${localTime}`;
  const candidates = probe.getPossibleOffsets()
    .filter((dt) => dt.toFormat("yyyy-LL-dd'T'HH:mm") === target)
    .map((dt) => dt.toJSDate())
    .sort((a, b) => a.getTime() - b.getTime());

  // Deduplicate identical millisecond timestamps
  const unique: Date[] = [];
  for (const dt of candidates) {
    if (!unique.some((existing) => existing.getTime() === dt.getTime())) {
      unique.push(dt);
    }
  }
  return unique;
}

/**
 * Resolve an operating-window boundary per §4.5:
 * - Ambiguous (DST fold): earlier instant for opening, later instant for closing.
 * - Nonexistent (DST gap): advance to the first valid local instant at or after the boundary.
 */
export function resolveWindowBoundary(
  localDate: ISODate,
  localTime: string,
  timeZone: string,
  kind: "opening" | "closing",
): Date {
  const instants = enumerateLocalInstants(localDate, localTime, timeZone);
  if (instants.length === 1) return instants[0]!;
  if (instants.length > 1) {
    return kind === "opening" ? instants[0]! : instants[instants.length - 1]!;
  }

  // DST gap: binary search by minute over +/- 16h around nominal UTC date for the first instant
  // whose local wall-clock representation is >= `${localDate}T${localTime}`.
  const target = `${localDate}T${localTime}`;
  const nominalUtc = DateTime.fromISO(`${localDate}T${localTime}`, { zone: "UTC" }).toMillis();
  let lowMin = Math.floor((nominalUtc - 16 * 3600_000) / 60_000);
  let highMin = Math.ceil((nominalUtc + 16 * 3600_000) / 60_000);
  while (lowMin < highMin) {
    const midMin = Math.floor((lowMin + highMin) / 2);
    const formatted = DateTime.fromMillis(midMin * 60_000, { zone: timeZone }).toFormat("yyyy-LL-dd'T'HH:mm");
    if (formatted >= target) {
      highMin = midMin;
    } else {
      lowMin = midMin + 1;
    }
  }
  return new Date(lowMin * 60_000);
}

/** Strict local-to-instant parser that rejects nonexistent and ambiguous local times. */
export function resolveLocalDateTime(localDate: string, localTime: string, timeZone: string): Date {
  const instants = enumerateLocalInstants(localDate, localTime, timeZone);
  if (instants.length === 0) {
    throw new BookingError("INVALID_INPUT", `Local time ${localDate} ${localTime} does not exist in ${timeZone}`);
  }
  if (instants.length > 1) {
    throw new BookingError("INVALID_INPUT", `Local time ${localDate} ${localTime} is ambiguous in ${timeZone}`);
  }
  return instants[0]!;
}
