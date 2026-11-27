import "dotenv/config";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  ALL_ADMIN_CAPABILITIES,
  BookingError,
  HoldExpiryWorker,
  PostgresBookingStore,
  TimeSlotEngine,
  createBookingPool,
  runMigrations,
} from "../src/index.js";

function parseArgNumber(prefix: string): number | undefined {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (!arg) return undefined;
  const val = Number(arg.slice(prefix.length));
  return Number.isFinite(val) && val > 0 ? val : undefined;
}

function summarize(samples: number[]) {
  if (samples.length === 0) return { p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
  return {
    p50Ms: Math.round(pick(50) * 100) / 100,
    p95Ms: Math.round(pick(95) * 100) / 100,
    p99Ms: Math.round(pick(99) * 100) / 100,
  };
}

/**
 * Sustained soak workload driver (supports --duration-minutes=30, --duration-minutes=60, or --duration-seconds=N).
 */
async function main(): Promise<void> {
  const durationMinutes = parseArgNumber("--duration-minutes=");
  const durationSeconds = parseArgNumber("--duration-seconds=") ?? (durationMinutes ? durationMinutes * 60 : 20);
  const concurrency = parseArgNumber("--concurrency=") ?? 16;

  const pool = createBookingPool(undefined, { max: 24 });
  await runMigrations(pool);
  const store = new PostgresBookingStore(pool, {
    lockTimeoutMs: 1_500,
    statementTimeoutMs: 5_000,
    maxPendingPoolRequests: 120,
  });
  const engine = new TimeSlotEngine(store);

  const tenant = await engine.createTenant({ name: `soak-${randomUUID().slice(0, 8)}` });
  const client = engine.forTenant({
    tenantId: tenant.id,
    actor: { id: "soak-runner", type: "admin", capabilities: ALL_ADMIN_CAPABILITIES },
  });

  const baseDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const facilityIds: string[] = [];
  const allSlotRefs: Array<{ facilityId: string; slotRef: string }> = [];

  for (let f = 0; f < 5; f++) {
    const fac = await client.createFacility({
      name: `Soak Bay ${f}`,
      category: "pc",
      timeZone: "UTC",
    });
    facilityIds.push(fac.id);
    await client.setSchedule(
      fac.id,
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        opensAt: "00:00",
        closesAt: "23:59",
        endDayOffset: 0 as const,
        effectiveFrom: baseDate,
        effectiveUntil: null,
        breaks: [],
      })),
    );
    await client.setSlotPolicy(fac.id, {
      durationMinutes: 60,
      intervalMinutes: 60,
      minNoticeMinutes: 0,
      maxAdvanceDays: 365,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      maxSlotsPerBooking: 4,
      defaultHoldMinutes: 5,
      maxActiveHoldsPerCustomer: 50,
    });
    await client.setPricing({ facilityId: fac.id, amountMinor: 1000, currency: "USD" });

    const avail = await client.getAvailability({
      facilityIds: [fac.id],
      fromDate: baseDate,
      toDate: new Date(new Date(`${baseDate}T00:00:00Z`).getTime() + 29 * 86_400_000).toISOString().slice(0, 10),
    });
    for (const s of avail.slots) {
      allSlotRefs.push({ facilityId: fac.id, slotRef: s.slotRef });
    }
  }

  const expiryWorker = new HoldExpiryWorker({ engine, intervalMs: 2_000, batchLimit: 100 });
  expiryWorker.start();

  const startRssMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
  const endTimeMs = Date.now() + durationSeconds * 1000;

  let reads = 0;
  let holdCycles = 0;
  let conflicts = 0;
  let retryable = 0;
  let unexpected = 0;
  const latencies: number[] = [];
  let slotCursor = 0;

  async function soakWorker(workerId: number): Promise<void> {
    let opIndex = 0;
    while (Date.now() < endTimeMs) {
      opIndex += 1;
      const t0 = performance.now();
      try {
        if (opIndex % 3 !== 0) {
          // Read-heavy mix (availability checks)
          const facId = facilityIds[(opIndex + workerId) % facilityIds.length]!;
          await client.getAvailability({
            facilityIds: [facId],
            fromDate: baseDate,
            toDate: baseDate,
          });
          reads += 1;
        } else {
          // Hold -> cancel/release/convert lifecycle
          const pick = allSlotRefs[(slotCursor++) % allSlotRefs.length]!;
          const hold = await client.createHold(
            { facilityId: pick.facilityId, slotRefs: [pick.slotRef], externalCustomerId: `soak-${workerId}-${opIndex % 10}` },
            { idempotencyKey: `soak-h-${workerId}-${opIndex}-${randomUUID()}` },
          );
          if (opIndex % 6 === 0) {
            await client.convertHoldToBooking(
              { holdId: hold.id },
              { idempotencyKey: `soak-c-${workerId}-${opIndex}-${randomUUID()}` },
            );
          } else {
            await client.releaseHold(hold.id, { idempotencyKey: `soak-r-${workerId}-${opIndex}` });
          }
          holdCycles += 1;
        }
      } catch (err) {
        if (err instanceof BookingError) {
          if (err.code === "SLOT_CONFLICT" || err.code === "HOLD_LIMIT_EXCEEDED") {
            conflicts += 1;
          } else if (err.retryable || err.code === "TEMPORARY_UNAVAILABLE") {
            retryable += 1;
          } else {
            unexpected += 1;
          }
        } else {
          unexpected += 1;
        }
      } finally {
        if (latencies.length < 50_000) {
          latencies.push(performance.now() - t0);
        }
      }
    }
  }

  const startedAt = performance.now();
  await Promise.all(Array.from({ length: concurrency }, (_v, i) => soakWorker(i)));
  const elapsedSec = Math.round(((performance.now() - startedAt) / 1000) * 100) / 100;
  expiryWorker.stop();

  const endRssMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
  const overlapRes = await pool.query(
    `SELECT count(*)::int AS cnt
     FROM allocations a1
     JOIN allocations a2
       ON a1.id < a2.id
      AND a1.tenant_id = a2.tenant_id
      AND a1.facility_id = a2.facility_id
      AND a1.status IN ('held', 'reserved')
      AND a2.status IN ('held', 'reserved')
      AND a1.occupied_range && a2.occupied_range
     WHERE a1.tenant_id = $1`,
    [tenant.id],
  );

  const totalOps = reads + holdCycles + conflicts + retryable + unexpected;
  console.log(
    JSON.stringify(
      {
        configuredDurationSeconds: durationSeconds,
        actualDurationSeconds: elapsedSec,
        concurrency,
        totalOperations: totalOps,
        throughputOpsPerSec: Math.round((totalOps / Math.max(0.1, elapsedSec)) * 10) / 10,
        availabilityReads: reads,
        completedHoldCycles: holdCycles,
        expectedConflicts: conflicts,
        retryableErrors: retryable,
        unexpectedErrors: unexpected,
        startRssMb,
        endRssMb,
        rssDeltaMb: Math.round((endRssMb - startRssMb) * 10) / 10,
        overlappingAllocations: Number(overlapRes.rows[0]?.cnt ?? 0),
        latencySample: summarize(latencies),
      },
      null,
      2,
    ),
  );

  await pool.end();
}

void main();

