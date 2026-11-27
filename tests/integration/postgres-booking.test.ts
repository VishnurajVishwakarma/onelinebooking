import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { DateTime } from "luxon";
import type { Pool } from "pg";
import {
  ALL_ADMIN_CAPABILITIES,
  BookingError,
  createBookingPool,
  DEFAULT_CUSTOMER_CAPABILITIES,
  PostgresBookingStore,
  runMigrations,
  TimeSlotEngine,
} from "../../src/index.js";

const DATABASE_URL = process.env.DATABASE_URL;

let pool: Pool | null = null;
let dbAvailable = false;

if (DATABASE_URL) {
  const candidate = createBookingPool(DATABASE_URL);
  let connected = false;
  try {
    await candidate.query("SELECT 1");
    connected = true;
  } catch {
    await candidate.end().catch(() => {});
  }
  if (connected) {
    await runMigrations(candidate);
    pool = candidate;
    dbAvailable = true;
  }
}

function makeAdminCtx(tenantId: string) {
  return {
    tenantId,
    actor: {
      id: "admin-1",
      type: "admin" as const,
      capabilities: ALL_ADMIN_CAPABILITIES,
    },
    correlationId: randomUUID(),
  };
}

function makeCustomerCtx(tenantId: string, customerId: string) {
  return {
    tenantId,
    actor: {
      id: `user-${customerId}`,
      type: "customer" as const,
      customerId,
      capabilities: DEFAULT_CUSTOMER_CAPABILITIES,
    },
    correlationId: randomUUID(),
  };
}

describe("PostgreSQL integration and concurrency matrix (§14.2 & §14.3)", { skip: !dbAvailable }, () => {
  let store: PostgresBookingStore;
  let engine: TimeSlotEngine;

  before(() => {
    store = new PostgresBookingStore(pool!);
    engine = new TimeSlotEngine(store);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  async function setupFacility(opts?: {
    durationMinutes?: number;
    intervalMinutes?: number;
    bufferBeforeMinutes?: number;
    bufferAfterMinutes?: number;
    maxActiveHoldsPerCustomer?: number;
  }) {
    const tenant = await engine.createTenant({ name: `Test Tenant ${randomUUID()}` });
    const admin = engine.forTenant(makeAdminCtx(tenant.id));
    const facility = await admin.createFacility({
      name: "Court A",
      category: "turf",
      timeZone: "Asia/Kolkata",
    });
    const effectiveFrom = DateTime.now().setZone("Asia/Kolkata").toISODate()!;
    await admin.setSchedule(
      facility.id,
      Array.from({ length: 7 }, (_, idx) => ({
        weekday: idx + 1,
        opensAt: "06:00",
        closesAt: "23:00",
        endDayOffset: 0,
        effectiveFrom,
        effectiveUntil: null,
        breaks: [],
      })),
    );
    await admin.setSlotPolicy(facility.id, {
      durationMinutes: opts?.durationMinutes ?? 60,
      intervalMinutes: opts?.intervalMinutes ?? 60,
      minNoticeMinutes: 0,
      maxAdvanceDays: 30,
      bufferBeforeMinutes: opts?.bufferBeforeMinutes ?? 0,
      bufferAfterMinutes: opts?.bufferAfterMinutes ?? 0,
      maxSlotsPerBooking: 6,
      defaultHoldMinutes: 5,
      maxActiveHoldsPerCustomer: opts?.maxActiveHoldsPerCustomer ?? 3,
    });
    await admin.setPricing({ facilityId: facility.id, amountMinor: 25000, currency: "INR" });
    await admin.setCancellationPolicy({
      facilityId: facility.id,
      customerCancellationAllowed: true,
      minNoticeMinutes: 30,
      adminOverrideAllowed: true,
    });
    return { tenant, admin, facility };
  }

  it("runs full hold -> convert -> cancel -> history -> outbox lifecycle and snapshots prices", async () => {
    const { tenant, admin, facility } = await setupFacility();
    const tomorrow = DateTime.now().setZone("Asia/Kolkata").plus({ days: 2 }).toISODate()!;
    const avail = await admin.getAvailability({ facilityIds: [facility.id], localDate: tomorrow });
    const slot = avail.slots.find((s) => s.available)!;

    // Create hold
    const holdKey = `hold-${randomUUID()}`;
    const hold = await admin.createHold(
      {
        facilityId: facility.id,
        slotRefs: [slot.slotRef],
        externalCustomerId: "cust_1",
        expectedAmountMinor: 25000,
        expectedCurrency: "INR",
      },
      { idempotencyKey: holdKey },
    );

    // Price change does NOT invalidate active hold and does NOT reprice conversion
    await admin.setPricing({ facilityId: facility.id, amountMinor: 40000, currency: "INR" });
    const convertKey = `convert-${randomUUID()}`;
    const booking = await admin.convertHoldToBooking(
      { holdId: hold.id, expectedAmountMinor: 25000, expectedCurrency: "INR", externalPaymentRef: "pay_1" },
      { idempotencyKey: convertKey },
    );
    assert.equal(booking.totalMinor, 25000);
    assert.equal(booking.status, "confirmed");

    // Repeated conversion returns same booking without creating a second one
    const bookingReplay = await admin.convertHoldToBooking(
      { holdId: hold.id, expectedAmountMinor: 25000, expectedCurrency: "INR", externalPaymentRef: "pay_1" },
      { idempotencyKey: `convert-other-${randomUUID()}` },
    );
    assert.equal(bookingReplay.id, booking.id);

    // Cancel and verify history + outbox
    const cancelled = await admin.cancelBooking({ bookingId: booking.id, reason: "rain" });
    assert.equal(cancelled.status, "cancelled");

    const history = await admin.getBookingHistory("booking", booking.id);
    assert.ok(history.length >= 2);

    const bookingEventsRes = await pool!.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE tenant_id = $1 AND aggregate_id = $2 ORDER BY aggregate_sequence ASC`,
      [tenant.id, booking.id],
    );
    const eventTypes = bookingEventsRes.rows.map((r) => r.event_type);
    assert.deepEqual(eventTypes, ["booking.created", "booking.confirmed", "booking.cancelled"]);

    const claimed = await engine.claimEvents({ limit: 50, leaseSeconds: 30 });
    for (const ev of claimed.filter((e) => e.tenantId === tenant.id)) {
      await engine.ackEvent(ev.id, ev.leaseToken!);
    }

    // Tenant isolation: another tenant cannot read booking
    const otherTenant = await engine.createTenant({ name: "Other Tenant" });
    const otherAdmin = engine.forTenant(makeAdminCtx(otherTenant.id));
    await assert.rejects(
      () => otherAdmin.getBooking(booking.id),
      (err: unknown) => err instanceof BookingError && err.code === "NOT_FOUND",
    );

    // Forged cross-tenant DB insert rejected by composite FK
    await assert.rejects(
      () => pool!.query(
        `INSERT INTO facility_blocks(tenant_id, facility_id, starts_at, ends_at, reason)
         VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days', 'forged')`,
        [otherTenant.id, facility.id],
      ),
    );
    void tenant;
  });

  it("enforces configuration conflict safety and blackout overlap checks (§5)", async () => {
    const { admin, facility } = await setupFacility();
    const tomorrow = DateTime.now().setZone("Asia/Kolkata").plus({ days: 2 }).toISODate()!;
    const avail = await admin.getAvailability({ facilityIds: [facility.id], localDate: tomorrow });
    const slot = avail.slots[2]!;

    const hold = await admin.createHold(
      { facilityId: facility.id, slotRefs: [slot.slotRef], externalCustomerId: "cust_cfg" },
      { idempotencyKey: `hold-${randomUUID()}` },
    );

    // Schedule edit conflicting with active hold is rejected
    await assert.rejects(
      () => admin.setScheduleException({ facilityId: facility.id, businessDate: tomorrow, windows: [] }),
      (err: unknown) => err instanceof BookingError && err.code === "CONFIGURATION_CONFLICT",
    );

    // Blackout overlapping active hold is rejected
    await assert.rejects(
      () => admin.createBlackout({
        facilityId: facility.id,
        startsAt: slot.startsAt.toISOString(),
        endsAt: slot.endsAt.toISOString(),
        reason: "maintenance",
      }),
      (err: unknown) => err instanceof BookingError && err.code === "CONFIGURATION_CONFLICT",
    );

    // Deactivation with active hold is rejected
    await assert.rejects(
      () => admin.deactivateFacility(facility.id),
      (err: unknown) => err instanceof BookingError && err.code === "CONFIGURATION_CONFLICT",
    );

    // Convert hold, then closing date produces warning without cancelling booking
    const booking = await admin.convertHoldToBooking({ holdId: hold.id }, { idempotencyKey: `c-${randomUUID()}` });
    const excRes = await admin.setScheduleException({ facilityId: facility.id, businessDate: tomorrow, windows: [] });
    assert.ok(excRes.warnings.some((w) => w.bookingId === booking.id));
  });

  it("concurrency matrix: only 1 of 10 simultaneous hold requests wins same slot", async () => {
    const { tenant, admin, facility } = await setupFacility();
    const tomorrow = DateTime.now().setZone("Asia/Kolkata").plus({ days: 3 }).toISODate()!;
    const avail = await admin.getAvailability({ facilityIds: [facility.id], localDate: tomorrow });
    const slot = avail.slots[4]!;

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, idx) => {
        const customer = engine.forTenant(makeCustomerCtx(tenant.id, `cust_${idx}`));
        return customer.createHold(
          { facilityId: facility.id, slotRefs: [slot.slotRef] },
          { idempotencyKey: `race-${idx}-${randomUUID()}` },
        );
      }),
    );

    const successes = results.filter((r) => r.status === "fulfilled");
    const conflicts = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof BookingError && r.reason.code === "SLOT_CONFLICT",
    );
    assert.equal(successes.length, 1);
    assert.equal(conflicts.length, 9);
  });

  it("concurrency matrix: overlapping buffers reject second adjacent hold, zero buffers allow both", async () => {
    // 1. With 15m buffers
    const buffered = await setupFacility({ bufferBeforeMinutes: 15, bufferAfterMinutes: 15 });
    const day = DateTime.now().setZone("Asia/Kolkata").plus({ days: 3 }).toISODate()!;
    const bAvail = await buffered.admin.getAvailability({ facilityIds: [buffered.facility.id], localDate: day });
    const b1 = bAvail.slots[3]!;
    const b2 = bAvail.slots[4]!;

    const bRace = await Promise.allSettled([
      buffered.admin.createHold(
        { facilityId: buffered.facility.id, slotRefs: [b1.slotRef], externalCustomerId: "a" },
        { idempotencyKey: `b1-${randomUUID()}` },
      ),
      buffered.admin.createHold(
        { facilityId: buffered.facility.id, slotRefs: [b2.slotRef], externalCustomerId: "b" },
        { idempotencyKey: `b2-${randomUUID()}` },
      ),
    ]);
    assert.equal(bRace.filter((r) => r.status === "fulfilled").length, 1);

    // 2. With 0m buffers
    const zeroBuf = await setupFacility({ bufferBeforeMinutes: 0, bufferAfterMinutes: 0 });
    const zAvail = await zeroBuf.admin.getAvailability({ facilityIds: [zeroBuf.facility.id], localDate: day });
    const z1 = zAvail.slots[3]!;
    const z2 = zAvail.slots[4]!;

    const zRace = await Promise.allSettled([
      zeroBuf.admin.createHold(
        { facilityId: zeroBuf.facility.id, slotRefs: [z1.slotRef], externalCustomerId: "a" },
        { idempotencyKey: `z1-${randomUUID()}` },
      ),
      zeroBuf.admin.createHold(
        { facilityId: zeroBuf.facility.id, slotRefs: [z2.slotRef], externalCustomerId: "b" },
        { idempotencyKey: `z2-${randomUUID()}` },
      ),
    ]);
    assert.equal(zRace.filter((r) => r.status === "fulfilled").length, 2);
  });

  it("concurrency matrix: concurrent identical idempotency keys serialize and mismatched payload conflicts", async () => {
    const { admin, facility } = await setupFacility();
    const day = DateTime.now().setZone("Asia/Kolkata").plus({ days: 3 }).toISODate()!;
    const avail = await admin.getAvailability({ facilityIds: [facility.id], localDate: day });
    const slot = avail.slots[2]!;
    const sameKey = `idem-${randomUUID()}`;

    const parallel = await Promise.all(
      Array.from({ length: 5 }, () =>
        admin.createHold(
          { facilityId: facility.id, slotRefs: [slot.slotRef], externalCustomerId: "cust_idem" },
          { idempotencyKey: sameKey },
        ),
      ),
    );
    const uniqueIds = new Set(parallel.map((h) => h.id));
    assert.equal(uniqueIds.size, 1);

    // Different payload with same key -> IDEMPOTENCY_KEY_CONFLICT
    await assert.rejects(
      () => admin.createHold(
        { facilityId: facility.id, slotRefs: [avail.slots[5]!.slotRef], externalCustomerId: "cust_idem" },
        { idempotencyKey: sameKey },
      ),
      (err: unknown) => err instanceof BookingError && err.code === "IDEMPOTENCY_KEY_CONFLICT",
    );
  });

  it("concurrency matrix: customer active hold limit never exceeded under race", async () => {
    const { tenant, admin, facility } = await setupFacility({ maxActiveHoldsPerCustomer: 2 });
    const day = DateTime.now().setZone("Asia/Kolkata").plus({ days: 3 }).toISODate()!;
    const avail = await admin.getAvailability({ facilityIds: [facility.id], localDate: day });
    const customer = engine.forTenant(makeCustomerCtx(tenant.id, "abuser_1"));

    const race = await Promise.allSettled(
      avail.slots.slice(2, 7).map((s) =>
        customer.createHold(
          { facilityId: facility.id, slotRefs: [s.slotRef] },
          { idempotencyKey: `abuse-${randomUUID()}` },
        ),
      ),
    );
    assert.equal(race.filter((r) => r.status === "fulfilled").length, 2);
    assert.ok(
      race.some((r) => r.status === "rejected" && r.reason instanceof BookingError && r.reason.code === "HOLD_LIMIT_EXCEEDED"),
    );
  });
});

