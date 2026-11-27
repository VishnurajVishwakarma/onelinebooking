import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DateTime } from "luxon";
import {
  ALL_ADMIN_CAPABILITIES,
  BookingError,
  createBookingPool,
  DEFAULT_CUSTOMER_CAPABILITIES,
  PostgresBookingStore,
  runMigrations,
  TimeSlotEngine,
  type Facility,
} from "../src/index.js";

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!.toFixed(2));
}

async function runConcurrent<T>(items: T[], concurrency: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      await fn(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
}

const pool = createBookingPool(process.env.DATABASE_URL, { max: 50 });

try {
  await runMigrations(pool);
  const store = new PostgresBookingStore(pool);
  const engine = new TimeSlotEngine(store);

  const tenant = await engine.createTenant({ name: `Bench10K ${randomUUID()}` });
  const admin = engine.forTenant({
    tenantId: tenant.id,
    actor: { id: "bench-admin", type: "admin", capabilities: ALL_ADMIN_CAPABILITIES },
  });

  // Create 10 independent facilities for independent-slot throughput benchmark
  const facilities: Facility[] = [];
  for (let f = 0; f < 10; f += 1) {
    const fac = await admin.createFacility({ name: `Bench Court ${f}`, category: "turf", timeZone: "Asia/Kolkata" });
    await admin.setSchedule(
      fac.id,
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
    await admin.setSlotPolicy(fac.id, {
      durationMinutes: 60,
      intervalMinutes: 60,
      minNoticeMinutes: 0,
      maxAdvanceDays: 365,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      maxSlotsPerBooking: 6,
      defaultHoldMinutes: 5,
      maxActiveHoldsPerCustomer: 100,
    });
    await admin.setPricing({ facilityId: fac.id, amountMinor: 25000, currency: "INR" });
    facilities.push(fac);
  }

  // ---- Benchmark A: 10,000-request single-slot contention at concurrency 50 ----
  const hotDate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 20 }).toISODate()!;
  const hotAvail = await admin.getAvailability({ facilityIds: [facilities[0]!.id], localDate: hotDate });
  const hotSlot = hotAvail.slots[5]!;

  const contentionOutcomes: Record<string, number> = { succeeded: 0 };
  const contentionLatencies: number[] = [];
  let maxWaitingPool = 0;
  const tContStart = performance.now();

  await runConcurrent(Array.from({ length: 10_000 }, (_, i) => i), 50, async (idx) => {
    if (pool.waitingCount > maxWaitingPool) maxWaitingPool = pool.waitingCount;
    const customer = engine.forTenant({
      tenantId: tenant.id,
      actor: { id: `u_${idx}`, type: "customer", customerId: `c10k_${idx}`, capabilities: DEFAULT_CUSTOMER_CAPABILITIES },
    });
    const r0 = performance.now();
    try {
      await customer.createHold(
        { facilityId: facilities[0]!.id, slotRefs: [hotSlot.slotRef] },
        { idempotencyKey: `c10k-${idx}-${randomUUID()}` },
      );
      contentionOutcomes.succeeded = (contentionOutcomes.succeeded ?? 0) + 1;
    } catch (error) {
      const code = error instanceof BookingError ? error.code : "UNEXPECTED_ERROR";
      contentionOutcomes[code] = (contentionOutcomes[code] ?? 0) + 1;
    } finally {
      contentionLatencies.push(performance.now() - r0);
    }
  });
  const contentionMs = performance.now() - tContStart;

  // ---- Benchmark B: 1,000-request independent-slot throughput across 10 facilities x 100 slots ----
  const fromDate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 21 }).toISODate()!;
  const toDate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 26 }).toISODate()!;
  const indepAvail = await admin.getAvailability({
    facilityIds: facilities.map((f) => f.id),
    fromDate,
    toDate,
  });
  // Interleave slots round-robin across all 10 facilities to measure true multi-facility independent throughput
  const byFacility = new Map<string, typeof indepAvail.slots>();
  for (const s of indepAvail.slots) {
    const arr = byFacility.get(s.facilityId) ?? [];
    arr.push(s);
    byFacility.set(s.facilityId, arr);
  }
  const distinctSlots: typeof indepAvail.slots = [];
  for (let round = 0; distinctSlots.length < 1000; round += 1) {
    let added = false;
    for (const fac of facilities) {
      const candidate = byFacility.get(fac.id)?.[round];
      if (candidate) {
        distinctSlots.push(candidate);
        added = true;
        if (distinctSlots.length >= 1000) break;
      }
    }
    if (!added) break;
  }
  assert.equal(distinctSlots.length, 1000);

  const indepOutcomes: Record<string, number> = { succeeded: 0 };
  const indepLatencies: number[] = [];
  const tIndepStart = performance.now();

  await runConcurrent(distinctSlots, 50, async (slot, idx) => {
    const customer = engine.forTenant({
      tenantId: tenant.id,
      actor: { id: `ui_${idx}`, type: "customer", customerId: `ci_${idx}`, capabilities: DEFAULT_CUSTOMER_CAPABILITIES },
    });
    const r0 = performance.now();
    try {
      const hold = await customer.createHold(
        { facilityId: slot.facilityId, slotRefs: [slot.slotRef] },
        { idempotencyKey: `indep-${idx}-${randomUUID()}` },
      );
      await customer.convertHoldToBooking({ holdId: hold.id }, { idempotencyKey: `indep-conv-${idx}-${randomUUID()}` });
      indepOutcomes.succeeded = (indepOutcomes.succeeded ?? 0) + 1;
    } catch (error) {
      const code = error instanceof BookingError ? error.code : "UNEXPECTED_ERROR";
      indepOutcomes[code] = (indepOutcomes[code] ?? 0) + 1;
    } finally {
      indepLatencies.push(performance.now() - r0);
    }
  });
  const indepMs = performance.now() - tIndepStart;

  // ---- Database Integrity Verification ----
  const [overlapRes, orphanHoldRes, orphanBookingRes] = await Promise.all([
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
       FROM allocations a
       JOIN allocations b
         ON a.tenant_id = b.tenant_id AND a.facility_id = b.facility_id AND a.id < b.id
        AND a.status IN ('held', 'reserved') AND b.status IN ('held', 'reserved')
        AND a.occupied_range && b.occupied_range
       WHERE a.tenant_id = $1`,
      [tenant.id],
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM holds h
       WHERE h.tenant_id = $1 AND h.state = 'active'
         AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.hold_id = h.id AND a.status = 'held')`,
      [tenant.id],
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM bookings b
       WHERE b.tenant_id = $1 AND b.status = 'confirmed'
         AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.booking_id = b.id AND a.status = 'reserved')`,
      [tenant.id],
    ),
  ]);

  assert.equal(Number(overlapRes.rows[0]!.cnt), 0, "Overlapping protected allocations detected!");
  assert.equal(Number(orphanHoldRes.rows[0]!.cnt), 0, "Active hold missing held allocation!");
  assert.equal(Number(orphanBookingRes.rows[0]!.cnt), 0, "Confirmed booking missing reserved allocation!");

  process.stdout.write(
    JSON.stringify(
      {
        benchmarkA_10kContention: {
          requests: 10_000,
          concurrency: 50,
          totalMs: Number(contentionMs.toFixed(1)),
          throughputRps: Number(((10_000 / contentionMs) * 1000).toFixed(1)),
          latencyMs: {
            p50: percentile(contentionLatencies, 50),
            p95: percentile(contentionLatencies, 95),
            p99: percentile(contentionLatencies, 99),
          },
          outcomes: contentionOutcomes,
          maxPoolWaitingObserved: maxWaitingPool,
        },
        benchmarkB_1000IndependentHoldPlusConvert: {
          workflows: 1000,
          operations: 2000,
          concurrency: 50,
          totalMs: Number(indepMs.toFixed(1)),
          workflowsPerSec: Number(((1000 / indepMs) * 1000).toFixed(1)),
          operationsPerSec: Number(((2000 / indepMs) * 1000).toFixed(1)),
          latencyMs: {
            p50: percentile(indepLatencies, 50),
            p95: percentile(indepLatencies, 95),
            p99: percentile(indepLatencies, 99),
          },
          outcomes: indepOutcomes,
        },
        integrity: {
          overlappingAllocations: Number(overlapRes.rows[0]!.cnt),
          orphanActiveHolds: Number(orphanHoldRes.rows[0]!.cnt),
          orphanConfirmedBookings: Number(orphanBookingRes.rows[0]!.cnt),
        },
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await pool.end();
}

