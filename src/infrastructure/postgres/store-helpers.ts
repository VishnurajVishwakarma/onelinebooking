import type { PoolClient, QueryResultRow } from "pg";
import { BookingError } from "../../domain/errors.js";
import type {
  Actor,
  Blackout,
  BookingHistoryEntry,
  BookingStatus,
  BookingSummary,
  CancellationPolicy,
  ConfigurationWarning,
  Facility,
  HoldResult,
  HoldState,
  ISODate,
  OccupiedInterval,
  OutboxEvent,
  OutboxEventStatus,
  PricingRule,
  ReservationItem,
  ScheduleException,
  ScheduleWindow,
  SlotOverride,
  SlotPolicy,
  Tenant,
  TenantStatus,
  UUID,
} from "../../domain/model.js";
import { validateSlotSelection } from "../../domain/slot-generation.js";

export interface TenantRow extends QueryResultRow {
  id: string;
  name: string;
  status: TenantStatus;
  metadata: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
}

export interface FacilityRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  name: string;
  category: string;
  time_zone: string;
  active: boolean;
  configuration_revision: number;
  metadata: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
}

export interface HoldRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  facility_id: string;
  state: HoldState;
  expires_at: Date | string;
  expired_recorded_at: Date | string | null;
  converted_booking_id: string | null;
  external_customer_id: string | null;
  actor_json: Actor;
  facility_time_zone: string;
  configuration_revision: number;
  pricing_revision: number;
  cancellation_policy_snapshot: CancellationPolicy;
  total_minor: string | number;
  currency: string;
  quote_created_at: Date | string;
  starts_at: Date | string;
  ends_at: Date | string;
  occupied_from: Date | string;
  occupied_until: Date | string;
  sequence: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface BookingRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  facility_id: string;
  status: BookingStatus;
  source_hold_id: string | null;
  external_customer_id: string | null;
  external_payment_ref: string | null;
  actor_json: Actor;
  facility_time_zone: string;
  configuration_revision: number;
  pricing_revision: number;
  cancellation_policy_snapshot: CancellationPolicy;
  starts_at: Date | string;
  ends_at: Date | string;
  occupied_from: Date | string;
  occupied_until: Date | string;
  total_minor: string | number;
  currency: string;
  cancelled_at: Date | string | null;
  cancellation_reason: string | null;
  completed_at: Date | string | null;
  no_show_at: Date | string | null;
  sequence: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ItemRow extends QueryResultRow {
  id: string;
  slot_ref: string;
  business_date: Date | string;
  starts_at: Date | string;
  ends_at: Date | string;
  local_start: string;
  local_end: string;
  local_offset: string;
  price_minor: string | number;
  currency: string;
}

export const pgTime = (value: string): string => value.slice(0, 5);
export const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
export const isoDate = (value: Date | string): string => (value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10));

export function toTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    metadata: row.metadata ?? {},
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
    archivedAt: row.archived_at ? asDate(row.archived_at) : null,
  };
}

export function toFacility(row: FacilityRow): Facility {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    category: row.category,
    timeZone: row.time_zone,
    active: row.active,
    configurationRevision: Number(row.configuration_revision),
    metadata: row.metadata ?? {},
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
    archivedAt: row.archived_at ? asDate(row.archived_at) : null,
  };
}

export function toBlackout(row: QueryResultRow): Blackout {
  return {
    id: row.id as string,
    facilityId: row.facility_id as string,
    startsAt: asDate(row.starts_at as Date | string),
    endsAt: asDate(row.ends_at as Date | string),
    reason: row.reason as string,
    active: Boolean(row.active),
    createdAt: asDate(row.created_at as Date | string),
  };
}

export function toReservationItem(row: ItemRow): ReservationItem {
  return {
    id: row.id,
    slotRef: row.slot_ref,
    businessDate: isoDate(row.business_date),
    startsAt: asDate(row.starts_at),
    endsAt: asDate(row.ends_at),
    localStart: row.local_start,
    localEnd: row.local_end,
    localOffset: row.local_offset,
    priceMinor: Number(row.price_minor),
    currency: row.currency.trim(),
  };
}

export function toHoldResult(row: HoldRow, items: ReservationItem[], overrideState?: HoldState): HoldResult {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    facilityId: row.facility_id,
    state: overrideState ?? row.state,
    expiresAt: asDate(row.expires_at),
    expiredRecordedAt: row.expired_recorded_at ? asDate(row.expired_recorded_at) : null,
    convertedBookingId: row.converted_booking_id,
    externalCustomerId: row.external_customer_id,
    facilityTimeZone: row.facility_time_zone,
    configurationRevision: Number(row.configuration_revision),
    pricingRevision: Number(row.pricing_revision),
    cancellationPolicy: row.cancellation_policy_snapshot,
    totalMinor: Number(row.total_minor),
    currency: row.currency.trim(),
    quoteCreatedAt: asDate(row.quote_created_at),
    startsAt: asDate(row.starts_at),
    endsAt: asDate(row.ends_at),
    occupiedFrom: asDate(row.occupied_from),
    occupiedUntil: asDate(row.occupied_until),
    items,
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

export function toBookingSummary(row: BookingRow, items: ReservationItem[]): BookingSummary {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    facilityId: row.facility_id,
    status: row.status,
    sourceHoldId: row.source_hold_id,
    externalCustomerId: row.external_customer_id,
    externalPaymentRef: row.external_payment_ref,
    facilityTimeZone: row.facility_time_zone,
    configurationRevision: Number(row.configuration_revision),
    pricingRevision: Number(row.pricing_revision),
    cancellationPolicy: row.cancellation_policy_snapshot,
    startsAt: asDate(row.starts_at),
    endsAt: asDate(row.ends_at),
    occupiedFrom: asDate(row.occupied_from),
    occupiedUntil: asDate(row.occupied_until),
    totalMinor: Number(row.total_minor),
    currency: row.currency.trim(),
    items,
    cancelledAt: row.cancelled_at ? asDate(row.cancelled_at) : null,
    cancellationReason: row.cancellation_reason,
    completedAt: row.completed_at ? asDate(row.completed_at) : null,
    noShowAt: row.no_show_at ? asDate(row.no_show_at) : null,
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

export function toOutboxEvent(row: QueryResultRow): OutboxEvent {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    aggregateType: row.aggregate_type as string,
    aggregateId: row.aggregate_id as string,
    aggregateSequence: Number(row.aggregate_sequence),
    eventType: row.event_type as string,
    schemaVersion: Number(row.schema_version),
    payload: (row.payload as Record<string, unknown>) ?? {},
    occurredAt: asDate(row.occurred_at as Date | string),
    recordedAt: asDate(row.recorded_at as Date | string),
    status: row.status as OutboxEventStatus,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: asDate(row.next_attempt_at as Date | string),
    leaseToken: (row.lease_token as string | null) ?? null,
    leaseExpiresAt: row.lease_expires_at ? asDate(row.lease_expires_at as Date | string) : null,
    lastError: (row.last_error as string | null) ?? null,
    deliveredAt: row.delivered_at ? asDate(row.delivered_at as Date | string) : null,
  };
}

export function toHistoryEntry(row: QueryResultRow): BookingHistoryEntry {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    aggregateType: row.aggregate_type as string,
    aggregateId: row.aggregate_id as string,
    facilityId: (row.facility_id as string | null) ?? null,
    action: row.action as string,
    actor: row.actor_json as Actor,
    priorState: (row.prior_state as string | null) ?? null,
    newState: (row.new_state as string | null) ?? null,
    diff: (row.diff_json as Record<string, unknown> | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    correlationId: (row.correlation_id as string | null) ?? null,
    decisionAt: asDate(row.decision_at as Date | string),
    recordedAt: asDate(row.recorded_at as Date | string),
  };
}

export interface FacilityConfig {
  policy: SlotPolicy | null;
  pricing: PricingRule | null;
  cancellationPolicy: CancellationPolicy;
  weeklyWindows: ScheduleWindow[];
  exceptions: ScheduleException[];
  overrides: SlotOverride[];
}

export async function getDecisionTime(client: PoolClient): Promise<Date> {
  const res = await client.query<{ now: Date | string }>("SELECT clock_timestamp() AS now");
  return asDate(res.rows[0]!.now);
}

export async function loadFacilityConfig(
  client: PoolClient,
  tenantId: UUID,
  facilityId: UUID,
): Promise<FacilityConfig> {
  const [policyRes, pricingRes, cancelRes, schedRes, excRes, ovRes] = await Promise.all([
    client.query(
      `SELECT duration_minutes, interval_minutes, min_notice_minutes, max_advance_days,
              buffer_before_minutes, buffer_after_minutes, max_slots_per_booking,
              default_hold_minutes, max_active_holds_per_customer, revision
       FROM slot_policies WHERE tenant_id = $1 AND facility_id = $2`,
      [tenantId, facilityId],
    ),
    client.query(
      `SELECT facility_id, revision, amount_minor, currency, created_at
       FROM pricing_rules WHERE tenant_id = $1 AND facility_id = $2 AND active = true`,
      [tenantId, facilityId],
    ),
    client.query(
      `SELECT customer_cancellation_allowed, min_notice_minutes, admin_override_allowed, revision
       FROM cancellation_policies WHERE tenant_id = $1 AND facility_id = $2 AND active = true`,
      [tenantId, facilityId],
    ),
    client.query(
      `SELECT s.weekday, s.opens_at::text, s.closes_at::text, s.end_day_offset,
              s.effective_from::text, s.effective_until::text,
              COALESCE(json_agg(json_build_object(
                'startsAt', br.starts_at::text,
                'endsAt', br.ends_at::text,
                'startDayOffset', br.start_day_offset,
                'endDayOffset', br.end_day_offset
              )) FILTER (WHERE br.id IS NOT NULL), '[]'::json) AS breaks
       FROM facility_schedules s
       LEFT JOIN schedule_breaks br ON br.schedule_id = s.id
       WHERE s.tenant_id = $1 AND s.facility_id = $2 AND s.active = true
       GROUP BY s.id
       ORDER BY s.weekday, s.opens_at`,
      [tenantId, facilityId],
    ),
    client.query(
      `SELECT id, facility_id, business_date::text, is_closed, windows, revision
       FROM schedule_exceptions WHERE tenant_id = $1 AND facility_id = $2`,
      [tenantId, facilityId],
    ),
    client.query(
      `SELECT id, facility_id, business_date::text, starts_at, ends_at, action, reason, configuration_revision
       FROM slot_overrides WHERE tenant_id = $1 AND facility_id = $2`,
      [tenantId, facilityId],
    ),
  ]);

  const pRow = policyRes.rows[0];
  const policy: SlotPolicy | null = pRow
    ? {
        durationMinutes: Number(pRow.duration_minutes),
        intervalMinutes: Number(pRow.interval_minutes),
        minNoticeMinutes: Number(pRow.min_notice_minutes),
        maxAdvanceDays: Number(pRow.max_advance_days),
        bufferBeforeMinutes: Number(pRow.buffer_before_minutes),
        bufferAfterMinutes: Number(pRow.buffer_after_minutes),
        maxSlotsPerBooking: Number(pRow.max_slots_per_booking),
        defaultHoldMinutes: Number(pRow.default_hold_minutes),
        maxActiveHoldsPerCustomer: Number(pRow.max_active_holds_per_customer),
        revision: Number(pRow.revision),
      }
    : null;

  const prRow = pricingRes.rows[0];
  const pricing: PricingRule | null = prRow
    ? {
        facilityId: prRow.facility_id as string,
        revision: Number(prRow.revision),
        amountMinor: Number(prRow.amount_minor),
        currency: (prRow.currency as string).trim(),
        createdAt: asDate(prRow.created_at as Date | string),
      }
    : null;

  const cRow = cancelRes.rows[0];
  const cancellationPolicy: CancellationPolicy = cRow
    ? {
        customerCancellationAllowed: Boolean(cRow.customer_cancellation_allowed),
        minNoticeMinutes: Number(cRow.min_notice_minutes),
        adminOverrideAllowed: Boolean(cRow.admin_override_allowed),
        revision: Number(cRow.revision),
      }
    : {
        customerCancellationAllowed: true,
        minNoticeMinutes: 0,
        adminOverrideAllowed: true,
        revision: 1,
      };

  const weeklyWindows: ScheduleWindow[] = schedRes.rows.map((r) => ({
    weekday: Number(r.weekday),
    opensAt: pgTime(r.opens_at as string),
    closesAt: pgTime(r.closes_at as string),
    endDayOffset: Number(r.end_day_offset) as 0 | 1,
    effectiveFrom: isoDate(r.effective_from as string),
    effectiveUntil: r.effective_until ? isoDate(r.effective_until as string) : null,
    breaks: (r.breaks as Array<{ startsAt: string; endsAt: string; startDayOffset: number; endDayOffset: number }>).map((b) => ({
      startsAt: pgTime(b.startsAt),
      endsAt: pgTime(b.endsAt),
      startDayOffset: Number(b.startDayOffset) as 0 | 1,
      endDayOffset: Number(b.endDayOffset) as 0 | 1,
    })),
  }));

  const exceptions: ScheduleException[] = excRes.rows.map((r) => ({
    id: r.id as string,
    facilityId: r.facility_id as string,
    businessDate: isoDate(r.business_date as string),
    isClosed: Boolean(r.is_closed),
    windows: (r.windows as ScheduleException["windows"]) ?? [],
    revision: Number(r.revision),
  }));

  const overrides: SlotOverride[] = ovRes.rows.map((r) => ({
    id: r.id as string,
    facilityId: r.facility_id as string,
    businessDate: isoDate(r.business_date as string),
    startsAt: asDate(r.starts_at as Date | string),
    endsAt: asDate(r.ends_at as Date | string),
    action: r.action as SlotOverride["action"],
    reason: r.reason as string,
    configurationRevision: Number(r.configuration_revision),
  }));

  return { policy, pricing, cancellationPolicy, weeklyWindows, exceptions, overrides };
}

export async function loadOccupiedIntervals(
  client: PoolClient,
  tenantId: UUID,
  facilityId: UUID,
  from: Date,
  until: Date,
  asOf: Date,
): Promise<OccupiedInterval[]> {
  const [blocks, allocations] = await Promise.all([
    client.query<{ starts_at: Date | string; ends_at: Date | string }>(
      `SELECT starts_at, ends_at FROM facility_blocks
       WHERE tenant_id = $1 AND facility_id = $2 AND active = true
         AND starts_at < $4 AND ends_at > $3`,
      [tenantId, facilityId, from, until],
    ),
    client.query<{
      occupied_start: Date | string;
      occupied_end: Date | string;
      service_start: Date | string;
      service_end: Date | string;
    }>(
      `SELECT occupied_start, occupied_end, service_start, service_end FROM allocations
       WHERE tenant_id = $1 AND facility_id = $2
         AND (status = 'reserved' OR (status = 'held' AND expires_at > $5))
         AND occupied_start < $4 AND occupied_end > $3`,
      [tenantId, facilityId, from, until, asOf],
    ),
  ]);

  return [
    ...blocks.rows.map((r) => ({
      kind: "block" as const,
      startsAt: asDate(r.starts_at),
      endsAt: asDate(r.ends_at),
    })),
    ...allocations.rows.map((r) => ({
      kind: "allocation" as const,
      startsAt: asDate(r.occupied_start),
      endsAt: asDate(r.occupied_end),
      serviceStart: asDate(r.service_start),
      serviceEnd: asDate(r.service_end),
    })),
  ];
}

export async function insertAudit(
  client: PoolClient,
  entry: {
    tenantId: UUID;
    aggregateType: string;
    aggregateId: UUID;
    facilityId?: UUID | null;
    action: string;
    actor: Actor;
    priorState?: string | null;
    newState?: string | null;
    diff?: Record<string, unknown> | null;
    reason?: string | null;
    correlationId?: string | null;
    decisionAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO booking_history (
       tenant_id, aggregate_type, aggregate_id, facility_id, action, actor_json,
       prior_state, new_state, diff_json, reason, correlation_id, decision_at
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11,$12)`,
    [
      entry.tenantId,
      entry.aggregateType,
      entry.aggregateId,
      entry.facilityId ?? null,
      entry.action,
      JSON.stringify(entry.actor),
      entry.priorState ?? null,
      entry.newState ?? null,
      entry.diff ? JSON.stringify(entry.diff) : null,
      entry.reason ?? null,
      entry.correlationId ?? null,
      entry.decisionAt,
    ],
  );
}

export async function insertOutboxEvent(
  client: PoolClient,
  event: {
    tenantId: UUID;
    aggregateType: string;
    aggregateId: UUID;
    aggregateSequence: number;
    eventType: string;
    payload: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (
       tenant_id, aggregate_type, aggregate_id, aggregate_sequence, event_type, schema_version, payload, occurred_at
     ) VALUES ($1,$2,$3,$4,$5,1,$6::jsonb,$7)`,
    [
      event.tenantId,
      event.aggregateType,
      event.aggregateId,
      event.aggregateSequence,
      event.eventType,
      JSON.stringify(event.payload),
      event.occurredAt,
    ],
  );
}

export async function expireFacilityHolds(
  client: PoolClient,
  tenantId: UUID,
  facilityId: UUID,
  decisionTime: Date,
  onlyConflictingWith?: { startsAt: Date; endsAt: Date },
): Promise<UUID[]> {
  const params: unknown[] = [tenantId, facilityId, decisionTime];
  let rangeClause = "";
  if (onlyConflictingWith) {
    params.push(onlyConflictingWith.endsAt, onlyConflictingWith.startsAt);
    rangeClause = ` AND a.occupied_start < $4 AND a.occupied_end > $5`;
  }

  const expiredRes = await client.query<{ id: string; sequence: number }>(
    `SELECT h.id, h.sequence
     FROM holds h
     JOIN allocations a ON a.hold_id = h.id
     WHERE h.tenant_id = $1 AND h.facility_id = $2 AND h.state = 'active' AND h.expires_at <= $3
       AND a.status = 'held'${rangeClause}
     ORDER BY h.id
     FOR UPDATE OF h, a`,
    params,
  );

  if (!expiredRes.rowCount) return [];

  const expiredIds = expiredRes.rows.map((r) => r.id);
  for (const row of expiredRes.rows) {
    const nextSeq = Number(row.sequence) + 1;
    await client.query(
      `UPDATE holds SET state = 'expired', expired_recorded_at = $2, sequence = $3, updated_at = $2 WHERE id = $1`,
      [row.id, decisionTime, nextSeq],
    );
    await client.query(
      `UPDATE allocations SET status = 'released', expires_at = NULL, released_at = $2, updated_at = $2
       WHERE hold_id = $1 AND status = 'held'`,
      [row.id, decisionTime],
    );
    await insertOutboxEvent(client, {
      tenantId,
      aggregateType: "hold",
      aggregateId: row.id,
      aggregateSequence: nextSeq,
      eventType: "hold.expired",
      payload: { holdId: row.id, facilityId, expiredRecordedAt: decisionTime.toISOString() },
      occurredAt: decisionTime,
    });
    await insertAudit(client, {
      tenantId,
      aggregateType: "hold",
      aggregateId: row.id,
      facilityId,
      action: "hold.expired",
      actor: { id: "system-expiry", type: "system", capabilities: [] },
      priorState: "active",
      newState: "expired",
      decisionAt: decisionTime,
    });
  }

  return expiredIds;
}

/** Validate active holds and future confirmed bookings against a proposed configuration (§5). */
export async function evaluateConfigChangeImpact(
  client: PoolClient,
  params: {
    tenantId: UUID;
    facility: Facility;
    nextRevision: number;
    config: FacilityConfig;
    decisionTime: Date;
    priceOnlyChange?: boolean;
  },
): Promise<ConfigurationWarning[]> {
  const { tenantId, facility, nextRevision, config, decisionTime, priceOnlyChange } = params;
  if (priceOnlyChange || !config.policy) return [];

  // 1. Check active unexpired holds: if schedule/policy/override would invalidate one, reject (§5)
  const activeHolds = await client.query<HoldRow>(
    `SELECT * FROM holds WHERE tenant_id = $1 AND facility_id = $2 AND state = 'active' AND expires_at > $3 ORDER BY id`,
    [tenantId, facility.id, decisionTime],
  );
  for (const hold of activeHolds.rows) {
    const itemsRes = await client.query<ItemRow>(
      `SELECT * FROM hold_items WHERE tenant_id = $1 AND hold_id = $2 ORDER BY starts_at`,
      [tenantId, hold.id],
    );
    if (itemsRes.rows.length > config.policy.maxSlotsPerBooking) {
      throw new BookingError("CONFIGURATION_CONFLICT", `Configuration change conflicts with active hold ${hold.id}`);
    }
    const rewrittenRefs = itemsRes.rows.map((item) =>
      `v1.${facility.id}.${isoDate(item.business_date)}.${nextRevision}.${asDate(item.starts_at).getTime()}.${asDate(item.ends_at).getTime()}`,
    );
    try {
      const check = validateSlotSelection({
        facilityId: facility.id,
        configurationRevision: nextRevision,
        timeZone: facility.timeZone,
        slotRefs: rewrittenRefs,
        weeklyWindows: config.weeklyWindows,
        exceptions: config.exceptions,
        overrides: config.overrides,
        policy: config.policy,
        pricing: config.pricing,
        occupied: [],
        asOf: decisionTime,
        bypassMinNotice: true,
      });
      if (!check.valid) {
        throw new BookingError("CONFIGURATION_CONFLICT", `Configuration change conflicts with active hold ${hold.id}: ${check.reasonCode}`);
      }
    } catch (error) {
      if (error instanceof BookingError && error.code === "CONFIGURATION_CONFLICT") throw error;
      throw new BookingError("CONFIGURATION_CONFLICT", `Configuration change invalidates active hold ${hold.id}`);
    }
  }

  // 2. Check future confirmed bookings: return warnings without cancelling (§5)
  const futureBookings = await client.query<BookingRow>(
    `SELECT * FROM bookings WHERE tenant_id = $1 AND facility_id = $2 AND status = 'confirmed' AND ends_at > $3 ORDER BY starts_at`,
    [tenantId, facility.id, decisionTime],
  );
  const warnings: ConfigurationWarning[] = [];
  for (const booking of futureBookings.rows) {
    const itemsRes = await client.query<ItemRow>(
      `SELECT * FROM booking_items WHERE tenant_id = $1 AND booking_id = $2 ORDER BY starts_at`,
      [tenantId, booking.id],
    );
    const rewrittenRefs = itemsRes.rows.map((item) =>
      `v1.${facility.id}.${isoDate(item.business_date)}.${nextRevision}.${asDate(item.starts_at).getTime()}.${asDate(item.ends_at).getTime()}`,
    );
    try {
      const check = validateSlotSelection({
        facilityId: facility.id,
        configurationRevision: nextRevision,
        timeZone: facility.timeZone,
        slotRefs: rewrittenRefs,
        weeklyWindows: config.weeklyWindows,
        exceptions: config.exceptions,
        overrides: config.overrides,
        policy: config.policy,
        pricing: config.pricing,
        occupied: [],
        asOf: decisionTime,
        bypassMinNotice: true,
      });
      if (!check.valid) {
        warnings.push({
          code: "CONFIRMED_BOOKING_SCHEDULE_MISMATCH",
          bookingId: booking.id,
          startsAt: asDate(booking.starts_at),
          endsAt: asDate(booking.ends_at),
          message: `Existing confirmed booking ${booking.id} no longer fits updated schedule (${check.reasonCode})`,
        });
      }
    } catch {
      warnings.push({
        code: "CONFIRMED_BOOKING_SCHEDULE_MISMATCH",
        bookingId: booking.id,
        startsAt: asDate(booking.starts_at),
        endsAt: asDate(booking.ends_at),
        message: `Existing confirmed booking ${booking.id} no longer matches updated slot configuration`,
      });
    }
  }
  return warnings;
}

