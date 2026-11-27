import "dotenv/config";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import {
  ALL_ADMIN_CAPABILITIES,
  ALL_PLATFORM_SCOPES,
  BookingError,
  HoldExpiryWorker,
  OutboxWebhookWorker,
  PlatformService,
  PostgresBookingStore,
  TimeSlotEngine,
  computeConnectionBudget,
  createBookingPool,
  runMigrations,
  verifyWebhookSignature,
} from "../src/index.js";

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

// Child worker mode for SIGKILL webhook worker chaos test
if (process.argv[2] === "--kill-worker-mid-delivery") {
  const tenantId = process.argv[3]!;
  const pool = createBookingPool(process.env.DATABASE_URL, { max: 4 });
  const store = new PostgresBookingStore(pool);
  const engine = new TimeSlotEngine(store);
  const platform = new PlatformService(pool, { ssrfOptions: { allowLocalHttpForTesting: true } });

  const worker = new OutboxWebhookWorker({
    pool,
    engine,
    platform,
    tenantFilter: [tenantId],
    fetchFn: async () => {
      process.stdout.write("HTTP_INFLIGHT\n");
      await new Promise((r) => setTimeout(r, 30_000));
      return new Response("ok", { status: 200 });
    },
  });
  void worker.runOnce();
  await new Promise((r) => setTimeout(r, 30_000));
}

async function runPhase7OpsSuite(): Promise<void> {
  const pgbouncerUrl = process.env.PGBOUNCER_URL;
  const targetConnStr = pgbouncerUrl || process.env.DATABASE_URL;
  const adminPool = createBookingPool(process.env.DATABASE_URL, { max: 8 });
  await runMigrations(adminPool);

  // Use PgBouncer URL for workload pool when available
  const pool = createBookingPool(targetConnStr, { max: 24 });
  pool.on("error", () => {});
  const store = new PostgresBookingStore(pool, { lockTimeoutMs: 1_500, statementTimeoutMs: 8_000 });
  const engine = new TimeSlotEngine(store);
  const platform = new PlatformService(pool, { ssrfOptions: { allowLocalHttpForTesting: true } });

  const results: Record<string, unknown> = {
    viaPgBouncer: Boolean(pgbouncerUrl),
    rollingDeployConnectionBudget: computeConnectionBudget({
      postgresMaxConnections: 100,
      apiInstanceCount: 5, // 4 active + 1 rolling replacement pod headroom
      reservedAdminConnections: 5,
      reservedWorkerConnections: 8,
      reservedMigrationConnections: 3,
      ...(pgbouncerUrl ? { pgbouncerDefaultPoolSize: 60 } : {}),
    }),
  };

  // 1. Predominantly-successful booking workload (20 facilities, distinct slots, concurrency 20)
  const tag = randomUUID().slice(0, 8);
  const { organization } = await platform.createOrganization({ name: `OpsOrg ${tag}`, slug: `ops-${tag}` });
  const proj = await platform.createProjectWithEnvironments({
    organizationId: organization.id,
    name: "OpsProj",
    slug: `ops-proj-${tag}`,
  });
  const tenant = await platform.createScopedTenant({
    organizationId: organization.id,
    projectId: proj.project.id,
    environmentId: proj.testEnvironment.id,
    name: "Ops Tenant",
  });

  const admin = engine.forTenant({
    tenantId: tenant.id,
    actor: { id: "ops", type: "admin", capabilities: ALL_ADMIN_CAPABILITIES },
  });

  const baseDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const monthEnd = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
  const workQueue: Array<{ facilityId: string; slotRef: string }> = [];

  for (let f = 0; f < 10; f++) {
    const fac = await admin.createFacility({ name: `Bay-${f}`, category: "pc", timeZone: "UTC" });
    await admin.setSchedule(
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
    await admin.setSlotPolicy(fac.id, {
      durationMinutes: 60,
      intervalMinutes: 60,
      minNoticeMinutes: 0,
      maxAdvanceDays: 90,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      maxSlotsPerBooking: 4,
      defaultHoldMinutes: 5,
      maxActiveHoldsPerCustomer: 50,
    });
    await admin.setPricing({ facilityId: fac.id, amountMinor: 1500, currency: "USD" });

    const avail = await admin.getAvailability({ facilityIds: [fac.id], fromDate: baseDate, toDate: monthEnd });
    for (const s of avail.slots.slice(0, 80)) {
      workQueue.push({ facilityId: fac.id, slotRef: s.slotRef });
    }
  }

  let cursor = 0;
  let successBookings = 0;
  let conflictResponses = 0;
  let retryableErrors = 0;
  let unexpectedErrors = 0;
  const bookingLatencies: number[] = [];

  // Record 95% disjoint slots + 5% intentional hot-slot conflict tests to measure both separately
  const totalTasks = 500;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: 20 }, async (_v, workerId) => {
      while (true) {
        const idx = cursor++;
        if (idx >= totalTasks) break;
        const item =
          idx % 20 === 0
            ? workQueue[0]! // intentional 5% hotspot conflict sample
            : workQueue[idx]!;
        const s0 = performance.now();
        try {
          const hold = await admin.createHold(
            { facilityId: item.facilityId, slotRefs: [item.slotRef], externalCustomerId: `ops-c-${workerId}-${idx}` },
            { idempotencyKey: `ops-h-${idx}` },
          );
          await admin.convertHoldToBooking(
            { holdId: hold.id },
            { idempotencyKey: `ops-c-${idx}` },
          );
          successBookings += 1;
        } catch (err) {
          if (err instanceof BookingError) {
            if (err.code === "SLOT_CONFLICT" || err.code === "HOLD_LIMIT_EXCEEDED") {
              conflictResponses += 1;
            } else if (err.retryable) {
              retryableErrors += 1;
            } else {
              unexpectedErrors += 1;
            }
          } else {
            unexpectedErrors += 1;
          }
        } finally {
          bookingLatencies.push(performance.now() - s0);
        }
      }
    }),
  );
  const benchSec = (performance.now() - t0) / 1000;

  results.predominantlySuccessfulWorkload = {
    totalWorkflowsAttempted: totalTasks,
    durationSeconds: Math.round(benchSec * 100) / 100,
    successfulHoldAndConfirmCount: successBookings,
    successfulBookingThroughputPerSec: Math.round((successBookings / benchSec) * 10) / 10,
    conflictResponses,
    conflictThroughputPerSec: Math.round((conflictResponses / benchSec) * 10) / 10,
    retryableErrors,
    unexpectedErrors,
    latency: summarize(bookingLatencies),
  };

  // 2. Measure Hold Expiration Lag & Outbox Webhook Delivery Lag + Worker SIGKILL recovery
  const lagSlot = workQueue[totalTasks + 1]!;
  const expHold = await admin.createHold(
    { facilityId: lagSlot.facilityId, slotRefs: [lagSlot.slotRef], externalCustomerId: "lag-expire" },
    { idempotencyKey: `exp-lag-${randomUUID()}` },
  );
  await adminPool.query(`UPDATE holds SET expires_at = now() - interval '250 milliseconds' WHERE id = $1`, [expHold.id]);
  await adminPool.query(`UPDATE allocations SET expires_at = now() - interval '250 milliseconds' WHERE hold_id = $1`, [expHold.id]);
  const expStart = performance.now();
  const expWorker = new HoldExpiryWorker({ engine, batchLimit: 50 });
  const expRes = await expWorker.runOnce();
  const holdExpirationWorkerDurationMs = Math.round((performance.now() - expStart) * 100) / 100;

  // Worker SIGKILL mid-delivery + recovery without lost delivery
  let hookHits = 0;
  let lastSig = "";
  let lastPayload = "";
  const hookServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      hookHits += 1;
      lastSig = String(req.headers["x-oneline-signature"] ?? "");
      lastPayload = Buffer.concat(chunks).toString("utf8");
      res.statusCode = 200;
      res.end("ok");
    });
  });
  await new Promise<void>((r) => hookServer.listen(0, "127.0.0.1", () => r()));
  const hookPort = (hookServer.address() as AddressInfo).port;

  try {
    const endpoint = await platform.createWebhookEndpoint({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.testEnvironment.id,
      tenantId: tenant.id,
      url: `http://127.0.0.1:${hookPort}/events`,
    });

    // Ensure only ONE fresh event is pending for crash test: create direct booking on next unused slot
    const whSlot = workQueue[totalTasks + 2]!;
    await admin.createBooking(
      { facilityId: whSlot.facilityId, slotRefs: [whSlot.slotRef], externalCustomerId: "sigkill-wh" },
      { idempotencyKey: `wh-kill-${randomUUID()}` },
    );

    // Spawn worker #1 -> kill SIGKILL mid-HTTP-POST
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(
        process.execPath,
        ["dist/scripts/phase7-ops-suite.js", "--kill-worker-mid-delivery", tenant.id],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      child.stdout.on("data", (d) => {
        if (String(d).includes("HTTP_INFLIGHT")) {
          child.kill("SIGKILL");
        }
      });
      child.on("close", () => resolvePromise());
      child.on("error", reject);
    });

    // Advance lease expiry slightly (simulating 15s lease timeout expiry) and run surviving worker #2
    await adminPool.query(
      `UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE tenant_id = $1 AND status IN ('pending', 'retrying')`,
      [tenant.id],
    );
    const whStart = performance.now();
    const survivingWorker = new OutboxWebhookWorker({
      pool,
      engine,
      platform,
      tenantFilter: [tenant.id],
      ssrfOptions: { allowLocalHttpForTesting: true },
    });
    const whRes = await survivingWorker.runOnce();
    const webhookDeliveryLagMs = Math.round((performance.now() - whStart) * 100) / 100;

    const sigVerified = lastPayload
      ? verifyWebhookSignature({
          secret: endpoint.signingSecret,
          payloadJson: lastPayload,
          signatureHeader: lastSig,
        })
      : false;

    results.lagAndChaosRecovery = {
      holdExpirationExpiredCount: expRes.expiredCount,
      holdExpirationWorkerDurationMs,
      workerSigkillRecoveredDeliveries: whRes.delivered,
      webhookEndpointHttpHits: hookHits,
      webhookSignatureVerified: sigVerified,
      webhookDeliveryLagMs,
    };
  } finally {
    await new Promise<void>((r) => hookServer.close(() => r()));
  }

  // DB Integrity check
  const overlapRes = await adminPool.query<{ cnt: number }>(
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
  results.overlappingAllocations = Number(overlapRes.rows[0]?.cnt ?? 0);

  console.log(JSON.stringify(results, null, 2));
  await pool.end();
  await adminPool.end();
}

if (process.argv[2] !== "--kill-worker-mid-delivery") {
  void runPhase7OpsSuite();
}

