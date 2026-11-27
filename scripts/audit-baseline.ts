import "dotenv/config";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DateTime } from "luxon";
import {
  ALL_ADMIN_CAPABILITIES,
  createBookingPool,
  DEFAULT_CUSTOMER_CAPABILITIES,
  PostgresBookingStore,
  runMigrations,
  TimeSlotEngine,
  validateSlotSelection,
} from "../src/index.js";
import {
  expireFacilityHolds,
  getDecisionTime,
  loadFacilityConfig,
  loadOccupiedIntervals,
} from "../src/infrastructure/postgres/store-helpers.js";

const pool = createBookingPool();

function percentile(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!.toFixed(2));
}

try {
  await runMigrations(pool);
  const store = new PostgresBookingStore(pool);
  const engine = new TimeSlotEngine(store);

  const tenant = await engine.createTenant({ name: `Audit ${randomUUID()}` });
  const admin = engine.forTenant({
    tenantId: tenant.id,
    actor: { id: "audit-admin", type: "admin", capabilities: ALL_ADMIN_CAPABILITIES },
  });
  const facility = await admin.createFacility({ name: "Audit Court", category: "turf", timeZone: "Asia/Kolkata" });
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

  const targetDate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 4 }).toISODate()!;
  const avail = await admin.getAvailability({ facilityIds: [facility.id], localDate: targetDate });
  const hotSlot = avail.slots[5]!;

  // 1. Single-request uncontended step-by-step breakdown
  const client = await pool.connect();
  const breakdown: Record<string, number> = {};
  try {
    let t = performance.now();
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '3000ms'");
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    breakdown.txSetupMs = Number((performance.now() - t).toFixed(2));

    t = performance.now();
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["audit-key"]);
    await client.query("SELECT clock_timestamp()");
    await client.query("SELECT 1 FROM idempotency_records WHERE tenant_id=$1 AND caller_namespace='default' AND operation='create_hold' AND idempotency_key='k'", [tenant.id]);
    breakdown.idempotencyCheckMs = Number((performance.now() - t).toFixed(2));

    t = performance.now();
    const facRes = await client.query<{ configuration_revision: number }>(
      "SELECT configuration_revision FROM facilities WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [tenant.id, facility.id],
    );
    const rev = Number(facRes.rows[0]!.configuration_revision);
    const decisionTime = await getDecisionTime(client);
    breakdown.facilityLockMs = Number((performance.now() - t).toFixed(2));

    t = performance.now();
    const config = await loadFacilityConfig(client, tenant.id, facility.id);
    breakdown.loadConfigMs = Number((performance.now() - t).toFixed(2));

    t = performance.now();
    await expireFacilityHolds(client, tenant.id, facility.id, decisionTime);
    breakdown.expireHoldsMs = Number((performance.now() - t).toFixed(2));

    t = performance.now();
    const minT = new Date(decisionTime.getTime() - 2 * 86_400_000);
    const maxT = new Date(decisionTime.getTime() + 33 * 86_400_000);
    const occupied = await loadOccupiedIntervals(client, tenant.id, facility.id, minT, maxT, decisionTime);
    breakdown.loadOccupiedMs = Number((performance.now() - t).toFixed(2));

    t = performance.now();
    validateSlotSelection({
      facilityId: facility.id,
      configurationRevision: rev,
      timeZone: facility.timeZone,
      slotRefs: [hotSlot.slotRef],
      weeklyWindows: config.weeklyWindows,
      exceptions: config.exceptions,
      overrides: config.overrides,
      policy: config.policy!,
      pricing: config.pricing,
      occupied,
      asOf: decisionTime,
    });
    breakdown.domainValidateMs = Number((performance.now() - t).toFixed(2));

    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  // 2. Concurrent 200-request contention breakdown measuring pool wait vs total request time
  const poolWaits: number[] = [];
  const totalReqTimes: number[] = [];
  const peakWaiting: number[] = [];
  await Promise.all(
    Array.from({ length: 200 }, async (_, i) => {
      const c = engine.forTenant({
        tenantId: tenant.id,
        actor: { id: `u_${i}`, type: "customer", customerId: `c_${i}`, capabilities: DEFAULT_CUSTOMER_CAPABILITIES },
      });
      const req0 = performance.now();
      const conn0 = performance.now();
      const probe = await pool.connect();
      poolWaits.push(performance.now() - conn0);
      peakWaiting.push(pool.waitingCount);
      probe.release();
      try {
        await c.createHold({ facilityId: facility.id, slotRefs: [hotSlot.slotRef] }, { idempotencyKey: `audit-${i}-${randomUUID()}` });
      } catch {
        // expected conflicts
      }
      totalReqTimes.push(performance.now() - req0);
    }),
  );

  // 3. EXPLAIN ANALYZE on core queries
  const explainAlloc = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS)
     SELECT occupied_start, occupied_end, service_start, service_end
     FROM allocations
     WHERE tenant_id = $1 AND facility_id = $2
       AND (status = 'reserved' OR (status = 'held' AND expires_at > now()))
       AND occupied_start < now() + interval '33 days' AND occupied_end > now() - interval '2 days'`,
    [tenant.id, facility.id],
  );
  const explainOutbox = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS)
     SELECT id FROM outbox_events
     WHERE status = 'pending' AND next_attempt_at <= now()
       AND (lease_expires_at IS NULL OR lease_expires_at <= now())
     ORDER BY recorded_at ASC, aggregate_sequence ASC
     LIMIT 50`,
  );

  process.stdout.write(
    JSON.stringify(
      {
        singleRequestBreakdownMs: breakdown,
        poolStats200Concurrent: {
          poolMax: 10,
          maxWaitingObserved: Math.max(...peakWaiting),
          poolConnectMs: { p50: percentile(poolWaits, 50), p95: percentile(poolWaits, 95), p99: percentile(poolWaits, 99) },
          totalReqMs: { p50: percentile(totalReqTimes, 50), p95: percentile(totalReqTimes, 95), p99: percentile(totalReqTimes, 99) },
        },
        explainAllocations: explainAlloc.rows.map((r) => r["QUERY PLAN"]),
        explainOutbox: explainOutbox.rows.map((r) => r["QUERY PLAN"]),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await pool.end();
}

