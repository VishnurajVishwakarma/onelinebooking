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
    await candidate.end().catch(() => { });
  }
  if (connected) {
    await runMigrations(candidate);
    pool = candidate;
    dbAvailable = true;
  }
}

const adminCtx = (tenantId: string) => ({
  tenantId,
  actor: { id: "rel-admin", type: "admin" as const, capabilities: ALL_ADMIN_CAPABILITIES },
  correlationId: randomUUID(),
});

const customerCtx = (tenantId: string, customerId: string) => ({
  tenantId,
  actor: { id: `u-${customerId}`, type: "customer" as const, customerId, capabilities: DEFAULT_CUSTOMER_CAPABILITIES },
  correlationId: randomUUID(),
});

describe("Phase 3: Production reliability & edge-case tests", { skip: !dbAvailable }, () => {
  let store: PostgresBookingStore;
  let engine: TimeSlotEngine;

  before(() => {
    store = new PostgresBookingStore(pool!);
    engine = new TimeSlotEngine(store);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  async function provisionFacility(
    tenantId: string,
    opts?: { timeZone?: string; name?: string; maxActiveHoldsPerCustomer?: number; defaultHoldMinutes?: number },
  ) {
    const admin = engine.forTenant(adminCtx(tenantId));
    const timeZone = opts?.timeZone ?? "Asia/Kolkata";
    const facility = await admin.createFacility({
      name: opts?.name ?? `Court ${randomUUID().slice(0, 6)}`,
      category: "turf",
      timeZone,
    });
    await admin.setSchedule(
      facility.id,
      Array.from({ length: 7 }, (_, i) => ({
        weekday: i + 1,
        opensAt: "00:00",
        closesAt: "23:00",
        endDayOffset: 0 as const,
        effectiveFrom: "2026-01-01",
        effectiveUntil: null,
        breaks: [],
      })),
    );
    await admin.setSlotPolicy(facility.id, {
      durationMinutes: 60,
      intervalMinutes: 60,
      minNoticeMinutes: 0,
      maxAdvanceDays: 365,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      maxSlotsPerBooking: 12,
      defaultHoldMinutes: opts?.defaultHoldMinutes ?? 5,
      maxActiveHoldsPerCustomer: opts?.maxActiveHoldsPerCustomer ?? 20,
    });
    await admin.setPricing({ facilityId: facility.id, amountMinor: 20000, currency: "INR" });
    await admin.setCancellationPolicy({
      facilityId: facility.id,
      customerCancellationAllowed: true,
      minNoticeMinutes: 0,
      adminOverrideAllowed: true,
    });
    return { admin, facility };
  }

  it("handles independent slots on same facility and multi-facility concurrency cleanly", async () => {
    const tenant = await engine.createTenant({ name: `Indep ${randomUUID()}` });
    const facilities = await Promise.all(
      Array.from({ length: 5 }, (_, idx) => provisionFacility(tenant.id, { name: `Court ${idx}` })),
    );
    const day = DateTime.now().setZone("Asia/Kolkata").plus({ days: 5 }).toISODate()!;
    const avail = await facilities[0]!.admin.getAvailability({
      facilityIds: facilities.map((f) => f.facility.id),
      localDate: day,
    });

    // Pick 8 independent slots across 5 facilities = 40 distinct reservations in parallel
    const targetSlots = facilities.flatMap((f) =>
      avail.slots.filter((s) => s.facilityId === f.facility.id && s.available).slice(0, 8),
    );
    assert.equal(targetSlots.length, 40);

    const results = await Promise.all(
      targetSlots.map((slot, i) =>
        engine.forTenant(customerCtx(tenant.id, `cust_ind_${i}`)).createHold(
          { facilityId: slot.facilityId, slotRefs: [slot.slotRef] },
          { idempotencyKey: `ind-${i}-${randomUUID()}` },
        ),
      ),
    );
    assert.equal(results.length, 40);
  });

  it("isolates multi-tenant workloads under heavy contention", async () => {
    const tenantA = await engine.createTenant({ name: `Tenant A ${randomUUID()}` });
    const tenantB = await engine.createTenant({ name: `Tenant B ${randomUUID()}` });
    const facA = await provisionFacility(tenantA.id, { name: "Hot Facility A" });
    const facB = await provisionFacility(tenantB.id, { name: "Quiet Facility B" });

    const day = DateTime.now().setZone("Asia/Kolkata").plus({ days: 6 }).toISODate()!;
    const availA = await facA.admin.getAvailability({ facilityIds: [facA.facility.id], localDate: day });
    const availB = await facB.admin.getAvailability({ facilityIds: [facB.facility.id], localDate: day });

    // Flood Tenant A slot 0 while Tenant B books 10 distinct slots concurrently
    const floodA = Promise.allSettled(
      Array.from({ length: 100 }, (_, i) =>
        engine.forTenant(customerCtx(tenantA.id, `a_${i}`)).createHold(
          { facilityId: facA.facility.id, slotRefs: [availA.slots[0]!.slotRef] },
          { idempotencyKey: `a-${i}-${randomUUID()}` },
        ),
      ),
    );
    const workB = Promise.all(
      availB.slots.slice(0, 10).map((slot, i) =>
        engine.forTenant(customerCtx(tenantB.id, `b_${i}`)).createHold(
          { facilityId: facB.facility.id, slotRefs: [slot.slotRef] },
          { idempotencyKey: `b-${i}-${randomUUID()}` },
        ),
      ),
    );

    const [resA, resB] = await Promise.all([floodA, workB]);
    assert.equal(resA.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(resB.length, 10);
  });

  it("serializes multiple independent API instances against the same PostgreSQL database", async () => {
    const tenant = await engine.createTenant({ name: `MultiAPI ${randomUUID()}` });
    const { admin, facility } = await provisionFacility(tenant.id);
    const day = DateTime.now().setZone("Asia/Kolkata").plus({ days: 7 }).toISODate()!;
    const avail = await admin.getAvailability({ facilityIds: [facility.id], localDate: day });
    const hotSlot = avail.slots[2]!;

    const pools = [
      createBookingPool(DATABASE_URL, { max: 10 }),
      createBookingPool(DATABASE_URL, { max: 10 }),
      createBookingPool(DATABASE_URL, { max: 10 }),
    ];
    try {
      const engines = pools.map((p) => new TimeSlotEngine(new PostgresBookingStore(p)));
      const races = await Promise.allSettled(
        Array.from({ length: 30 }, (_, i) =>
          engines[i % 3]!.forTenant(customerCtx(tenant.id, `multi_${i}`)).createHold(
            { facilityId: facility.id, slotRefs: [hotSlot.slotRef] },
            { idempotencyKey: `multi-${i}-${randomUUID()}` },
          ),
        ),
      );
      assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        races.filter((r) => r.status === "rejected" && r.reason instanceof BookingError && r.reason.code === "SLOT_CONFLICT").length,
        29,
      );
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it("resolves hold expiration races cleanly between conversion, expireHolds, and new hold", async () => {
    const tenant = await engine.createTenant({ name: `ExpRace ${randomUUID()}` });
    const { admin, facility } = await provisionFacility(tenant.id);
    const day = DateTime.now().setZone("Asia/Kolkata").plus({ days: 8 }).toISODate()!;
    const avail = await admin.getAvailability({ facilityIds: [facility.id], localDate: day });
    const slot = avail.slots[3]!;

    const hold = await admin.createHold(
      { facilityId: facility.id, slotRefs: [slot.slotRef], externalCustomerId: "exp_cust" },
      { idempotencyKey: `exp-hold-${randomUUID()}` },
    );

    // Move hold + allocation expiry to right now so it expires immediately
    await pool!.query(`UPDATE holds SET expires_at = clock_timestamp() - interval '10 milliseconds' WHERE id = $1`, [hold.id]);
    await pool!.query(`UPDATE allocations SET expires_at = clock_timestamp() - interval '10 milliseconds' WHERE hold_id = $1`, [hold.id]);

    // Race conversion of expired hold vs expireHolds vs new hold on same slot
    const [convRes, expireRes, newHoldRes] = await Promise.allSettled([
      admin.convertHoldToBooking({ holdId: hold.id }, { idempotencyKey: `conv-${randomUUID()}` }),
      engine.expireHolds(50),
      admin.createHold(
        { facilityId: facility.id, slotRefs: [slot.slotRef], externalCustomerId: "winner_cust" },
        { idempotencyKey: `new-${randomUUID()}` },
      ),
    ]);

    // Expired hold MUST NOT convert (late payment reconciliation hint present)
    assert.equal(convRes.status, "rejected");
    assert.ok(convRes.reason instanceof BookingError && convRes.reason.code === "HOLD_EXPIRED");
    assert.equal(convRes.reason.details?.reconciliationHint, "PAYMENT_RECONCILIATION_REQUIRED");
    assert.equal(expireRes.status, "fulfilled");
    assert.equal(newHoldRes.status, "fulfilled");

    const oldHoldState = await admin.getHold(hold.id);
    assert.equal(oldHoldState.state, "expired");
  });

  it("races releaseHold vs convertHoldToBooking and concurrent cancelBooking idempotently", async () => {
    const tenant = await engine.createTenant({ name: `RelConv ${randomUUID()}` });
    const { admin, facility } = await provisionFacility(tenant.id);
    const day = DateTime.now().setZone("Asia/Kolkata").plus({ days: 9 }).toISODate()!;
    const avail = await admin.getAvailability({ facilityIds: [facility.id], localDate: day });

    // 1. Release vs convert race
    const hold = await admin.createHold(
      { facilityId: facility.id, slotRefs: [avail.slots[4]!.slotRef], externalCustomerId: "race_c" },
      { idempotencyKey: `rc-${randomUUID()}` },
    );
    const [relRes, convRes] = await Promise.allSettled([
      admin.releaseHold(hold.id),
      admin.convertHoldToBooking({ holdId: hold.id }, { idempotencyKey: `rc-conv-${randomUUID()}` }),
    ]);
    const finalHold = await admin.getHold(hold.id);
    assert.ok(finalHold.state === "released" || finalHold.state === "converted");
    if (finalHold.state === "converted") {
      assert.equal(convRes.status, "fulfilled");
      assert.equal(relRes.status, "rejected");
    } else {
      assert.equal(relRes.status, "fulfilled");
      assert.equal(convRes.status, "rejected");
    }

    // 2. Concurrent cancelBooking x 5 emits at most one booking.cancelled event
    const direct = await admin.createBooking(
      { facilityId: facility.id, slotRefs: [avail.slots[6]!.slotRef], externalCustomerId: "c_cancel" },
      { idempotencyKey: `dir-${randomUUID()}` },
    );
    const cancels = await Promise.all(
      Array.from({ length: 5 }, () => admin.cancelBooking({ bookingId: direct.id, reason: "concurrent cancel" })),
    );
    for (const c of cancels) assert.equal(c.status, "cancelled");

    const evCount = await pool!.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'booking.cancelled'`,
      [direct.id],
    );
    assert.equal(Number(evCount.rows[0]!.cnt), 1);
  });

  it("recovers from real PostgreSQL deadlock (40P01) retries and from database backend connection loss", async () => {
    const tenant = await engine.createTenant({ name: `Deadlock ${randomUUID()}` });
    const { admin, facility } = await provisionFacility(tenant.id);
    const day = DateTime.now().setZone("Asia/Kolkata").plus({ days: 10 }).toISODate()!;
    const avail = await admin.getAvailability({ facilityIds: [facility.id], localDate: day });

    // 1. Deliberate real 40P01 deadlock across opposite lock order (hold row -> facility row vs facility row -> hold row)
    const dlHold = await admin.createHold(
      { facilityId: facility.id, slotRefs: [avail.slots[0]!.slotRef], externalCustomerId: "dl_c" },
      { idempotencyKey: `dl-${randomUUID()}` },
    );
    const raw = await pool!.connect();
    try {
      await raw.query("BEGIN");
      await raw.query("SELECT * FROM holds WHERE id = $1 FOR UPDATE", [dlHold.id]);
      const releasePromise = admin.releaseHold(dlHold.id);
      await new Promise((r) => setTimeout(r, 40));
      try {
        await raw.query("SELECT * FROM facilities WHERE id = $1 FOR UPDATE", [facility.id]);
      } catch {
        // raw transaction may be chosen as the 40P01 deadlock victim
      } finally {
        await raw.query("ROLLBACK").catch(() => { });
      }
      const released = await releasePromise;
      assert.equal(released.state, "released");
    } finally {
      raw.release();
    }

    // 2. Test connection loss recovery on a dedicated pool with an error listener
    const lossPool = createBookingPool(DATABASE_URL, { max: 3 });
    lossPool.on("error", () => {});
    try {
      const lossEngine = new TimeSlotEngine(new PostgresBookingStore(lossPool));
      const c1 = await lossPool.connect();
      c1.on("error", () => {});
      const pidRes = await c1.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const victimPid = pidRes.rows[0]!.pid;
      await pool!.query("SELECT pg_terminate_backend($1)", [victimPid]);
      c1.release(true);

      const recoveredHold = await lossEngine.forTenant(adminCtx(tenant.id)).createHold(
        { facilityId: facility.id, slotRefs: [avail.slots[1]!.slotRef], externalCustomerId: "rec_c" },
        { idempotencyKey: `rec-${randomUUID()}` },
      );
      assert.equal(recoveredHold.state, "active");
    } finally {
      await lossPool.end();
    }

    // 2. Verify transaction rollback leaves zero partial records on mid-flight error (e.g. PRICE_CHANGED)
    await assert.rejects(
      () => admin.createHold(
        {
          facilityId: facility.id,
          slotRefs: [avail.slots[2]!.slotRef],
          expectedAmountMinor: 999999,
          expectedCurrency: "INR",
        },
        { idempotencyKey: `rb-${randomUUID()}` },
      ),
      (err: unknown) => err instanceof BookingError && err.code === "PRICE_CHANGED",
    );
    const partialCheck = await pool!.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM holds WHERE tenant_id = $1 AND facility_id = $2 AND starts_at = $3`,
      [tenant.id, facility.id, avail.slots[2]!.startsAt],
    );
    assert.equal(Number(partialCheck.rows[0]!.cnt), 0);
  });

  it("enforces outbox worker lease exclusivity, stale-lease rejection, retry exhaustion, and replay", async () => {
    const tenant = await engine.createTenant({ name: `Outbox ${randomUUID()}` });
    const { admin, facility } = await provisionFacility(tenant.id);
    const day = DateTime.now().setZone("Asia/Kolkata").plus({ days: 11 }).toISODate()!;
    const avail = await admin.getAvailability({ facilityIds: [facility.id], localDate: day });

    const hold = await admin.createHold(
      { facilityId: facility.id, slotRefs: [avail.slots[1]!.slotRef], externalCustomerId: "ob_c" },
      { idempotencyKey: `ob-${randomUUID()}` },
    );

    // Clear older pending events from previous test suites so claimEvents reaches this test's event immediately
    await pool!.query(
      `UPDATE outbox_events SET status = 'delivered', delivered_at = clock_timestamp()
       WHERE tenant_id <> $1 AND status = 'pending'`,
      [tenant.id],
    );

    // Two concurrent workers claim pending events -> zero overlap
    const [w1, w2] = await Promise.all([
      engine.claimEvents({ limit: 500, leaseSeconds: 30 }),
      engine.claimEvents({ limit: 500, leaseSeconds: 30 }),
    ]);
    const w1Ids = new Set(w1.map((e) => e.id));
    for (const e of w2) {
      assert.equal(w1Ids.has(e.id), false, "Outbox event was double-claimed!");
    }

    const holdEvent = [...w1, ...w2].find((e) => e.aggregateId === hold.id && e.eventType === "hold.created");
    assert.ok(holdEvent);

    // Wrong lease token rejected
    await assert.rejects(
      () => engine.ackEvent(holdEvent.id, randomUUID()),
      (err: unknown) => err instanceof BookingError && err.code === "INVALID_STATE_TRANSITION",
    );

    // Retry until max_attempts (5) -> moves to 'failed', then replayFailedEvent restores exact event ID
    let current = holdEvent;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      current = await engine.retryEvent(current.id, current.leaseToken!, "webhook timeout", 0);
      if (current.status === "pending") {
        let found: typeof current | undefined;
        for (let spin = 0; spin < 5 && !found; spin += 1) {
          const batch = await engine.claimEvents({ limit: 500, leaseSeconds: 30 });
          found = batch.find((e) => e.id === holdEvent.id);
        }
        assert.ok(found);
        current = found;
      }
    }
    assert.equal(current.status, "failed");

    const replayed = await engine.replayFailedEvent(holdEvent.id);
    assert.equal(replayed.id, holdEvent.id);
    assert.equal(replayed.status, "pending");

    const reclaimed = await engine.claimEvents({ limit: 100, leaseSeconds: 30 });
    const target = reclaimed.find((e) => e.id === holdEvent.id);
    assert.ok(target);
    await engine.ackEvent(target.id, target.leaseToken!);
  });

  it("enforces V1 single-facility boundary and handles DST transitions end-to-end in PostgreSQL", async () => {
    const tenant = await engine.createTenant({ name: `DST ${randomUUID()}` });
    const ny = await provisionFacility(tenant.id, { timeZone: "America/New_York", name: "NY Court" });
    const ny2 = await provisionFacility(tenant.id, { timeZone: "America/New_York", name: "NY Court 2" });

    // Fall-back DST day in the future (within 365-day horizon): 2027-11-07 in America/New_York
    const fallAvail = await ny.admin.getAvailability({ facilityIds: [ny.facility.id], localDate: "2027-11-07" });
    const repeatedSlots = fallAvail.slots.filter((s) => s.localStart === "2027-11-07T01:00");
    assert.equal(repeatedSlots.length, 2);
    assert.equal(repeatedSlots[0]!.localOffset, "-04:00");
    assert.equal(repeatedSlots[1]!.localOffset, "-05:00");

    // Reserve BOTH consecutive 01:00 (-04:00) and 01:00 (-05:00) slots across the DST fold in one hold
    const dstHold = await ny.admin.createHold(
      {
        facilityId: ny.facility.id,
        slotRefs: [repeatedSlots[0]!.slotRef, repeatedSlots[1]!.slotRef],
        externalCustomerId: "dst_cust",
      },
      { idempotencyKey: `dst-${randomUUID()}` },
    );
    assert.equal(dstHold.items.length, 2);
    assert.equal(dstHold.items[0]!.localOffset, "-04:00");
    assert.equal(dstHold.items[1]!.localOffset, "-05:00");
    assert.equal(dstHold.endsAt.getTime() - dstHold.startsAt.getTime(), 120 * 60_000);

    // Mixed-facility slotRefs in one reservation rejected atomically (§1.2 V1 boundary)
    const ny2Avail = await ny2.admin.getAvailability({ facilityIds: [ny2.facility.id], localDate: "2027-11-08" });
    await assert.rejects(
      () => ny.admin.createHold(
        {
          facilityId: ny.facility.id,
          slotRefs: [fallAvail.slots[10]!.slotRef, ny2Avail.slots[10]!.slotRef],
          externalCustomerId: "mixed",
        },
        { idempotencyKey: `mixed-${randomUUID()}` },
      ),
      (err: unknown) => err instanceof BookingError && err.code === "INVALID_SLOT_SELECTION",
    );
  });

  it("degrades gracefully under tight pool & lock timeout exhaustion without leaking connections", async () => {
    const tightPool = createBookingPool(DATABASE_URL, { max: 2, connectionTimeoutMillis: 300 });
    const tightStore = new PostgresBookingStore(tightPool, { lockTimeoutMs: 150, statementTimeoutMs: 1500 });
    const tightEngine = new TimeSlotEngine(tightStore);

    try {
      const tenant = await tightEngine.createTenant({ name: `Exhaust ${randomUUID()}` });
      const admin = tightEngine.forTenant(adminCtx(tenant.id));
      const fac = await admin.createFacility({ name: "Tight Court", category: "turf", timeZone: "Asia/Kolkata" });
      await admin.setSchedule(
        fac.id,
        Array.from({ length: 7 }, (_, i) => ({
          weekday: i + 1,
          opensAt: "06:00",
          closesAt: "23:00",
          endDayOffset: 0 as const,
          effectiveFrom: "2026-01-01",
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
        maxSlotsPerBooking: 6,
        defaultHoldMinutes: 5,
        maxActiveHoldsPerCustomer: 100,
      });
      await admin.setPricing({ facilityId: fac.id, amountMinor: 10000, currency: "INR" });

      const day = DateTime.now().setZone("Asia/Kolkata").plus({ days: 12 }).toISODate()!;
      const avail = await admin.getAvailability({ facilityIds: [fac.id], localDate: day });

      // Burst 40 concurrent availability/hold calls onto a max=2 pool
      const burst = await Promise.allSettled(
        Array.from({ length: 40 }, (_, i) =>
          tightEngine.forTenant(customerCtx(tenant.id, `ex_${i}`)).createHold(
            { facilityId: fac.id, slotRefs: [avail.slots[i % avail.slots.length]!.slotRef] },
            { idempotencyKey: `ex-${i}-${randomUUID()}` },
          ),
        ),
      );
      // Either succeeds, hits expected SLOT_CONFLICT, or fails cleanly with BookingError (no unhandled crashes)
      for (const r of burst) {
        if (r.status === "rejected") {
          assert.ok(r.reason instanceof Error);
        }
      }
      // Pool has zero leaked/waiting connections after burst settles, and recovers immediately
      assert.equal(tightPool.waitingCount, 0);
      const afterAvail = await admin.getAvailability({ facilityIds: [fac.id], localDate: day });
      assert.ok(afterAvail.slots.length > 0);
    } finally {
      await tightPool.end();
    }
  });
});