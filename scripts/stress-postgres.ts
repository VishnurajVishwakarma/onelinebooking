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
} from "../src/index.js";

const CONTENTION_REQUESTS = Number(process.env.STRESS_REQUESTS ?? "1000");
const CONCURRENCY = Number(process.env.STRESS_CONCURRENCY ?? "50");

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number(sorted[idx]!.toFixed(2));
}

async function runPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      await fn(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
}

const pool = createBookingPool();

try {
  await runMigrations(pool);
  const store = new PostgresBookingStore(pool);
  const engine = new TimeSlotEngine(store);

  const tenant = await engine.createTenant({ name: `Stress Tenant ${randomUUID()}` });
  const admin = engine.forTenant({
    tenantId: tenant.id,
    actor: { id: "stress-admin", type: "admin", capabilities: ALL_ADMIN_CAPABILITIES },
  });

  const facility = await admin.createFacility({
    name: "Stress Court 01",
    category: "turf",
    timeZone: "Asia/Kolkata",
  });
  const effectiveFrom = DateTime.now().setZone("Asia/Kolkata").toISODate()!;
  await admin.setSchedule(
    facility.id,
    Array.from({ length: 7 }, (_, i) => ({
      weekday: i + 1,
      opensAt: "06:00",
      closesAt: "23:00",
      endDayOffset: 0,
      effectiveFrom,
      effectiveUntil: null,
      breaks: [],
    })),
  );
  await admin.setSlotPolicy(facility.id, {
    durationMinutes: 60,
    intervalMinutes: 60,
    minNoticeMinutes: 0,
    maxAdvanceDays: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    maxSlotsPerBooking: 6,
    defaultHoldMinutes: 5,
    maxActiveHoldsPerCustomer: 3,
  });
  await admin.setPricing({ facilityId: facility.id, amountMinor: 25000, currency: "INR" });

  const targetDate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 5 }).toISODate()!;
  const avail = await admin.getAvailability({ facilityIds: [facility.id], localDate: targetDate });
  const hotSlot = avail.slots[5]!;

  // Scenario 1: 1,000-request single-slot contention race (§14.3)
  const counts: Record<string, number> = { succeeded: 0 };
  const latencies: number[] = [];
  const t0 = performance.now();

  await runPool(Array.from({ length: CONTENTION_REQUESTS }, (_, i) => i), CONCURRENCY, async (idx) => {
    const customer = engine.forTenant({
      tenantId: tenant.id,
      actor: {
        id: `u_${idx}`,
        type: "customer",
        customerId: `cust_${idx}`,
        capabilities: DEFAULT_CUSTOMER_CAPABILITIES,
      },
    });
    const reqStart = performance.now();
    try {
      await customer.createHold(
        { facilityId: facility.id, slotRefs: [hotSlot.slotRef] },
        { idempotencyKey: `stress-hold-${idx}-${randomUUID()}` },
      );
      counts.succeeded = (counts.succeeded ?? 0) + 1;
    } catch (error) {
      const code = error instanceof BookingError ? error.code : "UNKNOWN_ERROR";
      counts[code] = (counts[code] ?? 0) + 1;
    } finally {
      latencies.push(performance.now() - reqStart);
    }
  });

  const totalMs = performance.now() - t0;
  latencies.sort((a, b) => a - b);

  // Nonnegotiable invariant: zero overlapping protected allocations
  const overlapCheck = await pool.query<{ overlaps: string }>(
    `SELECT COUNT(*)::text AS overlaps
     FROM allocations a
     JOIN allocations b
       ON a.tenant_id = b.tenant_id
      AND a.facility_id = b.facility_id
      AND a.id < b.id
      AND a.status IN ('held', 'reserved')
      AND b.status IN ('held', 'reserved')
      AND a.occupied_range && b.occupied_range
     WHERE a.tenant_id = $1 AND a.facility_id = $2`,
    [tenant.id, facility.id],
  );
  assert.equal(Number(overlapCheck.rows[0]!.overlaps), 0, "Detected overlapping protected allocations!");
  assert.equal(counts.succeeded, 1, `Expected exactly 1 winner under contention, got ${counts.succeeded}`);

  process.stdout.write(
    JSON.stringify(
      {
        scenario: "single_slot_contention",
        requests: CONTENTION_REQUESTS,
        concurrency: CONCURRENCY,
        totalMs: Number(totalMs.toFixed(1)),
        throughputRps: Number(((CONTENTION_REQUESTS / totalMs) * 1000).toFixed(1)),
        latencyMs: {
          p50: percentile(latencies, 50),
          p95: percentile(latencies, 95),
          p99: percentile(latencies, 99),
        },
        outcomes: counts,
        overlappingAllocations: Number(overlapCheck.rows[0]!.overlaps),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await pool.end();
}

