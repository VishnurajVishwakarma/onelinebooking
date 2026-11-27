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
  type Capability,
} from "../../src/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
let pool: Pool | null = null;
let dbAvailable = false;

if (DATABASE_URL) {
  const candidate = createBookingPool(DATABASE_URL, { max: 20 });
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

const adminCtx = (tenantId: string) => ({
  tenantId,
  actor: { id: "corr-admin", type: "admin" as const, capabilities: ALL_ADMIN_CAPABILITIES },
  correlationId: randomUUID(),
});

const customerCtx = (tenantId: string, customerId: string) => ({
  tenantId,
  actor: { id: `u-${customerId}`, type: "customer" as const, customerId, capabilities: DEFAULT_CUSTOMER_CAPABILITIES },
  correlationId: randomUUID(),
});

describe("Phase 5C: Correctness audit, error precedence, races & authorization", { skip: !dbAvailable }, () => {
  let store: PostgresBookingStore;
  let engine: TimeSlotEngine;

  before(() => {
    store = new PostgresBookingStore(pool!);
    engine = new TimeSlotEngine(store);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  async function setupFacility(tenantId: string, maxActiveHoldsPerCustomer = 3, maxSlotsPerBooking = 2) {
    const admin = engine.forTenant(adminCtx(tenantId));
    const fac = await admin.createFacility({ name: "Audit Court", category: "turf", timeZone: "Asia/Kolkata" });
    const effectiveFrom = DateTime.now().setZone("Asia/Kolkata").toISODate()!;
    await admin.setSchedule(
      fac.id,
      Array.from({ length: 7 }, (_, i) => ({
        weekday: i + 1,
        opensAt: "06:00",
        closesAt: "23:00",
        endDayOffset: 0 as const,
        effectiveFrom,
        effectiveUntil: null,
        breaks: [],
      })),
    );
    await admin.setSlotPolicy(fac.id, {
      durationMinutes: 60,
      intervalMinutes: 60,
      minNoticeMinutes: 0,
      maxAdvanceDays: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      maxSlotsPerBooking,
      defaultHoldMinutes: 5,
      maxActiveHoldsPerCustomer,
    });
    await admin.setPricing({ facilityId: fac.id, amountMinor: 10000, currency: "INR" });
    return { admin, fac };
  }

  it("preserves exact error precedence in fastPrecheckOrReplay and protects cross-customer idempotency keys", async () => {
    const tenant = await engine.createTenant({ name: `Precheck ${randomUUID()}` });
    const { admin, fac } = await setupFacility(tenant.id, 5, 2);
    const day = DateTime.now().setZone("Asia/Kolkata").plus({ days: 3 }).toISODate()!;
    const avail = await admin.getAvailability({ facilityIds: [fac.id], localDate: day });

    // Occupy slot 0
    const cust1 = engine.forTenant(customerCtx(tenant.id, "cust_1"));
    const cust2 = engine.forTenant(customerCtx(tenant.id, "cust_2"));
    const key1 = `k-${randomUUID()}`;
    await cust1.createHold({ facilityId: fac.id, slotRefs: [avail.slots[0]!.slotRef] }, { idempotencyKey: key1 });

    // 1. Duplicate occupied slot -> INVALID_SLOT_SELECTION (not SLOT_CONFLICT)
    await assert.rejects(
      () => cust2.createHold({ facilityId: fac.id, slotRefs: [avail.slots[0]!.slotRef, avail.slots[0]!.slotRef] }, { idempotencyKey: `dup-${randomUUID()}` }),
      (e: unknown) => e instanceof BookingError && e.code === "INVALID_SLOT_SELECTION",
    );

    // 2. Noncontiguous slots starting on occupied slot -> INVALID_SLOT_SELECTION
    await assert.rejects(
      () => cust2.createHold({ facilityId: fac.id, slotRefs: [avail.slots[0]!.slotRef, avail.slots[2]!.slotRef] }, { idempotencyKey: `gap-${randomUUID()}` }),
      (e: unknown) => e instanceof BookingError && e.code === "INVALID_SLOT_SELECTION",
    );

    // 3. Exceeding maxSlotsPerBooking (2) starting on occupied slot -> INVALID_SLOT_SELECTION
    await assert.rejects(
      () => cust2.createHold({ facilityId: fac.id, slotRefs: [avail.slots[0]!.slotRef, avail.slots[1]!.slotRef, avail.slots[2]!.slotRef] }, { idempotencyKey: `max-${randomUUID()}` }),
      (e: unknown) => e instanceof BookingError && e.code === "INVALID_SLOT_SELECTION",
    );

    // 4. Customer 2 probing Customer 1's idempotencyKey with a DIFFERENT payload -> FORBIDDEN (no key existence/conflict leak!)
    await assert.rejects(
      () => cust2.createHold({ facilityId: fac.id, slotRefs: [avail.slots[5]!.slotRef] }, { idempotencyKey: key1 }),
      (e: unknown) => e instanceof BookingError && e.code === "FORBIDDEN",
    );

    // 5. Ambiguous commit / lost response retry with identical key returns exact hold without new allocation
    const replay = await cust1.createHold({ facilityId: fac.id, slotRefs: [avail.slots[0]!.slotRef] }, { idempotencyKey: key1 });
    assert.equal(replay.externalCustomerId, "cust_1");
  });

  it("enforces FOR UPDATE vs FOR SHARE isolation during simultaneous config edits and blackouts", async () => {
    const tenant = await engine.createTenant({ name: `ConfigRace ${randomUUID()}` });
    const { admin, fac } = await setupFacility(tenant.id, 100, 6);
    const day = DateTime.now().setZone("Asia/Kolkata").plus({ days: 4 }).toISODate()!;
    const avail = await admin.getAvailability({ facilityIds: [fac.id], localDate: day });

    // Race 20 holds across distinct slots simultaneously with a schedule/pricing/blackout edit
    const holdPromises = avail.slots.slice(0, 15).map((slot, i) =>
      engine.forTenant(customerCtx(tenant.id, `cr_${i}`)).createHold(
        { facilityId: fac.id, slotRefs: [slot.slotRef] },
        { idempotencyKey: `cr-${i}-${randomUUID()}` },
      ),
    );
    const blackoutPromise = admin.createBlackout({
      facilityId: fac.id,
      startsAt: avail.slots[5]!.startsAt.toISOString(),
      endsAt: avail.slots[6]!.endsAt.toISOString(),
      reason: "concurrent maintenance",
    });

    const [holdResults, blackoutResult] = await Promise.all([Promise.allSettled(holdPromises), Promise.allSettled([blackoutPromise])]);
    const bRes = blackoutResult[0]!;

    // Invariant: if blackout succeeded, ZERO holds on slots 5 or 6 succeeded; if slot 5/6 hold succeeded, blackout failed with CONFIGURATION_CONFLICT
    const slot5Or6Held = holdResults[5]!.status === "fulfilled" || holdResults[6]!.status === "fulfilled";
    if (bRes.status === "fulfilled") {
      assert.equal(slot5Or6Held, false, "Blackout succeeded alongside overlapping hold!");
    } else {
      assert.ok(bRes.reason instanceof BookingError && bRes.reason.code === "CONFIGURATION_CONFLICT");
    }
  });

  it("enforces per-customer active hold limit strictly under FOR SHARE without blocking other customers", async () => {
    const tenant = await engine.createTenant({ name: `CustGuard ${randomUUID()}` });
    const { admin, fac } = await setupFacility(tenant.id, 3, 2);
    const day = DateTime.now().setZone("Asia/Kolkata").plus({ days: 5 }).toISODate()!;
    const avail = await admin.getAvailability({ facilityIds: [fac.id], localDate: day });

    const custA = engine.forTenant(customerCtx(tenant.id, "greedy_A"));
    const custB = engine.forTenant(customerCtx(tenant.id, "normal_B"));

    // Customer A floods 10 different slots simultaneously (limit = 3); Customer B books 3 distinct slots concurrently
    const [resA, resB] = await Promise.all([
      Promise.allSettled(
        avail.slots.slice(0, 10).map((s, i) =>
          custA.createHold({ facilityId: fac.id, slotRefs: [s.slotRef] }, { idempotencyKey: `ga-${i}-${randomUUID()}` }),
        ),
      ),
      Promise.all(
        avail.slots.slice(10, 13).map((s, i) =>
          custB.createHold({ facilityId: fac.id, slotRefs: [s.slotRef] }, { idempotencyKey: `nb-${i}-${randomUUID()}` }),
        ),
      ),
    ]);

    assert.equal(resA.filter((r) => r.status === "fulfilled").length, 3);
    assert.equal(
      resA.filter((r) => r.status === "rejected" && r.reason instanceof BookingError && r.reason.code === "HOLD_LIMIT_EXCEEDED").length,
      7,
    );
    assert.equal(resB.length, 3);
  });

  it("reclaims expired holds under concurrent FOR SHARE contention with exactly 1 winner", async () => {
    const tenant = await engine.createTenant({ name: `ExpReclaim ${randomUUID()}` });
    const { admin, fac } = await setupFacility(tenant.id, 10, 2);
    const day = DateTime.now().setZone("Asia/Kolkata").plus({ days: 6 }).toISODate()!;
    const avail = await admin.getAvailability({ facilityIds: [fac.id], localDate: day });
    const targetSlot = avail.slots[2]!;

    const oldHold = await admin.createHold(
      { facilityId: fac.id, slotRefs: [targetSlot.slotRef], externalCustomerId: "old_c" },
      { idempotencyKey: `old-${randomUUID()}` },
    );
    await pool!.query(`UPDATE holds SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [oldHold.id]);
    await pool!.query(`UPDATE allocations SET expires_at = clock_timestamp() - interval '1 second' WHERE hold_id = $1`, [oldHold.id]);

    const race = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        engine.forTenant(customerCtx(tenant.id, `reclaim_${i}`)).createHold(
          { facilityId: fac.id, slotRefs: [targetSlot.slotRef] },
          { idempotencyKey: `rec-${i}-${randomUUID()}` },
        ),
      ),
    );
    assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      race.filter((r) => r.status === "rejected" && r.reason instanceof BookingError && r.reason.code === "SLOT_CONFLICT").length,
      11,
    );
    const expiredOld = await admin.getHold(oldHold.id);
    assert.equal(expiredOld.state, "expired");
  });

  it("verifies tenant isolation and capability authorization across all public operations", async () => {
    const t1 = await engine.createTenant({ name: `Auth T1 ${randomUUID()}` });
    const t2 = await engine.createTenant({ name: `Auth T2 ${randomUUID()}` });
    const { admin: admin1, fac: fac1 } = await setupFacility(t1.id);
    const admin2 = engine.forTenant(adminCtx(t2.id));

    const day = DateTime.now().setZone("Asia/Kolkata").plus({ days: 6 }).toISODate()!;
    const avail1 = await admin1.getAvailability({ facilityIds: [fac1.id], localDate: day });
    const cust1 = engine.forTenant(customerCtx(t1.id, "owner_1"));
    const custOther = engine.forTenant(customerCtx(t1.id, "other_2"));

    const hold = await cust1.createHold({ facilityId: fac1.id, slotRefs: [avail1.slots[0]!.slotRef] }, { idempotencyKey: `auth-h-${randomUUID()}` });
    const booking = await admin1.createBooking(
      { facilityId: fac1.id, slotRefs: [avail1.slots[2]!.slotRef], externalCustomerId: "owner_1" },
      { idempotencyKey: `auth-b-${randomUUID()}` },
    );

    // Cross-tenant reads/mutations return NOT_FOUND (no cross-tenant existence leak)
    await assert.rejects(() => admin2.getFacility(fac1.id), (e: unknown) => e instanceof BookingError && e.code === "NOT_FOUND");
    await assert.rejects(() => admin2.getHold(hold.id), (e: unknown) => e instanceof BookingError && e.code === "NOT_FOUND");
    await assert.rejects(() => admin2.getBooking(booking.id), (e: unknown) => e instanceof BookingError && e.code === "NOT_FOUND");
    await assert.rejects(() => admin2.cancelBooking({ bookingId: booking.id }), (e: unknown) => e instanceof BookingError && e.code === "NOT_FOUND");

    // Cross-customer reads/mutations within same tenant return FORBIDDEN
    await assert.rejects(() => custOther.getHold(hold.id), (e: unknown) => e instanceof BookingError && e.code === "FORBIDDEN");
    await assert.rejects(() => custOther.releaseHold(hold.id), (e: unknown) => e instanceof BookingError && e.code === "FORBIDDEN");
    await assert.rejects(() => custOther.getBooking(booking.id), (e: unknown) => e instanceof BookingError && e.code === "FORBIDDEN");
    await assert.rejects(() => custOther.cancelBooking({ bookingId: booking.id }), (e: unknown) => e instanceof BookingError && e.code === "FORBIDDEN");

    // Capability checks reject unauthorized actor roles synchronously
    const readOnly = engine.forTenant({
      tenantId: t1.id,
      actor: { id: "viewer", type: "staff", capabilities: ["facility:read", "availability:read"] as readonly Capability[] },
    });
    assert.throws(() => readOnly.createFacility({ name: "X", category: "c", timeZone: "UTC" }), (e: unknown) => e instanceof BookingError && e.code === "FORBIDDEN");
    assert.throws(() => readOnly.createBooking({ facilityId: fac1.id, slotRefs: [avail1.slots[3]!.slotRef] }, { idempotencyKey: "x" }), (e: unknown) => e instanceof BookingError && e.code === "FORBIDDEN");
    assert.throws(() => readOnly.getBookingHistory("booking", booking.id), (e: unknown) => e instanceof BookingError && e.code === "FORBIDDEN");
  });
});
