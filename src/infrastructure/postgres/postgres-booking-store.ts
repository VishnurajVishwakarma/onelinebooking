import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type {
  AvailabilityQueryInput,
  BookingStore,
  CancelBookingInput,
  CheckSelectionInput,
  ConvertHoldInput,
  CreateBlackoutInput,
  CreateDirectBookingInput,
  CreateFacilityInput,
  CreateHoldInput,
  CreateTenantInput,
  ListBookingsQuery,
  SetCancellationPolicyInput,
  SetPricingInput,
  SetScheduleExceptionInput,
  SetSlotOverrideInput,
  UpdateFacilityInput,
} from "../../application/ports/booking-store.js";
import { BookingError } from "../../domain/errors.js";
import type {
  AvailabilityDiagnostic,
  AvailabilityResult,
  AvailabilitySlot,
  Blackout,
  BookingHistoryEntry,
  BookingListPage,
  BookingSummary,
  CancellationPolicy,
  ConfigurationMutationResult,
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
  SlotPolicy,
  Tenant,
  TenantContext,
  UUID,
} from "../../domain/model.js";
import {
  generateAvailabilitySlots,
  validateScheduleOverlaps,
  validateSlotSelection,
} from "../../domain/slot-generation.js";
import { assertBookingTransition, effectiveHoldState } from "../../domain/state-machines.js";
import { addDaysToLocalDate, computeRequestHash, resolveLocalDateTime } from "../../domain/validation.js";
import {
  asDate,
  evaluateConfigChangeImpact,
  expireFacilityHolds,
  getDecisionTime,
  insertAudit,
  insertOutboxEvent,
  isoDate,
  loadFacilityConfig,
  loadOccupiedIntervals,
  toBlackout,
  toBookingSummary,
  toFacility,
  toHistoryEntry,
  toHoldResult,
  toOutboxEvent,
  toReservationItem,
  toTenant,
  type BookingRow,
  type FacilityRow,
  type HoldRow,
  type ItemRow,
  type TenantRow,
} from "./store-helpers.js";

export interface PostgresStoreOptions {
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  maxTransientRetries?: number;
  idempotencyRetentionDays?: number;
  maxAvailabilityCandidates?: number;
}

const DEFAULT_OPTIONS: Required<PostgresStoreOptions> = {
  lockTimeoutMs: 3000,
  statementTimeoutMs: 10000,
  maxTransientRetries: 3,
  idempotencyRetentionDays: 7,
  maxAvailabilityCandidates: 5000,
};

function isTransientPgError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "40P01" || error.code === "40001";
}

function translatePgError(error: unknown): never {
  if (error instanceof BookingError) throw error;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String(error.code);
    if (code === "23P01") {
      throw new BookingError("SLOT_CONFLICT", "The selected interval overlaps an existing reservation", { cause: error });
    }
    if (code === "55P03" || code === "57014" || code === "40P01" || code === "40001") {
      throw new BookingError("TEMPORARY_UNAVAILABLE", "Database lock or timeout occurred; safe to retry with same key", {
        retryable: true,
        cause: error,
      });
    }
    if (code === "23505") {
      throw new BookingError("CONFIGURATION_CONFLICT", "A duplicate record conflict occurred", { cause: error });
    }
    if (code === "23503") {
      throw new BookingError("NOT_FOUND", "Referenced tenant or facility was not found", { cause: error });
    }
  }
  throw new BookingError("INTERNAL_ERROR", "An internal persistence error occurred", { cause: error });
}

export class PostgresBookingStore implements BookingStore {
  private readonly options: Required<PostgresStoreOptions>;

  constructor(private readonly pool: Pool, options: PostgresStoreOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    if (!Number.isInteger(this.options.lockTimeoutMs) || this.options.lockTimeoutMs < 100) {
      throw new BookingError("INVALID_CONFIGURATION", "lockTimeoutMs must be an integer >= 100");
    }
    if (!Number.isInteger(this.options.statementTimeoutMs) || this.options.statementTimeoutMs < 500) {
      throw new BookingError("INVALID_CONFIGURATION", "statementTimeoutMs must be an integer >= 500");
    }
    if (!Number.isInteger(this.options.maxTransientRetries) || this.options.maxTransientRetries < 1) {
      throw new BookingError("INVALID_CONFIGURATION", "maxTransientRetries must be an integer >= 1");
    }
  }

  // ---- Tenant Provisioning ----

  async createTenant(input: CreateTenantInput): Promise<Tenant> {
    return this.transaction(async (client) => {
      const res = await client.query<TenantRow>(
        `INSERT INTO tenants(name, status, metadata)
         VALUES ($1, 'active', $2::jsonb)
         RETURNING *`,
        [input.name, JSON.stringify(input.metadata ?? {})],
      );
      return toTenant(res.rows[0]!);
    });
  }

  async getTenant(tenantId: UUID): Promise<Tenant> {
    return this.readSnapshot(async (client) => {
      const res = await client.query<TenantRow>("SELECT * FROM tenants WHERE id = $1", [tenantId]);
      if (!res.rows[0]) throw new BookingError("NOT_FOUND", "Tenant was not found");
      return toTenant(res.rows[0]);
    });
  }

  async archiveTenant(tenantId: UUID): Promise<Tenant> {
    return this.transaction(async (client) => {
      const tRes = await client.query<TenantRow>("SELECT * FROM tenants WHERE id = $1 FOR UPDATE", [tenantId]);
      const tenant = tRes.rows[0];
      if (!tenant) throw new BookingError("NOT_FOUND", "Tenant was not found");
      if (tenant.status === "archived") return toTenant(tenant);

      const decisionTime = await getDecisionTime(client);
      const activeHolds = await client.query(
        `SELECT 1 FROM holds WHERE tenant_id = $1 AND state = 'active' AND expires_at > $2 LIMIT 1`,
        [tenantId, decisionTime],
      );
      if (activeHolds.rowCount) {
        throw new BookingError("CONFIGURATION_CONFLICT", "Cannot archive tenant with active unexpired holds");
      }
      const futureBookings = await client.query(
        `SELECT 1 FROM bookings WHERE tenant_id = $1 AND status = 'confirmed' AND ends_at > $2 LIMIT 1`,
        [tenantId, decisionTime],
      );
      if (futureBookings.rowCount) {
        throw new BookingError("CONFIGURATION_CONFLICT", "Cannot archive tenant with future confirmed bookings");
      }

      const updated = await client.query<TenantRow>(
        `UPDATE tenants SET status = 'archived', archived_at = $2, updated_at = $2 WHERE id = $1 RETURNING *`,
        [tenantId, decisionTime],
      );
      await client.query(
        `UPDATE facilities SET active = false, archived_at = $2, updated_at = $2 WHERE tenant_id = $1 AND archived_at IS NULL`,
        [tenantId, decisionTime],
      );
      return toTenant(updated.rows[0]!);
    });
  }

  // ---- Facilities ----

  async createFacility(ctx: TenantContext, input: CreateFacilityInput): Promise<Facility> {
    return this.transaction(async (client) => {
      await this.requireActiveTenant(client, ctx.tenantId);
      const decisionTime = await getDecisionTime(client);
      const res = await client.query<FacilityRow>(
        `INSERT INTO facilities(tenant_id, name, category, time_zone, active, configuration_revision, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, 1, $5::jsonb, $6, $6)
         RETURNING *`,
        [ctx.tenantId, input.name, input.category, input.timeZone, JSON.stringify(input.metadata ?? {}), decisionTime],
      );
      const facility = toFacility(res.rows[0]!);
      await insertAudit(client, {
        tenantId: ctx.tenantId,
        aggregateType: "facility",
        aggregateId: facility.id,
        facilityId: facility.id,
        action: "facility.created",
        actor: ctx.actor,
        newState: "active",
        correlationId: ctx.correlationId ?? null,
        decisionAt: decisionTime,
      });
      return facility;
    });
  }

  async getFacility(ctx: TenantContext, facilityId: UUID): Promise<Facility> {
    return this.readSnapshot(async (client) => this.requireFacility(client, ctx.tenantId, facilityId, false));
  }

  async listFacilities(ctx: TenantContext, options?: { includeInactive?: boolean }): Promise<Facility[]> {
    return this.readSnapshot(async (client) => {
      const includeInactive = options?.includeInactive ?? false;
      const res = await client.query<FacilityRow>(
        `SELECT * FROM facilities
         WHERE tenant_id = $1 ${includeInactive ? "" : "AND active = true"}
         ORDER BY created_at ASC, id ASC`,
        [ctx.tenantId],
      );
      return res.rows.map(toFacility);
    });
  }

  async updateFacility(ctx: TenantContext, facilityId: UUID, input: UpdateFacilityInput): Promise<Facility> {
    return this.transaction(async (client) => {
      const current = await this.requireFacility(client, ctx.tenantId, facilityId, true);
      const decisionTime = await getDecisionTime(client);
      await expireFacilityHolds(client, ctx.tenantId, facilityId, decisionTime);

      if (input.timeZone !== undefined && input.timeZone !== current.timeZone) {
        const futureProtected = await client.query(
          `SELECT 1 FROM allocations
           WHERE tenant_id = $1 AND facility_id = $2
             AND (status = 'reserved' OR (status = 'held' AND expires_at > $3))
             AND occupied_end > $3
           LIMIT 1`,
          [ctx.tenantId, facilityId, decisionTime],
        );
        if (futureProtected.rowCount) {
          throw new BookingError("CONFIGURATION_CONFLICT", "Cannot change facility timeZone while future protected allocations exist");
        }
      }

      if (input.active === false && current.active) {
        await this.assertNoActiveHolds(client, ctx.tenantId, facilityId, decisionTime);
      }

      const nextRev = current.configurationRevision + 1;
      const res = await client.query<FacilityRow>(
        `UPDATE facilities SET
           name = COALESCE($3, name),
           category = COALESCE($4, category),
           time_zone = COALESCE($5, time_zone),
           active = COALESCE($6, active),
           metadata = COALESCE($7::jsonb, metadata),
           configuration_revision = $8,
           updated_at = $9
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          facilityId,
          input.name ?? null,
          input.category ?? null,
          input.timeZone ?? null,
          input.active ?? null,
          input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
          nextRev,
          decisionTime,
        ],
      );
      const updated = toFacility(res.rows[0]!);
      await insertAudit(client, {
        tenantId: ctx.tenantId,
        aggregateType: "facility",
        aggregateId: facilityId,
        facilityId,
        action: "facility.updated",
        actor: ctx.actor,
        priorState: current.active ? "active" : "inactive",
        newState: updated.active ? "active" : "inactive",
        diff: { ...input, configurationRevision: nextRev },
        correlationId: ctx.correlationId ?? null,
        decisionAt: decisionTime,
      });
      return updated;
    });
  }

  async deactivateFacility(ctx: TenantContext, facilityId: UUID, reason?: string): Promise<Facility> {
    return this.transaction(async (client) => {
      const current = await this.requireFacility(client, ctx.tenantId, facilityId, true);
      const decisionTime = await getDecisionTime(client);
      await expireFacilityHolds(client, ctx.tenantId, facilityId, decisionTime);
      await this.assertNoActiveHolds(client, ctx.tenantId, facilityId, decisionTime);

      if (!current.active) return current;
      const nextRev = current.configurationRevision + 1;
      const res = await client.query<FacilityRow>(
        `UPDATE facilities SET active = false, configuration_revision = $3, updated_at = $4
         WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [ctx.tenantId, facilityId, nextRev, decisionTime],
      );
      await insertAudit(client, {
        tenantId: ctx.tenantId,
        aggregateType: "facility",
        aggregateId: facilityId,
        facilityId,
        action: "facility.deactivated",
        actor: ctx.actor,
        priorState: "active",
        newState: "inactive",
        reason: reason ?? null,
        correlationId: ctx.correlationId ?? null,
        decisionAt: decisionTime,
      });
      return toFacility(res.rows[0]!);
    });
  }

  // ---- Configuration Mutations ----

  async setSchedule(ctx: TenantContext, facilityId: UUID, windows: ScheduleWindow[]): Promise<ConfigurationMutationResult> {
    return this.transaction(async (client) => {
      const facility = await this.requireFacility(client, ctx.tenantId, facilityId, true);
      const decisionTime = await getDecisionTime(client);
      await expireFacilityHolds(client, ctx.tenantId, facilityId, decisionTime);

      const existingConfig = await loadFacilityConfig(client, ctx.tenantId, facilityId);
      validateScheduleOverlaps(facility.timeZone, windows, existingConfig.exceptions);

      const nextRev = facility.configurationRevision + 1;
      await client.query("DELETE FROM schedule_breaks WHERE schedule_id IN (SELECT id FROM facility_schedules WHERE tenant_id = $1 AND facility_id = $2)", [ctx.tenantId, facilityId]);
      await client.query("DELETE FROM facility_schedules WHERE tenant_id = $1 AND facility_id = $2", [ctx.tenantId, facilityId]);

      for (const window of windows) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO facility_schedules(
             tenant_id, facility_id, weekday, opens_at, closes_at, end_day_offset, effective_from, effective_until, revision
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            ctx.tenantId,
            facilityId,
            window.weekday,
            window.opensAt,
            window.closesAt,
            window.endDayOffset,
            window.effectiveFrom,
            window.effectiveUntil,
            nextRev,
          ],
        );
        for (const br of window.breaks) {
          await client.query(
            `INSERT INTO schedule_breaks(schedule_id, starts_at, ends_at, start_day_offset, end_day_offset)
             VALUES ($1,$2,$3,$4,$5)`,
            [inserted.rows[0]!.id, br.startsAt, br.endsAt, br.startDayOffset, br.endDayOffset],
          );
        }
      }

      const updatedConfig = await loadFacilityConfig(client, ctx.tenantId, facilityId);
      const warnings = await evaluateConfigChangeImpact(client, {
        tenantId: ctx.tenantId,
        facility,
        nextRevision: nextRev,
        config: updatedConfig,
        decisionTime,
      });

      await this.bumpFacilityRevision(client, ctx.tenantId, facilityId, nextRev, decisionTime);
      await insertAudit(client, {
        tenantId: ctx.tenantId,
        aggregateType: "facility",
        aggregateId: facilityId,
        facilityId,
        action: "schedule.updated",
        actor: ctx.actor,
        diff: { configurationRevision: nextRev, windowCount: windows.length },
        correlationId: ctx.correlationId ?? null,
        decisionAt: decisionTime,
      });

      return { configurationRevision: nextRev, warnings };
    });
  }

  async setScheduleException(
    ctx: TenantContext,
    input: SetScheduleExceptionInput,
  ): Promise<ConfigurationMutationResult & { exception: ScheduleException }> {
    return this.transaction(async (client) => {
      const facility = await this.requireFacility(client, ctx.tenantId, input.facilityId, true);
      const decisionTime = await getDecisionTime(client);
      await expireFacilityHolds(client, ctx.tenantId, input.facilityId, decisionTime);

      const isClosed = input.windows.length === 0;
      const nextRev = facility.configurationRevision + 1;

      const excRes = await client.query(
        `INSERT INTO schedule_exceptions(tenant_id, facility_id, business_date, is_closed, windows, revision, updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
         ON CONFLICT (tenant_id, facility_id, business_date) DO UPDATE SET
           is_closed = EXCLUDED.is_closed,
           windows = EXCLUDED.windows,
           revision = EXCLUDED.revision,
           updated_at = EXCLUDED.updated_at
         RETURNING id, facility_id, business_date::text, is_closed, windows, revision`,
        [ctx.tenantId, input.facilityId, input.businessDate, isClosed, JSON.stringify(input.windows), nextRev, decisionTime],
      );

      const updatedConfig = await loadFacilityConfig(client, ctx.tenantId, input.facilityId);
      validateScheduleOverlaps(facility.timeZone, updatedConfig.weeklyWindows, updatedConfig.exceptions);

      const warnings = await evaluateConfigChangeImpact(client, {
        tenantId: ctx.tenantId,
        facility,
        nextRevision: nextRev,
        config: updatedConfig,
        decisionTime,
      });

      await this.bumpFacilityRevision(client, ctx.tenantId, input.facilityId, nextRev, decisionTime);
      await insertAudit(client, {
        tenantId: ctx.tenantId,
        aggregateType: "facility",
        aggregateId: input.facilityId,
        facilityId: input.facilityId,
        action: "schedule_exception.set",
        actor: ctx.actor,
        diff: { businessDate: input.businessDate, isClosed, configurationRevision: nextRev },
        correlationId: ctx.correlationId ?? null,
        decisionAt: decisionTime,
      });

      const r = excRes.rows[0]!;
      return {
        configurationRevision: nextRev,
        warnings,
        exception: {
          id: r.id as string,
          facilityId: r.facility_id as string,
          businessDate: isoDate(r.business_date as string),
          isClosed: Boolean(r.is_closed),
          windows: r.windows as ScheduleException["windows"],
          revision: Number(r.revision),
        },
      };
    });
  }

  async removeScheduleException(ctx: TenantContext, facilityId: UUID, businessDate: ISODate): Promise<ConfigurationMutationResult> {
    return this.transaction(async (client) => {
      const facility = await this.requireFacility(client, ctx.tenantId, facilityId, true);
      const decisionTime = await getDecisionTime(client);
      await expireFacilityHolds(client, ctx.tenantId, facilityId, decisionTime);

      const deleted = await client.query(
        "DELETE FROM schedule_exceptions WHERE tenant_id = $1 AND facility_id = $2 AND business_date = $3",
        [ctx.tenantId, facilityId, businessDate],
      );
      if (!deleted.rowCount) throw new BookingError("NOT_FOUND", `Schedule exception for ${businessDate} was not found`);

      const updatedConfig = await loadFacilityConfig(client, ctx.tenantId, facilityId);
      validateScheduleOverlaps(facility.timeZone, updatedConfig.weeklyWindows, updatedConfig.exceptions);

      const nextRev = facility.configurationRevision + 1;
      const warnings = await evaluateConfigChangeImpact(client, {
        tenantId: ctx.tenantId,
        facility,
        nextRevision: nextRev,
        config: updatedConfig,
        decisionTime,
      });

      await this.bumpFacilityRevision(client, ctx.tenantId, facilityId, nextRev, decisionTime);
      await insertAudit(client, {
        tenantId: ctx.tenantId,
        aggregateType: "facility",
        aggregateId: facilityId,
        facilityId,
        action: "schedule_exception.removed",
        actor: ctx.actor,
        diff: { businessDate, configurationRevision: nextRev },
        correlationId: ctx.correlationId ?? null,
        decisionAt: decisionTime,
      });
      return { configurationRevision: nextRev, warnings };
    });
  }

  async setSlotPolicy(ctx: TenantContext, facilityId: UUID, policy: SlotPolicy): Promise<ConfigurationMutationResult> {
    return this.transaction(async (client) => {
      const facility = await this.requireFacility(client, ctx.tenantId, facilityId, true);
      const decisionTime = await getDecisionTime(client);
      await expireFacilityHolds(client, ctx.tenantId, facilityId, decisionTime);

      const nextRev = facility.configurationRevision + 1;
      await client.query(
        `INSERT INTO slot_policies(
           tenant_id, facility_id, duration_minutes, interval_minutes, min_notice_minutes,
           max_advance_days, buffer_before_minutes, buffer_after_minutes,
           max_slots_per_booking, default_hold_minutes, max_active_holds_per_customer, revision, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (tenant_id, facility_id) DO UPDATE SET
           duration_minutes = EXCLUDED.duration_minutes,
           interval_minutes = EXCLUDED.interval_minutes,
           min_notice_minutes = EXCLUDED.min_notice_minutes,
           max_advance_days = EXCLUDED.max_advance_days,
           buffer_before_minutes = EXCLUDED.buffer_before_minutes,
           buffer_after_minutes = EXCLUDED.buffer_after_minutes,
           max_slots_per_booking = EXCLUDED.max_slots_per_booking,
           default_hold_minutes = EXCLUDED.default_hold_minutes,
           max_active_holds_per_customer = EXCLUDED.max_active_holds_per_customer,
           revision = EXCLUDED.revision,
           updated_at = EXCLUDED.updated_at`,
        [
          ctx.tenantId,
          facilityId,
          policy.durationMinutes,
          policy.intervalMinutes,
          policy.minNoticeMinutes,
          policy.maxAdvanceDays,
          policy.bufferBeforeMinutes,
          policy.bufferAfterMinutes,
          policy.maxSlotsPerBooking,
          policy.defaultHoldMinutes,
          policy.maxActiveHoldsPerCustomer,
          nextRev,
          decisionTime,
        ],
      );

      const updatedConfig = await loadFacilityConfig(client, ctx.tenantId, facilityId);
      const warnings = await evaluateConfigChangeImpact(client, {
        tenantId: ctx.tenantId,
        facility,
        nextRevision: nextRev,
        config: updatedConfig,
        decisionTime,
      });

      await this.bumpFacilityRevision(client, ctx.tenantId, facilityId, nextRev, decisionTime);
      await insertAudit(client, {
        tenantId: ctx.tenantId,
        aggregateType: "facility",
        aggregateId: facilityId,
        facilityId,
        action: "slot_policy.updated",
        actor: ctx.actor,
        diff: { ...policy, configurationRevision: nextRev },
        correlationId: ctx.correlationId ?? null,
        decisionAt: decisionTime,
      });
      return { configurationRevision: nextRev, warnings };
    });
  }

  async setSlotOverride(
    ctx: TenantContext,
    input: SetSlotOverrideInput,
  ): Promise<ConfigurationMutationResult & { override: SlotOverride }> {
    return this.transaction(async (client) => {
      const facility = await this.requireFacility(client, ctx.tenantId, input.facilityId, true);
      const decisionTime = await getDecisionTime(client);
      await expireFacilityHolds(client, ctx.tenantId, input.facilityId, decisionTime);

      const config = await loadFacilityConfig(client, ctx.tenantId, input.facilityId);
      if (!config.policy) {
        throw new BookingError("INVALID_CONFIGURATION", "Slot policy must be configured before adding slot overrides");
      }

      if (input.action === "add") {
        const durationMs = config.policy.durationMinutes * 60_000;
        if (input.endsAt.getTime() - input.startsAt.getTime() !== durationMs) {
          throw new BookingError("INVALID_CONFIGURATION", "Added slot override duration must match configured slot duration");
        }
        // Verify override fits inside an effective operating window for that business date
        const nextRevPreview = facility.configurationRevision + 1;
        const previewOverride: SlotOverride = {
          id: randomUUID(),
          facilityId: input.facilityId,
          businessDate: input.businessDate,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          action: "add",
          reason: input.reason,
          configurationRevision: nextRevPreview,
        };
        const previewCheck = validateSlotSelection({
          facilityId: input.facilityId,
          configurationRevision: nextRevPreview,
          timeZone: facility.timeZone,
          slotRefs: [`v1.${input.facilityId}.${input.businessDate}.${nextRevPreview}.${input.startsAt.getTime()}.${input.endsAt.getTime()}`],
          weeklyWindows: config.weeklyWindows,
          exceptions: config.exceptions,
          overrides: [...config.overrides, previewOverride],
          policy: config.policy,
          pricing: config.pricing,
          occupied: [],
          asOf: decisionTime,
          bypassMinNotice: true,
        });
        if (!previewCheck.valid && (previewCheck.reasonCode === "OUTSIDE_OPERATING_HOURS" || previewCheck.reasonCode === "SLOT_NOT_FOUND")) {
          throw new BookingError("INVALID_CONFIGURATION", "Added slot override must fit inside an effective operating window");
        }
      }

      const nextRev = facility.configurationRevision + 1;
      const inserted = await client.query(
        `INSERT INTO slot_overrides(
           tenant_id, facility_id, business_date, starts_at, ends_at, action, reason, configuration_revision, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, facility_id, business_date::text, starts_at, ends_at, action, reason, configuration_revision`,
        [
          ctx.tenantId,
          input.facilityId,
          input.businessDate,
          input.startsAt,
          input.endsAt,
          input.action,
          input.reason,
          nextRev,
          decisionTime,
        ],
      );

      const updatedConfig = await loadFacilityConfig(client, ctx.tenantId, input.facilityId);
      const warnings = await evaluateConfigChangeImpact(client, {
        tenantId: ctx.tenantId,
        facility,
        nextRevision: nextRev,
        config: updatedConfig,
        decisionTime,
      });

      await this.bumpFacilityRevision(client, ctx.tenantId, input.facilityId, nextRev, decisionTime);
      await insertAudit(client, {
        tenantId: ctx.tenantId,
        aggregateType: "facility",
        aggregateId: input.facilityId,
        facilityId: input.facilityId,
        action: "slot_override.set",
        actor: ctx.actor,
        diff: { ...input, configurationRevision: nextRev },
        correlationId: ctx.correlationId ?? null,
        decisionAt: decisionTime,
      });

      const r = inserted.rows[0]!;
      return {
        configurationRevision: nextRev,
        warnings,
        override: {
          id: r.id as string,
          facilityId: r.facility_id as string,
          businessDate: isoDate(r.business_date as string),
          startsAt: asDate(r.starts_at as Date | string),
          endsAt: asDate(r.ends_at as Date | string),
          action: r.action as SlotOverride["action"],
          reason: r.reason as string,
          configurationRevision: Number(r.configuration_revision),
        },
      };
    });
  }

  async removeSlotOverride(ctx: TenantContext, facilityId: UUID, overrideId: UUID): Promise<ConfigurationMutationResult> {
    return this.transaction(async (client) => {
      const facility = await this.requireFacility(client, ctx.tenantId, facilityId, true);
      const decisionTime = await getDecisionTime(client);
      await expireFacilityHolds(client, ctx.tenantId, facilityId, decisionTime);

      const deleted = await client.query(
        "DELETE FROM slot_overrides WHERE tenant_id = $1 AND facility_id = $2 AND id = $3",
        [ctx.tenantId, facilityId, overrideId],
      );
      if (!deleted.rowCount) throw new BookingError("NOT_FOUND", "Slot override was not found");

      const nextRev = facility.configurationRevision + 1;
      const updatedConfig = await loadFacilityConfig(client, ctx.tenantId, facilityId);
      const warnings = await evaluateConfigChangeImpact(client, {
        tenantId: ctx.tenantId,
        facility,
        nextRevision: nextRev,
        config: updatedConfig,
        decisionTime,
      });

      await this.bumpFacilityRevision(client, ctx.tenantId, facilityId, nextRev, decisionTime);
      await insertAudit(client, {
        tenantId: ctx.tenantId,
        aggregateType: "facility",
        aggregateId: facilityId,
        facilityId,
        action: "slot_override.removed",
        actor: ctx.actor,
        diff: { overrideId, configurationRevision: nextRev },
        correlationId: ctx.correlationId ?? null,
        decisionAt: decisionTime,
      });
      return { configurationRevision: nextRev, warnings };
    });
  }

  async setPricing(ctx: TenantContext, input: SetPricingInput): Promise<ConfigurationMutationResult> {
    return this.transaction(async (client) => {
      const facility = await this.requireFacility(client, ctx.tenantId, input.facilityId, true);
      const decisionTime = await getDecisionTime(client);

      const maxRevRes = await client.query<{ max_rev: number | null }>(
        "SELECT MAX(revision) AS max_rev FROM pricing_rules WHERE tenant_id = $1 AND facility_id = $2",
        [ctx.tenantId, input.facilityId],
      );
      const nextPricingRev = Number(maxRevRes.rows[0]?.max_rev ?? 0) + 1;
      await client.query(
        "UPDATE pricing_rules SET active = false WHERE tenant_id = $1 AND facility_id = $2 AND active = true",
        [ctx.tenantId, input.facilityId],
      );
      await client.query(
        `INSERT INTO pricing_rules(tenant_id, facility_id, revision, amount_minor, currency, active, created_at)
         VALUES ($1,$2,$3,$4,$5,true,$6)`,
        [ctx.tenantId, input.facilityId, nextPricingRev, input.amountMinor, input.currency, decisionTime],
      );

      const nextConfigRev = facility.configurationRevision + 1;
      await this.bumpFacilityRevision(client, ctx.tenantId, input.facilityId, nextConfigRev, decisionTime);
      await insertAudit(client, {
        tenantId: ctx.tenantId,
        aggregateType: "facility",
        aggregateId: input.facilityId,
        facilityId: input.facilityId,
        action: "pricing.updated",
        actor: ctx.actor,
        diff: { pricingRevision: nextPricingRev, amountMinor: input.amountMinor, currency: input.currency, configurationRevision: nextConfigRev },
        correlationId: ctx.correlationId ?? null,
        decisionAt: decisionTime,
      });

      // Price-only changes do not invalidate existing holds or bookings (§5)
      return { configurationRevision: nextConfigRev, warnings: [] };
    });
  }

  async setCancellationPolicy(
    ctx: TenantContext,
    input: SetCancellationPolicyInput,
  ): Promise<ConfigurationMutationResult & { policy: CancellationPolicy }> {
    return this.transaction(async (client) => {
      const facility = await this.requireFacility(client, ctx.tenantId, input.facilityId, true);
      const decisionTime = await getDecisionTime(client);

      const maxRevRes = await client.query<{ max_rev: number | null }>(
        "SELECT MAX(revision) AS max_rev FROM cancellation_policies WHERE tenant_id = $1 AND facility_id = $2",
        [ctx.tenantId, input.facilityId],
      );
      const nextPolicyRev = Number(maxRevRes.rows[0]?.max_rev ?? 0) + 1;
      await client.query(
        "UPDATE cancellation_policies SET active = false WHERE tenant_id = $1 AND facility_id = $2 AND active = true",
        [ctx.tenantId, input.facilityId],
      );
      await client.query(
        `INSERT INTO cancellation_policies(
           tenant_id, facility_id, revision, customer_cancellation_allowed, min_notice_minutes, admin_override_allowed, active, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,true,$7)`,
        [
          ctx.tenantId,
          input.facilityId,
          nextPolicyRev,
          input.customerCancellationAllowed,
          input.minNoticeMinutes,
          input.adminOverrideAllowed,
          decisionTime,
        ],
      );

      const nextConfigRev = facility.configurationRevision + 1;
      await this.bumpFacilityRevision(client, ctx.tenantId, input.facilityId, nextConfigRev, decisionTime);
      await insertAudit(client, {
        tenantId: ctx.tenantId,
        aggregateType: "facility",
        aggregateId: input.facilityId,
        facilityId: input.facilityId,
        action: "cancellation_policy.updated",
        actor: ctx.actor,
        diff: { ...input, policyRevision: nextPolicyRev, configurationRevision: nextConfigRev },
        correlationId: ctx.correlationId ?? null,
        decisionAt: decisionTime,
      });

      return {
        configurationRevision: nextConfigRev,
        warnings: [],
        policy: {
          customerCancellationAllowed: input.customerCancellationAllowed,
          minNoticeMinutes: input.minNoticeMinutes,
          adminOverrideAllowed: input.adminOverrideAllowed,
          revision: nextPolicyRev,
        },
      };
    });
  }

  // ---- Blackouts ----

  async createBlackout(ctx: TenantContext, input: CreateBlackoutInput): Promise<Blackout> {
    return this.transaction(async (client) => {
      const facility = await this.requireFacility(client, ctx.tenantId, input.facilityId, true);
      const decisionTime = await getDecisionTime(client);
      await expireFacilityHolds(client, ctx.tenantId, input.facilityId, decisionTime, {
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      });

      // Reject blackouts overlapping unexpired holds or protected allocations (§5)
      const conflicts = await client.query<{ hold_id: string | null; booking_id: string | null; status: string }>(
        `SELECT hold_id, booking_id, status FROM allocations
         WHERE tenant_id = $1 AND facility_id = $2
           AND (status = 'reserved' OR (status = 'held' AND expires_at > $5))
           AND occupied_start < $4 AND occupied_end > $3
         ORDER BY occupied_start
         LIMIT 10`,
        [ctx.tenantId, input.facilityId, input.startsAt, input.endsAt, decisionTime],
      );
      if (conflicts.rowCount) {
        throw new BookingError("CONFIGURATION_CONFLICT", "Blackout overlaps an existing hold or protected booking", {
          details: {
            conflicts: conflicts.rows.map((r) => ({
              type: r.hold_id ? "hold" : "booking",
              id: r.hold_id ?? r.booking_id,
              status: r.status,
            })),
          },
        });
      }

      const res = await client.query(
        `INSERT INTO facility_blocks(tenant_id, facility_id, starts_at, ends_at, reason, active, created_at, created_by_actor)
         VALUES ($1,$2,$3,$4,$5,true,$6,$7::jsonb) RETURNING *`,
        [ctx.tenantId, input.facilityId, input.startsAt, input.endsAt, input.reason, decisionTime, JSON.stringify(ctx.actor)],
      );

      const nextRev = facility.configurationRevision + 1;
      await this.bumpFacilityRevision(client, ctx.tenantId, input.facilityId, nextRev, decisionTime);
      const blackout = toBlackout(res.rows[0]!);
      await insertAudit(client, {
        tenantId: ctx.tenantId,
        aggregateType: "facility",
        aggregateId: input.facilityId,
        facilityId: input.facilityId,
        action: "blackout.created",
        actor: ctx.actor,
        diff: { blackoutId: blackout.id, startsAt: blackout.startsAt.toISOString(), endsAt: blackout.endsAt.toISOString(), reason: blackout.reason },
        reason: input.reason,
        correlationId: ctx.correlationId ?? null,
        decisionAt: decisionTime,
      });
      return blackout;
    });
  }

  async removeBlackout(ctx: TenantContext, facilityId: UUID, blackoutId: UUID, reason?: string): Promise<void> {
    return this.transaction(async (client) => {
      const facility = await this.requireFacility(client, ctx.tenantId, facilityId, true);
      const decisionTime = await getDecisionTime(client);
      const updated = await client.query(
        `UPDATE facility_blocks SET active = false, removed_at = $4
         WHERE tenant_id = $1 AND facility_id = $2 AND id = $3 AND active = true`,
        [ctx.tenantId, facilityId, blackoutId, decisionTime],
      );
      if (!updated.rowCount) throw new BookingError("NOT_FOUND", "Active blackout was not found");
      const nextRev = facility.configurationRevision + 1;
      await this.bumpFacilityRevision(client, ctx.tenantId, facilityId, nextRev, decisionTime);
      await insertAudit(client, {
        tenantId: ctx.tenantId,
        aggregateType: "facility",
        aggregateId: facilityId,
        facilityId,
        action: "blackout.removed",
        actor: ctx.actor,
        diff: { blackoutId, configurationRevision: nextRev },
        reason: reason ?? null,
        correlationId: ctx.correlationId ?? null,
        decisionAt: decisionTime,
      });
    });
  }

  async listBlackouts(ctx: TenantContext, facilityId: UUID, options?: { includeInactive?: boolean }): Promise<Blackout[]> {
    return this.readSnapshot(async (client) => {
      await this.requireFacility(client, ctx.tenantId, facilityId, false);
      const includeInactive = options?.includeInactive ?? false;
      const res = await client.query(
        `SELECT * FROM facility_blocks
         WHERE tenant_id = $1 AND facility_id = $2 ${includeInactive ? "" : "AND active = true"}
         ORDER BY starts_at ASC`,
        [ctx.tenantId, facilityId],
      );
      return res.rows.map(toBlackout);
    });
  }

  // ---- Availability & Selection ----

  async getAvailability(ctx: TenantContext, query: AvailabilityQueryInput): Promise<AvailabilityResult> {
    return this.readSnapshot(async (client) => {
      const asOf = await getDecisionTime(client);
      const facRes = await client.query<FacilityRow>(
        `SELECT * FROM facilities WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id ASC`,
        [ctx.tenantId, query.facilityIds],
      );
      if (facRes.rows.length !== query.facilityIds.length) {
        throw new BookingError("NOT_FOUND", "One or more requested facilities were not found");
      }

      const facilities = facRes.rows.map(toFacility);
      const slots: AvailabilitySlot[] = [];
      const diagnostics: AvailabilityDiagnostic[] = [];

      for (const facility of facilities) {
        if (!facility.active) {
          if (query.includeInactiveDiagnostics) {
            diagnostics.push({
              facilityId: facility.id,
              code: "FACILITY_INACTIVE",
              message: "Facility is inactive and not accepting bookings",
            });
          }
          continue;
        }

        const config = await loadFacilityConfig(client, ctx.tenantId, facility.id);
        if (!config.policy) {
          diagnostics.push({
            facilityId: facility.id,
            code: "INVALID_CONFIGURATION",
            message: "Slot policy has not been configured for this facility",
          });
          continue;
        }

        const rangeStart = DateTime.fromISO(addDaysToLocalDate(query.fromDate, -2), { zone: facility.timeZone })
          .startOf("day")
          .toJSDate();
        const rangeEnd = DateTime.fromISO(addDaysToLocalDate(query.toDate, 3), { zone: facility.timeZone })
          .startOf("day")
          .toJSDate();
        const occupied = await loadOccupiedIntervals(client, ctx.tenantId, facility.id, rangeStart, rangeEnd, asOf);

        const remainingBudget = this.options.maxAvailabilityCandidates - slots.length;
        const generated = generateAvailabilitySlots({
          facilityId: facility.id,
          configurationRevision: facility.configurationRevision,
          fromDate: query.fromDate,
          toDate: query.toDate,
          timeZone: facility.timeZone,
          weeklyWindows: config.weeklyWindows,
          exceptions: config.exceptions,
          overrides: config.overrides,
          policy: config.policy,
          pricing: config.pricing,
          occupied,
          asOf,
          maxCandidates: remainingBudget,
        });

        // Date-level closed diagnostic if zero candidates exist for a requested date
        let dateCursor = query.fromDate;
        while (dateCursor <= query.toDate) {
          const hasForDate = generated.some((s) => s.localStart.startsWith(dateCursor));
          if (!hasForDate) {
            diagnostics.push({
              facilityId: facility.id,
              localDate: dateCursor,
              code: "CLOSED_OR_NO_SLOTS",
              message: `No candidate slots available for ${dateCursor}`,
            });
          }
          dateCursor = addDaysToLocalDate(dateCursor, 1);
        }

        const filtered = query.includeUnavailable ? generated : generated.filter((s) => s.available);
        if (slots.length + filtered.length > this.options.maxAvailabilityCandidates) {
          throw new BookingError(
            "QUERY_LIMIT_EXCEEDED",
            `Availability query exceeds candidate limit of ${this.options.maxAvailabilityCandidates}`,
          );
        }
        slots.push(...filtered);
      }

      return {
        asOf,
        facilities,
        fromDate: query.fromDate,
        toDate: query.toDate,
        slots,
        diagnostics,
      };
    });
  }

  async checkSelection(ctx: TenantContext, input: CheckSelectionInput): Promise<SelectionCheckResult> {
    return this.readSnapshot(async (client) => {
      const asOf = await getDecisionTime(client);
      const facility = await this.requireFacility(client, ctx.tenantId, input.facilityId, false);
      if (!facility.active) {
        throw new BookingError("FACILITY_INACTIVE", "Facility is not accepting bookings");
      }
      const config = await loadFacilityConfig(client, ctx.tenantId, input.facilityId);
      if (!config.policy) {
        throw new BookingError("INVALID_CONFIGURATION", "Slot policy has not been configured");
      }

      const rangeStart = new Date(asOf.getTime() - 2 * 86_400_000);
      const rangeEnd = new Date(asOf.getTime() + (config.policy.maxAdvanceDays + 3) * 86_400_000);
      const occupied = await loadOccupiedIntervals(client, ctx.tenantId, input.facilityId, rangeStart, rangeEnd, asOf);

      return validateSlotSelection({
        facilityId: facility.id,
        configurationRevision: facility.configurationRevision,
        timeZone: facility.timeZone,
        slotRefs: input.slotRefs,
        weeklyWindows: config.weeklyWindows,
        exceptions: config.exceptions,
        overrides: config.overrides,
        policy: config.policy,
        pricing: config.pricing,
        occupied,
        asOf,
        bypassMinNotice: input.bypassMinNotice,
      });
    });
  }

  // ---- Holds ----

  async createHold(ctx: TenantContext, input: CreateHoldInput, options: RequestOptions): Promise<HoldResult> {
    const callerNs = ctx.actor.callerNamespace ?? "default";
    const requestHash = computeRequestHash({
      facilityId: input.facilityId,
      slotRefs: [...input.slotRefs].sort(),
      externalCustomerId: input.externalCustomerId ?? null,
      expectedAmountMinor: input.expectedAmountMinor ?? null,
      expectedCurrency: input.expectedCurrency ?? null,
      holdMinutes: input.holdMinutes ?? null,
      bypassMinNotice: input.bypassMinNotice,
      metadata: input.metadata ?? {},
    });

    return this.transaction(async (client) => {
      // 1. Idempotency claim lock BEFORE facility lock (§8.1)
      const replay = await this.claimIdempotency<HoldResult>(client, ctx.tenantId, callerNs, "create_hold", options.idempotencyKey, requestHash);
      if (replay) {
        const parsed = this.hydrateHoldResult(replay);
        if (ctx.actor.type === "customer" && parsed.externalCustomerId !== ctx.actor.customerId) {
          throw new BookingError("FORBIDDEN", "Caller is not authorized for this idempotent hold");
        }
        return parsed;
      }

      // 2. Facility row lock + fresh post-lock decision clock (§8.2)
      const facility = await this.requireFacility(client, ctx.tenantId, input.facilityId, true);
      const decisionTime = await getDecisionTime(client);
      if (!facility.active) {
        throw new BookingError("FACILITY_INACTIVE", "This facility is not accepting bookings");
      }

      const config = await loadFacilityConfig(client, ctx.tenantId, input.facilityId);
      if (!config.policy) {
        throw new BookingError("INVALID_CONFIGURATION", "Slot policy has not been configured");
      }
      if (!config.pricing) {
        throw new BookingError("INVALID_CONFIGURATION", "Facility pricing must be configured before accepting holds");
      }

      // 3. Transition expired conflicting holds before allocating
      await expireFacilityHolds(client, ctx.tenantId, input.facilityId, decisionTime);

      // 4. Customer active-hold abuse limit (§13)
      if (input.externalCustomerId) {
        const countRes = await client.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM holds
           WHERE tenant_id = $1 AND facility_id = $2 AND external_customer_id = $3
             AND state = 'active' AND expires_at > $4`,
          [ctx.tenantId, input.facilityId, input.externalCustomerId, decisionTime],
        );
        if (Number(countRes.rows[0]!.cnt) >= config.policy.maxActiveHoldsPerCustomer) {
          throw new BookingError("HOLD_LIMIT_EXCEEDED", "Maximum active holds per customer for this facility reached");
        }
      }

      // 5. Validate selection against authoritative configuration & occupied intervals
      const minTime = new Date(decisionTime.getTime() - 2 * 86_400_000);
      const maxTime = new Date(decisionTime.getTime() + (config.policy.maxAdvanceDays + 3) * 86_400_000);
      const occupied = await loadOccupiedIntervals(client, ctx.tenantId, input.facilityId, minTime, maxTime, decisionTime);

      const selection = validateSlotSelection({
        facilityId: facility.id,
        configurationRevision: facility.configurationRevision,
        timeZone: facility.timeZone,
        slotRefs: input.slotRefs,
        weeklyWindows: config.weeklyWindows,
        exceptions: config.exceptions,
        overrides: config.overrides,
        policy: config.policy,
        pricing: config.pricing,
        occupied,
        asOf: decisionTime,
        bypassMinNotice: input.bypassMinNotice,
      });

      if (!selection.valid || !selection.serviceStart || !selection.serviceEnd || !selection.occupiedStart || !selection.occupiedEnd || selection.totalMinor === null || !selection.currency) {
        throw new BookingError(selection.reasonCode ?? "SLOT_CONFLICT", selection.message ?? "Selection is not available");
      }

      // 6. Authoritative price comparison (§10.1)
      if (
        input.expectedAmountMinor !== undefined
        && (input.expectedAmountMinor !== selection.totalMinor || input.expectedCurrency !== selection.currency)
      ) {
        throw new BookingError("PRICE_CHANGED", "Quoted price differs from current authoritative facility price", {
          details: { expectedAmountMinor: input.expectedAmountMinor, actualAmountMinor: selection.totalMinor, currency: selection.currency },
        });
      }

      // 7. Compute hold expiry capped at occupiedStart (§8.3)
      const holdMinutes = input.holdMinutes ?? config.policy.defaultHoldMinutes;
      const rawExpiryMs = decisionTime.getTime() + holdMinutes * 60_000;
      const cappedExpiryMs = Math.min(rawExpiryMs, selection.occupiedStart.getTime());
      if (cappedExpiryMs <= decisionTime.getTime()) {
        throw new BookingError("POLICY_VIOLATION", "No positive hold lifetime remains before the occupied interval begins");
      }
      const expiresAt = new Date(cappedExpiryMs);

      // 8. Persist hold + hold_items + allocation + audit + outbox + idempotency
      const holdRes = await client.query<HoldRow>(
        `INSERT INTO holds (
           tenant_id, facility_id, state, expires_at, external_customer_id, actor_json,
           facility_time_zone, configuration_revision, pricing_revision, cancellation_policy_snapshot,
           total_minor, currency, quote_created_at, starts_at, ends_at, occupied_from, occupied_until,
           sequence, metadata, created_at, updated_at
         ) VALUES ($1,$2,'active',$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,1,$17::jsonb,$12,$12)
         RETURNING *`,
        [
          ctx.tenantId,
          input.facilityId,
          expiresAt,
          input.externalCustomerId ?? null,
          JSON.stringify(ctx.actor),
          facility.timeZone,
          facility.configurationRevision,
          config.pricing.revision,
          JSON.stringify(config.cancellationPolicy),
          selection.totalMinor,
          selection.currency,
          decisionTime,
          selection.serviceStart,
          selection.serviceEnd,
          selection.occupiedStart,
          selection.occupiedEnd,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      const holdRow = holdRes.rows[0]!;

      const items = [];
      for (const slot of selection.slots) {
        const itemRes = await client.query<ItemRow>(
          `INSERT INTO hold_items (
             tenant_id, facility_id, hold_id, slot_ref, business_date,
             starts_at, ends_at, local_start, local_end, local_offset, price_minor, currency
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING *`,
          [
            ctx.tenantId,
            input.facilityId,
            holdRow.id,
            slot.slotRef,
            slot.businessDate,
            slot.startsAt,
            slot.endsAt,
            slot.localStart,
            slot.localEnd,
            slot.localOffset,
            config.pricing.amountMinor,
            config.pricing.currency,
          ],
        );
        items.push(toReservationItem(itemRes.rows[0]!));
      }

      await client.query(
        `INSERT INTO allocations (
           tenant_id, facility_id, hold_id, booking_id,
           service_start, service_end, occupied_start, occupied_end, status, expires_at, created_at, updated_at
         ) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,'held',$8,$9,$9)`,
        [
          ctx.tenantId,
          input.facilityId,
          holdRow.id,
          selection.serviceStart,
          selection.serviceEnd,
          selection.occupiedStart,
          selection.occupiedEnd,
          expiresAt,
          decisionTime,
        ],
      );

      const response = toHoldResult(holdRow, items);
      await insertOutboxEvent(client, {
        tenantId: ctx.tenantId,
        aggregateType: "hold",
        aggregateId: holdRow.id,
        aggregateSequence: 1,
        eventType: "hold.created",
        payload: {
          holdId: holdRow.id,
          facilityId: input.facilityId,
          expiresAt: expiresAt.toISOString(),
          totalMinor: response.totalMinor,
          currency: response.currency,
        },
        occurredAt: decisionTime,
      });
      await insertAudit(client, {
        tenantId: ctx.tenantId,
        aggregateType: "hold",
        aggregateId: holdRow.id,
        facilityId: input.facilityId,
        action: "hold.created",
        actor: ctx.actor,
        newState: "active",
        correlationId: options.correlationId ?? ctx.correlationId ?? null,
        decisionAt: decisionTime,
      });
      await this.storeIdempotency(
        client,
        ctx.tenantId,
        callerNs,
        "create_hold",
        options.idempotencyKey,
        requestHash,
        response,
        decisionTime,
      );

      return response;
    });
  }

  async getHold(ctx: TenantContext, holdId: UUID): Promise<HoldResult> {
    return this.readSnapshot(async (client) => {
      const decisionTime = await getDecisionTime(client);
      const res = await client.query<HoldRow>(
        "SELECT * FROM holds WHERE tenant_id = $1 AND id = $2",
        [ctx.tenantId, holdId],
      );
      const row = res.rows[0];
      if (!row) throw new BookingError("NOT_FOUND", "Hold was not found");
      this.assertCustomerOwnership(ctx, row.external_customer_id);
      const items = await this.loadHoldItems(client, ctx.tenantId, holdId);
      const effectiveState = effectiveHoldState(row.state, asDate(row.expires_at), decisionTime);
      return toHoldResult(row, items, effectiveState);
    });
  }

  async releaseHold(ctx: TenantContext, holdId: UUID, options?: Partial<RequestOptions>): Promise<HoldResult> {
    const callerNs = ctx.actor.callerNamespace ?? "default";
    const requestHash = computeRequestHash({ holdId });

    return this.transaction(async (client) => {
      if (options?.idempotencyKey) {
        const replay = await this.claimIdempotency<HoldResult>(client, ctx.tenantId, callerNs, "release_hold", options.idempotencyKey, requestHash);
        if (replay) {
          const hydrated = this.hydrateHoldResult(replay);
          this.assertCustomerOwnership(ctx, hydrated.externalCustomerId);
          return hydrated;
        }
      }

      const lookup = await client.query<{ facility_id: string; external_customer_id: string | null }>(
        "SELECT facility_id, external_customer_id FROM holds WHERE tenant_id = $1 AND id = $2",
        [ctx.tenantId, holdId],
      );
      const found = lookup.rows[0];
      if (!found) throw new BookingError("NOT_FOUND", "Hold was not found");
      this.assertCustomerOwnership(ctx, found.external_customer_id);

      await this.requireFacility(client, ctx.tenantId, found.facility_id, true);
      const decisionTime = await getDecisionTime(client);

      const hRes = await client.query<HoldRow>(
        "SELECT * FROM holds WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [ctx.tenantId, holdId],
      );
      const holdRow = hRes.rows[0]!;
      const items = await this.loadHoldItems(client, ctx.tenantId, holdId);

      if (holdRow.state === "converted") {
        throw new BookingError("INVALID_STATE_TRANSITION", "Cannot release an already converted hold");
      }
      if (holdRow.state === "released" || holdRow.state === "expired") {
        const result = toHoldResult(holdRow, items);
        if (options?.idempotencyKey) {
          await this.storeIdempotency(client, ctx.tenantId, callerNs, "release_hold", options.idempotencyKey, requestHash, result, decisionTime);
        }
        return result;
      }

      // Active hold but logically expired -> mark expired rather than released
      if (asDate(holdRow.expires_at).getTime() <= decisionTime.getTime()) {
        await expireFacilityHolds(client, ctx.tenantId, found.facility_id, decisionTime);
        const refreshed = await client.query<HoldRow>("SELECT * FROM holds WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, holdId]);
        const result = toHoldResult(refreshed.rows[0]!, items);
        if (options?.idempotencyKey) {
          await this.storeIdempotency(client, ctx.tenantId, callerNs, "release_hold", options.idempotencyKey, requestHash, result, decisionTime);
        }
        return result;
      }

      const nextSeq = Number(holdRow.sequence) + 1;
      const updated = await client.query<HoldRow>(
        `UPDATE holds SET state = 'released', sequence = $3, updated_at = $2 WHERE id = $1 RETURNING *`,
        [holdId, decisionTime, nextSeq],
      );
      await client.query(
        `UPDATE allocations SET status = 'released', expires_at = NULL, released_at = $2, updated_at = $2
         WHERE hold_id = $1 AND status = 'held'`,
        [holdId, decisionTime],
      );
      await insertOutboxEvent(client, {
        tenantId: ctx.tenantId,
        aggregateType: "hold",
        aggregateId: holdId,
        aggregateSequence: nextSeq,
        eventType: "hold.released",
        payload: { holdId, facilityId: found.facility_id },
        occurredAt: decisionTime,
      });
      await insertAudit(client, {
        tenantId: ctx.tenantId,
        aggregateType: "hold",
        aggregateId: holdId,
        facilityId: found.facility_id,
        action: "hold.released",
        actor: ctx.actor,
        priorState: "active",
        newState: "released",
        correlationId: options?.correlationId ?? ctx.correlationId ?? null,
        decisionAt: decisionTime,
      });

      const result = toHoldResult(updated.rows[0]!, items);
      if (options?.idempotencyKey) {
        await this.storeIdempotency(client, ctx.tenantId, callerNs, "release_hold", options.idempotencyKey, requestHash, result, decisionTime);
      }
      return result;
    });
  }

  async convertHoldToBooking(ctx: TenantContext, input: ConvertHoldInput, options: RequestOptions): Promise<BookingSummary> {
    const callerNs = ctx.actor.callerNamespace ?? "default";
    const requestHash = computeRequestHash({
      holdId: input.holdId,
      expectedAmountMinor: input.expectedAmountMinor ?? null,
      expectedCurrency: input.expectedCurrency ?? null,
      externalPaymentRef: input.externalPaymentRef ?? null,
    });

    return this.transaction(async (client) => {
      const replay = await this.claimIdempotency<BookingSummary>(client, ctx.tenantId, callerNs, "convert_hold", options.idempotencyKey, requestHash);
      if (replay) {
        const hydrated = this.hydrateBookingSummary(replay);
        this.assertCustomerOwnership(ctx, hydrated.externalCustomerId);
        return hydrated;
      }

      const lookup = await client.query<{ facility_id: string; external_customer_id: string | null }>(
        "SELECT facility_id, external_customer_id FROM holds WHERE tenant_id = $1 AND id = $2",
        [ctx.tenantId, input.holdId],
      );
      const found = lookup.rows[0];
      if (!found) throw new BookingError("NOT_FOUND", "Hold was not found");
      this.assertCustomerOwnership(ctx, found.external_customer_id);

      await this.requireFacility(client, ctx.tenantId, found.facility_id, true);
      const decisionTime = await getDecisionTime(client);

      const hRes = await client.query<HoldRow>(
        "SELECT * FROM holds WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [ctx.tenantId, input.holdId],
      );
      const holdRow = hRes.rows[0]!;

      // Repeated conversion on already-converted hold returns existing booking if details match (§9.1)
      if (holdRow.state === "converted" && holdRow.converted_booking_id) {
        if (
          input.expectedAmountMinor !== undefined
          && (input.expectedAmountMinor !== Number(holdRow.total_minor) || input.expectedCurrency !== holdRow.currency.trim())
        ) {
          throw new BookingError("PRICE_CHANGED", "Conversion price expectations do not match converted booking");
        }
        const existingBooking = await this.loadBookingSummary(client, ctx.tenantId, holdRow.converted_booking_id);
        if (input.externalPaymentRef && existingBooking.externalPaymentRef && input.externalPaymentRef !== existingBooking.externalPaymentRef) {
          throw new BookingError("INVALID_STATE_TRANSITION", "Hold was already converted with a different payment reference");
        }
        await this.storeIdempotency(client, ctx.tenantId, callerNs, "convert_hold", options.idempotencyKey, requestHash, existingBooking, decisionTime);
        return existingBooking;
      }

      if (holdRow.state === "expired" || (holdRow.state === "active" && asDate(holdRow.expires_at).getTime() <= decisionTime.getTime())) {
        throw new BookingError("HOLD_EXPIRED", "Hold has expired and cannot be converted", {
          details: { reconciliationHint: "PAYMENT_RECONCILIATION_REQUIRED", holdId: holdRow.id },
        });
      }
      if (holdRow.state !== "active") {
        throw new BookingError("INVALID_STATE_TRANSITION", `Cannot convert a ${holdRow.state} hold`);
      }

      // Check expected quote against hold snapshot (§10.1)
      if (
        input.expectedAmountMinor !== undefined
        && (input.expectedAmountMinor !== Number(holdRow.total_minor) || input.expectedCurrency !== holdRow.currency.trim())
      ) {
        throw new BookingError("PRICE_CHANGED", "Quoted hold amount differs from expected amount");
      }

      const allocRes = await client.query<{ id: string }>(
        "SELECT id FROM allocations WHERE tenant_id = $1 AND facility_id = $2 AND hold_id = $3 AND status = 'held' FOR UPDATE",
        [ctx.tenantId, holdRow.facility_id, holdRow.id],
      );
      if (!allocRes.rowCount) {
        throw new BookingError("INTERNAL_ERROR", "Held allocation missing for active hold");
      }

      const holdItems = await this.loadHoldItems(client, ctx.tenantId, holdRow.id);

      // Create confirmed booking preserving hold snapshots (no repricing!)
      const bRes = await client.query<BookingRow>(
        `INSERT INTO bookings (
           tenant_id, facility_id, status, source_hold_id, external_customer_id, external_payment_ref,
           actor_json, facility_time_zone, configuration_revision, pricing_revision, cancellation_policy_snapshot,
           starts_at, ends_at, occupied_from, occupied_until, total_minor, currency,
           sequence, metadata, created_at, updated_at
         ) VALUES ($1,$2,'confirmed',$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,1,$17::jsonb,$18,$18)
         RETURNING *`,
        [
          ctx.tenantId,
          holdRow.facility_id,
          holdRow.id,
          holdRow.external_customer_id,
          input.externalPaymentRef ?? null,
          JSON.stringify(ctx.actor),
          holdRow.facility_time_zone,
          holdRow.configuration_revision,
          holdRow.pricing_revision,
          JSON.stringify(holdRow.cancellation_policy_snapshot),
          holdRow.starts_at,
          holdRow.ends_at,
          holdRow.occupied_from,
          holdRow.occupied_until,
          holdRow.total_minor,
          holdRow.currency,
          JSON.stringify(holdRow.metadata ?? {}),
          decisionTime,
        ],
      );
      const bookingRow = bRes.rows[0]!;

      const bookingItems = [];
      for (const item of holdItems) {
        const biRes = await client.query<ItemRow>(
          `INSERT INTO booking_items (
             tenant_id, facility_id, booking_id, slot_ref, business_date,
             starts_at, ends_at, local_start, local_end, local_offset, price_minor, currency
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [
            ctx.tenantId,
            holdRow.facility_id,
            bookingRow.id,
            item.slotRef,
            item.businessDate,
            item.startsAt,
            item.endsAt,
            item.localStart,
            item.localEnd,
            item.localOffset,
            item.priceMinor,
            item.currency,
          ],
        );
        bookingItems.push(toReservationItem(biRes.rows[0]!));
      }

      // Transfer allocation ownership in-place from hold -> booking (§7.1, §9.3)
      await client.query(
        `UPDATE allocations SET hold_id = NULL, booking_id = $2, status = 'reserved', expires_at = NULL, updated_at = $3
         WHERE id = $1`,
        [allocRes.rows[0]!.id, bookingRow.id, decisionTime],
      );

      const nextHoldSeq = Number(holdRow.sequence) + 1;
      await client.query(
        `UPDATE holds SET state = 'converted', converted_booking_id = $2, sequence = $3, updated_at = $4 WHERE id = $1`,
        [holdRow.id, bookingRow.id, nextHoldSeq, decisionTime],
      );

      const summary = toBookingSummary(bookingRow, bookingItems);

      await insertOutboxEvent(client, {
        tenantId: ctx.tenantId,
        aggregateType: "hold",
        aggregateId: holdRow.id,
        aggregateSequence: nextHoldSeq,
        eventType: "hold.converted",
        payload: { holdId: holdRow.id, bookingId: bookingRow.id, facilityId: holdRow.facility_id },
        occurredAt: decisionTime,
      });
      await insertOutboxEvent(client, {
        tenantId: ctx.tenantId,
        aggregateType: "booking",
        aggregateId: bookingRow.id,
        aggregateSequence: 1,
        eventType: "booking.created",
        payload: { bookingId: bookingRow.id, facilityId: holdRow.facility_id, sourceHoldId: holdRow.id, totalMinor: summary.totalMinor, currency: summary.currency },
        occurredAt: decisionTime,
      });
      await insertOutboxEvent(client, {
        tenantId: ctx.tenantId,
        aggregateType: "booking",
        aggregateId: bookingRow.id,
        aggregateSequence: 2,
        eventType: "booking.confirmed",
        payload: { bookingId: bookingRow.id, facilityId: holdRow.facility_id, sourceHoldId: holdRow.id },
        occurredAt: decisionTime,
      });
      await insertAudit(client, {
        tenantId: ctx.tenantId,
        aggregateType: "booking",
        aggregateId: bookingRow.id,
        facilityId: holdRow.facility_id,
        action: "booking.confirmed_from_hold",
        actor: ctx.actor,
        newState: "confirmed",
        diff: { sourceHoldId: holdRow.id },
        correlationId: options.correlationId ?? ctx.correlationId ?? null,
        decisionAt: decisionTime,
      });

      await this.storeIdempotency(client, ctx.tenantId, callerNs, "convert_hold", options.idempotencyKey, requestHash, summary, decisionTime);
      return summary;
    });
  }

  // ---- Bookings ----

  async createBooking(ctx: TenantContext, input: CreateDirectBookingInput, options: RequestOptions): Promise<BookingSummary> {
    const callerNs = ctx.actor.callerNamespace ?? "default";
    const requestHash = computeRequestHash({
      facilityId: input.facilityId,
      slotRefs: [...input.slotRefs].sort(),
      externalCustomerId: input.externalCustomerId ?? null,
      expectedAmountMinor: input.expectedAmountMinor ?? null,
      expectedCurrency: input.expectedCurrency ?? null,
      externalPaymentRef: input.externalPaymentRef ?? null,
      bypassMinNotice: input.bypassMinNotice,
      metadata: input.metadata ?? {},
    });

    return this.transaction(async (client) => {
      const replay = await this.claimIdempotency<BookingSummary>(client, ctx.tenantId, callerNs, "create_booking", options.idempotencyKey, requestHash);
      if (replay) {
        const hydrated = this.hydrateBookingSummary(replay);
        this.assertCustomerOwnership(ctx, hydrated.externalCustomerId);
        return hydrated;
      }

      const facility = await this.requireFacility(client, ctx.tenantId, input.facilityId, true);
      const decisionTime = await getDecisionTime(client);
      if (!facility.active) {
        throw new BookingError("FACILITY_INACTIVE", "This facility is not accepting bookings");
      }

      const config = await loadFacilityConfig(client, ctx.tenantId, input.facilityId);
      if (!config.policy) throw new BookingError("INVALID_CONFIGURATION", "Slot policy has not been configured");
      if (!config.pricing) throw new BookingError("INVALID_CONFIGURATION", "Facility pricing must be configured before accepting bookings");

      await expireFacilityHolds(client, ctx.tenantId, input.facilityId, decisionTime);

      const minTime = new Date(decisionTime.getTime() - 2 * 86_400_000);
      const maxTime = new Date(decisionTime.getTime() + (config.policy.maxAdvanceDays + 3) * 86_400_000);
      const occupied = await loadOccupiedIntervals(client, ctx.tenantId, input.facilityId, minTime, maxTime, decisionTime);

      const selection = validateSlotSelection({
        facilityId: facility.id,
        configurationRevision: facility.configurationRevision,
        timeZone: facility.timeZone,
        slotRefs: input.slotRefs,
        weeklyWindows: config.weeklyWindows,
        exceptions: config.exceptions,
        overrides: config.overrides,
        policy: config.policy,
        pricing: config.pricing,
        occupied,
        asOf: decisionTime,
        bypassMinNotice: input.bypassMinNotice,
      });

      if (!selection.valid || !selection.serviceStart || !selection.serviceEnd || !selection.occupiedStart || !selection.occupiedEnd || selection.totalMinor === null || !selection.currency) {
        throw new BookingError(selection.reasonCode ?? "SLOT_CONFLICT", selection.message ?? "Selection is not available");
      }

      if (
        input.expectedAmountMinor !== undefined
        && (input.expectedAmountMinor !== selection.totalMinor || input.expectedCurrency !== selection.currency)
      ) {
        throw new BookingError("PRICE_CHANGED", "Quoted price differs from current authoritative facility price");
      }

      const bRes = await client.query<BookingRow>(
        `INSERT INTO bookings (
           tenant_id, facility_id, status, source_hold_id, external_customer_id, external_payment_ref,
           actor_json, facility_time_zone, configuration_revision, pricing_revision, cancellation_policy_snapshot,
           starts_at, ends_at, occupied_from, occupied_until, total_minor, currency,
           sequence, metadata, created_at, updated_at
         ) VALUES ($1,$2,'confirmed',NULL,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,2,$16::jsonb,$17,$17)
         RETURNING *`,
        [
          ctx.tenantId,
          input.facilityId,
          input.externalCustomerId ?? null,
          input.externalPaymentRef ?? null,
          JSON.stringify(ctx.actor),
          facility.timeZone,
          facility.configurationRevision,
          config.pricing.revision,
          JSON.stringify(config.cancellationPolicy),
          selection.serviceStart,
          selection.serviceEnd,
          selection.occupiedStart,
          selection.occupiedEnd,
          selection.totalMinor,
          selection.currency,
          JSON.stringify(input.metadata ?? {}),
          decisionTime,
        ],
      );
      const bookingRow = bRes.rows[0]!;

      const bookingItems = [];
      for (const slot of selection.slots) {
        const biRes = await client.query<ItemRow>(
          `INSERT INTO booking_items (
             tenant_id, facility_id, booking_id, slot_ref, business_date,
             starts_at, ends_at, local_start, local_end, local_offset, price_minor, currency
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [
            ctx.tenantId,
            input.facilityId,
            bookingRow.id,
            slot.slotRef,
            slot.businessDate,
            slot.startsAt,
            slot.endsAt,
            slot.localStart,
            slot.localEnd,
            slot.localOffset,
            config.pricing.amountMinor,
            config.pricing.currency,
          ],
        );
        bookingItems.push(toReservationItem(biRes.rows[0]!));
      }

      await client.query(
        `INSERT INTO allocations (
           tenant_id, facility_id, hold_id, booking_id,
           service_start, service_end, occupied_start, occupied_end, status, expires_at, created_at, updated_at
         ) VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,'reserved',NULL,$8,$8)`,
        [
          ctx.tenantId,
          input.facilityId,
          bookingRow.id,
          selection.serviceStart,
          selection.serviceEnd,
          selection.occupiedStart,
          selection.occupiedEnd,
          decisionTime,
        ],
      );

      const summary = toBookingSummary(bookingRow, bookingItems);
      await insertOutboxEvent(client, {
        tenantId: ctx.tenantId,
        aggregateType: "booking",
        aggregateId: bookingRow.id,
        aggregateSequence: 1,
        eventType: "booking.created",
        payload: { bookingId: bookingRow.id, facilityId: input.facilityId, totalMinor: summary.totalMinor, currency: summary.currency },
        occurredAt: decisionTime,
      });
      await insertOutboxEvent(client, {
        tenantId: ctx.tenantId,
        aggregateType: "booking",
        aggregateId: bookingRow.id,
        aggregateSequence: 2,
        eventType: "booking.confirmed",
        payload: { bookingId: bookingRow.id, facilityId: input.facilityId },
        occurredAt: decisionTime,
      });
      await insertAudit(client, {
        tenantId: ctx.tenantId,
        aggregateType: "booking",
        aggregateId: bookingRow.id,
        facilityId: input.facilityId,
        action: "booking.created_direct",
        actor: ctx.actor,
        newState: "confirmed",
        correlationId: options.correlationId ?? ctx.correlationId ?? null,
        decisionAt: decisionTime,
      });
      await this.storeIdempotency(client, ctx.tenantId, callerNs, "create_booking", options.idempotencyKey, requestHash, summary, decisionTime);
      return summary;
    });
  }

  async getBooking(ctx: TenantContext, bookingId: UUID): Promise<BookingSummary> {
    return this.readSnapshot(async (client) => {
      const summary = await this.loadBookingSummary(client, ctx.tenantId, bookingId);
      this.assertCustomerOwnership(ctx, summary.externalCustomerId);
      return summary;
    });
  }

  async listBookings(ctx: TenantContext, query: ListBookingsQuery): Promise<BookingListPage> {
    return this.readSnapshot(async (client) => {
      const params: unknown[] = [ctx.tenantId];
      const clauses: string[] = ["tenant_id = $1"];

      if (query.facilityId) {
        params.push(query.facilityId);
        clauses.push(`facility_id = $${params.length}`);
      }
      if (query.status) {
        params.push(query.status);
        clauses.push(`status = $${params.length}`);
      }
      if (query.externalCustomerId) {
        params.push(query.externalCustomerId);
        clauses.push(`external_customer_id = $${params.length}`);
      }
      if (query.cursor) {
        const [tsStr, idStr] = query.cursor.split("|");
        if (!tsStr || !idStr || Number.isNaN(Date.parse(tsStr))) {
          throw new BookingError("INVALID_INPUT", "Invalid pagination cursor");
        }
        params.push(new Date(tsStr), idStr);
        clauses.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
      }

      params.push(query.limit + 1);
      const res = await client.query<BookingRow>(
        `SELECT * FROM bookings WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length}`,
        params,
      );

      const hasMore = res.rows.length > query.limit;
      const rows = hasMore ? res.rows.slice(0, query.limit) : res.rows;
      const items: BookingSummary[] = [];
      for (const row of rows) {
        const bItems = await this.loadBookingItems(client, ctx.tenantId, row.id);
        items.push(toBookingSummary(row, bItems));
      }

      const last = rows[rows.length - 1];
      const nextCursor = hasMore && last ? `${asDate(last.created_at).toISOString()}|${last.id}` : null;
      return { items, nextCursor };
    });
  }

  async cancelBooking(ctx: TenantContext, input: CancelBookingInput, options?: Partial<RequestOptions>): Promise<BookingSummary> {
    return this.transitionBookingStatus(ctx, input.bookingId, "cancelled", input.reason, options);
  }

  async completeBooking(ctx: TenantContext, bookingId: UUID, options?: Partial<RequestOptions>): Promise<BookingSummary> {
    return this.transitionBookingStatus(ctx, bookingId, "completed", undefined, options);
  }

  async markNoShow(ctx: TenantContext, bookingId: UUID, options?: Partial<RequestOptions>): Promise<BookingSummary> {
    return this.transitionBookingStatus(ctx, bookingId, "no_show", undefined, options);
  }

  async getBookingHistory(ctx: TenantContext, aggregateType: string, aggregateId: UUID): Promise<BookingHistoryEntry[]> {
    return this.readSnapshot(async (client) => {
      const res = await client.query(
        `SELECT * FROM booking_history
         WHERE tenant_id = $1 AND aggregate_type = $2 AND aggregate_id = $3
         ORDER BY recorded_at ASC, id ASC`,
        [ctx.tenantId, aggregateType, aggregateId],
      );
      return res.rows.map(toHistoryEntry);
    });
  }

  // ---- Maintenance & Durable Outbox ----

  async expireHolds(limit = 100): Promise<ExpireHoldsResult> {
    const expiredHoldIds: UUID[] = [];
    // Discover candidate holds without holding locks (§8.3)
    const candidates = await this.pool.query<{ id: string; tenant_id: string; facility_id: string }>(
      `SELECT id, tenant_id, facility_id FROM holds
       WHERE state = 'active' AND expires_at <= clock_timestamp()
       ORDER BY expires_at ASC, id ASC
       LIMIT $1`,
      [limit],
    );

    const byFacility = new Map<string, { tenantId: string; facilityId: string }>();
    for (const row of candidates.rows) {
      byFacility.set(`${row.tenant_id}:${row.facility_id}`, { tenantId: row.tenant_id, facilityId: row.facility_id });
    }

    for (const entry of byFacility.values()) {
      const ids = await this.transaction(async (client) => {
        await this.requireFacility(client, entry.tenantId, entry.facilityId, true);
        const decisionTime = await getDecisionTime(client);
        return expireFacilityHolds(client, entry.tenantId, entry.facilityId, decisionTime);
      });
      expiredHoldIds.push(...ids);
    }

    return { expiredCount: expiredHoldIds.length, expiredHoldIds };
  }

  async claimEvents(options?: { limit?: number; leaseSeconds?: number }): Promise<OutboxEvent[]> {
    const limit = options?.limit ?? 50;
    const leaseSeconds = options?.leaseSeconds ?? 30;
    const leaseToken = randomUUID();

    return this.transaction(async (client) => {
      const decisionTime = await getDecisionTime(client);
      const leaseUntil = new Date(decisionTime.getTime() + leaseSeconds * 1000);
      const res = await client.query(
        `WITH candidate AS (
           SELECT id FROM outbox_events
           WHERE status = 'pending'
             AND next_attempt_at <= $1
             AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
           ORDER BY recorded_at ASC, aggregate_sequence ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE outbox_events e
         SET lease_token = $3, lease_expires_at = $4
         FROM candidate
         WHERE e.id = candidate.id
         RETURNING e.*`,
        [decisionTime, limit, leaseToken, leaseUntil],
      );
      return res.rows.map(toOutboxEvent);
    });
  }

  async ackEvent(eventId: UUID, leaseToken: UUID): Promise<void> {
    return this.transaction(async (client) => {
      const decisionTime = await getDecisionTime(client);
      const res = await client.query(
        `UPDATE outbox_events
         SET status = 'delivered', delivered_at = $3, lease_token = NULL, lease_expires_at = NULL
         WHERE id = $1 AND lease_token = $2 AND status = 'pending' AND lease_expires_at > $3`,
        [eventId, leaseToken, decisionTime],
      );
      if (!res.rowCount) {
        throw new BookingError("INVALID_STATE_TRANSITION", "Outbox lease token is missing, stale, or expired");
      }
    });
  }

  async retryEvent(eventId: UUID, leaseToken: UUID, errorMessage?: string, backoffSeconds = 30): Promise<OutboxEvent> {
    return this.transaction(async (client) => {
      const decisionTime = await getDecisionTime(client);
      const existing = await client.query(
        `SELECT * FROM outbox_events WHERE id = $1 AND lease_token = $2 AND status = 'pending' FOR UPDATE`,
        [eventId, leaseToken],
      );
      const row = existing.rows[0];
      if (!row) {
        throw new BookingError("INVALID_STATE_TRANSITION", "Outbox lease token is invalid or event is not pending");
      }
      const nextAttempts = Number(row.attempts) + 1;
      const exhausted = nextAttempts >= Number(row.max_attempts);
      const nextAttemptAt = new Date(decisionTime.getTime() + backoffSeconds * 1000);
      const updated = await client.query(
        `UPDATE outbox_events SET
           attempts = $2,
           status = $3,
           last_error = $4,
           next_attempt_at = $5,
           lease_token = NULL,
           lease_expires_at = NULL
         WHERE id = $1
         RETURNING *`,
        [eventId, nextAttempts, exhausted ? "failed" : "pending", errorMessage ?? null, nextAttemptAt],
      );
      return toOutboxEvent(updated.rows[0]!);
    });
  }

  async replayFailedEvent(eventId: UUID): Promise<OutboxEvent> {
    return this.transaction(async (client) => {
      const decisionTime = await getDecisionTime(client);
      const res = await client.query(
        `UPDATE outbox_events SET
           status = 'pending',
           attempts = 0,
           next_attempt_at = $2,
           lease_token = NULL,
           lease_expires_at = NULL,
           last_error = NULL
         WHERE id = $1 AND status = 'failed'
         RETURNING *`,
        [eventId, decisionTime],
      );
      if (!res.rows[0]) {
        throw new BookingError("NOT_FOUND", "Failed outbox event was not found");
      }
      return toOutboxEvent(res.rows[0]);
    });
  }

  async cleanupIdempotencyRecords(limit = 500): Promise<number> {
    return this.transaction(async (client) => {
      const decisionTime = await getDecisionTime(client);
      const res = await client.query(
        `WITH doomed AS (
           SELECT tenant_id, caller_namespace, operation, idempotency_key
           FROM idempotency_records
           WHERE expires_at <= $1
           LIMIT $2
         )
         DELETE FROM idempotency_records r
         USING doomed d
         WHERE r.tenant_id = d.tenant_id
           AND r.caller_namespace = d.caller_namespace
           AND r.operation = d.operation
           AND r.idempotency_key = d.idempotency_key`,
        [decisionTime, limit],
      );
      return res.rowCount ?? 0;
    });
  }

  // ---- Internal helpers ----

  private async transitionBookingStatus(
    ctx: TenantContext,
    bookingId: UUID,
    targetStatus: "cancelled" | "completed" | "no_show",
    reason?: string,
    options?: Partial<RequestOptions>,
  ): Promise<BookingSummary> {
    const callerNs = ctx.actor.callerNamespace ?? "default";
    const operation = `booking_${targetStatus}`;
    const requestHash = computeRequestHash({ bookingId, targetStatus, reason: reason ?? null });

    return this.transaction(async (client) => {
      if (options?.idempotencyKey) {
        const replay = await this.claimIdempotency<BookingSummary>(client, ctx.tenantId, callerNs, operation, options.idempotencyKey, requestHash);
        if (replay) {
          const hydrated = this.hydrateBookingSummary(replay);
          this.assertCustomerOwnership(ctx, hydrated.externalCustomerId);
          return hydrated;
        }
      }

      const lookup = await client.query<{ facility_id: string; external_customer_id: string | null }>(
        "SELECT facility_id, external_customer_id FROM bookings WHERE tenant_id = $1 AND id = $2",
        [ctx.tenantId, bookingId],
      );
      const found = lookup.rows[0];
      if (!found) throw new BookingError("NOT_FOUND", "Booking was not found");
      this.assertCustomerOwnership(ctx, found.external_customer_id);

      await this.requireFacility(client, ctx.tenantId, found.facility_id, true);
      const decisionTime = await getDecisionTime(client);

      const bRes = await client.query<BookingRow>(
        "SELECT * FROM bookings WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [ctx.tenantId, bookingId],
      );
      const row = bRes.rows[0]!;
      const items = await this.loadBookingItems(client, ctx.tenantId, bookingId);

      const { idempotentReplay } = assertBookingTransition(row.status, targetStatus, {
        startsAt: asDate(row.starts_at),
        endsAt: asDate(row.ends_at),
        decisionTime,
        cancellationPolicy: row.cancellation_policy_snapshot,
        actor: ctx.actor,
        overrideReason: reason,
      });

      if (idempotentReplay) {
        const summary = toBookingSummary(row, items);
        if (options?.idempotencyKey) {
          await this.storeIdempotency(client, ctx.tenantId, callerNs, operation, options.idempotencyKey, requestHash, summary, decisionTime);
        }
        return summary;
      }

      const nextSeq = Number(row.sequence) + 1;
      let updated: BookingRow;
      if (targetStatus === "cancelled") {
        const uRes = await client.query<BookingRow>(
          `UPDATE bookings SET status = 'cancelled', cancelled_at = $2, cancellation_reason = $3, sequence = $4, updated_at = $2
           WHERE id = $1 RETURNING *`,
          [bookingId, decisionTime, reason ?? null, nextSeq],
        );
        updated = uRes.rows[0]!;
        await client.query(
          `UPDATE allocations SET status = 'released', released_at = $2, updated_at = $2
           WHERE booking_id = $1 AND status = 'reserved'`,
          [bookingId, decisionTime],
        );
      } else if (targetStatus === "completed") {
        const uRes = await client.query<BookingRow>(
          `UPDATE bookings SET status = 'completed', completed_at = $2, sequence = $3, updated_at = $2
           WHERE id = $1 RETURNING *`,
          [bookingId, decisionTime, nextSeq],
        );
        updated = uRes.rows[0]!;
      } else {
        const uRes = await client.query<BookingRow>(
          `UPDATE bookings SET status = 'no_show', no_show_at = $2, sequence = $3, updated_at = $2
           WHERE id = $1 RETURNING *`,
          [bookingId, decisionTime, nextSeq],
        );
        updated = uRes.rows[0]!;
      }

      await insertOutboxEvent(client, {
        tenantId: ctx.tenantId,
        aggregateType: "booking",
        aggregateId: bookingId,
        aggregateSequence: nextSeq,
        eventType: `booking.${targetStatus}`,
        payload: { bookingId, facilityId: found.facility_id, ...(reason ? { reason } : {}) },
        occurredAt: decisionTime,
      });
      await insertAudit(client, {
        tenantId: ctx.tenantId,
        aggregateType: "booking",
        aggregateId: bookingId,
        facilityId: found.facility_id,
        action: `booking.${targetStatus}`,
        actor: ctx.actor,
        priorState: row.status,
        newState: targetStatus,
        reason: reason ?? null,
        correlationId: options?.correlationId ?? ctx.correlationId ?? null,
        decisionAt: decisionTime,
      });

      const summary = toBookingSummary(updated, items);
      if (options?.idempotencyKey) {
        await this.storeIdempotency(client, ctx.tenantId, callerNs, operation, options.idempotencyKey, requestHash, summary, decisionTime);
      }
      return summary;
    });
  }

  private assertCustomerOwnership(ctx: TenantContext, ownerCustomerId: string | null): void {
    if (ctx.actor.type === "customer" && ownerCustomerId !== ctx.actor.customerId) {
      throw new BookingError("FORBIDDEN", "Customer cannot access or mutate another customer's reservation");
    }
  }

  private async requireActiveTenant(client: PoolClient, tenantId: UUID): Promise<Tenant> {
    const res = await client.query<TenantRow>("SELECT * FROM tenants WHERE id = $1", [tenantId]);
    const row = res.rows[0];
    if (!row) throw new BookingError("NOT_FOUND", "Tenant was not found");
    if (row.status === "archived") throw new BookingError("FORBIDDEN", "Tenant has been archived");
    return toTenant(row);
  }

  private async requireFacility(client: PoolClient, tenantId: UUID, facilityId: UUID, lock: boolean): Promise<Facility> {
    const res = await client.query<FacilityRow>(
      `SELECT * FROM facilities WHERE tenant_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
      [tenantId, facilityId],
    );
    const row = res.rows[0];
    if (!row) throw new BookingError("NOT_FOUND", "Facility was not found for this tenant");
    return toFacility(row);
  }

  private async assertNoActiveHolds(client: PoolClient, tenantId: UUID, facilityId: UUID, decisionTime: Date): Promise<void> {
    const res = await client.query(
      "SELECT 1 FROM holds WHERE tenant_id = $1 AND facility_id = $2 AND state = 'active' AND expires_at > $3 LIMIT 1",
      [tenantId, facilityId, decisionTime],
    );
    if (res.rowCount) {
      throw new BookingError("CONFIGURATION_CONFLICT", "Cannot perform operation while unexpired holds exist");
    }
  }

  private async bumpFacilityRevision(client: PoolClient, tenantId: UUID, facilityId: UUID, nextRev: number, decisionTime: Date): Promise<void> {
    await client.query(
      "UPDATE facilities SET configuration_revision = $3, updated_at = $4 WHERE tenant_id = $1 AND id = $2",
      [tenantId, facilityId, nextRev, decisionTime],
    );
  }

  private async loadHoldItems(client: PoolClient, tenantId: UUID, holdId: UUID) {
    const res = await client.query<ItemRow>(
      "SELECT * FROM hold_items WHERE tenant_id = $1 AND hold_id = $2 ORDER BY starts_at ASC",
      [tenantId, holdId],
    );
    return res.rows.map(toReservationItem);
  }

  private async loadBookingItems(client: PoolClient, tenantId: UUID, bookingId: UUID) {
    const res = await client.query<ItemRow>(
      "SELECT * FROM booking_items WHERE tenant_id = $1 AND booking_id = $2 ORDER BY starts_at ASC",
      [tenantId, bookingId],
    );
    return res.rows.map(toReservationItem);
  }

  private async loadBookingSummary(client: PoolClient, tenantId: UUID, bookingId: UUID): Promise<BookingSummary> {
    const res = await client.query<BookingRow>(
      "SELECT * FROM bookings WHERE tenant_id = $1 AND id = $2",
      [tenantId, bookingId],
    );
    const row = res.rows[0];
    if (!row) throw new BookingError("NOT_FOUND", "Booking was not found");
    const items = await this.loadBookingItems(client, tenantId, bookingId);
    return toBookingSummary(row, items);
  }

  private async claimIdempotency<T>(
    client: PoolClient,
    tenantId: UUID,
    callerNamespace: string,
    operation: string,
    key: string,
    requestHash: string,
  ): Promise<T | null> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${tenantId}:${callerNamespace}:${operation}:${key}`],
    );
    const decisionTime = await getDecisionTime(client);
    const existing = await client.query<{ request_hash: string; response_json: T; expires_at: Date | string }>(
      `SELECT request_hash, response_json, expires_at FROM idempotency_records
       WHERE tenant_id = $1 AND caller_namespace = $2 AND operation = $3 AND idempotency_key = $4`,
      [tenantId, callerNamespace, operation, key],
    );
    const row = existing.rows[0];
    if (!row) return null;
    if (asDate(row.expires_at).getTime() <= decisionTime.getTime()) {
      await client.query(
        `DELETE FROM idempotency_records
         WHERE tenant_id = $1 AND caller_namespace = $2 AND operation = $3 AND idempotency_key = $4`,
        [tenantId, callerNamespace, operation, key],
      );
      return null;
    }
    if (row.request_hash !== requestHash) {
      throw new BookingError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency key was already used with a different semantic request");
    }
    return row.response_json;
  }

  private async storeIdempotency(
    client: PoolClient,
    tenantId: UUID,
    callerNamespace: string,
    operation: string,
    key: string,
    requestHash: string,
    response: unknown,
    decisionTime: Date,
  ): Promise<void> {
    const expiresAt = new Date(decisionTime.getTime() + this.options.idempotencyRetentionDays * 86_400_000);
    await client.query(
      `INSERT INTO idempotency_records (
         tenant_id, caller_namespace, operation, idempotency_key, request_hash, response_json, created_at, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       ON CONFLICT (tenant_id, caller_namespace, operation, idempotency_key) DO NOTHING`,
      [tenantId, callerNamespace, operation, key, requestHash, JSON.stringify(response), decisionTime, expiresAt],
    );
  }

  private hydrateHoldResult(raw: HoldResult): HoldResult {
    return {
      ...raw,
      expiresAt: asDate(raw.expiresAt),
      expiredRecordedAt: raw.expiredRecordedAt ? asDate(raw.expiredRecordedAt) : null,
      quoteCreatedAt: asDate(raw.quoteCreatedAt),
      startsAt: asDate(raw.startsAt),
      endsAt: asDate(raw.endsAt),
      occupiedFrom: asDate(raw.occupiedFrom),
      occupiedUntil: asDate(raw.occupiedUntil),
      createdAt: asDate(raw.createdAt),
      updatedAt: asDate(raw.updatedAt),
      items: raw.items.map((item) => ({ ...item, startsAt: asDate(item.startsAt), endsAt: asDate(item.endsAt) })),
    };
  }

  private hydrateBookingSummary(raw: BookingSummary): BookingSummary {
    return {
      ...raw,
      startsAt: asDate(raw.startsAt),
      endsAt: asDate(raw.endsAt),
      occupiedFrom: asDate(raw.occupiedFrom),
      occupiedUntil: asDate(raw.occupiedUntil),
      cancelledAt: raw.cancelledAt ? asDate(raw.cancelledAt) : null,
      completedAt: raw.completedAt ? asDate(raw.completedAt) : null,
      noShowAt: raw.noShowAt ? asDate(raw.noShowAt) : null,
      createdAt: asDate(raw.createdAt),
      updatedAt: asDate(raw.updatedAt),
      items: raw.items.map((item) => ({ ...item, startsAt: asDate(item.startsAt), endsAt: asDate(item.endsAt) })),
    };
  }

  private async readSnapshot<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query(`SET LOCAL statement_timeout = '${this.options.statementTimeoutMs}ms'`);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      translatePgError(error);
    } finally {
      client.release();
    }
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.options.maxTransientRetries; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query(`SET LOCAL lock_timeout = '${this.options.lockTimeoutMs}ms'`);
        await client.query(`SET LOCAL statement_timeout = '${this.options.statementTimeoutMs}ms'`);
        const value = await work(client);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        lastError = error;
        if (isTransientPgError(error) && attempt < this.options.maxTransientRetries) {
          const jitterMs = 15 + Math.floor(Math.random() * 40 * attempt);
          await new Promise((resolve) => setTimeout(resolve, jitterMs));
          continue;
        }
        translatePgError(error);
      } finally {
        client.release();
      }
    }
    translatePgError(lastError);
  }
}

/** Convenience constructor for apps that supply DATABASE_URL. */
export function createBookingPool(connectionString: string | undefined = process.env.DATABASE_URL): Pool {
  if (!connectionString) throw new Error("DATABASE_URL is required to connect the booking engine");
  return new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
}

/** Parse local venue wall-clock input into a timezone-aware absolute instant. */
export function localStartToInstant(localDate: string, localTime: string, timeZone: string): Date {
  return resolveLocalDateTime(localDate, localTime, timeZone);
}

// Keep unused QueryResultRow import suppressed cleanly if needed
export type { QueryResultRow };
