import "dotenv/config";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  ALL_ADMIN_CAPABILITIES,
  PostgresBookingStore,
  TimeSlotEngine,
  createBookingPool,
  runMigrations,
} from "../src/index.js";

function summarize(samples: number[]): { count: number; avgMs: number; p50Ms: number; p95Ms: number; p99Ms: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (pct: number) => sorted[Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length))] ?? 0;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    avgMs: Math.round((sum / Math.max(1, sorted.length)) * 100) / 100,
    p50Ms: Math.round(pick(50) * 100) / 100,
    p95Ms: Math.round(pick(95) * 100) / 100,
    p99Ms: Math.round(pick(99) * 100) / 100,
  };
}

async function main(): Promise<void> {
  const pool = createBookingPool(undefined, { max: 16 });
  await runMigrations(pool);
  const store = new PostgresBookingStore(pool);
  const engine = new TimeSlotEngine(store);

  const tenant = await engine.createTenant({ name: `avail-profile-${randomUUID().slice(0, 8)}` });
  const client = engine.forTenant({
    tenantId: tenant.id,
    actor: { id: "profiler", type: "admin", capabilities: ALL_ADMIN_CAPABILITIES },
  });

  const facility = await client.createFacility({
    name: "Profile Bay",
    category: "pc",
    timeZone: "America/New_York",
  });

  const baseDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  await client.setSchedule(
    facility.id,
    [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      opensAt: "08:00",
      closesAt: "23:00",
      endDayOffset: 0 as const,
      effectiveFrom: baseDate,
      effectiveUntil: null,
      breaks: [{ startsAt: "13:00", endsAt: "13:30", startDayOffset: 0 as const, endDayOffset: 0 as const }],
    })),
  );
  await client.setSlotPolicy(facility.id, {
    durationMinutes: 30,
    intervalMinutes: 30,
    minNoticeMinutes: 0,
    maxAdvanceDays: 90,
    bufferBeforeMinutes: 5,
    bufferAfterMinutes: 5,
    maxSlotsPerBooking: 6,
    defaultHoldMinutes: 5,
    maxActiveHoldsPerCustomer: 10,
  });
  await client.setPricing({ facilityId: facility.id, amountMinor: 1200, currency: "USD" });

  // Seed realistic density: bookings + blackouts across 30 days
  const monthEnd = new Date(Date.now() + 36 * 86_400_000).toISOString().slice(0, 10);
  const avail30 = await client.getAvailability({
    facilityIds: [facility.id],
    fromDate: baseDate,
    toDate: monthEnd,
  });

  for (let i = 0; i < avail30.slots.length; i += 12) {
    const s = avail30.slots[i]!;
    await client.createBooking(
      { facilityId: facility.id, slotRefs: [s.slotRef], externalCustomerId: `c-${i}` },
      { idempotencyKey: `prof-seed-${i}` },
    ).catch(() => {});
  }

  // Warmup
  for (let i = 0; i < 5; i++) {
    await client.getAvailability({ facilityIds: [facility.id], fromDate: baseDate, toDate: baseDate });
  }

  const horizons = [
    { name: "1_day", days: 0 },
    { name: "7_days", days: 6 },
    { name: "30_days", days: 29 },
  ];

  const report: Record<string, unknown> = {
    facilityTimeZone: "America/New_York",
    slotDurationMinutes: 30,
    seededSlotsTotal: avail30.slots.length,
    horizons: {},
  };

  for (const h of horizons) {
    const toDate = new Date(new Date(`${baseDate}T00:00:00Z`).getTime() + h.days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const totalTimes: number[] = [];
    let slotsReturned = 0;

    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      const res = await client.getAvailability({
        facilityIds: [facility.id],
        fromDate: baseDate,
        toDate,
      });
      totalTimes.push(performance.now() - t0);
      slotsReturned = res.slots.length;
    }

    (report.horizons as Record<string, unknown>)[h.name] = {
      slotsReturned,
      latency: summarize(totalTimes),
    };
  }

  // Profile PostgreSQL EXPLAIN ANALYZE on hot availability queries
  const explainAlloc = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT id, service_start, service_end, occupied_start, occupied_end, status
     FROM allocations
     WHERE tenant_id = $1
       AND facility_id = $2
       AND status IN ('held', 'reserved')
       AND occupied_range && tstzrange($3::timestamptz, $4::timestamptz, '[)')`,
    [tenant.id, facility.id, `${baseDate}T00:00:00Z`, `${monthEnd}T23:59:59Z`],
  );
  const plan = (explainAlloc.rows[0] as { "QUERY PLAN": Array<{ "Execution Time": number; "Planning Time": number; Plan: { "Node Type": string; "Index Name"?: string } }> })["QUERY PLAN"][0]!;

  report.postgresExplainAllocations = {
    planningTimeMs: plan["Planning Time"],
    executionTimeMs: plan["Execution Time"],
    nodeType: plan.Plan["Node Type"],
    indexName: plan.Plan["Index Name"] ?? null,
  };

  console.log(JSON.stringify(report, null, 2));
  await pool.end();
}

void main();

