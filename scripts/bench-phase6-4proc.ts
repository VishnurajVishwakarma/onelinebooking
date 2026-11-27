import "dotenv/config";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  ALL_ADMIN_CAPABILITIES,
  BookingError,
  PostgresBookingStore,
  TimeSlotEngine,
  buildBudgetedPoolConfig,
  computeConnectionBudget,
  createBookingPool,
  runMigrations,
} from "../src/index.js";

interface WorkerArgs {
  tenantId: string;
  facilityId: string;
  slotRefs: string[];
  mode: "hot_slot" | "multi_slot";
  requests: number;
  concurrency: number;
  poolMax: number;
  maxPendingQueue: number;
}

interface WorkerSummary {
  pid: number;
  ok: number;
  conflicts: number;
  retryable: number;
  unexpected: number;
  latenciesMs: number[];
}

function summarizeLatencies(latencies: number[]) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
  return {
    p50Ms: Math.round(pick(50) * 100) / 100,
    p95Ms: Math.round(pick(95) * 100) / 100,
    p99Ms: Math.round(pick(99) * 100) / 100,
  };
}

async function runWorker(): Promise<void> {
  const args = JSON.parse(process.env.PHASE6_WORKER_ARGS ?? "{}") as WorkerArgs;
  const connStr = process.env.PGBOUNCER_URL || process.env.DATABASE_URL;
  const pool = createBookingPool(connStr, {
    max: args.poolMax,
    connectionTimeoutMillis: 2_500,
    idleTimeoutMillis: 15_000,
  });
  pool.on("error", () => {});

  const store = new PostgresBookingStore(pool, {
    lockTimeoutMs: 1_500,
    statementTimeoutMs: 5_000,
    maxPendingPoolRequests: args.maxPendingQueue,
  });
  const engine = new TimeSlotEngine(store);
  const client = engine.forTenant({
    tenantId: args.tenantId,
    actor: { id: `proc-${process.pid}`, type: "admin", capabilities: ALL_ADMIN_CAPABILITIES },
  });

  let idx = 0;
  let ok = 0;
  let conflicts = 0;
  let retryable = 0;
  let unexpected = 0;
  const latenciesMs: number[] = [];

  async function workerLoop(): Promise<void> {
    while (true) {
      const i = idx++;
      if (i >= args.requests) break;
      const slotRef =
        args.mode === "hot_slot"
          ? args.slotRefs[0]!
          : args.slotRefs[i % args.slotRefs.length]!;
      const t0 = performance.now();
      try {
        await client.createBooking(
          {
            facilityId: args.facilityId,
            slotRefs: [slotRef],
            externalCustomerId: `c-${process.pid}-${i}`,
          },
          { idempotencyKey: `p6-${process.pid}-${i}-${randomUUID()}` },
        );
        ok += 1;
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
        latenciesMs.push(performance.now() - t0);
      }
    }
  }

  await Promise.all(Array.from({ length: args.concurrency }, () => workerLoop()));
  await pool.end();
  process.send?.({
    pid: process.pid,
    ok,
    conflicts,
    retryable,
    unexpected,
    latenciesMs,
  } satisfies WorkerSummary);
}

async function runCoordinator(): Promise<void> {
  const processCount = 4;
  const budget = computeConnectionBudget({
    postgresMaxConnections: 100,
    apiInstanceCount: processCount,
    reservedAdminConnections: 5,
    reservedWorkerConnections: 8,
    reservedMigrationConnections: 3,
    ...(process.env.PGBOUNCER_URL ? { pgbouncerDefaultPoolSize: 60 } : {}),
  });

  const adminPool = createBookingPool(undefined, buildBudgetedPoolConfig(budget, "admin"));
  await runMigrations(adminPool);
  const store = new PostgresBookingStore(adminPool);
  const engine = new TimeSlotEngine(store);

  const scenarios: Array<"hot_slot" | "multi_slot"> = ["hot_slot", "multi_slot"];
  const results: Record<string, unknown> = {
    budgetPlan: budget,
    viaPgBouncer: Boolean(process.env.PGBOUNCER_URL),
    scenarios: {},
  };

  for (const mode of scenarios) {
    const tenant = await engine.createTenant({ name: `p6-4proc-${mode}-${randomUUID().slice(0, 6)}` });
    const client = engine.forTenant({
      tenantId: tenant.id,
      actor: { id: "bench-coord", type: "admin", capabilities: ALL_ADMIN_CAPABILITIES },
    });

    const slotRefs: string[] = [];
    const facilitiesCount = mode === "hot_slot" ? 1 : 20;
    const baseDate = new Date(Date.now() + 8 * 86_400_000).toISOString().slice(0, 10);

    for (let f = 0; f < facilitiesCount; f++) {
      const fac = await client.createFacility({
        name: `Fac-${f}`,
        category: "pc",
        timeZone: "UTC",
      });
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
        maxAdvanceDays: 90,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        maxSlotsPerBooking: 4,
        defaultHoldMinutes: 5,
        maxActiveHoldsPerCustomer: 100,
      });
      await client.setPricing({ facilityId: fac.id, amountMinor: 1000, currency: "USD" });

      const avail = await client.getAvailability({
        facilityIds: [fac.id],
        fromDate: baseDate,
        toDate: new Date(new Date(`${baseDate}T00:00:00Z`).getTime() + 6 * 86_400_000).toISOString().slice(0, 10),
      });
      if (mode === "hot_slot") {
        slotRefs.push(avail.slots[0]!.slotRef);
        // Save single facilityId in outer map
        break;
      } else {
        for (const s of avail.slots.slice(0, 20)) {
          slotRefs.push(s.slotRef);
        }
      }
    }

    // Track peak active/total DB connections during the 4-process run
    let peakBackendConnections = 0;
    const monitorTimer = setInterval(async () => {
      try {
        const res = await adminPool.query(
          `SELECT count(*)::int AS cnt FROM pg_stat_activity WHERE datname = current_database()`,
        );
        const cnt = Number(res.rows[0]?.cnt ?? 0);
        if (cnt > peakBackendConnections) peakBackendConnections = cnt;
      } catch {
        // Ignore transient sampler error
      }
    }, 100);

    // Wait: for multi_slot, pass 1 facility per slot batch or use first facility's 100 slots
    const targetFacId = (await client.listFacilities())[0]!.id;
    const effectiveSlots =
      mode === "hot_slot"
        ? [slotRefs[0]!]
        : (
            await client.getAvailability({
              facilityIds: [targetFacId],
              fromDate: baseDate,
              toDate: new Date(new Date(`${baseDate}T00:00:00Z`).getTime() + 14 * 86_400_000)
                .toISOString()
                .slice(0, 10),
            })
          ).slots.map((s) => s.slotRef);

    const t0 = performance.now();
    const summaries = await Promise.all(
      Array.from({ length: processCount }, (_v, idx) =>
        new Promise<WorkerSummary>((resolve, reject) => {
          const workerArgs: WorkerArgs = {
            tenantId: tenant.id,
            facilityId: targetFacId,
            slotRefs:
              mode === "hot_slot"
                ? [effectiveSlots[0]!]
                : effectiveSlots.slice(idx * 60, (idx + 1) * 60),
            mode,
            requests: 250,
            concurrency: 20, // 80 total offered concurrency across 4 API processes
            poolMax: budget.pgbouncerEnabled ? budget.pgbouncerClientMaxPerInstance : budget.perApiInstancePoolMax,
            maxPendingQueue: budget.maxPendingPoolRequestsPerInstance,
          };
          const child = fork(new URL(import.meta.url), [], {
            env: {
              ...process.env,
              PHASE6_WORKER: "1",
              PHASE6_WORKER_ARGS: JSON.stringify(workerArgs),
            },
          });
          let result: WorkerSummary | undefined;
          child.on("message", (msg) => {
            result = msg as WorkerSummary;
          });
          child.on("exit", (code) => {
            if (code !== 0 || !result) {
              reject(new Error(`Worker exited with code ${code}`));
            } else {
              resolve(result);
            }
          });
        }),
      ),
    );
    const totalMs = performance.now() - t0;
    clearInterval(monitorTimer);

    const agg = summaries.reduce(
      (acc, w) => {
        acc.ok += w.ok;
        acc.conflicts += w.conflicts;
        acc.retryable += w.retryable;
        acc.unexpected += w.unexpected;
        acc.latencies.push(...w.latenciesMs);
        return acc;
      },
      { ok: 0, conflicts: 0, retryable: 0, unexpected: 0, latencies: [] as number[] },
    );

    const overlapRes = await adminPool.query(
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

    const totalRequests = agg.ok + agg.conflicts + agg.retryable + agg.unexpected;
    (results.scenarios as Record<string, unknown>)[mode] = {
      processes: processCount,
      totalOfferedConcurrency: 80,
      totalRequests,
      durationMs: Math.round(totalMs),
      throughputRps: Math.round((totalRequests / (totalMs / 1000)) * 10) / 10,
      successfulBookings: agg.ok,
      expectedConflicts: agg.conflicts,
      retryableErrors: agg.retryable,
      unexpectedErrors: agg.unexpected,
      peakBackendConnectionsObserved: peakBackendConnections,
      overlappingAllocations: Number(overlapRes.rows[0]?.cnt ?? 0),
      latency: summarizeLatencies(agg.latencies),
    };
  }

  console.log(JSON.stringify(results, null, 2));
  await adminPool.end();
}

if (process.env.PHASE6_WORKER === "1") {
  void runWorker();
} else {
  void runCoordinator();
}

