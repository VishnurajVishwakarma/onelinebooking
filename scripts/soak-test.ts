import "dotenv/config";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { PerformanceObserver, performance } from "node:perf_hooks";
import {
  ALL_ADMIN_CAPABILITIES,
  BookingError,
  HoldExpiryWorker,
  PostgresBookingStore,
  TimeSlotEngine,
  createBookingPool,
  runMigrations,
} from "../src/index.js";

function parseArg(prefix: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function parseArgNumber(prefix: string): number | undefined {
  const raw = parseArg(prefix);
  if (!raw) return undefined;
  const val = Number(raw);
  return Number.isFinite(val) && val > 0 ? val : undefined;
}

function parseArgFloat(prefix: string): number | undefined {
  const raw = parseArg(prefix);
  if (raw === undefined) return undefined;
  const val = Number(raw);
  return Number.isFinite(val) && val >= 0 && val <= 1 ? val : undefined;
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

function computeLinearSlopeKbPerMin(points: Array<{ elapsedSec: number; mb: number }>): number {
  if (points.length < 2) return 0;
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.elapsedSec / 60, 0) / n;
  const meanY = points.reduce((s, p) => s + p.mb * 1024, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    const dx = p.elapsedSec / 60 - meanX;
    const dy = p.mb * 1024 - meanY;
    num += dx * dy;
    den += dx * dx;
  }
  return den === 0 ? 0 : Math.round((num / den) * 100) / 100;
}

/**
 * Sustained soak workload driver (supports --duration-minutes=30, --duration-minutes=60, --duration-minutes=1440, or --duration-seconds=N).
 * Separately measures read throughput, successful booking lifecycle throughput, conflict rejection throughput,
 * GC telemetry, V8 memory spaces, pool metrics, active handles, and PostgreSQL relation growth.
 */
async function main(): Promise<void> {
  const durationMinutes = parseArgNumber("--duration-minutes=");
  const durationSeconds = parseArgNumber("--duration-seconds=") ?? (durationMinutes ? durationMinutes * 60 : 20);
  const concurrency = parseArgNumber("--concurrency=") ?? 16;
  const conflictRatio = parseArgFloat("--conflict-ratio=") ?? 0.1;
  const sampleIntervalSec = parseArgNumber("--sample-interval-seconds=") ?? (durationSeconds >= 600 ? 60 : 10);
  const reportJsonPath = parseArg("--report-json=");

  let gcCount = 0;
  let gcTotalMs = 0;
  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcCount += 1;
      gcTotalMs += entry.duration;
    }
  });
  gcObserver.observe({ entryTypes: ["gc"] });

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
      toDate: new Date(new Date(`${baseDate}T00:00:00Z`).getTime() + 59 * 86_400_000).toISOString().slice(0, 10),
    });
    for (const s of avail.slots) {
      allSlotRefs.push({ facilityId: fac.id, slotRef: s.slotRef });
    }
  }

  // Reserve 1 persistent hot slot for realistic conflict contention when conflictRatio > 0
  const hotTarget = allSlotRefs[0]!;
  if (conflictRatio > 0) {
    await client.createBooking(
      {
        facilityId: hotTarget.facilityId,
        slotRefs: [hotTarget.slotRef],
        externalCustomerId: "soak-hotspot-holder",
      },
      { idempotencyKey: `soak-hotspot-init-${randomUUID()}` },
    );
  }
  const nonHotSlots = allSlotRefs.slice(1);

  let workerSweepsCount = 0;
  let workerExpiredTotal = 0;
  const expiryWorker = new HoldExpiryWorker({
    engine,
    intervalMs: 2_000,
    batchLimit: 100,
    onSweep: (res) => {
      workerSweepsCount += 1;
      workerExpiredTotal += res.expiredCount;
    },
  });
  expiryWorker.start();

  const toMb = (n: number) => Math.round((n / (1024 * 1024)) * 10) / 10;
  const startMem = process.memoryUsage();
  const endTimeMs = Date.now() + durationSeconds * 1000;

  let reads = 0;
  let holdsSucceeded = 0;
  let conversionsSucceeded = 0;
  let releasesSucceeded = 0;
  let conflictsRejected = 0;
  let retryable = 0;
  let unexpected = 0;
  let slotCursor = 0;

  // Bounded circular latency buffers (max 10k samples each -> O(1) memory even across 24h)
  const MAX_SAMPLES = 10_000;
  const readLatencies: number[] = [];
  const bookingSuccessLatencies: number[] = [];
  const conflictLatencies: number[] = [];
  const pushBounded = (arr: number[], val: number, seenCount: number): void => {
    if (arr.length < MAX_SAMPLES) {
      arr.push(val);
    } else {
      const idx = seenCount % MAX_SAMPLES;
      arr[idx] = val;
    }
  };

  interface TelemetryPoint {
    elapsedSec: number;
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    externalMb: number;
    arrayBuffersMb: number;
    gcCount: number;
    gcTotalMs: number;
    activeHandles: number;
    poolTotal: number;
    poolIdle: number;
    poolWaiting: number;
    dbSizeMb: number;
    allocationsRows: number;
    maxHoldExpiryLagSec: number;
    pendingOutboxEvents: number;
    oldestPendingOutboxLagSec: number;
  }
  const samples: TelemetryPoint[] = [];
  const startedAt = performance.now();

  const collectPoint = async (): Promise<TelemetryPoint> => {
    const m = process.memoryUsage();
    const procHandles = process as unknown as { _getActiveHandles?: () => unknown[] };
    const handlesCount = procHandles._getActiveHandles ? procHandles._getActiveHandles().length : -1;
    const dbStats = await pool.query<{
      db_mb: number;
      alloc_cnt: number;
      max_hold_lag_sec: number;
      pending_outbox: number;
      oldest_outbox_lag_sec: number;
    }>(`
      SELECT
        round((pg_database_size(current_database())::numeric / (1024 * 1024)), 2)::float8 AS db_mb,
        (SELECT count(*)::int FROM allocations) AS alloc_cnt,
        COALESCE(
          (SELECT EXTRACT(EPOCH FROM (clock_timestamp() - MIN(expires_at)))::float8
           FROM holds WHERE tenant_id = $1 AND state = 'active' AND expires_at < clock_timestamp()),
          0
        ) AS max_hold_lag_sec,
        (SELECT count(*)::int FROM outbox_events WHERE tenant_id = $1 AND status = 'pending') AS pending_outbox,
        COALESCE(
          (SELECT EXTRACT(EPOCH FROM (clock_timestamp() - MIN(occurred_at)))::float8
           FROM outbox_events WHERE tenant_id = $1 AND status = 'pending'),
          0
        ) AS oldest_outbox_lag_sec
    `, [tenant.id]);
    return {
      elapsedSec: Math.round(((performance.now() - startedAt) / 1000) * 10) / 10,
      rssMb: toMb(m.rss),
      heapUsedMb: toMb(m.heapUsed),
      heapTotalMb: toMb(m.heapTotal),
      externalMb: toMb(m.external),
      arrayBuffersMb: toMb(m.arrayBuffers),
      gcCount,
      gcTotalMs: Math.round(gcTotalMs * 10) / 10,
      activeHandles: handlesCount,
      poolTotal: pool.totalCount,
      poolIdle: pool.idleCount,
      poolWaiting: pool.waitingCount,
      dbSizeMb: Number(dbStats.rows[0]?.db_mb ?? 0),
      allocationsRows: Number(dbStats.rows[0]?.alloc_cnt ?? 0),
      maxHoldExpiryLagSec: Math.round(Number(dbStats.rows[0]?.max_hold_lag_sec ?? 0) * 100) / 100,
      pendingOutboxEvents: Number(dbStats.rows[0]?.pending_outbox ?? 0),
      oldestPendingOutboxLagSec: Math.round(Number(dbStats.rows[0]?.oldest_outbox_lag_sec ?? 0) * 100) / 100,
    };
  };

  samples.push(await collectPoint());
  let sampling = false;
  const sampler = setInterval(() => {
    if (sampling) return;
    sampling = true;
    void collectPoint()
      .then((pt) => samples.push(pt))
      .catch(() => { })
      .finally(() => {
        sampling = false;
      });
  }, sampleIntervalSec * 1000);
  sampler.unref();

  async function soakWorker(workerId: number): Promise<void> {
    let opIndex = 0;
    while (Date.now() < endTimeMs) {
      opIndex += 1;
      const t0 = performance.now();
      const deterministicFraction = ((opIndex + workerId) % 100) / 100;
      const forceConflict = conflictRatio > 0 && opIndex % 3 === 0 && deterministicFraction < conflictRatio;
      try {
        if (opIndex % 3 !== 0) {
          const facId = facilityIds[(opIndex + workerId) % facilityIds.length]!;
          await client.getAvailability({
            facilityIds: [facId],
            fromDate: baseDate,
            toDate: baseDate,
          });
          reads += 1;
          pushBounded(readLatencies, performance.now() - t0, reads);
        } else if (forceConflict) {
          await client.createHold(
            {
              facilityId: hotTarget.facilityId,
              slotRefs: [hotTarget.slotRef],
              externalCustomerId: `soak-conflict-${workerId}-${opIndex % 5}`,
            },
            { idempotencyKey: `soak-hc-${workerId}-${opIndex}-${randomUUID()}` },
          );
          holdsSucceeded += 1;
        } else {
          const pick = nonHotSlots[(slotCursor++) % nonHotSlots.length]!;
          const hold = await client.createHold(
            { facilityId: pick.facilityId, slotRefs: [pick.slotRef], externalCustomerId: `soak-${workerId}-${opIndex % 10}` },
            { idempotencyKey: `soak-h-${workerId}-${opIndex}-${randomUUID()}` },
          );
          holdsSucceeded += 1;
          if (opIndex % 6 === 0) {
            await client.convertHoldToBooking(
              { holdId: hold.id },
              { idempotencyKey: `soak-c-${workerId}-${opIndex}-${randomUUID()}` },
            );
            conversionsSucceeded += 1;
          } else {
            await client.releaseHold(hold.id, { idempotencyKey: `soak-r-${workerId}-${opIndex}` });
            releasesSucceeded += 1;
          }
          pushBounded(bookingSuccessLatencies, performance.now() - t0, conversionsSucceeded + releasesSucceeded);
        }
      } catch (err) {
        if (err instanceof BookingError) {
          if (err.code === "SLOT_CONFLICT" || err.code === "HOLD_LIMIT_EXCEEDED") {
            conflictsRejected += 1;
            pushBounded(conflictLatencies, performance.now() - t0, conflictsRejected);
          } else if (err.retryable || err.code === "TEMPORARY_UNAVAILABLE") {
            retryable += 1;
          } else {
            unexpected += 1;
          }
        } else {
          unexpected += 1;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_v, i) => soakWorker(i)));
  clearInterval(sampler);
  const elapsedSec = Math.round(((performance.now() - startedAt) / 1000) * 100) / 100;
  expiryWorker.stop();

  const endSample = await collectPoint();
  samples.push(endSample);
  const endMem = process.memoryUsage();
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

  const postWarmupSamples = samples.filter((s) => s.elapsedSec >= Math.min(20, elapsedSec / 3));
  const completedHoldCycles = conversionsSucceeded + releasesSucceeded;
  const totalOps = reads + completedHoldCycles + conflictsRejected + retryable + unexpected;

  const report = {
    configuredDurationSeconds: durationSeconds,
    actualDurationSeconds: elapsedSec,
    concurrency,
    conflictRatioConfigured: conflictRatio,
    totalOperations: totalOps,
    throughputOpsPerSec: Math.round((totalOps / Math.max(0.1, elapsedSec)) * 10) / 10,
    separateThroughput: {
      availabilityReadOpsPerSec: Math.round((reads / Math.max(0.1, elapsedSec)) * 10) / 10,
      successfulBookingWorkflowsPerSec: Math.round((completedHoldCycles / Math.max(0.1, elapsedSec)) * 10) / 10,
      successfulConfirmedBookingsPerSec: Math.round((conversionsSucceeded / Math.max(0.1, elapsedSec)) * 10) / 10,
      conflictRejectionOpsPerSec: Math.round((conflictsRejected / Math.max(0.1, elapsedSec)) * 10) / 10,
    },
    counts: {
      availabilityReads: reads,
      holdsCreated: holdsSucceeded,
      bookingsConfirmed: conversionsSucceeded,
      holdsReleased: releasesSucceeded,
      completedHoldCycles,
      expectedConflictsRejected: conflictsRejected,
      retryableErrors: retryable,
      unexpectedErrors: unexpected,
      overlappingAllocations: Number(overlapRes.rows[0]?.cnt ?? 0),
    },
    memory: {
      startRssMb: toMb(startMem.rss),
      endRssMb: toMb(endMem.rss),
      rssDeltaMb: Math.round((toMb(endMem.rss) - toMb(startMem.rss)) * 10) / 10,
      startHeapUsedMb: toMb(startMem.heapUsed),
      endHeapUsedMb: toMb(endMem.heapUsed),
      endHeapTotalMb: toMb(endMem.heapTotal),
      endExternalMb: toMb(endMem.external),
      endArrayBuffersMb: toMb(endMem.arrayBuffers),
      postWarmupHeapSlopeKbPerMin: computeLinearSlopeKbPerMin(
        postWarmupSamples.map((s) => ({ elapsedSec: s.elapsedSec, mb: s.heapUsedMb })),
      ),
      postWarmupRssSlopeKbPerMin: computeLinearSlopeKbPerMin(
        postWarmupSamples.map((s) => ({ elapsedSec: s.elapsedSec, mb: s.rssMb })),
      ),
      gcCount,
      gcTotalMs: Math.round(gcTotalMs * 10) / 10,
    },
    latencySample: {
      reads: summarize(readLatencies),
      successfulBookingWorkflows: summarize(bookingSuccessLatencies),
      conflictRejections: summarize(conflictLatencies),
    },
    workerStats: {
      holdExpirySweeps: workerSweepsCount,
      holdExpiryExpiredTotal: workerExpiredTotal,
      maxObservedHoldExpiryLagSec: Math.max(...samples.map((s) => s.maxHoldExpiryLagSec), 0),
      maxObservedOutboxPending: Math.max(...samples.map((s) => s.pendingOutboxEvents), 0),
      maxObservedOutboxLagSec: Math.max(...samples.map((s) => s.oldestPendingOutboxLagSec), 0),
    },
    telemetrySamplesCount: samples.length,
    telemetrySamples: samples,
  };

  if (reportJsonPath) {
    writeFileSync(reportJsonPath, JSON.stringify(report, null, 2), "utf8");
  }

  console.log(JSON.stringify(report, null, 2));

  gcObserver.disconnect();
  await pool.end();
}

void main();
